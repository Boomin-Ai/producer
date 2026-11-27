mod outbox;

use super::publish_options::{InstagramFormat, Options};
use super::*;
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Publish {
    pub(super) scope: Option<(String, String)>,
    channels: Vec<Channel>,
    jobs: Vec<Job>,
    selected: BTreeSet<String>,
    expanded: Option<String>,
    pub(super) options: BTreeMap<String, Options>,
    pub(super) caption: TextEdit,
    schedule: TextEdit,
    scheduled: bool,
    pub(super) files: Vec<PathBuf>,
    pasted_images: Vec<Arc<tempfile::NamedTempFile>>,
    thumbnails: BTreeMap<PathBuf, Thumbnail>,
    avatars: BTreeMap<String, Thumbnail>,
    awaiting_default: bool,
    clips_open: bool,
    accounts_open: bool,
    tab: PublishTab,
    pub(super) composing: bool,
    history: Option<super::publish_history::History>,
    history_worker: Option<mpsc::Receiver<Result<super::publish_history::History>>>,
    history_next: Option<Instant>,
    history_error: String,
    pub(super) limit: usize,
    pub(super) notice: String,
    sync_error: String,
    outbox: Vec<outbox::Post>,
    staging: Option<mpsc::Receiver<Result<outbox::Post>>>,
    delivering: Option<(String, mpsc::Receiver<Result<()>>)>,
    loading_outbox: Option<mpsc::Receiver<Result<Vec<outbox::Post>>>>,
    outbox_next: Option<Instant>,
    retry_id: Option<String>,
    delivery_errors: BTreeMap<String,String>,
    tab_menu: bool,
    job_menu: Option<String>,
    pending: bool,
    working: Option<mpsc::Receiver<Result<Done>>>,
    refreshing: Option<mpsc::Receiver<Result<Catalog>>>,
    next: Option<Instant>,
}
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum PublishTab {
    #[default]
    Overview,
    Local,
    Scheduled,
}

enum Thumbnail {
    Loading(mpsc::Receiver<Result<rune::Pixels>>),
    Ready(rune::Pixels),
    Failed(String),
}

fn thumbnail(path: &Path) -> Result<rune::Pixels> {
    use image::ImageDecoder;
    let mut decoder = image::ImageReader::open(path)?.into_decoder()?;
    let (width, height) = decoder.dimensions();
    ensure!(
        u64::from(width) * u64::from(height) <= 60_000_000,
        "Image exceeds preview size"
    );
    let orientation = decoder.orientation()?;
    let mut bitmap = image::DynamicImage::from_decoder(decoder)?.thumbnail(144, 144);
    bitmap.apply_orientation(orientation);
    let pixels = rune::Pixels::new();
    pixels.set(
        bitmap.width(),
        bitmap.height(),
        bitmap.to_rgba8().into_raw(),
    );
    Ok(pixels)
}

impl Publish {
    pub(super) fn set_files(&mut self, files: Vec<PathBuf>) {
        self.pasted_images.retain(|image| files.iter().any(|path| path == image.path()));
        self.thumbnails.retain(|path, _| files.contains(path));
        let mut pending = Vec::new();
        for path in &files {
            if !self.thumbnails.contains_key(path)
                && mime(path).is_ok_and(|m| m.starts_with("image/"))
            {
                let (send, receive) = mpsc::channel();
                self.thumbnails
                    .insert(path.clone(), Thumbnail::Loading(receive));
                pending.push((path.clone(), send));
            }
        }
        if !pending.is_empty() {
            std::thread::spawn(move || {
                for (path, send) in pending {
                    let _ = send.send(thumbnail(&path));
                }
            });
        }
        self.files = files;
    }

    pub(super) fn load_avatars(&mut self) {
        let mut urls = BTreeMap::new();
        if let Some(history) = &self.history {
            urls.extend(history.preview_urls(20 + self.limit).map(|url| (url.to_owned(), false)));
        }
        urls.extend(self.channels.iter().filter_map(|c| c.avatar_url.clone()).map(|url| (url, true)));
        self.avatars.retain(|url, _| urls.contains_key(url));
        let mut pending = Vec::new();
        for (url, square) in urls {
            if !self.avatars.contains_key(&url) {
                let (tx, rx) = mpsc::channel();
                self.avatars.insert(url.clone(), Thumbnail::Loading(rx));
                pending.push((url, square, tx));
            }
        }
        if pending.is_empty() { return; }
        std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return; };
            rt.block_on(async move {
                let mut tasks = tokio::task::JoinSet::new();
                for (url, square, tx) in pending {
                    if tasks.len() >= 4 { tasks.join_next().await; }
                    tasks.spawn(async move {
                        let result = if square { crate::boomin_account::avatar(&url).await }
                            else { crate::boomin_account::remote_image(&url, false).await };
                        let _ = tx.send(result.map(|image| {
                            let pixels = rune::Pixels::new();
                            pixels.set(image.width(), image.height(), image.into_raw());
                            pixels
                        }));
                    });
                }
                while tasks.join_next().await.is_some() {}
            });
        });
    }

    pub(super) fn downloaded_preview(&self, url: &str) -> Option<&rune::Pixels> {
        match self.avatars.get(url) {
            Some(Thumbnail::Ready(image)) => Some(image),
            _ => None,
        }
    }

    fn poll_thumbnails(&mut self) -> bool {
        let mut changed = false;
        for thumbnail in self.thumbnails.values_mut().chain(self.avatars.values_mut()) {
            if let Thumbnail::Loading(receive) = thumbnail {
                *thumbnail = match receive.try_recv() {
                    Ok(Ok(pixels)) => Thumbnail::Ready(pixels),
                    Ok(Err(error)) => Thumbnail::Failed(error.to_string()),
                    Err(mpsc::TryRecvError::Disconnected) => {
                        Thumbnail::Failed("Preview unavailable".into())
                    }
                    Err(mpsc::TryRecvError::Empty) => continue,
                };
                changed = true;
            }
        }
        changed
    }
}

