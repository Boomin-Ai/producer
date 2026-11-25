//! Durable, private assistant traces independent of the room document and transcript.
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub fn directory(root: &Path) -> PathBuf {
    root.join("assistant-logs")
}

pub struct Journal {
    pub id: String,
    started: Instant,
    writer: Mutex<Writer>,
}
struct Writer {
    file: File,
    finished: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event<'a> {
    version: u32,
    turn_id: &'a str,
    at_unix_ms: u128,
    elapsed_ms: u128,
    event: &'a str,
    data: Value,
}

impl Journal {
    pub fn start(root: &Path, generation: u64, data: Value) -> Result<Self> {
        let directory = directory(root);
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
            .context("Create assistant log folder")?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let id = format!("{stamp:020}-{}-{generation}", std::process::id());
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join(format!("{id}.jsonl")))
            .context("Create assistant turn log")?;
        let journal = Self {
            id,
            started: Instant::now(),
            writer: Mutex::new(Writer {
                file,
                finished: false,
            }),
        };
        journal.record("turn_started", data)?;
        Ok(journal)
    }
    pub fn record(&self, event: &str, data: Value) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        if !writer.finished {
            self.write(&mut writer.file, event, data)?;
        }
        Ok(())
    }
    pub fn finish(&self, outcome: &str, error: Option<&str>, steps: Vec<Value>) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        if !writer.finished {
            self.write(
                &mut writer.file,
                "turn_finished",
                json!({"outcome":outcome,"error":error,"steps":steps}),
            )?;
            writer.finished = true;
        }
        Ok(())
    }
    fn write(&self, file: &mut File, event: &str, mut data: Value) -> Result<()> {
        scrub(&mut data);
        let mut line = serde_json::to_vec(&Event {
            version: 1,
            turn_id: &self.id,
            at_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
            elapsed_ms: self.started.elapsed().as_millis(),
            event,
            data,
        })?;
        line.push(b'\n');
        file.write_all(&line).context("Append assistant turn log")?;
        file.sync_data().context("Flush assistant turn log")
    }
}

fn scrub(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, item) in object {
                match key.as_str() {
                    "image_url" | "image_base64" | "encrypted_content" | "access_token"
                    | "refresh_token" | "id_token" | "authorization" | "api_key" => {
                        *item = json!("[omitted]");
                    }
                    _ => scrub(item),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        _ => {}
    }
}

pub fn print(root: &Path, selection: &str) -> Result<()> {
    let dir = directory(root);
    let mut names = Vec::new();
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_file() {
                    if let Some(id) = entry
                        .file_name()
                        .to_str()
                        .and_then(|name| name.strip_suffix(".jsonl"))
                    {
                        names.push(id.to_owned());
                    }
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    names.sort_unstable();
    if selection == "list" {
        for name in names.iter().rev() {
            println!("{name}");
        }
        return Ok(());
    }
    let id = if selection == "latest" {
        names
            .last()
            .context("No assistant turn logs in this room")?
            .as_str()
    } else {
        selection
    };
    ensure!(
        names.iter().any(|name| name == id),
        "Unknown assistant turn"
    );
    io::copy(
        &mut File::open(dir.join(format!("{id}.jsonl")))?,
        &mut io::stdout().lock(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn logs_are_private_and_omit_credentials_and_images() {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::start(root.path(), 1, json!({"prompt":"Use this image"})).unwrap();
        journal.record("provider_response",json!({"output":[{"image_url":"raw image","encrypted_content":"provider secret","access_token":"token"}]})).unwrap();
        journal
            .finish("cancelled", Some("Stopped"), vec![])
            .unwrap();
        journal.record("late_event", json!({})).unwrap();
        let dir = directory(root.path());
        let file = dir.join(format!("{}.jsonl", journal.id));
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let text = fs::read_to_string(file).unwrap();
        assert!(text.contains("Use this image") && text.contains("cancelled"));
        for value in ["raw image", "provider secret", "\"token\"", "late_event"] {
            assert!(!text.contains(value));
        }
    }
}
