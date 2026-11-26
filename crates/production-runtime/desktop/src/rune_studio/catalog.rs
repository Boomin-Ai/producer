use crate::studio_presets::Starter;
use anyhow::{ensure, Result};
use std::{
    fs,
    path::{Path, PathBuf},
};
pub(super) struct RoomEntry {
    pub path: PathBuf,
    pub title: String,
}
pub(super) fn catalog(root: &Path) -> Result<Vec<RoomEntry>> {
    let mut paths = vec![root.to_path_buf()];
    let dir = root.join("rooms");
    if dir.exists() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() && entry.path().join("room.json").is_file() {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    Ok(paths
        .into_iter()
        .map(|path| {
            let title = fs::read(path.join("room.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| v["production"]["title"].as_str().map(str::to_string))
                .unwrap_or_else(|| "Native Studio".into());
            RoomEntry { path, title }
        })
        .collect())
}
pub(super) fn create_room(root: &Path, name: &str, starter: Option<Starter>) -> Result<PathBuf> {
    let name = name.trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 80,
        "Enter a studio name (up to 80 characters)"
    );
    let parent = root.join("rooms");
    fs::create_dir_all(&parent)?;
    let dir = tempfile::Builder::new()
        .prefix("room-")
        .tempdir_in(parent)?;
    let mut project = crate::model::RoomProject::demo();
    project.room = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_ascii_lowercase();
    project.production.id = project.room.clone();
    project.production.title = name.into();
    starter.unwrap_or(Starter::Classic).apply(&mut project)?;
    project.compile()?;
    let mut file = fs::File::create(dir.path().join("room.json"))?;
    serde_json::to_writer_pretty(&mut file, &project)?;
    file.sync_all()?;
    Ok(dir.keep())
}

use super::{
    button, col, color, el, field, row, title, El, Page, Studio, SurfaceFit, TextEdit, MINT, MUTED,
    PANEL, TEXT,
};
pub(super) fn starters(s: &Studio, width: f32) -> El {
    let available = (width - 48.).clamp(160., 854.);
    let mut page = col().w(available).max_w(available).gap(14.);
    page = page.child(row().child(button(
        "starter-back",
        if s.naming {
            "‹ Starters"
        } else {
            "‹ Studios"
        },
        false,
        |s| {
            if s.naming {
                s.naming = false;
            } else {
                s.page = Page::Studios;
            }
        },
    )));
    if s.naming {
        page = page
            .child(title(
                s.starter.unwrap_or(Starter::Classic).name(),
                26.,
                700.,
                TEXT,
            ))
            .child(title("Studio name", 12., 500., MUTED))
            .child(
                field("studio-name", &s.name, |s| &mut s.name)
                    .max_w(440.)
                    .on_submit(|s: &mut Studio, _| s.create()),
            )
            .child(row().child(button("create", "Create Studio", true, Studio::create)));
    } else {
        page = page.child(title("Choose a studio", 28., 700., TEXT));
        let columns = if width >= 696. { 2 } else { 1 };
        let card_width = (available - 14. * (columns - 1) as f32) / columns as f32;
        for (r, starters) in Starter::ALL.chunks(columns).enumerate() {
            let mut cards = row().key(format!("starter-row-{r}")).gap(14.);
            for (i, &starter) in starters.iter().enumerate() {
                let mut art = el()
                    .w(card_width)
                    .h(card_width * 9. / 16.)
                    .fill(color(PANEL));
                if let Some(images) = &s.starter_images {
                    art = art.pixels_fit(images[r * columns + i].pixels(), SurfaceFit::Fit);
                }
                cards = cards.child(
                    col()
                        .key(starter.key())
                        .w(card_width)
                        .radius(13.)
                        .clip_rounded(13.)
                        .border(1., color(if starter == Starter::Classic { MINT } else { 0x263443 }))
                        .fill(color(0x101924))
                        .role("button")
                        .focusable(true)
                        .label(starter.name())
                        .child(art)
                        .child(
                            col()
                                .padding(14.)
                                .gap(5.)
                                .child(title(starter.name(), 16., 700., TEXT))
                                .child(title(starter.description(), 12., 450., MUTED)),
                        )
                        .on_press(move |s: &mut Studio| {
                            s.starter = Some(starter);
                            s.name = TextEdit::new(starter.name());
                            s.naming = true;
                        }),
                );
            }
            page = page.child(cards);
        }
    }
    col()
        .w_full()
        .key("starters-scroll")
        .min_h(0.)
        .grow(1.)
        .items_center()
        .padding(20.)
        .child(page)
        .scroll(Default::default())
}
pub(super) fn studios(s: &Studio, width: f32) -> El {
    let available = (width - 44.).max(160.);
    let cols = ((available + 14.) / 234.).floor().max(1.) as usize;
    let tile_width = (available - 14. * (cols - 1) as f32) / cols as f32;
    let mut page = col().w_full().px(22.).py(14.).gap(14.);
    let mut tiles = Vec::new();
    let account = s.settings.account.as_ref();
    let mut entries = Vec::new();
    if let Some(a) = account {
        for room in &a.rooms {
            let path = crate::boomin_account::room_path(&s.base, &a.login.brand, room.id);
            entries.push((
                path,
                room.title.clone().unwrap_or_else(|| "Studio".into()),
                room.is_default,
                Some((a.login.brand.clone(), room.clone())),
            ));
        }
    } else {
        entries.extend(s.rooms.iter().map(|room| {
            (
                room.path.clone(),
                room.title.clone(),
                room.path == s.base,
                None,
            )
        }));
    }
    for (i, (path, name, main, remote)) in entries.into_iter().enumerate() {
        let active = s.live.as_ref().is_some_and(|l| l.handle.root == path);
        let mut card = col()
            .w(tile_width)
            .h(109.)
            .gap(5.)
            .padding(20.)
            .radius(16.)
            .fill(color(0x101924))
            .border(1., color(if active || main { 0x197c64 } else { 0x263443 }))
            .key(format!("room-{i}"))
            .role("button")
            .label(name.clone())
            .focusable(true);
        if main {
            card = card.child(title("MAIN STAGE", 10., 600., MINT));
        }
        tiles.push(
            card.child(title(name, 16., 650., TEXT).wrap())
                .child(title(
                    if active {
                        "Return to studio"
                    } else {
                        "Open studio"
                    },
                    12.,
                    450.,
                    MUTED,
                ))
                .on_press(move |s: &mut Studio| {
                    if let Some((brand, room)) = &remote {
                        match crate::boomin_account::prepare_room(&s.base, brand, room, None) {
                            Ok(path) => s.open(path),
                            Err(e) => s.error = e.to_string(),
                        }
                    } else {
                        s.open(path.clone())
                    }
                }),
        );
    }
    tiles.push(
        col()
            .key("new")
            .w(tile_width)
            .h(109.)
            .padding(20.)
            .gap(5.)
            .radius(16.)
            .border(1., color(0x263443))
            .role("button")
            .label("New Studio")
            .focusable(true)
            .child(title("+", 17., 550., MINT))
            .child(title("New Studio", 16., 600., TEXT))
            .on_press(|s: &mut Studio| {
                s.settings.reference = uuid::Uuid::new_v4().to_string();
                s.page = Page::Starters;
                s.naming = false;
                s.starter = Some(Starter::Classic);
            }),
    );
    let mut iter = tiles.into_iter();
    while iter.len() > 0 {
        let mut line = row().w_full().gap(14.);
        for card in iter.by_ref().take(cols) {
            line = line.child(card);
        }
        page = page.child(line);
    }
    page.scroll(Default::default())
}