#[derive(Deserialize)]
struct Channel {
    #[serde(default)]
    capabilities: Value,
    id: String,
    platform: String,
    avatar_url: Option<String>,
    display_name: Option<String>,
    external_handle: Option<String>,
    status: String,
}
impl Channel {
    fn label(&self) -> String {
        let name = self
            .external_handle
            .as_deref()
            .or(self.display_name.as_deref())
            .unwrap_or("");
        format!("{} · {}", platform(&self.platform), name)
            .trim_end_matches(" · ")
            .to_string()
    }
}
#[derive(Deserialize)]
struct Job {
    intent_id: Option<String>,
    #[serde(skip)]
    title: String,
    id: String,
    channel_id: String,
    state: String,
    due_at: String,
    error_message: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Submission {
    key: String,
    body: Value,
}
struct Catalog {
    channels: Vec<Channel>,
    jobs: Vec<Job>,
    pending: bool,
}
enum Done {
    Browser(String),
    Submitted(String),
    Updated,
    Disconnected(String),
}
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct ApiError {
    status: u16,
    message: String,
}

pub(super) struct Api {
    client: reqwest::Client,
    root: String,
    brand: String,
    token: String,
    receipt: PathBuf,
}

impl Api {
    fn lock_submission(&self) -> Result<fs::File> {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.receipt.with_extension("lock"))?;
        lock.try_lock()
            .context("Another studio is submitting this brand’s post")?;
        Ok(lock)
    }
    fn titles(&self) -> Result<std::collections::BTreeMap<String, String>> {
        match fs::read(self.receipt.with_extension("titles.json")) {
            Ok(data) => Ok(serde_json::from_slice(&data)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub(super) async fn call(
        &self,
        path: &str,
        body: Option<&Value>,
        key: Option<&str>,
        params: &[(&str, &str)],
    ) -> Result<Value> {
        let method = if body.is_some() { reqwest::Method::POST } else { reqwest::Method::GET };
        self.request(method, path, body, key, params).await
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        key: Option<&str>,
        params: &[(&str, &str)],
    ) -> Result<Value> {
        let url = if matches!(path, "files/get" | "channels/list" | "content/social-posts") {
            format!(
                "{}/{path}",
                self.root
                    .strip_suffix("/producer/v1")
                    .context("Invalid Boomin contract root")?
            )
        } else {
            format!("{}/{path}", self.root)
        };
        let mut req = self.client.request(method, url);
        if let Some(body) = body {
            req = req.json(body);
        }
        if let Some(key) = key {
            req = req.header("Idempotency-Key", key);
        }
        let response = req
            .query(&[("brandSlug", &self.brand)])
            .query(params)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| anyhow!("Could not reach Boomin"))?;
        let status = response.status();
        let data = response
            .json::<Value>()
            .await
            .context("Could not read Boomin’s response")?;
        if !status.is_success() {
            let message = data["error"]["message"]
                .as_str()
                .or(data["message"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Boomin returned {status}"));
            return Err(ApiError {
                status: status.as_u16(),
                message,
            }
            .into());
        }
        Ok(data)
    }
    async fn disconnect(&self, id: &str) -> Result<()> {
        let id = Uuid::parse_str(id).context("Invalid publishing account")?;
        let response = self.request(reqwest::Method::DELETE, &format!("channels/{id}"), None, None, &[]).await?;
        ensure!(response["ok"] == true, "Boomin could not confirm disconnection");
        Ok(())
    }

    async fn catalog(&self) -> Result<Catalog> {
        let (channels, mut page) = tokio::try_join!(
            self.call("channels", None, None, &[]),
            self.call("jobs", None, None, &[("limit", "200")])
        )?;
        let mut jobs = Vec::new();
        let mut previous = String::new();
        loop {
            jobs.extend(serde_json::from_value::<Vec<Job>>(page["jobs"].take())?);
            let Some(cursor) = page["next_cursor"].as_str() else {
                break;
            };
            ensure!(cursor != previous, "Invalid queue cursor");
            previous = cursor.to_owned();
            page = self
                .call(
                    "jobs",
                    None,
                    None,
                    &[("limit", "200"), ("cursor", &previous)],
                )
                .await?;
        }
        jobs.retain(|job| !matches!(job.state.as_str(), "published" | "canceled"));
        let titles = self.titles()?;
        for job in &mut jobs {
            if let Some(name) = job.intent_id.as_ref().and_then(|id| titles.get(id)) {
                job.title = name.clone();
            }
        }
        Ok(Catalog {
            channels: serde_json::from_value(channels["channels"].clone())?,
            jobs,
            pending: self.receipt.exists(),
        })
    }
    async fn media(&self, path: &Path) -> Result<String> {
        let mime = mime(path)?;
        let size = fs::metadata(path)?.len();
        ensure!(size > 0, "The selected file is empty");
        let upload=self.call("media/uploads",Some(&json!({"filename":path.file_name().and_then(|s|s.to_str()).context("Invalid filename")?,"content_type":mime,"size_bytes":size})),None,&[]).await?;
        let id = Uuid::parse_str(
            upload["upload_id"]
                .as_str()
                .context("Missing upload identifier")?,
        )?;
        let url = url::Url::parse(
            upload["put_url"]
                .as_str()
                .context("Missing upload destination")?,
        )?;
        ensure!(
            (url.scheme() == "https"
                || cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
                && !url.as_str().contains(['"', '\\']),
            "Invalid upload destination"
        );
        // Pass the signed URL privately and let curl stream the file from disk.
        let mut child = Command::new("/usr/bin/curl")
            .args([
                "--disable",
                "--globoff",
                "--fail",
                "--silent",
                "--max-time",
                "900",
                "--header",
                &format!("Content-Type: {mime}"),
                "--upload-file",
            ])
            .arg(path)
            .args(["--config", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        writeln!(
            child.stdin.take().context("Could not start upload")?,
            "url = \"{url}\""
        )?;
        ensure!(
            child.wait()?.success(),
            "Clip upload failed. Check your connection and try again."
        );
        for attempt in 0..6 {
            let media = self.call(&format!("media/{id}"), None, None, &[]).await?;
            if media["status"] == "stored" {
                return Ok(id.to_string());
            }
            if attempt < 5 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        bail!("Boomin could not confirm the clip upload")
    }
    async fn submit(&self, submission: &Submission) -> Result<Done> {
        let response = match self
            .call("posts", Some(&submission.body), Some(&submission.key), &[])
            .await
        {
            Ok(value) => value,
            Err(err) => {
                // These responses reject the request before a job is created.
                if err
                    .downcast_ref::<ApiError>()
                    .is_some_and(|e| matches!(e.status, 400 | 401 | 403 | 404 | 413 | 415 | 422))
                {
                    fs::remove_file(&self.receipt)?;
                }
                return Err(err);
            }
        };
        ensure!(
            response["job"]["id"].is_string(),
            "Boomin did not confirm the post"
        );
        fs::remove_file(&self.receipt)?;
        Ok(Done::Submitted(
            submission.body["channel_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        ))
    }
    async fn recover(&self) -> Result<Done> {
        let _lock = self.lock_submission()?;
        let submission: Submission = serde_json::from_slice(&fs::read(&self.receipt)?)?;
        let existing = self
            .call("jobs", None, None, &[("intent_id", &submission.key)])
            .await?;
        if existing["jobs"]
            .as_array()
            .context("Invalid queue response")?
            .iter()
            .any(|j| j["intent_id"] == submission.key)
        {
            fs::remove_file(&self.receipt)?;
            return Ok(Done::Submitted(
                submission.body["channel_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            ));
        }
        self.submit(&submission).await
    }
}
fn mime(path: &Path) -> Result<&'static str> {
    Ok(
        match path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "mp4" => "video/mp4",
            "mov" => "video/quicktime",
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            _ => bail!("Choose an MP4, MOV, JPEG, or PNG file"),
        },
    )
}
pub(super) fn platform(raw: &str) -> &str {
    match raw {
        "threads" => "Threads",
        "instagram" => "Instagram",
        other => other,
    }
}
fn schedule_utc(input: &str) -> Result<String> {
    let output = Command::new("/bin/date")
        .args([
            "-j",
            "-v0S",
            "-f",
            "%Y-%m-%d %H:%M",
            input,
            "+%Y-%m-%d %H:%M|%s",
        ])
        .output()?;
    let parsed = std::str::from_utf8(&output.stdout)?.trim();
    let (local, epoch) = parsed
        .split_once('|')
        .context("Enter a local date and time as YYYY-MM-DD HH:MM")?;
    ensure!(
        output.status.success() && local == input,
        "Enter a valid local date and time"
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    ensure!(epoch.parse::<u64>()? > now, "Choose a time in the future");
    let utc = Command::new("/bin/date")
        .args(["-u", "-r", epoch, "+%Y-%m-%dT%H:%M:%SZ"])
        .output()?;
    ensure!(utc.status.success(), "Invalid schedule");
    Ok(String::from_utf8(utc.stdout)?.trim().to_owned())
}
fn worker<T: Send + 'static>(
    s: &Studio,
    run: impl FnOnce(Api, tokio::runtime::Runtime) -> Result<T> + Send + 'static,
) -> mpsc::Receiver<Result<T>> {
    let (tx, rx) = mpsc::channel();
    let base = s.base.clone();
    let (brand, email) = s.publish.scope.clone().expect("Signed-in publisher");
    std::thread::spawn(move || {
        let result = (|| {
            let token = crate::boomin_account::room_token(&base, &brand)?;
            let dir = base.join("publish");
            fs::create_dir_all(&dir)?;
            let receipt = dir.join(format!(
                "{:x}.json",
                Sha256::digest(format!("{brand}\0{email}").as_bytes())
            ));
            let api = Api {
                client: crate::boomin_account::http()?,
                root: format!(
                    "{}/v1/app/producer/v1",
                    crate::boomin::DEFAULT_BOOMIN_API_ROOT
                ),
                brand,
                token,
                receipt,
            };
            run(
                api,
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?,
            )
        })();
        let _ = tx.send(result);
    });
    rx
}
fn start(
    s: &mut Studio,
    run: impl FnOnce(Api, tokio::runtime::Runtime) -> Result<Done> + Send + 'static,
) {
    if s.publish.scope.is_none() || s.publish.working.is_some() {
        return;
    }
    s.publish.notice.clear();
    s.publish.refreshing = None;
    s.publish.working = Some(worker(s, run));
}
fn submission_problem(p: &Publish) -> Option<String> {
    if p.selected.is_empty() {
        return Some("Choose an account.".into());
    }
    for id in &p.selected {
        let Some(c) = p
            .channels
            .iter()
            .find(|c| &c.id == id && c.status == "active")
        else {
            return Some("Reconnect the selected account.".into());
        };
        let options = p.options.get(id).cloned().unwrap_or_default();
        let file = p.files.first().map(PathBuf::as_path);
        if c.platform == "instagram" {
            let format = options.format(file);
            if let Some(message) = format.requirement(&p.files) {
                return Some(message.into());
            }
            if format == InstagramFormat::Story
                && !c.capabilities["media"]["kinds"]
                    .as_array()
                    .is_some_and(|k| k.iter().any(|v| v == "story"))
            {
                return Some("This Boomin server does not support Stories yet.".into());
            }
        }
        if p.files.len() as u64 > c.capabilities["media"]["max_items"].as_u64().unwrap_or(1) {
            return Some(format!("Too many attachments for {}.", c.label()));
        }
        if let Err(e) = options.payload(&c.platform, &p.caption.text, file) {
            return Some(e.to_string());
        }
    }
    None
}

fn outbox_dir(s: &Studio) -> PathBuf {
    let (brand, email) = s.publish.scope.as_ref().expect("Signed-in publisher");
    s.base.join("publish").join(format!(
        "{:x}.outbox",
        Sha256::digest(format!("{brand}\0{email}").as_bytes())
    ))
}

fn send(s: &mut Studio) {
    let p = &s.publish;
    if p.staging.is_some() || !p.composing || p.scope.is_none() {
        return;
    }
    if let Some(message) = submission_problem(p) {
        s.publish.notice = message;
        return;
    }
    let text = p.caption.text.trim().to_owned();
    let file = p.files.first().map(PathBuf::as_path);
    let mut targets = Vec::new();
    for c in p
        .channels
        .iter()
        .filter(|c| p.selected.contains(&c.id) && c.status == "active")
    {
        let options = p.options.get(&c.id).cloned().unwrap_or_default();
        let overrides = match options.payload(&c.platform, &text, file) {
            Ok(value) => value,
            Err(e) => {
                s.publish.notice = e.to_string();
                return;
            }
        };
        if c.capabilities["features"]["instagram_tagging_and_trial"] != true
            && (overrides["trial_post"] == true
                || overrides.get("userTags").is_some()
                || overrides.get("location").is_some())
        {
            s.publish.notice =
                "This account does not support the selected Instagram options.".into();
            return;
        }
        let format = (c.platform == "instagram").then(|| options.format(file));
        targets.push(outbox::Destination {
            id: c.id.clone(),
            label: c.label(),
            key: Uuid::new_v4().to_string(),
            overrides,
            format: format.map(|f| f.key().to_owned()),
            cover: if format == Some(InstagramFormat::Reel) {
                options.cover
            } else {
                None
            },
        });
    }
    if targets.is_empty() {
        return;
    }
    let schedule = p.scheduled.then(|| p.schedule.text.trim().to_owned());
    let mut post = outbox::Post {
        created_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        id: Uuid::new_v4().to_string(),
        text,
        files: p.files.clone(),
        schedule: None,
        targets,
        error: None,
    };
    let root = outbox_dir(s);
    let pasted = p.pasted_images.clone();
    let (tx, rx) = mpsc::channel();
    s.publish.staging = Some(rx);
    s.publish.composing = false;
    s.publish.tab = PublishTab::Scheduled;
    s.publish.tab_menu = false;
    std::thread::spawn(move || {
        let _keep_pasted_alive = pasted;
        let result = (|| {
            post.schedule = schedule.as_deref().map(schedule_utc).transpose()?;
            post.stage(&root)
        })();
        let _ = tx.send(result);
    });
}

fn poll_delivery(s: &mut Studio) -> bool {
    let root = outbox_dir(s);
    let p = &mut s.publish;
    let mut changed = false;
    if let Some(result) = p.loading_outbox.as_ref().and_then(|rx| rx.try_recv().ok()) {
        p.loading_outbox = None;
        match result {
            Ok(posts) => p.outbox = posts,
            Err(e) => p.notice = e.to_string(),
        }
        p.outbox_next = Some(Instant::now() + Duration::from_secs(10));
        changed = true;
    }
    if let Some(result) = p.staging.as_ref().and_then(|rx| rx.try_recv().ok()) {
        p.staging = None;
        match result {
            Ok(post) => {
                p.loading_outbox = None;
                p.outbox.retain(|old| old.id != post.id);
                p.outbox.push(post);
                p.set_files(Vec::new());
                p.scheduled = false;
                p.schedule = Default::default();
                p.caption = Default::default();
                p.options.clear();
                p.selected.clear();
                p.expanded = None;
                p.clips_open = false;
                p.notice.clear();
            }
            Err(e) => {
                p.notice = format!("Could not save the post locally. {e}");
                p.accounts_open = false;
                p.composing = true;
            }
        }
        changed = true;
    }
    if let Some(result) = p.delivering.as_ref().and_then(|(_, rx)| rx.try_recv().ok()) {
        let (id, _) = p.delivering.take().unwrap();
        if let Err(e) = result {
            p.delivery_errors.insert(id.clone(), e.to_string());
        }
        p.outbox.retain(|post| post.id != id);
        p.outbox_next = None;
        p.next = None;
        p.history_next = None;
        p.loading_outbox = None;
        changed = true;
    }
    if p.delivering.is_none()
        && p.loading_outbox.is_none()
        && p.outbox_next.is_none_or(|t| Instant::now() >= t)
    {
        let (tx, rx) = mpsc::channel();
        p.loading_outbox = Some(rx);
        let dir = root.clone();
        std::thread::spawn(move || {
            let _ = tx.send(outbox::list(&dir));
        });
    }
    if s.publish.delivering.is_none() && s.publish.loading_outbox.is_none() {
        let retry = s.publish.retry_id.take();
        let id = retry.clone().or_else(|| {
            s.publish
                .outbox
                .iter()
                .find(|post| {
                    post.error.is_none() && !s.publish.delivery_errors.contains_key(&post.id)
                })
                .map(|post| post.id.clone())
        });
        if let Some(id) = id {
            let dir = root.join(&id);
            s.publish.delivery_errors.remove(&id);
            let rx = worker(s, move |api, rt| {
                rt.block_on(outbox::deliver(&api, &dir, retry.is_some()))
            });
            s.publish.delivering = Some((id, rx));
            changed = true;
        }
    }
    changed
}

fn finish(p: &mut Publish, ids: Vec<String>, error: Option<String>) -> String {
    let count = ids.len();
    for id in ids {
        p.selected.remove(&id);
        p.options.remove(&id);
        if p.expanded.as_ref() == Some(&id) {
            p.expanded = None;
        }
    }
    if count > 0 {
        p.tab = PublishTab::Scheduled;
    }
    if let Some(error) = error {
        return if count == 0 {
            error
        } else {
            format!("{count} accepted. {error}")
        };
    }
    if p.selected.is_empty() {
        p.set_files(Vec::new());
        p.scheduled = false;
        p.clips_open = false;
        p.schedule = Default::default();
        p.caption = Default::default();
    }
    p.pending = false;
    p.composing = false;
    p.history_next = None;
    "Post accepted by Boomin".into()
}
pub(super) fn poll(s: &mut Studio) -> bool {
    let account = s
        .settings
        .account
        .as_ref()
        .map(|a| (a.login.brand.as_str(), a.email.as_str()));
    let mut changed = s.publish.poll_thumbnails();
    if account
        != s.publish
            .scope
            .as_ref()
            .map(|(brand, email)| (brand.as_str(), email.as_str()))
    {
        s.publish = Publish {
            scope: account.map(|(brand, email)| (brand.to_owned(), email.to_owned())),
            ..Default::default()
        };
        changed = true;
    }
    if s.publish.scope.is_none() {
        return changed;
    }
    changed |= poll_delivery(s);
    if let Some(result) = s
        .publish
        .refreshing
        .as_ref()
        .and_then(|rx| rx.try_recv().ok())
    {
        let p = &mut s.publish;
        p.refreshing = None;
        match result {
            Ok(data) => {
                p.pending = data.pending;
                p.channels = data.channels;
                p.load_avatars();
                select_default(p);
                p.jobs = data.jobs;
                p.sync_error.clear();
                p.selected.retain(|id| {
                    p.channels
                        .iter()
                        .any(|c| c.status == "active" && &c.id == id)
                });
            }
            Err(e) => p.sync_error = e.to_string(),
        }
        p.next = Some(
            Instant::now()
                + Duration::from_secs(if p.tab == PublishTab::Scheduled {
                    12
                } else {
                    30
                }),
        );
        changed = true;
    }
    if let Some(result) = s.publish.working.as_ref().and_then(|rx| rx.try_recv().ok()) {
        let p = &mut s.publish;
        p.working = None;
        p.refreshing = None;
        p.next = None;
        p.notice = match result {
            Ok(Done::Browser(url)) => match Command::new("/usr/bin/open").arg(url).spawn() {
                Ok(_) => "Finish connecting in your browser, then refresh accounts.".into(),
                Err(e) => e.to_string(),
            },
            Ok(Done::Submitted(id)) => finish(p, vec![id], None),
            Ok(Done::Updated) => "Queue updated".into(),
            Ok(Done::Disconnected(id)) => {
                p.channels.retain(|channel| channel.id != id);
                p.selected.remove(&id);
                if p.expanded.as_ref() == Some(&id) { p.expanded = None; }
                p.options.remove(&id);
                p.history_next = None;
                "Account disconnected".into()
            }
            Err(e) => e.to_string(),
        };
        changed = true;
    }
    let visible = s.page == Page::Studio
        && s.live
            .as_ref()
            .is_some_and(|l| l.snapshot.project.workspace.visible(PanelId::Publish));
    if let Some(result) = s
        .publish
        .history_worker
        .as_ref()
        .and_then(|rx| rx.try_recv().ok())
    {
        let p = &mut s.publish;
        p.history_worker = None;
        p.history_next =
            Some(Instant::now() + Duration::from_secs(if result.is_err() { 20 } else { 120 }));
        match result {
            Ok(data) => {
                p.history = Some(data);
                p.load_avatars();
                p.history_error.clear();
            }
            Err(e) => p.history_error = e.to_string(),
        }
        changed = true;
    }
    if visible
        && s.publish.tab == PublishTab::Overview
        && !s.publish.composing
        && s.publish.history_worker.is_none()
        && s.publish.history_next.is_none_or(|t| Instant::now() >= t)
    {
        s.publish.history_worker = Some(worker(s, |api, rt| {
            rt.block_on(super::publish_history::History::fetch(&api))
        }));
    }
    if visible
        && s.publish.working.is_none()
        && s.publish.refreshing.is_none()
        && s.publish.next.is_none_or(|t| Instant::now() >= t)
    {
        s.publish.refreshing = Some(worker(s, |api, rt| rt.block_on(api.catalog())));
        changed = true;
    }
    changed
}
fn connect(s: &mut Studio, provider: &'static str) {
    start(s, move |api, rt| {
        rt.block_on(async move {
            let response = api
                .call(
                    &format!("channels/{provider}/connect-session"),
                    Some(&json!({})),
                    None,
                    &[],
                )
                .await?;
            let url = url::Url::parse(
                response["browser_url"]
                    .as_str()
                    .context("Missing sign-in link")?,
            )?;
            ensure!(
                url.scheme() == "https"
                    && matches!(
                        url.host_str(),
                        Some(
                            "www.instagram.com"
                                | "api.instagram.com"
                                | "instagram.com"
                                | "www.threads.net"
                                | "www.threads.com"
                                | "threads.net"
                                | "threads.com"
                        )
                    ),
                "Unrecognized account connection link"
            );
            Ok(Done::Browser(url.to_string()))
        })
    });
}
fn subhead(label: &str) -> El {
    title(label, 12., 600., TEXT)
}
fn select_default(p: &mut Publish) {
    if p.awaiting_default {
        if let Some(c) = p
            .channels
            .iter()
            .find(|c| c.platform == "threads" && c.status == "active")
        {
            p.selected.insert(c.id.clone());
            p.expanded = Some(c.id.clone());
            p.awaiting_default = false;
        }
    }
}
pub(super) fn new_post(s: &mut Studio) {
    let p = &mut s.publish;
    if p.staging.is_some() { return; }
    p.composing = true;
    p.awaiting_default = p.selected.is_empty();
    select_default(p);
}
fn new_button(s: &Studio) -> El {
    row().key("publish-new").role("button").label("New post").focusable(true)
        .items_center().gap(5.).px(8.).h(28.).radius(6.)
        .fill(color(theme::TOOL_SELECTED)).hover_fill(color(theme::SELECTED_HOVER))
        .child(publish_icon("plus", 14., MINT))
        .child(title("New post", 11., 650., MINT))
        .on_press(new_post).disabled(s.publish.scope.is_none() || s.publish.staging.is_some())
}
pub(super) fn inline_composer(s: &Studio, wide: bool) -> El {
    let media = composer_media(s, col().gap(7.).min_w(0.), wide);
    let targets = destinations(s, col().gap(6.).min_w(0.));
    let targets = delivery_details(s, targets);
    let pane = |key, body: El| col().key(key).min_w(0.).min_h(0.).grow(1.)
        .child(body.w_full()).scroll(Default::default());
    let content = if wide {
        row().w_full().h(0.).grow(1.).min_h(0.).gap(10.)
            .child(pane("publish-media-pane", media).w(0.).h_full())
            .child(el().w(1.).h_full().fill(color(SURFACE)))
            .child(pane("publish-destination-pane", targets).w(0.).h_full())
    } else {
        pane("publish-compose-scroll", col().gap(8.).child(media).child(targets)).h(0.).w_full()
    };
    col()
        .key("publish-inline-composer").w_full().h(0.).grow(1.).min_h(0.)
        .gap(5.)
        .child(
            row().h(30.).gap(7.).items_center()
                .child(panels::tool("publish-close", "back", "Back to posts", false, |s| {
                    s.publish.composing = false;
                }).size(28., 28.))
                .child(el().size(27., 27.).radius(6.).center().fill(color(theme::TOOL_SELECTED))
                    .child(publish_icon("edit", 15., MINT)))
                .child(title("New post", 15., 650., TEXT)),
        )
        .child(content)
        .child(delivery(s, wide))
        .disabled(s.publish.staging.is_some())
}
pub(super) fn publish_icon(name: &str, size: f32, tint: u32) -> El {
    rune::icon(super::glyphs::glyph(name), size).color(color(tint))
}
fn media_label(icon: &str, label: &str) -> El {
    row().gap(5.).items_center()
        .child(publish_icon(icon, 14., MUTED))
        .child(title(label, 11., 550., TEXT))
}

fn append_media(existing: &[PathBuf], picked: Vec<PathBuf>) -> Result<Vec<PathBuf>> {
    let mut files = existing.to_vec();
    for path in picked {
        mime(&path)?;
        if !files.contains(&path) {
            files.push(path);
        }
    }
    ensure!(files.len() <= 10, "Choose up to 10 images per carousel");
    ensure!(
        files.len() <= 1 || files.iter().all(|path| mime(path).is_ok_and(|kind| kind.starts_with("image/"))),
        "Carousels use images. Remove the video to add images, or remove the images to add one video.",
    );
    Ok(files)
}

fn attach_paths(s: &mut Studio, paths: Vec<PathBuf>) {
    if s.publish.working.is_some() || s.publish.staging.is_some() { return; }
    match append_media(&s.publish.files, paths) {
        Ok(files) => { s.publish.set_files(files); s.publish.notice.clear(); }
        Err(error) => s.publish.notice = error.to_string(),
    }
}

fn composer_media(s: &Studio, mut b: El, wide: bool) -> El {
    let p = &s.publish;
    let busy = p.working.is_some() || p.staging.is_some();
    let threads = p.channels.iter().any(|channel| {
        channel.platform == "threads" && p.selected.contains(&channel.id)
    });
    let limit = if threads { 500 } else { 2200 };
    let count = p.caption.text.chars().count();
    b = b.on_drop_files(|s: &mut Studio, paths, _| {
        if s.publish.staging.is_none() && s.publish.working.is_none() { attach_paths(s, paths.to_vec()); }
    });
    b = b.child(col().w_full().radius(7.).clip_rounded(7.)
        .border(1., color(theme::TRANSPORT_BORDER)).fill(color(SURFACE))
        .child(field("Post caption", &p.caption, |s| &mut s.publish.caption)
            .h(if wide && !p.files.is_empty() { 31. } else if wide { 46. } else { 68. })
            .on_input_paste(|s: &mut Studio, content, _| {
                if !content.files().is_empty() {
                    attach_paths(s, content.files().to_vec());
                    return true;
                }
                let Some(image) = content.image() else { return false };
                let saved = (|| -> Result<_> {
                    let mut file = tempfile::Builder::new().suffix(".png").tempfile()?;
                    file.write_all(image.png())?;
                    Ok(file)
                })();
                match saved {
                    Ok(file) => {
                        let path = file.path().to_owned();
                        attach_paths(s, vec![path.clone()]);
                        if s.publish.files.contains(&path) { s.publish.pasted_images.push(Arc::new(file)); }
                    }
                    Err(error) => s.publish.notice = error.to_string(),
                }
                true
            })
            .placeholder("Write a caption…", color(MUTED))
            .disabled(busy))
        .child(row().px(8.).py(3.).justify_end()
            .child(title(format!("{count} / {limit}"), 10., 500.,
                if count > limit { 0xff8b89 } else { MUTED }))));
    let upload_label = if p.files.is_empty() { "Upload" } else { "Upload more" };
    let choose = el()
        .key("publish-file").role("button").label(upload_label)
        .help("Attach JPG, PNG, MP4, or MOV files")
        .focusable(true).h(28.).px(8.).center().radius(5.).fill(color(SURFACE))
        .border(1., color(theme::TRANSPORT_BORDER)).w(0.).grow(1.).min_w(0.)
        .hover_fill(color(theme::TOOL_SELECTED)).child(media_label("stage-in", upload_label))
        .on_press_tx(|s: &mut Studio, tx| {
            s.publish.clips_open = false;
            tx.open_files(
                rune::FileDialogOptions::default().filter("Media", &["png", "jpg", "jpeg", "mp4", "mov"]),
                |s: &mut Studio, result, _| match result {
                    Ok(Some(paths)) if !paths.is_empty() => {
                        match append_media(&s.publish.files, paths) {
                            Ok(files) => {
                                s.publish.set_files(files);
                                s.publish.notice.clear();
                            }
                            Err(error) => s.publish.notice = error.to_string(),
                        }
                    }
                    Err(error) => s.publish.notice = error.to_string(),
                    _ => {}
                },
            )
        });
    b = b.child(
        row().w_full().gap(5.).child(choose)
            .child(el().key("publish-clips").role("button").label("Saved clips")
                .focusable(true).focus_selected(p.clips_open).w(0.).grow(1.).min_w(0.)
                .h(28.).center().radius(5.).border(1., color(theme::TRANSPORT_BORDER))
                .fill(color(if p.clips_open { theme::TOOL_SELECTED } else { SURFACE }))
                .hover_fill(color(theme::TOOL_SELECTED)).child(media_label("clip", "Clips"))
                .on_press(|s: &mut Studio| s.publish.clips_open = !s.publish.clips_open))
            .disabled(busy),
    );
    if !p.files.is_empty() {
        let mut strip = row().gap(5.).flex_wrap();
        for (i, path) in p.files.iter().enumerate() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let mut tile = el().size(66., 48.).clip_rounded(4.).fill(color(SURFACE));
            tile = match p.thumbnails.get(path) {
                Some(Thumbnail::Ready(pixels)) => tile
                    .key(format!("publish-thumbnail-{i}"))
                    .role("img")
                    .label(format!("Image {}: {name}", i + 1))
                    .pixels_fit(pixels, SurfaceFit::Fit),
                Some(Thumbnail::Loading(_)) => {
                    tile.center().child(title("Loading…", 10., 450., MUTED))
                }
                Some(Thumbnail::Failed(error)) => tile
                    .center()
                    .child(title("No preview", 10., 450., MUTED))
                    .help(error),
                None => tile
                    .center()
                    .child(title(name.to_string(), 10., 450., TEXT)),
            };
            let remove = el()
                .absolute(47., 1.)
                .size(18., 18.)
                .center()
                .radius(9.)
                .fill(color(BG))
                .role("button")
                .focusable(true)
                .key(format!("publish-remove-{i}"))
                .label(format!("Remove {name}"))
                .help(format!("Remove {name}"))
                .child(title("×", 13., 650., TEXT))
                .on_press(move |s: &mut Studio| {
                    let path = s.publish.files.remove(i);
                    s.publish.thumbnails.remove(&path);

                })
                .disabled(busy);
            strip = strip.child(
                el().size(66., 48.)
                    .help(name.to_string())
                    .child(tile)
                    .child(remove),
            );
        }
        b = b.child(strip);
    }
    if p.clips_open {
        let recent = s.live.as_ref().and_then(|l| l.clip_view.as_ref())
            .map(|(status, _)| status.recent.as_slice()).unwrap_or_default();
        if recent.is_empty() {
            b = b.child(title("No saved clips in this studio", 11., 450., MUTED));
        }
        for clip in recent {
            for file in &clip.files {
                let path = file.path.clone();
                b = b.child(
                    button(
                        format!("publish-clip-{}-{}", clip.id, file.output.label()),
                        format!("{} · {}", clip.name, file.output.label()),
                        p.files.first() == Some(&path),
                        move |s| {
                            s.publish.set_files(vec![path.clone()]);
                            s.publish.clips_open = false;
                        },
                    )
                    .disabled(busy),
                );
            }
        }
    }
    b
}

pub(super) fn channel_avatar(s: &Studio, id: &str, provider: &str, name: &str) -> El {
    let url = s.publish.channels.iter().find(|c| c.id == id).and_then(|c| c.avatar_url.as_ref());
    avatar_badge(s, provider, name, url)
}
fn account_avatar(s: &Studio, channel: &Channel) -> El {
    let name = channel.external_handle.as_deref().or(channel.display_name.as_deref()).unwrap_or("?");
    avatar_badge(s, &channel.platform, name, channel.avatar_url.as_ref())
}
fn avatar_badge(s: &Studio, provider: &str, name: &str, url: Option<&String>) -> El {
    let mut face = el().size(24., 24.).clip_rounded(12.).radius(12.).center().fill(color(theme::AVATAR));
    face = match url.and_then(|u| s.publish.avatars.get(u)) {
        Some(Thumbnail::Ready(image)) => face.pixels_fit(image, SurfaceFit::Fill),
        _ => face.child(title(name.trim_start_matches('@').chars().next().unwrap_or('?').to_uppercase().to_string(), 11., 600., TEXT)),
    };
    el().size(30., 27.).child(face).child(el().absolute(16., 12.).size(14., 14.).center().radius(7.).fill(color(BG))
        .child(title(if provider == "instagram" { "📷" } else { "🧵" }, 10., 450., TEXT)))
}

fn destinations(s: &Studio, mut b: El) -> El {
    let p = &s.publish;
    let busy = p.working.is_some() || p.staging.is_some();
    b = b.child(row().gap(6.).items_center()
        .child(publish_icon("channels", 15., MUTED))
        .child(subhead("Publish to")));
    let mut has_accounts = false;
    for channel in p.channels.iter().filter(|channel| {
        channel.status == "active" && matches!(channel.platform.as_str(), "threads" | "instagram")
    }) {
        has_accounts = true;
        b = b.child(destination_card(s, channel).disabled(busy));
    }
    if !has_accounts {
        b = b.child(button("publish-connect-account", "Connect account…", false, open_accounts).disabled(busy));
    }
    if p.pending {
        b = b.child(
            button(
                "publish-recover",
                "Check and retry previous submission",
                false,
                |s| start(s, |api, rt| rt.block_on(api.recover())),
            )
            .disabled(busy),
        );
    }
    for msg in [&p.notice, &p.sync_error] {
        if !msg.is_empty() {
            b = b.child(
                text(msg.clone())
                    .font(TextStyle::new(11., 450.))
                    .color(color(MUTED)),
            );
        }
    }
    b
}
fn destination_card(s: &Studio, channel: &Channel) -> El {
    let p = &s.publish;
    let id = channel.id.clone();
    let active = p.selected.contains(&id);
    let open = p.expanded.as_ref() == Some(&id);
    let disclosure_id = id.clone();
    let provider = platform(&channel.platform);
    let name = channel.external_handle.as_deref().or(channel.display_name.as_deref()).unwrap_or(provider);
    let disclosure = el().key(format!("publish-options-{id}")).role("button").focusable(true)
        .label(format!("{} options for {}", if open { "Hide" } else { "Show" }, channel.label()))
        .size(24., 26.).center().radius(5.).hover_fill(color(theme::SELECTED_HOVER))
        .child(publish_icon(if open { "chevron-up" } else { "chevron-down" }, 13., MUTED))
        .on_press(move |s: &mut Studio| {
            s.publish.expanded = (s.publish.expanded.as_ref() != Some(&disclosure_id)).then(|| disclosure_id.clone());
        });
    let track = row().w(24.).h(14.).px(2.).items_center();
    let track = if active { track.justify_end() } else { track.justify_start() };
    let switch = row().key(format!("publish-channel-{id}")).role("button")
        .label(format!("{} · {}", channel.label(), if active { "Selected" } else { "Unselected" }))
        .focusable(true).focus_selected(active).items_center().gap(7.).min_w(0.).h(32.).grow(1.)
        .child(account_avatar(s, channel))
        .child(col().min_w(0.).grow(1.)
            .child(title(provider, 12., 650., TEXT))
            .child(title(name, 10., 500., MUTED)))
        .child(track
            .radius(7.).fill(color(if active { MINT } else { theme::TRANSPORT_BORDER }))
            .child(el().size(10., 10.).radius(5.).fill(color(if active { BG } else { MUTED }))))
        .on_press(move |s: &mut Studio| {
            let p = &mut s.publish;
            p.awaiting_default = false;
            if p.selected.remove(&id) {
                if p.expanded.as_ref() == Some(&id) { p.expanded = None; }
            } else {
                p.selected.insert(id.clone());
                p.expanded = Some(id.clone());
            }
        });
    let mut card = col().w_full().min_w(0.).px(6.).py(3.).gap(4.).radius(7.)
        .fill(color(if active { theme::TOOL_SELECTED } else { SURFACE }))
        .border(1., color(if active { theme::SELECTED_HOVER } else { theme::TRANSPORT_BORDER }))
        .child(row().w_full().gap(4.).items_center().child(switch).child(disclosure));
    if open {
        card = card.child(el().w_full().h(1.).fill(color(theme::TRANSPORT_BORDER)));
        if channel.platform == "instagram" {
            let current = p.options.get(&channel.id).cloned().unwrap_or_default()
                .format(p.files.first().map(PathBuf::as_path));
            let mut formats = row().gap(4.).flex_wrap().label("Instagram format");
            for (label, format) in [("Post", InstagramFormat::Post), ("Story", InstagramFormat::Story), ("Reel", InstagramFormat::Reel)] {
                let id = channel.id.clone();
                formats = formats.child(button(format!("publish-{id}-{}", format.key()), label, current == format, move |s| {
                    s.publish.options.entry(id.clone()).or_default().format = Some(format);
                }).h(24.));
            }
            card = card.child(formats);
        }
        card = card.child(super::publish_options::controls(s, &channel.id, &channel.platform));
    }
    card
}

fn delivery_details(s: &Studio, mut b: El) -> El {
    let p = &s.publish;
    let busy = p.working.is_some() || p.staging.is_some();
    if p.scheduled {
        b = b
            .child(title("Local time · YYYY-MM-DD HH:MM", 11., 450., MUTED))
            .child(field("Schedule time", &p.schedule, |s| &mut s.publish.schedule).disabled(busy));
    }
    b
}
fn delivery(s: &Studio, wide: bool) -> El {
    let p = &s.publish;
    let busy = p.working.is_some() || p.staging.is_some();
    let invalid = submission_problem(p).is_some();
    let schedule_disabled = busy || (!p.scheduled && invalid);
    let disabled = busy || invalid || p.pending || p.scheduled && p.schedule.text.trim().is_empty();
    let mut actions = row().w_full().gap(5.).items_center()
        .child(button("publish-later-mode", if p.scheduled { "Cancel" } else { "Schedule…" }, false,
            |s| s.publish.scheduled = !s.publish.scheduled)
            .opacity(if schedule_disabled { 0.45 } else { 1. }).disabled(schedule_disabled));
    let hint = submission_problem(p);
    if wide {
        actions = actions.child(hint.as_ref().map_or_else(|| el().grow(1.), |hint| {
            title(hint, 11., 450., MUTED).grow(1.).min_w(0.).help(hint)
        }));
    } else {
        actions = actions.child(el().grow(1.));
    }
    let label = if p.staging.is_some() { "Saving…" } else if busy { "Working…" } else if p.scheduled { "Schedule post" } else { "Publish now" };
    actions = actions.child(row().key("publish-submit").role("button").label(label)
        .focusable(true).h(30.).px(10.).gap(5.).items_center().radius(6.)
        .fill(color(if disabled { SURFACE } else { MINT }))
        .opacity(if disabled { 0.5 } else { 1. })
        .child(publish_icon("send", 14., if disabled { MUTED } else { BG }))
        .child(title(label, 11., 650., if disabled { MUTED } else { BG }))
        .on_press(send).disabled(disabled));
    let mut footer = col().gap(4.).child(el().h(1.).w_full().fill(color(SURFACE)));
    if !wide {
        if let Some(hint) = hint { footer = footer.child(title(&hint, 11., 450., MUTED)); }
    }
    footer.child(actions)
}
fn accounts(s: &Studio) -> El {
    let p = &s.publish;
    let busy = p.working.is_some() || p.refreshing.is_some();
    let mut panel = col().w_full().gap(7.).child(
        row().items_center().gap(7.)
            .child(panels::tool("publish-accounts-back", "back", "Back to Publish", false, |s| {
                s.publish.accounts_open = false;
            }).size(28., 28.))
            .child(title("Publishing accounts", 14., 650., TEXT).grow(1.))
            .child(panels::tool("publish-refresh", "restart", "Refresh accounts", false, |s| {
                s.publish.next = None;
            }).size(28., 28.).disabled(busy)),
    );
    for provider in ["threads", "instagram"] {
        let mut channels = p.channels.iter().filter(|channel| channel.platform == provider).peekable();
        if channels.peek().is_none() {
            panel = panel.child(manage_account(s, provider, None, busy));
        }
        for channel in channels {
            panel = panel.child(manage_account(s, provider, Some(channel), busy));
        }
    }
    for message in [&p.notice, &p.sync_error].into_iter().filter(|s| !s.is_empty()) {
        panel = panel.child(text(message.clone()).font(TextStyle::new(11., 450.)).color(color(MUTED)));
    }
    panel
}

fn manage_account(s: &Studio, provider: &'static str, channel: Option<&Channel>, busy: bool) -> El {
    let platform_name = platform(provider);
    let status = match channel.map(|channel| channel.status.as_str()) {
        Some("active") => "Connected",
        Some(_) => "Connection expired",
        None => "Add account",
    };
    let (name, icon) = if let Some(channel) = channel {
        let name = channel.external_handle.as_deref()
            .or(channel.display_name.as_deref()).unwrap_or(platform_name);
        (name, account_avatar(s, channel))
    } else {
        (platform_name, avatar_badge(s, provider, platform_name, None))
    };
    let action = if let Some(channel) = channel {
        let id = channel.id.clone();
        let anchor = format!("publish-disconnect-{id}");
        let menu_anchor = anchor.clone();
        let label = format!("Disconnect {platform_name}");
        button(anchor, "Disconnect…", false, |_| {})
            .help(&label)
            .on_press_tx(move |_: &mut Studio, tx| {
                let id = id.clone();
                tx.popup_menu(
                    rune::PopupMenu::new().item(rune::PopupItem::new("disconnect", &label)),
                    menu_anchor.clone(),
                    move |s: &mut Studio, pick, _| {
                        if pick == Some("disconnect") {
                            start(s, move |api, rt| {
                                rt.block_on(api.disconnect(&id))?;
                                Ok(Done::Disconnected(id))
                            });
                        }
                    },
                );
            })
    } else {
        button(format!("publish-connect-{provider}"), "Connect", true, move |s| connect(s, provider))
    };
    row().w_full().min_w(0.).items_center().gap(6.).padding(7.).radius(7.)
        .fill(color(SURFACE)).border(1., color(theme::TRANSPORT_BORDER))
        .child(icon)
        .child(col().min_w(0.).grow(1.).gap(2.)
            .child(title(platform_name, 11., 650., TEXT))
            .child(title(name, 10., 450., MUTED))
            .child(row().gap(4.).items_center()
                .child(el().size(5., 5.).radius(2.5)
                    .fill(color(match status { "Connected" => MINT, "Connection expired" => 0xe8b268, _ => MUTED })))
                .child(title(status, 9., 500., MUTED))))
        .child(action.fill(color(theme::TOOL)).disabled(busy))

}
fn open_accounts(s: &mut Studio) {
    s.publish.accounts_open = true;
    s.publish.composing = false;
}

pub(super) fn header_actions(s: &Studio, split: bool) -> Option<El> {
    let signed = s.publish.scope.is_some();
    if !signed || s.publish.accounts_open || split { return None; }
    Some(row().items_center().gap(3.).child(accounts_tool())
        .child(panels::tool("publish-new", "plus", "New post", true, new_post).size(27., 27.).disabled(s.publish.staging.is_some())))
}
pub(super) fn panel(s: &Studio, mut b: El, split: bool, hidden_header: bool) -> El {
    let p = &s.publish;
    let signed = p.scope.is_some();
    if signed && p.accounts_open {
        let content = b.child(accounts(s));
        return if split {
            col().h_full().child(content).scroll(Default::default())
        } else {
            content
        };
    }
    b = b.gap(7.);
    let queued = s.live.as_ref().and_then(|l| l.clip_view.as_ref())
        .map(|(_, queued)| queued.as_slice()).unwrap_or_default();
    if !signed {
        b = b.child(super::settings::panel_account(s, PanelId::Publish));
        return local_list(s, b.child(subhead("Local clip queue")), queued);
    }
    let tab = |key: &str, name: String, selected, action: fn(&mut Studio)| button(key.to_owned(), name, selected, action).px(6.).h(25.);
    let narrow = !split && s.live.as_ref().is_none_or(|live| {
        let workspace = &live.snapshot.project.workspace;
        let edge = workspace.panels[&PanelId::Publish].edge;
        !edge.side() || workspace.docks[&edge].size < 265.
    });
    let delivery_count = p.jobs.len() + p.outbox.len() + usize::from(p.staging.is_some());
    let tabs = row()
            .gap(3.)
            .child(tab(
                "publish-overview",
                "Overview".into(),
                p.tab == PublishTab::Overview,
                |s| {
                    s.publish.tab = PublishTab::Overview;
                    s.publish.composing = false;
                },
            ))
            .child(tab(
                "publish-local",
                format!("Local · {}", queued.len()),
                p.tab == PublishTab::Local,
                |s| {
                    s.publish.tab = PublishTab::Local;
                    s.publish.composing = false;
                },
            ))
            .child(tab(
                "publish-queue",
                format!("Scheduled · {delivery_count}"),
                p.tab == PublishTab::Scheduled,
                |s| {
                    s.publish.tab = PublishTab::Scheduled;
                    s.publish.composing = false;
                    s.publish.next = None;
                },
            ));
    if hidden_header && !split {
        b = b.child(row().w_full().items_center().child(new_button(s))
            .child(el().grow(1.)).child(accounts_tool()));
    }
    if narrow {
        let name = match p.tab {
            PublishTab::Overview => "Overview".into(),
            PublishTab::Local => format!("Local · {}", queued.len()),
            PublishTab::Scheduled => format!("Scheduled · {delivery_count}"),
        };
        b = b.child(button("publish-view-menu", format!("{name}  ▾"), true, |s| s.publish.tab_menu = !s.publish.tab_menu)
            .self_start().label("Choose Publish view"));
        if p.tab_menu {
            for (key, label, view) in [("overview","Overview",PublishTab::Overview),("local","Local clips",PublishTab::Local),("queue","Scheduled",PublishTab::Scheduled)] {
                b=b.child(button(format!("publish-{key}"),label,p.tab==view,move|s|{
                    s.publish.tab=view; s.publish.tab_menu=false; s.publish.next=None;
                }).h(24.));
            }
        }
    } else {
        b = b.child(tabs);
    }
    if !p.notice.is_empty() {
        b = b.child(title(&p.notice, 11., 500., MUTED).help(&p.notice));
    }
    if let Some(h) = &p.history {
        if split || p.tab == PublishTab::Overview {
            b = h.metrics(s, b);
        }
    }
    if split {
        let pane = |key: &str, content: El| {
            col()
                .key(key.to_owned())
                .w(0.)
                .grow(1.)
                .min_w(0.)
                .min_h(0.)
                .h_full()
                .child(content.w_full())
                .scroll(Default::default())
        };
        row()
            .key("publish-columns")
            .gap(8.)
            .w_full()
            .h(0.)
            .grow(1.)
            .min_h(0.)
            .child(pane("publish-summary-column", b))
            .child(el().w(1.).h_full().fill(color(SURFACE)))
            .child(pane(
                "publish-posts-column",
                post_list(s, queued, col().min_w(0.).gap(4.), true, hidden_header),
            ))
    } else {
        post_list(s, queued, b, false, hidden_header)
    }
}
fn local_list(s: &Studio, mut b: El, queued: &[crate::clips::Saved]) -> El {
    if queued.is_empty() {
        return b.child(title(
            "Enable “Add saved clips to local queue” in Clips settings to collect clips here.",
            12.,
            450.,
            MUTED,
        ));
    }
    b = b.child(title(
        "On this device until you schedule or publish.",
        11.,
        450.,
        MUTED,
    ));
    for clip in queued.iter().take(20 + s.publish.limit) {
        let id = clip.id;
        let mut actions = row().flex_wrap().gap(4.);
        for file in &clip.files {
            let path = file.path.clone();
            actions = actions.child(
                button(
                    format!("publish-local-compose-{id}-{}", file.output.label()),
                    format!("Use {}", file.output.label()),
                    false,
                    move |s| {
                        s.publish.set_files(vec![path.clone()]);
                        s.publish.notice.clear();
                        new_post(s);
                    },
                )
                .disabled(s.publish.scope.is_none() || s.publish.working.is_some()),
            );
        }
        actions = actions.child(
            button(
                format!("publish-local-remove-{id}"),
                "Remove",
                false,
                move |s| {
                    if let Some(live) = &s.live {
                        let handle = live.handle.clone();
                        s.room_task(move |_| {
                            let clips = handle.media.lock().unwrap().as_ref()
                                .map(|media| media.clips.clone()).context("Studio media unavailable")?;
                            clips.remove_from_local_queue(id)?;
                            Ok(String::new())
                        });
                    }
                },
            )
            .help("Remove from the local queue and keep the saved clip"),
        );
        b = b.child(
            col()
                .gap(3.)
                .padding(7.)
                .radius(5.)
                .fill(color(SURFACE))
                .child(subhead(&clip.name))
                .child(actions),
        );
    }
    if queued.len() > 20 + s.publish.limit {
        b = b.child(button(
            "publish-local-more",
            "Show more clips",
            false,
            |s| s.publish.limit += 20,
        ));
    }
    b
}

fn accounts_tool() -> El {
    panels::tool("publish-accounts", "settings", "Publishing accounts", false, open_accounts)
        .size(28., 28.)
}

fn local_date(input: &str) -> String {
    // Boomin returns UTC timestamps, optionally with fractional seconds.
    if !(input.ends_with('Z') || input.ends_with("+00:00")) { return input.into(); }
    let Some(stamp)=input.get(..19).and_then(|s|std::ffi::CString::new(s).ok()) else { return input.into() };
    let mut utc: libc::tm = unsafe { std::mem::zeroed() };
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    let mut buffer=[0i8;64];
    unsafe {
        if libc::strptime(stamp.as_ptr(), c"%Y-%m-%dT%H:%M:%S".as_ptr(), &mut utc).is_null(){return input.into();}
        let epoch=libc::timegm(&mut utc);
        if libc::localtime_r(&epoch,&mut local).is_null(){return input.into();}
        if libc::strftime(buffer.as_mut_ptr(),buffer.len(),c"%b %e · %H:%M %Z".as_ptr(),&local)==0{return input.into();}
        std::ffi::CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned()
    }
}

fn post_list(s: &Studio, queued: &[crate::clips::Saved], mut b: El, split: bool, hidden_header: bool) -> El {
    let mut heading = row().key("publish-list-heading").w_full().items_center().gap(4.)
        .child(subhead(match s.publish.tab {
            PublishTab::Overview => "Published timeline",
            PublishTab::Local => "Local clips",
            PublishTab::Scheduled => "Scheduled posts",
        }).min_w(0.).grow(1.));
    if split {
        if hidden_header { heading = heading.child(accounts_tool()); }
        heading = heading.child(new_button(s));
    }
    b = b.child(heading);
    if s.publish.tab == PublishTab::Local {
        return local_list(s, b, queued);
    }
    let p = &s.publish;
    let signed = p.scope.is_some();
    let busy = p.working.is_some() || p.staging.is_some();
    if p.tab == PublishTab::Overview {
        if !p.history_error.is_empty() {
            b = b
                .child(title(&p.history_error, 11., 500., MUTED))
                .child(button("publish-reload", "Retry history", false, |s| {
                    s.publish.history_next = None
                }));
        }
        return if let Some(history) = &p.history {
            history.timeline(s, b, 20 + p.limit)
        } else if p.history_error.is_empty() {
            b.child(title("Loading published posts…", 12., 450., MUTED))
        } else {
            b
        };
    }
    if !p.sync_error.is_empty() {
        b = b.child(title(&p.sync_error, 11., 500., MUTED));
    }
    {
        if p.staging.is_some() {
            let caption = p.caption.text.trim();
            let title = if caption.is_empty() { "Media post" } else { caption };
            b = b.child(col().key("publish-saving-post").padding(7.).gap(3.).radius(5.)
                .fill(color(SURFACE)).child(subhead(title))
                .child(super::title("Saving on this device…", 10., 500., MUTED)));
        }
        for post in &p.outbox {
            let error=post.error.as_ref().or_else(|| p.delivery_errors.get(&post.id));
            let state=if error.is_some() {"Needs attention"} else if post.schedule.is_some() {"Scheduling…"} else {"Sending…"};
            let mut card=col().w_full().min_w(0.).padding(7.).gap(3.).radius(5.).fill(color(SURFACE))
                .child(subhead(&post.title()))
                .child(title(state,10.,600.,if error.is_some(){ MUTED }else{ MINT }))
                .child(title(post.targets.iter().map(|t| t.label.as_str()).collect::<Vec<_>>().join(" · "),10.,500.,MUTED));
            if let Some(message)=error{
                let id=post.id.clone();
                card=card.child(title(message,10.,500.,MUTED).help(message))
                    .child(button(format!("retry-delivery-{id}"),"Retry",false,move |s|s.publish.retry_id=Some(id.clone())).self_start());
            }
            b=b.child(card);
        }
        if p.jobs.is_empty() && p.outbox.is_empty() && p.staging.is_none() {
            b = b.child(title(
                if !signed {
                    "Sign in to view your queue"
                } else if p.refreshing.is_some() {
                    "Loading queue…"
                } else if !p.sync_error.is_empty() {
                    "Queue unavailable"
                } else {
                    "No posts queued"
                },
                11.,
                450.,
                MUTED,
            ));
        }
        for job in &p.jobs {
            let name = p
                .channels
                .iter()
                .find(|c| c.id == job.channel_id)
                .map(Channel::label)
                .unwrap_or_else(|| "Disconnected account".into());
            let mut card = col()
                .gap(3.)
                .padding(7.)
                .radius(5.)
                .fill(color(SURFACE))
                .child(subhead(if job.title.is_empty() {
                    &name
                } else {
                    &job.title
                }))
                .child(title(
                    format!("{} · {}", job.state, local_date(&job.due_at)),
                    11.,
                    450.,
                    MUTED,
                ));
            if !job.title.is_empty() {
                card = card.child(title(name, 11., 450., MUTED));
            }
            if let Some(msg) = &job.error_message {
                card = card.child(
                    text(msg.clone())
                        .font(TextStyle::new(11., 450.))
                        .color(color(MUTED)),
                );
            }
            let action = match job.state.as_str() {
                "scheduled" | "queued" => Some(("cancel", "Cancel")),
                "failed" => Some(("retry", "Retry")),
                _ => None,
            };
            if let Some((op, label)) = action {
                let id = job.id.clone();
                let menu = id.clone();
                card=card.child(panels::tool(&format!("publish-job-menu-{id}"),"more","Post actions",p.job_menu.as_ref()==Some(&id),move|s|{
                    s.publish.job_menu=if s.publish.job_menu.as_ref()==Some(&menu){None}else{Some(menu.clone())};
                }).size(24.,20.).self_start());
                if p.job_menu.as_ref()==Some(&id) { card = card.child(
                    button(format!("publish-{op}-{id}"), label, false, move |s| {
                        let id = id.clone();
                        start(s, move |api, rt| {
                            rt.block_on(async move {
                                api.call(&format!("jobs/{id}/{op}"), Some(&json!({})), None, &[])
                                    .await?;
                                Ok(Done::Updated)
                            })
                        });
                    })
                    .disabled(busy),
                ); }
            }
            b = b.child(card);
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read},
        net::TcpListener,
        sync::Mutex,
    };

    #[test]
    fn full_dock_draft_selects_accounts_and_previews_images() {
        let scratch = tempfile::tempdir().unwrap();
        let mut studio = Studio::new(scratch.path().into());
        studio.publish.scope = Some(("studio".into(), "test".into()));
        studio.publish.channels = serde_json::from_value(json!([
            {"id":"t","platform":"threads","status":"active"},
            {"id":"i","platform":"instagram","status":"active"}
        ]))
        .unwrap();
        let mut rt = rune::Runtime::new(
            studio,
            |s, _| col().w_full().h_full().child(if s.publish.composing { inline_composer(s, true) } else { panel(s, col(), true, true) }),
            (1360., 192.),
            rune::Env::default(),
        );
        rt.frame(0.);
        let (x, y) = rt.find("publish-new").unwrap();
        assert!(x > 1000.);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert!(rt.state.publish.selected.contains("t"));
        assert!(rt.find("publish-inline-composer").is_some());
        assert!(rt.find("publish-dialog").is_none());
        assert!(rt.find("publish-channel-i").is_some());
        assert!(rt.find("publish-columns").is_none());
        let (x, y) = rt.find("publish-clips").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.03);
        assert!(rt.state.publish.clips_open);
        let (x, y) = rt.find("publish-file").unwrap();
        assert!(x < 680. && y < 192.);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.04);
        assert!(rt.file_dialog_multiple());
        assert!(!rt.state.publish.clips_open);
        let files = vec![
            scratch.path().join("first.jpg"),
            scratch.path().join("second.png"),
        ];
        for (file, rgb) in files.iter().zip([[240u8, 20, 20], [20, 200, 20]]) {
            image::RgbImage::from_pixel(240, 120, image::Rgb(rgb))
                .save(file)
                .unwrap();
        }
        rt.resolve_file_dialog_files(Some(vec![files[0].clone()])).unwrap();
        rt.frame(0.05);
        let (x, y) = rt.find("publish-file").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.055);
        rt.resolve_file_dialog_files(Some(vec![files[1].clone()])).unwrap();
        rt.frame(0.06);
        assert_eq!(rt.state.publish.files, files);
        assert!(append_media(&files, vec!["clip.mov".into()]).is_err());
        let deadline = Instant::now() + Duration::from_secs(5);
        while rt
            .state
            .publish
            .thumbnails
            .values()
            .any(|v| matches!(v, Thumbnail::Loading(_)))
        {
            assert!(Instant::now() < deadline);
            rt.state.publish.poll_thumbnails();
            std::thread::sleep(Duration::from_millis(2));
        }
        for (i, path) in files.iter().enumerate() {
            let Thumbnail::Ready(pixels) = &rt.state.publish.thumbnails[path] else {
                panic!("Thumbnail {i} failed");
            };
            assert_eq!(pixels.size(), (144, 72));
            assert!(pixels.with_rgba(|_, _, bytes| bytes[i] > 180).unwrap());
        }
        rt.invalidate();
        rt.frame(0.08);
        assert!(rt.find("publish-thumbnail-0").is_some());
        assert!(rt.find("publish-thumbnail-1").is_some());
        assert!(rt.find("publish-channel-i").is_some());
        assert!(!rt.state.publish.selected.contains("i"));
        let (x, y) = rt.find("publish-remove-0").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.1);
        assert_eq!(rt.state.publish.files, files[1..]);
        assert!(!rt.state.publish.thumbnails.contains_key(&files[0]));
        assert!(rt.find("publish-thumbnail-0").is_some());
        assert!(rt.find("publish-thumbnail-1").is_none());
    }

    #[test]
    fn compact_queue_and_composer_handle_native_paste_and_drop() {
        const W: u32 = 246;
        const H: u32 = 650;
        let scratch = tempfile::tempdir().unwrap();
        let mut studio = Studio::new(scratch.path().into());
        studio.publish.scope = Some(("studio".into(), "test".into()));
        studio.publish.channels = serde_json::from_value(json!([
            {"id":"t", "platform":"threads", "status":"active", "display_name":"Useful Information"}
        ]))
        .unwrap();
        studio.publish.jobs = serde_json::from_value(json!([
            {"id":"job", "channel_id":"t", "state":"scheduled", "due_at":"2099-12-01T18:00:00Z"}
        ]))
        .unwrap();
        studio.publish.jobs[0].title = "The next episode".into();
        studio.publish.tab = PublishTab::Scheduled;
        let mut rt = rune::Runtime::new(
            studio,
            |s, _| {
                let body = if s.publish.composing {
                    inline_composer(s, false)
                } else {
                    col()
                        .gap(6.)
                        .child(
                            row()
                                .items_center()
                                .child(subhead("Publish").grow(1.))
                                .child(header_actions(s, false).unwrap()),
                        )
                        .child(panel(s, col(), false, false))
                };
                col()
                    .w_full()
                    .h_full()
                    .padding(8.)
                    .fill(color(BG))
                    .child(body)
            },
            (W as f32, H as f32),
            rune::Env::default(),
        );
        let snapshot = |rt: &mut rune::Runtime<Studio>, name: &str| {
            let Some(dir) = std::env::var_os("PRODUCER_PUBLISH_TEST_PNG_DIR") else {
                return;
            };
            let dir = PathBuf::from(dir);
            fs::create_dir_all(&dir).unwrap();
            use rune::render::{Gpu, Offscreen, Renderer, OFFSCREEN_FORMAT};
            let gpu = Gpu::headless();
            let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
            let target = Offscreen::new(&gpu.device, W, H);
            renderer.render_runtime_to_offscreen(&gpu.device, &gpu.queue, &target, rt);
            rune::render::write_png(&dir.join(name), W, H, &target.read(&gpu.device)).unwrap();
        };
        let click = |rt: &mut rune::Runtime<Studio>, key: &str| {
            let (x, y) = rt.find(key).unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.frame(0.03);
        };
        rt.frame(0.);
        assert!(rt.find("publish-view-menu").is_some());
        snapshot(&mut rt, "compact-publish.png");
        click(&mut rt, "publish-new");
        click(&mut rt, "Post caption");
        rt.paste("Two views of the studio");
        rt.frame(0.03);
        assert_eq!(rt.state.publish.caption.text, "Two views of the studio");
        let image_path = scratch.path().join("detail.png");
        image::RgbImage::from_pixel(64, 40, image::Rgb([26, 154, 121]))
            .save(&image_path)
            .unwrap();
        let png = rune::ClipboardImage::from_png(fs::read(&image_path).unwrap()).unwrap();
        rt.paste_content(rune::ClipboardContent::default().with_image(png));
        rt.frame(0.03);
        let at = rt.find("Post caption").unwrap();
        rt.drop_files(vec![image_path], Some(at));
        rt.frame(0.03);
        assert_eq!(rt.state.publish.files.len(), 2);
        assert_eq!(rt.state.publish.pasted_images.len(), 1);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && rt
                .state
                .publish
                .thumbnails
                .values()
                .any(|v| matches!(v, Thumbnail::Loading(_)))
        {
            rt.state.publish.poll_thumbnails();
            std::thread::yield_now();
        }
        rt.frame(0.03);
        assert!(rt.find("publish-thumbnail-0").is_some());
        assert!(rt.find("publish-thumbnail-1").is_some());
        snapshot(&mut rt, "composer-photos.png");
        click(&mut rt, "publish-remove-1");
        click(&mut rt, "publish-remove-0");
        let video = scratch.path().join("interview.mp4");
        fs::write(&video, b"video fixture").unwrap();
        rt.drop_files(vec![video.clone()], Some(rt.find("Post caption").unwrap()));
        rt.frame(0.03);
        assert_eq!(rt.state.publish.files, [video]);
        snapshot(&mut rt, "composer-video.png");
    }

    #[test]
    fn queue_opens_immediately_and_staging_failure_restores_the_draft() {
        let scratch = tempfile::tempdir().unwrap();
        let mut studio = Studio::new(scratch.path().into());
        let p = &mut studio.publish;
        p.scope = Some(("studio".into(), "test".into()));
        p.channels = serde_json::from_value(json!([
            {"id":"t","platform":"threads","status":"active"}
        ]))
        .unwrap();
        p.selected.insert("t".into());
        p.composing = true;
        p.caption.text = "Draft survives a local storage error".into();
        let missing = scratch.path().join("missing.png");
        p.files.push(missing.clone());
        send(&mut studio);
        assert!(!studio.publish.composing);
        assert!(studio.publish.tab == PublishTab::Scheduled);
        assert!(studio.publish.staging.is_some());
        let deadline = Instant::now() + Duration::from_secs(5);
        while studio.publish.staging.is_some() && Instant::now() < deadline {
            poll_delivery(&mut studio);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(studio.publish.composing);
        assert_eq!(
            studio.publish.caption.text,
            "Draft survives a local storage error"
        );
        assert_eq!(studio.publish.files, [missing]);
        assert!(studio.publish.selected.contains("t"));
        assert!(studio.publish.notice.contains("Could not save"));
        assert!(studio.publish.outbox.is_empty());
    }

    #[test]
    fn account_disclosure_is_independent_of_publishing_selection() {
        let scratch = tempfile::tempdir().unwrap();
        let mut studio = Studio::new(scratch.path().into());
        studio.publish.channels = serde_json::from_value(json!([
            {"id":"i","platform":"instagram","status":"active"}
        ])).unwrap();
        let mut rt = rune::Runtime::new(
            studio, |s, _| col().w_full().h_full().child(inline_composer(s, false)),
            (250., 550.), rune::Env::default(),
        );
        rt.frame(0.);
        let (x, y) = rt.find("publish-options-i").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.1);
        assert!(rt.find("publish-i-story").is_some());
        assert!(rt.state.publish.selected.is_empty());
        let (x, y) = rt.find("publish-channel-i").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.2);
        assert!(rt.state.publish.selected.contains("i"));
        assert!(submission_problem(&rt.state.publish).is_some());
    }

    #[test]
    fn instagram_requirements_follow_each_selected_account_and_format() {
        let mut draft = Publish::default();
        draft.channels = serde_json::from_value(json!([
            {"id":"t","platform":"threads","status":"active"},
            {"id":"i","platform":"instagram","status":"active","capabilities":{"media":{"kinds":["story"],"max_items":10}}}
        ])).unwrap();
        draft.caption = TextEdit::new("Caption");
        draft.selected.insert("t".into());
        assert!(submission_problem(&draft).is_none());
        draft.selected.insert("i".into());
        assert!(submission_problem(&draft).is_some());
        draft.files = vec!["photo.jpg".into()];
        assert!(submission_problem(&draft).is_none());
        draft.options.entry("i".into()).or_default().format = Some(InstagramFormat::Reel);
        assert!(submission_problem(&draft).is_some());
        draft.files = vec!["clip.mp4".into()];
        assert!(submission_problem(&draft).is_none());
        draft.options.get_mut("i").unwrap().format = Some(InstagramFormat::Story);
        assert!(submission_problem(&draft).is_none());
        draft.files = vec!["one.jpg".into(),"two.jpg".into()];
        draft.selected.remove("t");
        assert!(submission_problem(&draft).is_some());
        draft.files.pop();
        assert!(submission_problem(&draft).is_none());
        draft.channels[1].capabilities = Value::Null;
        assert!(submission_problem(&draft).is_some());
        draft.options.get_mut("i").unwrap().format = Some(InstagramFormat::Post);
        assert!(submission_problem(&draft).is_none());
    }

    #[test]
    fn clip_schedule_recovery_and_queue_use_the_brand_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let remote = root.clone();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let upload_id = Uuid::new_v4();
        let disconnect_id = Uuid::new_v4();
        let server = std::thread::spawn(move || {
            let mut stored = false;
            let mut intent = String::new();
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(&stream);
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let target = first.split_whitespace().nth(1).unwrap().to_owned();
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    headers.push_str(&line.to_lowercase());
                }
                let size = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                let path = target.split('?').next().unwrap();
                seen.lock().unwrap().push(path.to_owned());
                if path != "/object" && path != "/end" {
                    assert!(target.contains("brandSlug=studio"));
                    assert!(headers.contains("authorization: bearer test"));
                }
                let mut status = "200 OK";
                let response = match path {
                    "/media/uploads" => {
                        assert_eq!(
                            serde_json::from_slice::<Value>(&body).unwrap()["size_bytes"],
                            8
                        );
                        json!({"upload_id":upload_id,"put_url":format!("{remote}/object")})
                    }
                    "/object" => {
                        assert_eq!(body, b"clipdata");
                        assert!(!headers.contains("authorization:"));
                        stored = true;
                        json!({})
                    }
                    path if path == format!("/media/{upload_id}") => {
                        assert!(stored);
                        json!({"status":"stored"})
                    }
                    "/posts" => {
                        let post: Value = serde_json::from_slice(&body).unwrap();
                        assert!(headers.contains(post["intent_id"].as_str().unwrap()));
                        if post["text"] == "invalid" {
                            status = "422 Unprocessable Entity";
                            json!({"message":"Reconnect Threads"})
                        } else if post["channel_id"] == "instagram-id" {
                            assert_eq!(post["media"][0]["upload_id"], upload_id.to_string());
                            assert!(post["schedule_at"].as_str().unwrap().ends_with('Z'));
                            intent = post["intent_id"].as_str().unwrap().to_owned();
                            status = "503 Service Unavailable";
                            json!({"message":"Response interrupted"})
                        } else {
                            assert!(
                                post.get("schedule_at").is_none() && post.get("media").is_none()
                            );
                            json!({"job":{"id":"threads-job"}})
                        }
                    }
                    "/jobs" => {
                        json!({"jobs":[{"id":"scheduled-job","channel_id":"instagram-id","state":"scheduled","due_at":"2099-12-01T18:00:00Z","intent_id":intent}]})
                    }
                    "/channels" => {
                        json!({"channels":[{"id":"instagram-id","platform":"instagram","status":"active","display_name":"Studio"}]})
                    }
                    path if path == format!("/channels/{disconnect_id}") => {
                        assert!(first.starts_with("DELETE "));
                        assert!(body.is_empty());
                        json!({"ok":true})
                    }
                    "/end" => break,
                    _ => panic!("Unexpected contract path {path}"),
                };
                let bytes = response.to_string();
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}",bytes.len()).unwrap();
            }
        });
        let scratch = tempfile::tempdir().unwrap();
        let clip = scratch.path().join("clip.mp4");
        fs::write(&clip, b"clipdata").unwrap();
        let api = Api {
            root: root.clone(),
            client: crate::boomin_account::http().unwrap(),
            brand: "studio".into(),
            token: "test".into(),
            receipt: scratch.path().join("pending.json"),
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let spool = scratch.path().join("outbox");
            let make = |text: &str, channel: &str, files: Vec<PathBuf>, schedule: Option<String>| {
                outbox::Post {
                    created_ms: 0,
                    id: Uuid::new_v4().to_string(), text: text.into(), files, schedule, error: None,
                    targets: vec![outbox::Destination { id: channel.into(), label: channel.into(),
                        key: Uuid::new_v4().to_string(), overrides: json!({}), cover: None,
                        format: (channel=="instagram-id").then(|| "reel".into()) }],
                }.stage(&spool).unwrap()
            };
            let staged=make("Clip","instagram-id",vec![clip.clone()],Some(schedule_utc("2099-12-01 11:00").unwrap()));
            let dir=spool.join(&staged.id);
            fs::remove_file(clip).unwrap();
            assert!(calls.lock().unwrap().is_empty());
            outbox::deliver(&api,&dir,false).await.unwrap();
            assert!(outbox::list(&spool).unwrap()[0].error.is_some());
            outbox::deliver(&api,&dir,true).await.unwrap();
            assert!(outbox::list(&spool).unwrap().is_empty());
            let catalog = api.catalog().await.unwrap();
            assert_eq!(catalog.jobs[0].state, "scheduled");
            assert_eq!(catalog.channels[0].label(), "Instagram · Studio");
            assert_eq!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|p| p.as_str() == "/posts")
                    .count(),
                1
            );
            let text=make("Text post","threads-id",vec![],None);
            outbox::deliver(&api,&spool.join(&text.id),false).await.unwrap();
            assert!(outbox::list(&spool).unwrap().is_empty());
            let rejected=make("invalid","threads-id",vec![],None);
            outbox::deliver(&api,&spool.join(&rejected.id),false).await.unwrap();
            let failed=outbox::list(&spool).unwrap();
            assert_eq!(failed[0].text,"invalid");
            assert!(failed[0].error.as_ref().unwrap().contains("Reconnect Threads"));
            api.disconnect(&disconnect_id.to_string()).await.unwrap();
            let _ = api.client.get(format!("{root}/end")).send().await;
        });
        server.join().unwrap();
        assert!(schedule_utc("2020-01-01 12:00").is_err());
        assert!(schedule_utc("not a time").is_err());
    }
}
