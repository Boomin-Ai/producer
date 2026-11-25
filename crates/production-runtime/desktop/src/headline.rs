use anyhow::{ensure, Context, Result};
use producer_production_contract::{Content, GraphInput, GraphPass, Layout, Node, Orientation, Set};
use std::ffi::{c_char, CString};

const ID: &str = "headline";
const ATLAS_HEIGHT: f64 = 144.;
const ATLAS_BOTTOM: f64 = 80. + ATLAS_HEIGHT;
pub const MIN_SIZE: u16 = 32;
pub const MAX_SIZE: u16 = 72;
pub const DEFAULT_SIZE: u16 = 56;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Wrap {
    #[default]
    Auto,
    OneLine,
    TwoLines,
}

pub fn wrap(set: &Set) -> Wrap {
    set.graphs.values().flat_map(|g| &g.passes).find_map(|pass| {
        if let GraphPass::Fragment { params, .. } = pass {
            if uses_headline(pass) {
                return Some(match params[0] {
                    1. => Wrap::OneLine,
                    2. => Wrap::TwoLines,
                    _ => Wrap::Auto,
                });
            }
        }
        None
    }).unwrap_or_default()
}

fn node(layout: &Layout) -> Option<&Node> {
    layout.root.children.iter().find(|node| node.id == ID)
}

pub fn supports(set: &Set, layout: &str) -> bool {
    set.layouts.get(layout).and_then(node).is_some()
        && set.output_graphs.get(layout).and_then(|id| set.graphs.get(id))
            .is_some_and(|graph| graph.passes.iter().any(uses_headline))
}

fn uses_headline(pass: &GraphPass) -> bool {
    matches!(pass, GraphPass::Fragment { id, inputs, .. } if id == "dj-credit"
        && inputs.iter().any(|input| matches!(input,
            GraphInput::Layers { nodes } if nodes.iter().any(|id| id == ID))))
}

pub fn visible(set: &Set) -> bool {
    set.graphs.values().flat_map(|g| &g.passes).any(|pass| {
        matches!(pass, GraphPass::Fragment { params, .. } if params[3] > 0.5)
            && uses_headline(pass)
    })
}

pub fn size(set: &Set) -> u16 {
    set.graphs.values().flat_map(|g| &g.passes).find_map(|pass| {
        if let GraphPass::Fragment { params, .. } = pass {
            if uses_headline(pass) && (f32::from(MIN_SIZE)..=f32::from(MAX_SIZE)).contains(&params[2]) {
                return Some(params[2].round() as u16);
            }
        }
        None
    }).unwrap_or(DEFAULT_SIZE)
}

pub fn text(set: &Set) -> Option<&str> {
    set.layouts.iter().filter(|(id, layout)| layout.orientation == Orientation::Landscape
        && supports(set, id))
        .find_map(|(_, layout)| match &node(layout)?.content {
            Content::Text { value, .. } => Some(value.as_str()),
            _ => None,
        })
}

fn text_width(text: &str, size: f64) -> Result<f64> {
    unsafe extern "C" {
        fn nr_headline_width(value: *const c_char, size: f64) -> f64;
    }
    let value = CString::new(text)?;
    let width = unsafe { nr_headline_width(value.as_ptr(), size) };
    ensure!(width.is_finite(), "Could not measure the headline");
    Ok(width)
}

fn widest_line(text: &str, size: f64) -> Result<f64> {
    text.lines().try_fold(0_f64, |width, line| {
        Ok(width.max(text_width(line, size)?))
    })
}

fn fitted(text: &str, width: f64, vertical: bool, preferred: u16, wrap: Wrap) -> Result<(String, f64, f64)> {
    let width = width - 12.;
    let preferred = f64::from(preferred);
    let single = text_width(text, preferred)?;
    // Prefer a broad single line if a modest reduction in size will fit it.
    let should_wrap = vertical && match wrap {
        Wrap::OneLine => false,
        Wrap::TwoLines => true,
        Wrap::Auto => single * 0.80 > width,
    };
    let mut split = None;
    if should_wrap {
        for (index, _) in text.match_indices(' ') {
            let longest = text_width(&text[..index], preferred)?
                .max(text_width(&text[index + 1..], preferred)?);
            if split.is_none_or(|(_, best)| longest < best) {
                split = Some((index, longest));
            }
        }
    }
    let label = split.map_or_else(|| text.to_owned(), |(index, _)| {
        format!("{}\n{}", &text[..index], &text[index + 1..])
    });
    let rows = label.lines().count() as f64;
    let mut font_size = preferred.min((ATLAS_HEIGHT - 6.) / (1.23 * rows));
    // System fonts can change optical size. Recheck after resizing.
    for _ in 0..3 {
        let measured = widest_line(&label, font_size)?;
        if measured <= width { break; }
        font_size *= width / measured;
    }
    let height = (font_size * 1.23 * rows + 6.).ceil().min(ATLAS_HEIGHT);
    Ok((label, font_size, height))
}

