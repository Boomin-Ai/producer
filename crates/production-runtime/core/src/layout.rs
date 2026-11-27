//! Deterministic, off-callback geometry. Observed display ratios are immutable
//! compile inputs; no source probing, native font measurement or UI layout here.
use crate::contract::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAspect {
    pub ratio: Ratio,
    pub source: Option<Id>,
    pub used_fallback: bool,
}
pub(crate) struct Geometry {
    pub frame: Rect,
    pub pivot: UnitPoint,
    pub aspect: Option<ResolvedAspect>,
}
fn bad(path: &str, message: &str) -> Error {
    Error::new("LAYOUT", path, message)
}
fn normalized(mut r: Ratio) -> Ratio {
    let (mut a, mut b) = (r.width, r.height);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    r.width /= a;
    r.height /= a;
    r
}
fn aspect(n: &Node, inputs: &LayoutInputs) -> Option<ResolvedAspect> {
    n.placement
        .as_ref()?
        .aspect
        .as_ref()
        .map(|a| match &a.ratio {
            AspectRatio::Fixed { ratio } => ResolvedAspect {
                ratio: normalized(*ratio),
                source: None,
                used_fallback: false,
            },
            AspectRatio::Source { source, fallback } => {
                let input = inputs.sources.get(source);
                ResolvedAspect {
                    ratio: normalized(input.map_or(*fallback, |v| v.display)),
                    source: Some(source.clone()),
                    used_fallback: input.is_none(),
                }
            }
        })
}
/// Largest rectangle at the validated display ratio that fits the supplied pixel bounds.
pub fn contained_dimensions(width: f64, height: f64, ratio: Ratio) -> (f64, f64) {
    let aspect = f64::from(ratio.width) / f64::from(ratio.height);
    if width / height > aspect {
        (height * aspect, height)
    } else {
        (width, width / aspect)
    }
}
/// Preserve legacy explicit-frame placement when no new constraint is present.
pub(crate) fn place(
    n: &Node,
    parent: Rect,
    offsets: Rect,
    inputs: &LayoutInputs,
) -> Result<Geometry> {
    let resolved = aspect(n, inputs);
    let (mut width, mut height) = (offsets.width, offsets.height);
    if let Some(r) = &resolved {
        let ratio = f64::from(r.ratio.width) / f64::from(r.ratio.height);
        match n.placement.as_ref().unwrap().aspect.as_ref().unwrap().mode {
            AspectMode::Width => height = width / ratio,
            AspectMode::Height => width = height * ratio,
            AspectMode::Contain => {
                (width, height) = contained_dimensions(width, height, r.ratio);
            }
        }
    }
    let (anchor, pivot) = n
        .placement
        .as_ref()
        .map_or((UnitPoint::default(), UnitPoint::default()), |p| {
            (p.anchor, p.pivot)
        });
    let frame = Rect {
        x: parent.x + parent.width * anchor.x + offsets.x - width * pivot.x,
        y: parent.y + parent.height * anchor.y + offsets.y - height * pivot.y,
        width,
        height,
    };
    if [frame.x, frame.y, frame.width, frame.height]
        .iter()
        .any(|v| !v.is_finite() || v.abs() > 1_000_000_000.0)
        || width <= 0.0
        || height <= 0.0
    {
        return Err(bad(
            &n.id,
            "resolved geometry exceeds finite positive layout bounds",
        ));
    }
    Ok(Geometry {
        frame,
        pivot,
        aspect: resolved,
    })
}
pub(crate) fn fill(n: &Node, parent: Rect, inputs: &LayoutInputs) -> Result<Geometry> {
    place(
        n,
        parent,
        Rect {
            x: 0.0,
            y: 0.0,
            width: parent.width,
            height: parent.height,
        },
        inputs,
    )
}
pub(crate) fn raster(r: Rect) -> Rect {
    let x = r.x.round_ties_even();
    let y = r.y.round_ties_even();
    Rect {
        x,
        y,
        width: (r.x + r.width).round_ties_even() - x,
        height: (r.y + r.height).round_ties_even() - y,
    }
}
pub(crate) fn children(n: &Node, r: Rect, inputs: &LayoutInputs) -> Result<Vec<Geometry>> {
    let count = n.children.len();
    if count == 0 {
        return Ok(vec![]);
    }
    match &n.flow {
        Flow::Overlay => n
            .children
            .iter()
            .map(|c| {
                place(
                    c,
                    r,
                    c.frame.ok_or_else(|| bad(&c.id, "child frame missing"))?,
                    inputs,
                )
            })
            .collect(),
        Flow::Row { gap, sizes } | Flow::Column { gap, sizes } => {
            let row = matches!(n.flow, Flow::Row { .. });
            let available = (if row { r.width } else { r.height }) - gap * (count - 1) as f64;
            // Resolve intrinsic main-axis lengths before the existing bounded
            // weighted allocator. Aspect items therefore move later siblings.
            let sizes = sizes
                .iter()
                .zip(&n.children)
                .map(|(s, child)| {
                    if !matches!(s, Size::Aspect) {
                        return Ok(s.clone());
                    }
                    let a = aspect(child, inputs)
                        .ok_or_else(|| bad(&child.id, "aspect item has no constraint"))?;
                    let ratio = f64::from(a.ratio.width) / f64::from(a.ratio.height);
                    Ok(Size::Fixed {
                        pixels: if row {
                            r.height * ratio
                        } else {
                            r.width / ratio
                        },
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let lengths = crate::compile::allocation(&sizes, available)?;
            let mut offset = 0.0;
            let mut out = Vec::with_capacity(count);
            for (child, length) in n.children.iter().zip(lengths) {
                if length <= 0.0 {
                    return Err(bad(&child.id, "empty allocated child"));
                }
                let cell = if row {
                    Rect {
                        x: r.x + offset,
                        y: r.y,
                        width: length,
                        height: r.height,
                    }
                } else {
                    Rect {
                        x: r.x,
                        y: r.y + offset,
                        width: r.width,
                        height: length,
                    }
                };
                out.push(fill(child, cell, inputs)?);
                offset += length + gap;
            }
            Ok(out)
        }
        Flow::Grid { gap, columns } => {
            let cols = *columns as usize;
            let rows = count.div_ceil(cols);
            let width = (r.width - gap * (cols - 1) as f64) / cols as f64;
            let height = (r.height - gap * (rows - 1) as f64) / rows as f64;
            if width <= 0.0 || height <= 0.0 {
                return Err(bad(&n.id, "grid gaps exceed parent"));
            }
            n.children
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    fill(
                        c,
                        Rect {
                            x: r.x + (i % cols) as f64 * (width + gap),
                            y: r.y + (i / cols) as f64 * (height + gap),
                            width,
                            height,
                        },
                        inputs,
                    )
                })
                .collect()
        }
    }
}
