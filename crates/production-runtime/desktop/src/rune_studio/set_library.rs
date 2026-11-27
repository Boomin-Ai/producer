use super::*;
use crate::model::SetLayoutPair;
use anyhow::{ensure, Context, Result};
use producer_production_contract::{Content, Node, Paint};
use serde::Deserialize;
use std::collections::BTreeMap;

const LINE: u32 = 0x263747;

#[derive(Default, Clone, Copy, PartialEq)]
enum Collection {
    #[default]
    Installed,
    Shows,
    Producer,
    Published,
}

#[derive(Default)]
pub(super) struct Library {
    collection: Collection,
    filter: TextEdit,
    publisher: TextEdit,
    fetched: Option<String>,
    entries: Vec<Publication>,
    previews: BTreeMap<String, rune::Image>,
    images: Option<rune::ImageCache>,
    local: BTreeMap<&'static str, rune::Image>,
    loading: Option<mpsc::Receiver<Result<Update>>>,
    notice: String,
}

#[derive(Deserialize)]
struct Publication {
    slug: String,
    title: String,
    description: String,
    layout_count: usize,
    preview_url: Option<String>,
}

enum Update {
    Catalog(String, Vec<Publication>),
    Preview(String, Vec<u8>),
}

macro_rules! poster {
    ($id:literal) => {
        (
            $id,
            include_bytes!(concat!("../../starter-sets/previews/", $id, ".jpg")).as_slice(),
        )
    };
}
const POSTERS: &[(&str, &[u8])] = &[
    poster!("atmosphere"),
    poster!("atmosphere-aerie"),
    poster!("meridian-avenue"),
    poster!("classic"),
    poster!("classic-host"), poster!("classic-landscape"), poster!("classic-opening"), poster!("classic-screen-share"),
    poster!("useful-information-landscape"), poster!("useful-information-focus-host"), poster!("useful-information-focus-cohost"), poster!("useful-information-interview"), poster!("useful-information-screen-share"), poster!("useful-information-follow"), poster!("useful-information-opening"),

    poster!("layout-family-landscape"),
    poster!("layout-family-duo"),
    poster!("layout-family-interview"),
    poster!("layout-family-content"),
    poster!("layout-family-inset"),
    poster!("layout-family-opening"),
    poster!("layout-family-closing"),

    poster!("my-first-million"),
    poster!("mfm-opening"), poster!("mfm-conversation"), poster!("mfm-interview"),
    poster!("mfm-focus-shaan"), poster!("mfm-focus-sam"), poster!("mfm-screen-share"), poster!("mfm-follow"),
];

impl Library {
    pub fn setup(&mut self, wake: Waker) {
        let images = rune::ImageCache::new(wake);
        self.local = POSTERS
            .iter()
            .map(|(id, bytes)| (*id, images.load(*bytes)))
            .collect();
        self.images = Some(images);
    }