pub fn apply(set: &mut Set, draft: Option<&str>, requested_size: Option<u16>, requested_wrap: Option<Wrap>) -> Result<()> {
    let preferred = requested_size.unwrap_or_else(|| size(set));
    let wrap = requested_wrap.unwrap_or_else(|| wrap(set));
    ensure!((MIN_SIZE..=MAX_SIZE).contains(&preferred),
        "Headline text size must be between {MIN_SIZE} and {MAX_SIZE}");
    let styling = requested_size.is_some() || requested_wrap.is_some();
    let visible = draft.is_some() || (styling && visible(set));
    let value = draft.map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "));
    if let Some(value) = value.as_ref() {
        ensure!(!value.is_empty(), "Type a headline first");
        ensure!(value.chars().count() <= 96 && !value.chars().any(char::is_control),
            "Enter a headline up to 96 characters");
    }
    let value = value.or_else(|| styling.then(|| text(set)).flatten().map(str::to_owned))
        .filter(|value| !value.is_empty());
    let mut atlas_heights = std::collections::BTreeMap::new();
    if let Some(value) = value.as_deref() {
        let layouts = set.layouts.keys().filter(|id| supports(set, id)).cloned().collect::<Vec<_>>();
        for id in layouts {
            let layout = set.layouts.get_mut(&id).context("Missing headline layout")?;
            let node = layout.root.children.iter_mut().find(|node| node.id == ID)
                .context("Missing headline layer")?;
            let frame = node.frame.as_mut().context("Headline is missing its text frame")?;
            let style = node.style.as_mut().and_then(|s| s.text.as_mut())
                .context("Headline is missing its text style")?;
            let Content::Text { value: text, .. } = &mut node.content else {
                anyhow::bail!("Headline must be a text layer");
            };
            let (label, font_size, height) = fitted(value, frame.width,
                layout.orientation == Orientation::Vertical, preferred, wrap)?;
            ensure!(font_size >= 6., "Shorten the headline to fit the camera frame");
            *text = label;
            style.font_size = font_size;
            frame.y = ATLAS_BOTTOM - height;
            frame.height = height;
            atlas_heights.insert(set.output_graphs[&id].clone(), height as f32);
        }
    }
    for (id, graph) in &mut set.graphs {
        for pass in &mut graph.passes {
            if uses_headline(pass) {
                if let GraphPass::Fragment { params, .. } = pass {
                    params[0] = match wrap {
                        Wrap::Auto => 0.,
                        Wrap::OneLine => 1.,
                        Wrap::TwoLines => 2.,
                    };
                    if let Some(height) = atlas_heights.get(id) {
                        params[1] = *height;
                    }
                    params[2] = f32::from(preferred);
                    params[3] = f32::from(visible);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headline_wraps_on_portrait_and_fits_one_landscape_line() {
        let title = "Why do good products struggle to sell?";
        let (portrait, size, height) = fitted(title, 633., true, DEFAULT_SIZE, Wrap::Auto).unwrap();
        assert_eq!(portrait.replace('\n', " "), title);
        assert_eq!(portrait.lines().count(), 2);
        assert!(size > 42. && size <= f64::from(DEFAULT_SIZE));
        assert!(height <= ATLAS_HEIGHT);
        let (landscape, size, _) = fitted(title, 544., false, DEFAULT_SIZE, Wrap::Auto).unwrap();
        assert_eq!(landscape, title);
        assert!(text_width(title, size).unwrap() <= 532.);
    }

    #[test]
    fn short_headlines_grow_and_large_two_line_titles_stay_in_the_atlas() {
        assert_eq!(fitted("Buy my work", 633., true, MAX_SIZE, Wrap::Auto).unwrap().1, f64::from(MAX_SIZE));
        let (label, size, height) = fitted("Why do good products struggle to sell?", 633., true, MAX_SIZE, Wrap::Auto).unwrap();
        assert_eq!(label.lines().count(), 2);
        assert!(size > 42. && size <= f64::from(MAX_SIZE));
        assert!(height <= ATLAS_HEIGHT);
    }

    #[test]
    fn wide_first_layout_uses_one_line_for_the_reported_headline() {
        let title = "DO WHAT YOU WANT";
        let (label, size, _) = fitted(title, 633., true, 60, Wrap::Auto).unwrap();
        assert_eq!(label, title);
        let measured = widest_line(&label, size).unwrap();
        assert!((540. ..=621.).contains(&measured), "{measured}");
        assert_eq!(fitted(title, 633., true, 60, Wrap::TwoLines).unwrap().0.lines().count(), 2);
        let (label, size, _) = fitted(title, 410., true, 72, Wrap::OneLine).unwrap();
        assert_eq!(label, title);
        assert!(widest_line(&label, size).unwrap() <= 398.);
    }
}
