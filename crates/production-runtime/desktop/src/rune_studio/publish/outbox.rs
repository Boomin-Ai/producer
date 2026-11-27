//! Private, account-scoped delivery spool. A directory becomes visible to workers
//! only after the complete post and its media have been saved.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Destination {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) key: String,
    pub(super) overrides: Value,
    pub(super) format: Option<String>,
    pub(super) cover: Option<PathBuf>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Post {
    pub(super) id: String,
    #[serde(default)]
    pub(super) created_ms: u64,
    pub(super) text: String,
    pub(super) files: Vec<PathBuf>,
    pub(super) schedule: Option<String>,
    pub(super) targets: Vec<Destination>,
    pub(super) error: Option<String>,
}

impl Post {
    pub(super) fn title(&self) -> String {
        if !self.text.is_empty() {
            return self.text.chars().take(90).collect();
        }
        "Media post".into()
    }
    fn save(&self, dir: &Path) -> Result<()> {
        let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut tmp, self)?;
        tmp.as_file().sync_all()?;
        tmp.persist(dir.join("post.json"))?;
        fs::File::open(dir)?.sync_all()?;
        Ok(())
    }
    pub(super) fn stage(mut self, root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        let staging = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(root)?;
        let mut copied = BTreeMap::new();
        let mut copy = |path: &mut PathBuf| -> Result<()> {
            if let Some(relative) = copied.get(path) {
                *path = PathBuf::clone(relative);
                return Ok(());
            }
            mime(path)?;
            let relative = PathBuf::from(format!(
                "{}.{}",
                copied.len(),
                path.extension()
                    .and_then(|e| e.to_str())
                    .context("Missing media extension")?
            ));
            let dst = staging.path().join(&relative);
            fs::copy(&*path, &dst).context("Could not save media to the delivery queue")?;
            fs::File::open(&dst)?.sync_all()?;
            copied.insert(path.clone(), relative.clone());
            *path = relative;
            Ok(())
        };
        for path in &mut self.files {
            copy(path)?;
        }
        for target in &mut self.targets {
            if let Some(path) = &mut target.cover {
                copy(path)?;
            }
        }
        self.save(staging.path())?;
        fs::rename(staging.path(), root.join(&self.id))?;
        fs::File::open(root)?.sync_all()?;
        Ok(self)
    }
}

pub(super) fn list(root: &Path) -> Result<Vec<Post>> {
    let entries = match fs::read_dir(root) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in entries {
        let dir = entry?.path();
        if !dir
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|v| Uuid::parse_str(v).is_ok())
        {
            continue;
        }
        match fs::read(dir.join("post.json")) {
            Ok(bytes) => {
                let post: Post = serde_json::from_slice(&bytes)?;
                if !post.targets.is_empty() {
                    out.push(post);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        }
    }
    out.sort_by(|a, b| {
        a.created_ms
            .cmp(&b.created_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

pub(super) async fn deliver(api: &Api, dir: &Path, retry: bool) -> Result<()> {
    // Serializes background delivery with legacy recovery and other studio instances.
    let _lock = api.lock_submission()?;
    let bytes = match fs::read(dir.join("post.json")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        other => other?,
    };
    let mut post: Post = serde_json::from_slice(&bytes)?;
    if post.error.is_some() && !retry {
        return Ok(());
    }
    while let Some(target) = post.targets.first() {
        let result = transmit(api, dir, &post, target).await;
        if let Err(e) = result {
            post.error = Some(format!("{}: {e}", target.label));
            post.save(dir)?;
            return Ok(());
        }
        post.targets.remove(0);
        post.error = None;
        post.save(dir)?;
    }
    fs::remove_dir_all(dir)?;
    Ok(())
}

async fn transmit(api: &Api, dir: &Path, post: &Post, target: &Destination) -> Result<()> {
    let receipt = dir.join(format!("{}.json", target.key));
    let body: Value = if receipt.exists() {
        // A previous request may have succeeded before its response was received.
        let found = api
            .call("jobs", None, None, &[("intent_id", &target.key)])
            .await?;
        if found["jobs"]
            .as_array()
            .context("Invalid queue response")?
            .iter()
            .any(|j| j["intent_id"] == target.key)
        {
            return Ok(());
        }
        serde_json::from_slice(&fs::read(&receipt)?)?
    } else {
        let mut overrides = target.overrides.clone();
        if let Some(path) = &target.cover {
            let id = api.media(&dir.join(path)).await?;
            let v = api
                .call("files/get", None, None, &[("file_id", &id)])
                .await?;
            let url = v["file"]["content_url"]
                .as_str()
                .filter(|url| url.starts_with("https://"))
                .context("Missing cover URL")?;
            overrides["cover_url"] = json!(url);
        }
        let mut body = json!({"channel_id":target.id,"intent_id":target.key,"text":post.text,"overrides":overrides});
        if let Some(date) = &post.schedule {
            body["schedule_at"] = json!(date);
        }
        if let Some(format) = &target.format {
            body["instagram_format"] = json!(format);
        }
        if !post.files.is_empty() {
            let mut media = Vec::new();
            for path in &post.files {
                media.push(json!({"upload_id":api.media(&dir.join(path)).await?}));
            }
            body["media"] = json!(media);
        }
        let mut titles = api.titles()?;
        titles.insert(
            target.key.clone(),
            target.overrides["caption"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| post.title()),
        );
        let mut index = tempfile::NamedTempFile::new_in(api.receipt.parent().unwrap())?;
        serde_json::to_writer(&mut index, &titles)?;
        index.persist(api.receipt.with_extension("titles.json"))?;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut file, &body)?;
        file.as_file().sync_all()?;
        file.persist(&receipt)?;
        fs::File::open(dir)?.sync_all()?;
        body
    };
    let response = api
        .call("posts", Some(&body), Some(&target.key), &[])
        .await?;
    ensure!(
        response["job"]["id"].is_string(),
        "Boomin did not confirm the post"
    );
    Ok(())
}
