//! On-demand inspection of a private set revision. No live device is sampled.
use crate::{authored_set, model::RoomProject, posters};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use producer_production_contract::GraphPass;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Query {
    set: String,
    #[serde(default)]
    mode: Mode,
    layout: Option<String>,
    page: Option<usize>,
    #[serde(default)]
    pass: Option<String>,
    #[serde(default)]
    time: f64,
    #[serde(default)]
    disconnected: bool,
    #[serde(default)]
    profile_gpu: bool,
    #[serde(default)]
    candidate: Option<Value>,
    detail: Option<Detail>,
}

const LOOKS_PER_PAGE: usize = 3;
const SHEET_ROW_HEIGHT: u32 = 360;
const SHEET_LANDSCAPE_WIDTH: u32 = 640;
const SHEET_PORTRAIT_WIDTH: u32 = 203;
const SHEET_GUTTER: u32 = 8;

#[derive(Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Mode {
    #[default]
    Single,
    Overview,
}

impl Query {
    fn validate(&self) -> Result<()> {
        ensure!(
            (0. ..=3600.).contains(&self.time),
            "Preview time must be within 0–3600 seconds"
        );
        match self.mode {
            Mode::Single => {
                ensure!(
                    self.layout
                        .as_deref()
                        .is_some_and(|id| !id.trim().is_empty()),
                    "Single preview requires layout"
                );
                ensure!(self.page.is_none(), "page is available in overview mode");
                if let Some(detail) = &self.detail {
                    detail.validate()?;
                }
            }
            Mode::Overview => {
                ensure!(self.layout.is_none() && self.detail.is_none() && self.pass.is_none() && !self.profile_gpu,
                    "Overview previews complete layout pairs. Use single mode for layout, detail, pass or GPU profiling.");
                ensure!(self.page.unwrap_or(1) > 0, "Overview pages start at one");
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Detail {
    view: String,
    region: [f64; 4],
}

impl Detail {
    fn validate(&self) -> Result<()> {
        let [x, y, w, h] = self.region;
        ensure!(
            matches!(self.view.as_str(), "landscape" | "portrait"),
            "Unknown detail orientation"
        );
        ensure!(
            x >= 0. && y >= 0. && w > 0. && h > 0. && x + w <= 1. && y + h <= 1.,
            "Detail region must fit inside the normalized canvas"
        );
        Ok(())
    }
    fn save(&self, dest: &Path) -> Result<Value> {
        let rendered = image::open(dest.join(format!("{}.png", self.view)))?;
        let [x, y, w, h] = self.region;
        let bounds = |start: f64, length: f64, size: u32| {
            let first = ((start * f64::from(size)).floor() as u32).min(size - 1);
            let end = (((start + length) * f64::from(size)).ceil() as u32).clamp(first + 1, size);
            (first, end - first)
        };
        let (left, width) = bounds(x, w, rendered.width());
        let (top, height) = bounds(y, h, rendered.height());
        rendered
            .crop_imm(left, top, width, height)
            .save(dest.join("detail.png"))?;
        Ok(json!({"view":self.view,"pixels":[left,top,width,height],"region":self.region}))
    }
}

pub fn tool() -> Value {
    json!({"type":"function","name":"preview_set","description":
        "Inspect private Metal renders of both orientations. For a multi-look design, first use mode:overview without layout to compare composition, type hierarchy, and the visibility of hosts and material treatments across the entire set. Each page shows up to three looks in one paired sheet. Then reuse candidateRef with mode:single, layout and optional detail to inspect a problem area sampled at output resolution. Use a saved set, or pass an authorSet/editAuthoredSet candidate before proposing it. The pictures use blue host and amber guest calibration inputs. Supply a pass ID to inspect a terminal graph up to that pass. Use a different time to inspect motion. Reuse candidateRef for another inspection, including after an invalid preview. To revise that candidate, include edits with JSON pointers relative to its command. Once the design satisfies the brief, call submit_set with its candidateRef.",
        "parameters":{"type":"object","additionalProperties":false,"required":["set"],
        "properties":{"set":{"type":"string"},"mode":{"enum":["single","overview"],"description":"Defaults to single, which requires layout. For overview omit layout, detail, pass and profileGpu."},"page":{"type":"integer","minimum":1,"description":"Overview page; first page is 1. The receipt includes pageCount."},"layout":{"type":"string","description":"Authored look ID, layout ID or layout choice label"},
        "time":{"type":"number","minimum":0,"maximum":3600},"pass":{"type":"string"},
        "detail":{"type":"object","additionalProperties":false,"description":"Inspect type or a material edge from one full-resolution output. Coordinates are normalized x,y,width,height.","required":["view","region"],"properties":{"view":{"enum":["landscape","portrait"]},"region":{"type":"array","minItems":4,"maxItems":4,"items":{"type":"number","minimum":0,"maximum":1}}}},
        "profileGpu":{"type":"boolean","description":"Measure the private render command and supported vertex/fragment stage timestamps."},"disconnected":{"type":"boolean"},"edits":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","properties":{"op":{"enum":["add","replace","remove"]},"path":{"type":"string"},"value":{}},"required":["op","path"]}},"candidateRef":{"type":"string"},"candidate":{"type":"object","description":"Optional complete native authoring command"}}}})
}

pub fn capture(room_root: &Path, project: &RoomProject, args: Value, dest: &Path) -> Result<Value> {
    render(room_root, project, args, dest, 0)
}

fn render(
    room_root: &Path,
    project: &RoomProject,
    args: Value,
    dest: &Path,
    max_dimension: u32,
) -> Result<Value> {
    let mut query: Query = serde_json::from_value(args)?;
    query.validate()?;
    let mut scratch = project.clone();
    if let Some(value) = query.candidate.take() {
        ensure!(
            value["id"] == query.set,
            "Candidate and inspected set IDs differ"
        );
        authored_set::prepare(project, value)?.install(&mut scratch)?;
    }
    if query.mode == Mode::Overview {
        return render_overview(room_root, &scratch, &query, dest);
    }
    let layout = query
        .layout
        .as_deref()
        .context("Single preview requires layout")?;
    let choice = scratch
        .set_layout_choices(&query.set)
        .into_iter()
        .find(|c| {
            c.pair.ids().contains(&layout)
                || c.pair.landscape.strip_suffix("-landscape") == Some(layout)
                || c.label.eq_ignore_ascii_case(layout)
        })
        .with_context(|| {
            format!(
                "Unknown preview layout {}. Available: {}",
                layout,
                scratch
                    .set_layout_choices(&query.set)
                    .iter()
                    .map(|c| c.pair.landscape.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    let pair = choice.pair;
    let set = scratch
        .production
        .sets
        .get_mut(&query.set)
        .context("Unknown preview set")?;
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&set)?));
    if let Some(id) = &query.pass {
        // Apply the tap only to this disposable copy. Each orientation can have
        // a separately lowered graph for the same named material.
        for layout in pair.ids() {
            let graph = set
                .output_graphs
                .get(layout)
                .and_then(|name| set.graphs.get_mut(name))
                .with_context(|| format!("{layout} has no terminal graph"))?;
            let index = graph
                .passes
                .iter()
                .position(|p| match p {
                    GraphPass::Composite { id: name }
                    | GraphPass::Geometry { id: name, .. }
                    | GraphPass::Fragment { id: name, .. } => name == id,
                })
                .with_context(|| format!("Pass {id} missing on {layout}"))?;
            graph.passes.truncate(index + 1);
        }
    }
    scratch.mount_set(Some(query.set.clone()), Some(pair.clone()))?;
    let live = scratch.live_set()?;
    let (device, profile) = posters::inspect_pair(
        room_root,
        &live,
        dest,
        query.time,
        !query.disconnected,
        if query.detail.is_some() {
            0
        } else {
            max_dimension
        },
        query.profile_gpu,
    )?;
    let mut receipt = json!({"set":query.set,"compiledSha256":digest,"layouts":pair,"pass":query.pass,
        "backend":"Metal","deviceRegistryId":device,"seconds":query.time,"inputs":if query.disconnected {"disconnected"} else {"synthetic host and guest"}});
    if let Some(detail) = query.detail {
        receipt["detail"] = detail.save(dest)?;
    }
    if let Some(profile) = profile {
        receipt["gpuTiming"] = profile;
    }
    std::fs::write(
        dest.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    Ok(receipt)
}

fn render_overview(
    root: &Path,
    project: &RoomProject,
    query: &Query,
    dest: &Path,
) -> Result<Value> {
    let mut choices = project.set_layout_choices(&query.set);
    ensure!(
        !choices.is_empty(),
        "No layout pairs to preview for {}",
        query.set
    );
    if let Some(source) = project.authored_designs.get(&query.set) {
        let ids = source.inspect("authoredLook", "");
        if let Some(ids) = ids.as_array() {
            choices.sort_by_key(|c| {
                let stem = c
                    .pair
                    .landscape
                    .strip_suffix("-landscape")
                    .unwrap_or(&c.pair.landscape);
                ids.iter()
                    .position(|id| id.as_str() == Some(stem))
                    .unwrap_or(usize::MAX)
            });
        }
    }
    let page_count = choices.len().div_ceil(LOOKS_PER_PAGE);
    let page = query.page.unwrap_or(1);
    ensure!(
        page <= page_count,
        "Overview page {page} exceeds {page_count} pages"
    );
    let selected = choices
        .chunks(LOOKS_PER_PAGE)
        .nth(page - 1)
        .context("Missing overview page")?;
    let sample = posters::PosterSample {
        seconds: query.time,
        connected: !query.disconnected,
        max_dimension: SHEET_LANDSCAPE_WIDTH,
    };
    let (rendered, mut receipt) =
        posters::inspect_layout_pairs(root, project, &query.set, dest, selected, sample, |_| {
            Ok(())
        })?;
    let sheet = overview_picture(&rendered)?;
    sheet.save(dest.join("overview.png"))?;
    receipt["mode"] = json!("overview");
    receipt["page"] = json!(page);
    receipt["pageCount"] = json!(page_count);
    receipt["totalLooks"] = json!(choices.len());
    receipt["rows"] = json!(selected
        .iter()
        .map(|c| json!({"label":c.label,"layouts":c.pair}))
        .collect::<Vec<_>>());
    receipt["sheetPixels"] = json!([sheet.width(), sheet.height()]);
    std::fs::write(
        dest.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    Ok(receipt)
}

/// Preserve the full frame in each cell, including canvases with a custom ratio.
fn overview_picture(rows: &[(String, std::path::PathBuf)]) -> Result<image::RgbImage> {
    ensure!(
        (1..=LOOKS_PER_PAGE).contains(&rows.len()),
        "An overview needs one to three rows"
    );
    let width = SHEET_LANDSCAPE_WIDTH + SHEET_GUTTER + SHEET_PORTRAIT_WIDTH;
    let height = rows.len() as u32 * (SHEET_ROW_HEIGHT + SHEET_GUTTER) - SHEET_GUTTER;
    let mut sheet = image::RgbImage::from_pixel(width, height, image::Rgb([22, 26, 31]));
    for (row, (_, dir)) in rows.iter().enumerate() {
        let y = row as u32 * (SHEET_ROW_HEIGHT + SHEET_GUTTER);
        for (name, x, cell_width) in [
            ("landscape", 0, SHEET_LANDSCAPE_WIDTH),
            (
                "portrait",
                SHEET_LANDSCAPE_WIDTH + SHEET_GUTTER,
                SHEET_PORTRAIT_WIDTH,
            ),
        ] {
            let picture = image::open(dir.join(format!("{name}.png")))?;
            let view = picture.thumbnail(cell_width, SHEET_ROW_HEIGHT).to_rgb8();
            let left = x + (cell_width - view.width()) / 2;
            let top = y + (SHEET_ROW_HEIGHT - view.height()) / 2;
            image::imageops::replace(&mut sheet, &view, i64::from(left), i64::from(top));
        }
    }
    Ok(sheet)
}

pub fn for_model(
    room_root: &Path,
    project: &RoomProject,
    args: Value,
) -> Result<(Value, Vec<Value>)> {
    let dir = tempfile::tempdir()?;
    // A single labeled pair fits in one low-detail vision tile. The director's
    // full-resolution output is produced independently by the native renderer.
    let layout = args["layout"].as_str().unwrap_or_default().to_string();
    let receipt = render(room_root, project, args, dir.path(), 352)?;
    let overview = receipt["mode"] == "overview";
    let (picture, label, quality) = if overview {
        let rows = receipt["rows"]
            .as_array()
            .context("Missing overview rows")?
            .iter()
            .filter_map(|r| r["label"].as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let label = format!("Private overview page {} of {}. Rows top to bottom: {rows}. Each row has landscape left and portrait right, both uncropped. Use a detail crop to inspect fine type or edges.",receipt["page"],receipt["pageCount"]);
        (
            image::open(dir.path().join("overview.png"))?.to_rgb8(),
            label,
            85,
        )
    } else if let Some(detail) = receipt.get("detail") {
        let img = image::open(dir.path().join("detail.png"))?;
        let img = if img.width().max(img.height()) > 512 {
            img.thumbnail(512, 512)
        } else {
            img
        };
        (
            img.to_rgb8(),
            format!(
                "{} detail of {layout} at pixel bounds {}",
                detail["view"], detail["pixels"]
            ),
            84,
        )
    } else {
        (
            paired_picture(dir.path())?,
            format!("Private rehearsal of {layout}. Left is landscape. Right is portrait."),
            66,
        )
    };
    let mut jpg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, quality).encode_image(&picture)?;
    let images = vec![
        json!({"type":"input_text","text":label}),
        json!({"type":"input_image","image_url":format!("data:image/jpeg;base64,{}",STANDARD.encode(jpg)),"detail":if overview { "high" } else { "low" }}),
    ];
    Ok((receipt, images))
}

fn paired_picture(dir: &Path) -> Result<image::RgbImage> {
    let landscape = image::open(dir.join("landscape.png"))?.to_rgb8();
    let portrait = image::open(dir.join("portrait.png"))?.to_rgb8();
    let height = landscape.height().max(1);
    let portrait_width = (u64::from(portrait.width()) * u64::from(height)
        / u64::from(portrait.height().max(1)))
    .max(1) as u32;
    let portrait = image::imageops::resize(
        &portrait,
        portrait_width,
        height,
        image::imageops::FilterType::Triangle,
    );
    let mut pair = image::RgbImage::new(landscape.width() + 4 + portrait_width, height);
    image::imageops::replace(&mut pair, &landscape, 0, 0);
    image::imageops::replace(&mut pair, &portrait, i64::from(landscape.width()) + 4, 0);
    Ok(pair)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_requires_exclusive_mode_and_positive_page() {
        for args in [
            json!({"mode":"overview","layout":"host"}),
            json!({"mode":"overview","pass":"glow"}),
            json!({"mode":"overview","page":0}),
            json!({"mode":"unknown"}),
            json!({"mode":"overview","profileGpu":true}),
            json!({"mode":"overview","detail":{"view":"portrait","region":[0,0,1,1]}}),
            json!({"mode":"single","layout":"host","page":2}),
            json!({}),
        ] {
            let mut args = args;
            args["set"] = json!("desk");
            assert!(serde_json::from_value::<Query>(args)
                .map_err(anyhow::Error::from)
                .and_then(|q| q.validate())
                .is_err());
        }
        for args in [
            json!({"set":"desk","layout":"host"}),
            json!({"set":"desk","mode":"overview","page":2,"disconnected":true,"time":2.5}),
        ] {
            serde_json::from_value::<Query>(args)
                .unwrap()
                .validate()
                .unwrap();
        }
    }

    #[test]
    fn overview_preserves_six_images_in_separate_cells() {
        let dir = tempfile::tempdir().unwrap();
        let mut rows = Vec::new();
        for row in 0..LOOKS_PER_PAGE {
            let path = dir.path().join(row.to_string());
            std::fs::create_dir(&path).unwrap();
            for (name, w, h, tag) in [("landscape", 640, 360, 110), ("portrait", 360, 640, 210)] {
                image::RgbImage::from_pixel(w, h, image::Rgb([row as u8, tag, 0]))
                    .save(path.join(format!("{name}.png")))
                    .unwrap();
            }
            rows.push((row.to_string(), path));
        }
        let sheet = overview_picture(&rows).unwrap();
        assert_eq!(sheet.dimensions(), (851, 1096));
        for row in 0..LOOKS_PER_PAGE {
            let y = row as u32 * (SHEET_ROW_HEIGHT + SHEET_GUTTER) + 180;
            assert_eq!(sheet.get_pixel(320, y).0, [row as u8, 110, 0]);
            assert_eq!(sheet.get_pixel(750, y).0, [row as u8, 210, 0]);
            assert_eq!(sheet.get_pixel(644, y).0, [22, 26, 31]);
        }
        assert!(overview_picture(&[]).is_err());
        rows.push(rows[0].clone());
        assert!(overview_picture(&rows).is_err());
    }
}
