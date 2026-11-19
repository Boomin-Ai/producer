//! Layout-only semantic admission. Observed dimensions never grant source access.
use crate::*;

pub fn ratio_valid(r: Ratio) -> bool {
    (1..=65536).contains(&r.width) && (1..=65536).contains(&r.height)
}
pub fn visual_source(d: &Document, id: &str) -> bool {
    match d.sources.get(id) {
        Some(Source::Live { .. } | Source::Graphics { .. }) => true,
        Some(Source::Player { asset }) => d
            .assets
            .get(asset)
            .is_some_and(|a| a.kind == AssetKind::Video),
        None => false,
    }
}
/// Definition identity qualifies inputs against asset replacement and document
/// identity. A native adapter still needs the actual capture incarnation fence.
pub fn source_layout_identity(d: &Document, id: &str) -> Result<Digest> {
    let source = d
        .sources
        .get(id)
        .ok_or_else(|| Error::new("LAYOUT_INPUT", id, "source is missing"))?;
    let asset = if let Source::Player { asset } = source {
        Some(
            d.assets
                .get(asset)
                .ok_or_else(|| Error::new("LAYOUT_INPUT", id, "asset is missing"))?,
        )
    } else {
        None
    };
    digest(&(&d.id, id, source, asset))
}
pub fn validate_inputs(d: &Document, inputs: &LayoutInputs) -> Result<()> {
    if inputs.document != d.id || inputs.sources.len() > 256 {
        return Err(Error::new(
            "LAYOUT_INPUT",
            "inputs",
            "matching document and at most 256 sources required",
        ));
    }
    for (id, value) in &inputs.sources {
        if !visual_source(d, id)
            || !ratio_valid(value.display)
            || value.identity != source_layout_identity(d, id)?
        {
            return Err(Error::new("LAYOUT_INPUT", id, "visual source, matching definition identity and bounded display dimensions required"));
        }
    }
    Ok(())
}
pub(crate) fn validate_placement(d: &Document, n: &Node, path: &str) -> Result<()> {
    let Some(p) = &n.placement else { return Ok(()) };
    if [p.anchor.x, p.anchor.y, p.pivot.x, p.pivot.y]
        .iter()
        .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
    {
        return Err(Error::new(
            "SEMANTIC",
            path,
            "anchor/pivot coordinates must be finite and in [0,1]",
        ));
    }
    if let Some(a) = &p.aspect {
        let ratio = match &a.ratio {
            AspectRatio::Fixed { ratio } => *ratio,
            AspectRatio::Source { source, fallback } => {
                if !visual_source(d, source) {
                    return Err(Error::new(
                        "SEMANTIC",
                        path,
                        "source aspect requires an existing visual source",
                    ));
                }
                *fallback
            }
        };
        if !ratio_valid(ratio) {
            return Err(Error::new(
                "SEMANTIC",
                path,
                "display ratio dimensions must be in [1,65536]",
            ));
        }
    }
    Ok(())
}
