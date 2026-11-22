//! Portable, public-media visual acceptance document. This is a compositor
//! specimen for Classic, not the complete eight-layout beta Set.
use crate::model::{CanvasView, RoomProject};
use producer_production_contract::*;
use std::collections::BTreeMap;
fn ink(color: &str, opacity: f64) -> Ink {
    Ink {
        color: color.into(),
        opacity,
    }
}
fn box_node(id: &str, x: f64, y: f64, w: f64, h: f64, style: SurfaceStyle) -> Node {
    Node {
        id: id.into(),
        style: Some(style),
        frame: Some(Rect {
            x,
            y,
            width: w,
            height: h,
        }),
        placement: None,
        flow: Flow::Overlay,
        content: Content::Group,
        children: vec![],
        bindings: vec![],
    }
}
fn label(id: &str, text: &str, frame: [f64; 4], size: f64, color: &str, weight: u16) -> Node {
    let mut n = box_node(
        id,
        frame[0],
        frame[1],
        frame[2],
        frame[3],
        SurfaceStyle {
            text: Some(TextStyle {
                field: None,
                font_size: size,
                weight,
                ink: ink(color, 1.),
                align: TextAlign::Left,
            }),
            ..Default::default()
        },
    );
    n.content = Content::Text {
        value: text.into(),
        font: "0".repeat(64),
    };
    n
}
pub fn project(light: bool) -> RoomProject {
    let mut p = RoomProject::demo();
    p.production.title = "Classic / Native light & motion".into();
    p.canvas.view = CanvasView::Both;
    let set = p.production.sets.get_mut("studio").unwrap();
    set.layouts = BTreeMap::from([
        (
            "landscape".into(),
            layout(1920, 1080, Orientation::Landscape, light),
        ),
        (
            "vertical".into(),
            layout(1080, 1920, Orientation::Vertical, light),
        ),
    ]);
    let seq = p.production.sequences.get_mut("main").unwrap();
    seq.tracks.clear();
    let movie = seq
        .placements
        .iter_mut()
        .find(|p| p.source == "movie")
        .unwrap();
    movie.range.start = Time::ZERO;
    movie.range.duration = Time::seconds(30);
    movie.looping = true;
    p
}
fn layout(w: u32, h: u32, orientation: Orientation, light: bool) -> Layout {
    let tall = orientation == Orientation::Vertical;
    let (fg, muted, _paper) = if light {
        ("#172C30", "#466165", "#F4F8F6")
    } else {
        ("#F5F9F7", "#AEC3C1", "#0C171E")
    };
    let mut root = box_node(
        "root",
        0.,
        0.,
        w as f64,
        h as f64,
        SurfaceStyle {
            fill: Some(Paint::Solid {
                ink: ink("#09151A", 1.),
            }),
            ..Default::default()
        },
    );
    let mut video = box_node(
        "forest-train",
        0.,
        0.,
        w as f64,
        h as f64,
        Default::default(),
    );
    video.content = Content::Source {
        source: "movie".into(),
        fit: Fit::Cover,
    };
    root.children.push(video);
    let (x, y, pw, ph) = if tall {
        (48., 160., 984., 1580.)
    } else {
        (116., 86., 1410., 908.)
    };
    let mut window = box_node(
        "glass",
        x,
        y,
        pw,
        ph,
        SurfaceStyle {
            fill: Some(Paint::Veil {
                from: ink(if light { "#8BC9E8" } else { "#173C50" }, 0.82),
                to: ink(if light { "#D9A7CB" } else { "#543451" }, 0.78),
                glow: ink(if light { "#E4EAD8" } else { "#101C22" }, 0.90),
                cell: 4.,
                motion: 0.35,
            }),
            radius: 30.,
            border: Some(SurfaceBorder {
                ink: ink(if light { "#FFFFFF" } else { "#B5DDD4" }, 0.65),
                width: 1.5,
            }),
            grain: 0.012,
            text: None,
        },
    );
    // A single flat surface with independent sharp typography; the train behind
    // the glass is decoded once and remains a live video texture.
    window.children.push(label(
        "brand",
        "PRODUCER  /  CLASSIC",
        [40., 28., pw - 80., 40.],
        22.,
        fg,
        600,
    ));
    let headline_y = if tall { 130. } else { 122. };
    window.children.push(label(
        "eyebrow",
        "YOUR NEXT GREAT SHOW",
        [44., headline_y, pw - 88., 42.],
        24.,
        if light { "#216657" } else { "#B6F5DB" },
        600,
    ));
    window.children.push(label(
        "headline",
        "Make room\nfor your ideas.",
        [
            40.,
            headline_y + 65.,
            pw - 80.,
            if tall { 290. } else { 238. },
        ],
        if tall { 92. } else { 94. },
        fg,
        700,
    ));
    window.children.push(label(
        "message",
        "Live sources. Native motion. Your signal.",
        [
            44.,
            headline_y + if tall { 400. } else { 325. },
            pw - 88.,
            100.,
        ],
        if tall { 32. } else { 30. },
        muted,
        400,
    ));
    let cy = if tall { 930. } else { 628. };
    let ch = if tall { 390. } else { 124. };
    let mut card = box_node(
        "note",
        40.,
        cy,
        pw - 80.,
        ch,
        SurfaceStyle {
            fill: Some(Paint::Solid {
                ink: ink(if light { "#FFFFFF" } else { "#071218" }, 0.32),
            }),
            radius: 20.,
            border: Some(SurfaceBorder {
                ink: ink(if light { "#6C9991" } else { "#7DAF9E" }, 0.4),
                width: 1.,
            }),
            ..Default::default()
        },
    );
    card.children.push(label(
        "note-title",
        "A little breathing room.",
        [28., 22., pw - 136., 54.],
        34.,
        fg,
        600,
    ));
    if tall {
        card.children.push(label(
            "note-copy",
            "The scene keeps moving.\nThe design stays out of your way.",
            [28., 110., pw - 136., 180.],
            32.,
            muted,
            400,
        ));
    }
    window.children.push(card);
    window.children.push(label(
        "footer",
        "STOP POSTING. START PRODUCING.",
        [44., ph - 76., pw - 88., 38.],
        22.,
        muted,
        500,
    ));
    root.children.push(window);
    Layout {
        orientation,
        width: w,
        height: h,
        root,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_modes_compile_at_native_canvas_sizes() {
        for light in [false, true] {
            let p = project(light);
            let plan = p.compile().unwrap();
            assert_eq!(plan.nodes.iter().filter(|n| n.text.is_some()).count(), 13);
            assert!(plan.nodes.iter().any(|n| n
                .style
                .as_ref()
                .is_some_and(|s| matches!(s.fill, Some(Paint::Veil { .. })))));
        }
    }
}
