//! Operator toolbar glyphs, shared visually with the original studio artwork.
pub fn glyph(name: &str) -> &'static rune::Icon {
    match name {
        "producer-update" => &rune::Icon {
            name: "producer-update",
            view: 24.,
            body: r#"<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>"#,
        },
        "back" => &rune::Icon {
            name: "back",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><path d="M20 12H4l7-7m-7 7 7 7"/></g>"#,
        },
        "more" => &rune::Icon {
            name: "more", view: 24.,
            body: r#"<g fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></g>"#,
        },
        "folder" => &rune::Icon {
            name: "folder", view: 24.,
            body: r#"<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>"#,
        },
        "clip-landscape" => &rune::Icon {
            name: "clip-landscape", view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></g>"#,
        },
        "clip-portrait" => &rune::Icon {
            name: "clip-portrait", view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2"/><path d="m10 9 5 3-5 3z"/></g>"#,
        },
        "send" => &rune::Icon {
            name: "send",
            view: 24.,
            body: r#"<path d="m3 10 18-7-7 18-3-8-8-3Zm8 3L21 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>"#,
        },
        "image" => &rune::Icon {
            name: "image",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="1.3"/><path d="m4 17 5-4 3 2 4-5 5 6"/></g>"#,
        },
        "clip" => &rune::Icon {
            name: "clip",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 11h18M7 5l4 6m2-6 4 6"/></g>"#,
        },
        "chevron-up" => &rune::Icon {
            name: "chevron-up",
            view: 24.,
            body: r#"<path d="m5 15 7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
        },
        "chevron-down" => &rune::Icon {
            name: "chevron-down",
            view: 24.,
            body: r#"<path d="m5 9 7 7 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
        },
        "profile" => &rune::Icon {
            name: "profile",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></g>"#,
        },
        "remove-guest" => &rune::Icon {
            name: "remove-guest",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H4v16h6 M9 12h12 M17 8l4 4-4 4"/></g>"#,
        },
        "stage-out" => &rune::Icon {
            name: "stage-out",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v4h16v-4 M12 3v12 M7 10l5 5 5-5"/></g>"#,
        },
        "stage-in" => &rune::Icon {
            name: "stage-in",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v4h16v-4 M12 15V3 M7 8l5-5 5 5"/></g>"#,
        },
        "plus" => &rune::Icon {
            name: "plus",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></g>"#,
        },
        "record" => &rune::Icon {
            name: "record",
            view: 24.,
            body: r#"<g width="24" height="24" ><circle fill="black" cx="12" cy="12" r="7"/></g>"#,
        },
        "pause" => &rune::Icon {
            name: "pause",
            view: 24.,
            body: r#"<g ><path fill="black" d="M7 5h3v14H7zm7 0h3v14h-3z"/></g>"#,
        },
        "play" => &rune::Icon {
            name: "play",
            view: 24.,
            body: r#"<g ><path fill="black" d="M7 4v16l13-8Z"/></g>"#,
        },
        "previous" => &rune::Icon {
            name: "previous",
            view: 24.,
            body: r#"<g ><path fill="black" d="M4 6h2v12H4zm9 0-7 6 7 6zm7 0-7 6 7 6z"/></g>"#,
        },
        "next" => &rune::Icon {
            name: "next",
            view: 24.,
            body: r#"<g ><path fill="black" d="M20 6h-2v12h2zM11 6l7 6-7 6zM4 6l7 6-7 6z"/></g>"#,
        },
        "next-track" => &rune::Icon {
            name: "next-track",
            view: 24.,
            body: r#"<g ><path fill="black" d="M5 4v16l12-8zM18 4h2v16h-2z"/></g>"#,
        },
        "restart" => &rune::Icon {
            name: "restart",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 4v5h-5m5 0a7 7 0 1 0 1.4 7"/></g>"#,
        },
        "stop" => &rune::Icon {
            name: "stop",
            view: 24.,
            body: r#"<g width="24" height="24" ><rect fill="black" x="5" y="5" width="14" height="14" rx="2"/></g>"#,
        },
        "mic" => &rune::Icon {
            name: "mic",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></g>"#,
        },
        "mic-off" => &rune::Icon {
            name: "mic-off",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5V4a3 3 0 0 1 6 0v8M9 9v3a3 3 0 0 0 5 2M5 10v2a7 7 0 0 0 12 5m2-5v-2M12 19v3m-4 0h8M3 3l18 18"/></g>"#,
        },
        "volume" => &rune::Icon {
            name: "volume",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6m2.8-8a7 7 0 0 1 0 10"/></g>"#,
        },
        "volume-off" => &rune::Icon {
            name: "volume-off",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4zM16 10l5 5m0-5-5 5"/></g>"#,
        },
        "screen" => &rune::Icon {
            name: "screen",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-4 0h8M12 13V7m-3 3 3-3 3 3"/></g>"#,
        },
        "settings" => &rune::Icon {
            name: "settings",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 3 1-2h4l1 2 2 1 2 0 2 3-1 2v3l1 2-2 3h-2l-2 1-1 3h-4l-1-3-2-1H5l-2-3 1-2V9L3 7l2-3h2z" transform="translate(0 1)"/><circle cx="12" cy="12" r="3"/></g>"#,
        },
        "edit" => &rune::Icon {
            name: "edit",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4 5 5-10 10-6 1 1-6zM13 6l5 5"/></g>"#,
        },
        "done" => &rune::Icon {
            name: "done",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></g>"#,
        },
        "activity" => &rune::Icon {
            name: "activity",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-8 5 16 3-8h5"/></g>"#,
        },
        "link" => &rune::Icon {
            name: "link",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 1) scale(.9)"/></g>"#,
        },
        "search" => &rune::Icon {
            name: "search",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 4.8 4.8"/></g>"#,
        },
        "inbox" => &rune::Icon {
            name: "inbox",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5h10l4 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/><path d="M3 13h5l2 3h4l2-3h5"/></g>"#,
        },
        "door" => &rune::Icon {
            name: "door",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21h16M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16m-5-8h1"/></g>"#,
        },
        "channels" => &rune::Icon {
            name: "channels",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 20H5a2 2 0 0 1-2-2V8"/></g>"#,
        },
        "studio" => &rune::Icon {
            name: "studio",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 3v18m0-7h11"/></g>"#,
        },
        "camera" => &rune::Icon {
            name: "camera",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/></g>"#,
        },
        "live" => &rune::Icon {
            name: "live",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/></g>"#,
        },
        "headphones" => &rune::Icon {
            name: "headphones",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="5" height="7" rx="2"/><rect x="16" y="13" width="5" height="7" rx="2"/></g>"#,
        },
        "assistant-bubble" => &rune::Icon {
            name: "assistant-bubble",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 10h8"/></g>"#,
        },
        "waveform" => &rune::Icon {
            name: "waveform",
            view: 24.,
            body: r#"<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4"/></g>"#,
        },
        "mixer" => &rune::Icon {
            name: "mixer",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 3v18M12 3v18M19 3v18M2 8h6m1 8h6m1-10h6"/></g>"#,
        },
        "timeline" => &rune::Icon {
            name: "timeline",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 4h18M8 2v20"/><rect x="3" y="9" width="10" height="4" rx="1"/><rect x="10" y="16" width="11" height="4" rx="1"/></g>"#,
        },
        "panels" => &rune::Icon {
            name: "panels",
            view: 24.,
            body: r#"<g width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></g>"#,
        },
        _ => &rune::Icon {
            name: "menu",
            view: 24.,
            body: r#"<path d="m6 9 6 6 6-6" stroke="currentColor" fill="none" stroke-width="1.8"/>"#,
        },
    }
}