    pub(super) fn shot_image(&self, id: &str, set: &producer_production_contract::Set,
        landscape: &str, width: f32, height: f32) -> Option<El> {
        {
            let shot = landscape.strip_suffix("-landscape").unwrap_or(landscape);
            let key = match (id, shot) {
                ("my-first-million", "landscape") => "mfm-conversation".to_owned(),
                ("my-first-million", _) => format!("mfm-{shot}"),
                _ => format!("{id}-{shot}"),
            };
            if let Some(image) = self.local.get(key.as_str()).filter(|image| image.size().is_some()) {
                return Some(el().size(width, height).clip_rounded(4.).pixels_fit(image.pixels(), SurfaceFit::Fill));
            }
        }
        let layout = set.layouts.get(landscape)?;
        Some(layout_thumbnail(&layout.root, width, height, width / layout.width.max(1) as f32,
            height / layout.height.max(1) as f32).clip_rounded(4.))
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Some(rx) = &self.loading {
            match rx.try_recv() {
                Ok(Ok(Update::Catalog(handle, entries))) => {
                    self.fetched = Some(handle);
                    self.entries = entries;
                    changed = true;
                }
                Ok(Ok(Update::Preview(slug, bytes))) => {
                    if let Some(cache) = &self.images {
                        self.previews
                            .insert(slug, cache.load_scaled(bytes, 640., 1.));
                    }
                    changed = true;
                }
                Ok(Err(error)) => {
                    self.notice = error.to_string();
                    self.loading = None;
                    changed = true;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.loading = None;
                    changed = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        changed
    }
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn publisher_handle(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let handle = value.strip_prefix('@').unwrap_or(&value);
    let handle = handle.strip_prefix("https://").unwrap_or(handle);
    let handle = if let Some(path) = handle.strip_prefix("producer.dev/") {
        path.split('/').next()?
    } else {
        handle
    };
    valid_segment(handle).then(|| handle.to_owned())
}

async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= limit,
            "Publication response exceeds its size limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn fetch(handle: String, tx: &mpsc::Sender<Result<Update>>) -> Result<()> {
    #[derive(Deserialize)]
    struct Profile {
        handle: String,
        sets: Vec<Publication>,
    }

    let client = crate::boomin_account::http()?;
    let base = format!(
        "{}/v1/connect/producer/{handle}",
        crate::boomin::DEFAULT_BOOMIN_API_ROOT
    );
    let response = client
        .get(&base)
        .send()
        .await
        .context("Couldn’t reach producer.dev")?;
    ensure!(response.status() != 404, "No publisher found for @{handle}");
    ensure!(
        response.status().is_success(),
        "Producer.dev could not load this collection"
    );
    let profile: Profile = serde_json::from_slice(&read_bounded(response, 512 * 1024).await?)?;
    ensure!(
        profile.handle == handle,
        "The publisher changed. Search for it again."
    );
    let mut entries = profile.sets;
    entries.retain(|entry| valid_segment(&entry.slug));
    let preview_ids: Vec<_> = entries
        .iter()
        .filter(|p| p.preview_url.is_some())
        .map(|p| p.slug.clone())
        .collect();
    tx.send(Ok(Update::Catalog(handle, entries)))?;
    let mut pending = tokio::task::JoinSet::new();
    let mut slugs = preview_ids.into_iter();
    loop {
        while pending.len() < 4 {
            let Some(slug) = slugs.next() else { break };
            let client = client.clone();
            let url = format!("{base}/sets/{slug}/preview");
            pending.spawn(async move {
                let response = client.get(url).send().await.ok()?.error_for_status().ok()?;
                let data = read_bounded(response, 2 * 1024 * 1024).await.ok()?;
                Some((slug, data))
            });
        }
        match pending.join_next().await {
            Some(Ok(Some((id, bytes)))) => tx.send(Ok(Update::Preview(id, bytes)))?,
            Some(_) => {}
            None => break,
        }
    }
    Ok(())
}

fn load(s: &mut Studio) {
    let library = &mut s.set_library;
    let Some(handle) = publisher_handle(&library.publisher.text) else {
        library.notice = "Enter a publisher’s @handle or Producer.dev profile URL.".into();
        return;
    };
    library.fetched = None;
    library.entries.clear();
    library.previews.clear();
    library.notice.clear();
    let (tx, rx) = mpsc::channel();
    library.loading = Some(rx);
    std::thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(anyhow::Error::from)
            .and_then(|rt| rt.block_on(fetch(handle, &tx)));
        if let Err(error) = result {
            let _ = tx.send(Err(error));
        }
    });
}

fn collection(s: &mut Studio, choice: Collection) {
    s.set_library.collection = choice;
    if choice == Collection::Published && s.set_library.publisher.text.is_empty() {
        if let Some(account) = &s.settings.account {
            s.set_library.publisher = TextEdit::new(account.login.brand.clone());
            load(s);
        }
    }
}

fn ink(node: &Node) -> Option<Color> {
    let fill = node.style.as_ref()?.fill.as_ref()?;
    let ink = match fill {
        Paint::Solid { ink } | Paint::Contours { ink, .. } => ink,
        Paint::Linear { from, .. } | Paint::Veil { from, .. } => from,
        _ => return None,
    };
    rune::color::hex(&ink.color).map(|color| color.alpha(ink.opacity as f32))
}

fn layout_thumbnail(root: &Node, width: f32, height: f32, sx: f32, sy: f32) -> El {
    let mut tile = el()
        .clip_rounded(3.).size(width, height)
        .fill(ink(root).unwrap_or(color(0x12232e)));
    for node in &root.children {
        if let Some(frame) = node.frame {
            let w = frame.width as f32 * sx;
            let h = frame.height as f32 * sy;
            let slot = el().absolute(frame.x as f32 * sx, frame.y as f32 * sy).size(w, h);
            let preview = match node.content {
                Content::Source { .. } => {
                    let radius = (w.min(h) * 0.08).min(4.);
                    let slot = slot.clip_rounded(radius).radius(radius).fill(color(0x294854));
                    if w >= 20. && h >= 14. {
                        slot.center().child(rune::icon(glyphs::glyph("camera"), (h * 0.48).min(w * 0.45).min(18.)).color(color(0x88b6c4)))
                    } else { slot }
                }
                Content::Text { .. } => {
                    // A line of ink still reads as type at thumbnail scale.
                    slot.center().child(el().size(w * 0.78, (h * 0.29).clamp(1., 5.)).radius(1.)
                        .fill(color(0x94aab2)))
                }
                _ => match ink(node) { Some(fill) => slot.fill(fill), None => continue },
            };
            tile = tile.child(preview);
        }
    }
    tile
}

fn artwork(width: f32, image: Option<&rune::Image>, fallback: El) -> El {
    let height = width * 9. / 16.;
    let preview = el()
        .size(width, height)
        .clip_rounded(1.)
        .fill(color(0x12232e));
    if let Some(image) = image.filter(|image| image.size().is_some()) {
        preview.pixels_fit(image.pixels(), SurfaceFit::Fill)
    } else {
        preview.child(fallback)
    }
}

fn card(
    key: String,
    name: &str,
    subtitle: String,
    action: &str,
    image: El,
    width: f32,
    active: bool,
    press: impl Fn(&mut Studio) + 'static,
) -> El {
    col()
        .key(key)
        .role("button")
        .label(format!("{action} {name}"))
        .help(format!("{action} {name}"))
        .focusable(true)
        .w(width)
        .clip_rounded(10.)
        .radius(10.)
        .border(1., color(if active { 0x63b6a3 } else { LINE }))
        .fill(color(PANEL))
        .hover_fill(color(0x182731))
        .child(image)
        .child(
            col()
                .padding(11.)
                .gap(4.)
                .child(
                    row()
                        .items_center()
                        .gap(8.)
                        .child(title(name, 14., 650., TEXT).grow(1.))
                        .child(title("↗", 13., 600., if active { MINT } else { MUTED })),
                )
                .child(title(subtitle, 11., 500., MUTED)),
        )
        .on_press(press)
}

fn placeholder(width: f32, glyph: &str) -> El {
    el().size(width, width * 9. / 16.)
        .center()
        .child(rune::icon(glyphs::glyph(glyph), 29.).color(color(0x557787)))
}

pub(super) fn view(s: &Studio, width: f32, current: &str) -> El {
    let library = &s.set_library;
    let project = &s.live.as_ref().unwrap().snapshot.project;
    let mut tabs = row().gap(5.).flex_wrap();
    for (label, key, choice) in [
        ("In this studio", "installed", Collection::Installed),
        ("Shows", "shows", Collection::Shows),
        ("Producer", "producer", Collection::Producer),
        ("Published", "published", Collection::Published),
    ] {
        tabs = tabs.child(button(
            format!("library-{key}"),
            label,
            library.collection == choice,
            move |s| collection(s, choice),
        ));
    }
    let heading = row()
        .items_center()
        .gap(12.)
        .flex_wrap()
        .child(title("Sets and shows", 24., 650., TEXT))
        .child(el().grow(1.))
        .child(button(
            "library-back",
            "Back to editor",
            false,
            super::editor::back_to_editor,
        ));
    let published = library.collection == Collection::Published;
    let search = if published {
        row()
            .gap(6.)
            .items_center()
            .child(
                field("library-publisher", &library.publisher, |s| {
                    &mut s.set_library.publisher
                })
                .grow(1.)
                .placeholder("@publisher or producer.dev profile", color(MUTED))
                .on_submit(|s: &mut Studio, _| load(s)),
            )
            .child(button("library-load", "Browse", false, load))
    } else {
        field("library-search", &library.filter, |s| {
            &mut s.set_library.filter
        })
        .placeholder(if library.collection == Collection::Shows { "Find a show" } else { "Find a set" }, color(MUTED))
        .max_w(300.)
    };
    let columns = if width >= 940. {
        3
    } else if width >= 490. {
        2
    } else {
        1
    };
    let card_width = ((width - 44. - 12. * (columns - 1) as f32) / columns as f32).max(1.);
    let mut cards = Vec::new();
    let mut status = String::new();
    if published {
        if let Some(handle) = &library.fetched {
            for entry in &library.entries {
                let page = format!("https://producer.dev/{handle}/set/{}", entry.slug);
                let meta = if entry.description.trim().is_empty() {
                    format!("@{handle} · {} layouts · Producer.dev", entry.layout_count)
                } else {
                    format!("@{handle} · {}", entry.description)
                };
                let tile = artwork(
                    card_width,
                    library.previews.get(&entry.slug),
                    placeholder(card_width, "panels"),
                );
                cards.push(card(
                    format!("published-set-{}", entry.slug),
                    &entry.title,
                    meta,
                    "Open on Producer.dev",
                    tile,
                    card_width,
                    false,
                    move |s| {
                        if std::process::Command::new("/usr/bin/open")
                            .arg(&page)
                            .spawn()
                            .is_err()
                        {
                            s.set_library.notice =
                                "Couldn’t open the publication in your browser.".into();
                        }
                    },
                ));
            }
            if cards.is_empty() {
                status = format!("@{handle} has no public sets.");
            }
        } else if library.loading.is_some() {
            status = "Loading published sets…".into();
        } else if library.notice.is_empty() {
            status = "Browse a creator’s public sets on Producer.dev.".into();
        }
    } else if library.collection == Collection::Shows {
        let filter = library.filter.text.trim().to_lowercase();
        for (id, show) in project.production.shows.iter() {
            let label = crate::model::set_label(id);
            if !label.to_lowercase().contains(&filter) { continue; }
            let Some(set) = project.production.sets.get(&show.set) else { continue };
            let Some(first) = show.segments.first() else { continue };
            let pair = SetLayoutPair { landscape: first.landscape.clone(), vertical: first.vertical.clone() };
            let image = library.shot_image(&show.set, set, &pair.landscape, card_width, card_width * 9. / 16.)
                .unwrap_or_else(|| placeholder(card_width, "panels"));
            let detail = format!("{} · {} {}", crate::model::set_label(&show.set), show.segments.len(),
                if show.segments.len() == 1 { "segment" } else { "segments" });
            let selected = super::editor::ControllerSelection::new(project.active_scene.clone(), show.set.clone(), pair, Some(id.clone()));
            cards.push(card(format!("prepare-show-{id}"), &label, detail, "Prepare show", image,
                card_width, false, move |s| {
                    super::editor::close(s);
                    if s.editor.is_none() { s.set_selection = Some(selected.clone()); }
                }));
        }
        if cards.is_empty() { status = "No shows match your search.".into(); }
    } else {
        let filter = library.filter.text.trim().to_lowercase();
        let mut sets: Vec<_> = project
            .production
            .sets
            .iter()
            .filter(|(id, _)| id.as_str() != "room-scene")
            .collect();
        sets.sort_by_key(|(id, _)| (id.as_str() != current, crate::model::set_label(id)));
        for (id, set) in sets {
            let bundled = library.local.contains_key(id.as_str()) || id == "useful-information";
            let label = crate::model::set_label(id);
            if (library.collection == Collection::Producer && !bundled)
                || !label.to_lowercase().contains(&filter)
            {
                continue;
            }
            let pair = project.default_set_selection(id);
            let fallback = set.layouts.get(&pair.landscape).map_or_else(
                || placeholder(card_width, "panels"),
                |layout| {
                    let height = card_width * 9. / 16.;
                    layout_thumbnail(
                        &layout.root,
                        card_width,
                        height,
                        card_width / layout.width.max(1) as f32,
                        height / layout.height.max(1) as f32,
                    )
                },
            );
            let image = artwork(card_width, library.local.get(id.as_str()), fallback);
            let source = if bundled { "Producer" } else { "This studio" };
            let count = project.set_layout_choices(id).len();
            let detail = if count == 1 {
                "1 layout".into()
            } else {
                format!("{count} layouts")
            };
            let subtitle = if id == current {
                format!("Editing · {source} · {detail}")
            } else {
                format!("{source} · {detail}")
            };
            let id = id.clone();
            let template = id == "useful-information";
            let entry = card(
                format!("select-{id}"),
                &label,
                subtitle,
                "Edit",
                image,
                card_width,
                id == current,
                move |s| {
                    if let Some(live) = &s.live {
                        s.set_selection = Some(super::editor::ControllerSelection::new(
                            live.snapshot.project.active_scene.clone(), id.clone(), pair.clone(), None));
                    }
                    super::editor::open_selection(s, id.clone(), pair.clone())
                },
            );
            cards.push(if template {
                col().w(card_width).child(entry).child(button("clone-podcast-set", "Clone starter set", false, |s| {
                    s.send(RoomCommand::CloneSet { id: "useful-information".into() });
                }))
            } else { entry });
        }
        if cards.is_empty() {
            status = "No sets match your search.".into();
        }
    }
    let mut list = col()
        .key(if published {
            "published-grid"
        } else {
            "installed-grid"
        })
        .w_full()
        .padding(20.)
        .gap(12.);
    if !status.is_empty() {
        list = list.child(title(status, 13., 500., MUTED));
    }
    if published && !library.notice.is_empty() {
        list = list.child(title(&library.notice, 13., 500., 0xffadb3));
    }
    let mut cards = cards.into_iter();
    loop {
        let Some(first) = cards.next() else { break };
        let mut line = row().gap(12.).child(first);
        for next in cards.by_ref().take(columns - 1) {
            line = line.child(next);
        }
        list = list.child(line);
    }
    col()
        .key("set-library")
        .w_full()
        .h_full()
        .min_h(0.)
        .fill(color(BG))
        .child(
            col()
                .gap(10.)
                .padding(16.)
                .fill(color(PANEL))
                .child(heading)
                .child(tabs)
                .child(search),
        )
        .child(el().h(1.).w_full().fill(color(LINE)))
        .child(
            col()
                .key("set-library-scroll")
                .grow(1.)
                .h(0.)
                .min_h(0.)
                .w_full()
                .child(list)
                .scroll(Default::default()),
        )
}
