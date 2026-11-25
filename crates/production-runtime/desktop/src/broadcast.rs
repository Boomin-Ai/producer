//! Native program fragments are encoded once per orientation and distributed on bounded queues.
use anyhow::{ensure, Context, Result};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Seek, Write},
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

const SERVICE: &str = "dev.producer.native.live-destinations";
#[derive(Clone, Serialize, Deserialize)]
pub struct Destination {
    pub id: String,
    pub label: String,
    pub server: String,
    pub vertical: bool,
    #[serde(skip)]
    pub enabled: bool,
    credential: String,
}
pub fn list(root: &Path) -> Result<Vec<Destination>> {
    match fs::read(root.join("live-destinations.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}
fn persist(root: &Path, rows: &[Destination]) -> Result<()> {
    fs::create_dir_all(root)?;
    let mut tmp = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer_pretty(&mut tmp, rows)?;
    tmp.as_file().sync_all()?;
    tmp.persist(root.join("live-destinations.json"))?;
    Ok(())
}
pub fn save(
    root: &Path,
    id: Option<&str>,
    label: &str,
    server: &str,
    key: Option<&str>,
    vertical: bool,
) -> Result<()> {
    let label = label.trim();
    let server = server.trim().trim_end_matches('/');
    ensure!(
        !label.is_empty() && label.chars().count() <= 80,
        "Enter a destination name (up to 80 characters)"
    );
    let url = url::Url::parse(server).context("Enter the RTMP or RTMPS server URL")?;
    ensure!(
        matches!(url.scheme(), "rtmp" | "rtmps")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Use an RTMP(S) server URL and paste the stream key separately"
    );
    let mut rows = list(root)?;
    let old = id
        .map(|id| {
            rows.iter()
                .position(|d| d.id == id)
                .context("Destination no longer exists")
        })
        .transpose()?;
    ensure!(
        old.is_some() || rows.len() < 16,
        "Up to 16 destinations can be saved"
    );
    let uid = || {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    };
    let credential = if let Some(k) = key {
        ensure!(
            !k.is_empty() && k.len() <= 4096 && !k.chars().any(char::is_control),
            "Paste a valid stream key"
        );
        let credential = uid();
        set_generic_password(SERVICE, &credential, k.as_bytes())
            .context("Save stream key in Keychain")?;
        credential
    } else {
        rows.get(old.context("Paste a stream key first")?)
            .unwrap()
            .credential
            .clone()
    };
    let previous = old.map(|i| rows[i].clone());
    let row = Destination {
        id: id.map(str::to_owned).unwrap_or_else(uid),
        label: label.into(),
        server: server.into(),
        vertical,
        enabled: false,
        credential: credential.clone(),
    };
    if let Some(i) = old {
        rows[i] = row
    } else {
        rows.push(row)
    }
    if let Err(e) = persist(root, &rows) {
        if key.is_some() {
            let _ = delete_generic_password(SERVICE, &credential);
        }
        return Err(e);
    }
    if let Some(old) = previous.filter(|d| d.credential != credential) {
        let _ = delete_generic_password(SERVICE, &old.credential);
    }
    Ok(())
}
pub fn remove(root: &Path, id: &str) -> Result<()> {
    let mut rows = list(root)?;
    let i = rows
        .iter()
        .position(|d| d.id == id)
        .context("Unknown destination")?;
    let old = rows.remove(i);
    persist(root, &rows)?;
    let _ = delete_generic_password(SERVICE, &old.credential);
    Ok(())
}
pub fn channels(root: &Path, room: &Path) -> Result<Vec<Destination>> {
    let selected: Vec<String> = match fs::read(room.join("broadcast-channels.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.into()),
    };
    let mut rows = list(root)?;
    for row in &mut rows {
        row.enabled = selected.contains(&row.id);
    }
    Ok(rows)
}
pub fn toggle(root: &Path, room: &Path, id: &str) -> Result<Vec<Destination>> {
    let mut rows = channels(root, room)?;
    let row = rows
        .iter_mut()
        .find(|d| d.id == id)
        .context("Unknown destination")?;
    row.enabled = !row.enabled;
    let selected: Vec<_> = rows.iter().filter(|d| d.enabled).map(|d| &d.id).collect();
    let mut tmp = tempfile::NamedTempFile::new_in(room)?;
    serde_json::to_writer(&mut tmp, &selected)?;
    tmp.as_file().sync_all()?;
    tmp.persist(room.join("broadcast-channels.json"))?;
    Ok(rows)
}
struct Retry {
    tool: PathBuf,
    row: Destination,
    key: Vec<u8>,
    attempt: u32,
    after: Instant,
    connected: Instant,
}
struct Sender {
    label: String,
    track: usize,
    child: Child,
    queue: Option<SyncSender<Arc<[u8]>>>,
    frames: Arc<std::sync::atomic::AtomicU64>,
    error: Option<String>,
    retry: Retry,
}
impl Drop for Sender {
    fn drop(&mut self) {
        self.queue.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Sender {
    fn fail(&mut self, message: &str) {
        if self.error.is_some() {
            return;
        }
        self.retry.after =
            Instant::now() + std::time::Duration::from_secs(1 << self.retry.attempt.min(3));
        self.error = Some(message.into());
        self.queue.take();
        let _ = self.child.kill();
    }
    fn spawn(tool: &Path, row: &Destination, key: &[u8], track: usize) -> Result<Self> {
        // An unlinked descriptor carries the RTMP playpath. Neither argv nor logs contain the key.
        let mut preset = tempfile::tempfile()?;
        preset.write_all(b"rtmp_playpath=")?;
        preset.write_all(key)?;
        preset.write_all(b"\n")?;
        preset.rewind()?;
        let fd = preset.as_raw_fd();
        let mut cmd = Command::new(tool);
        cmd.args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-analyzeduration",
            "100000",
            "-probesize",
            "32768",
            "-f",
            "mov",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c",
            "copy",
            "-fpre",
            "/dev/fd/3",
            "-flvflags",
            "no_duration_filesize",
            "-f",
            "flv",
        ]);
        if row.server.starts_with("rtmps://") {
            cmd.args(["-tls_verify", "1"]);
        }
        cmd.arg(format!("{}/publish", row.server))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().context("Start packaged RTMP sender")?;
        let mut input = child.stdin.take().unwrap();
        let progress = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::sync_channel::<Arc<[u8]>>(4);
        let frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = frames.clone();
        let sender = Self {
            label: row.label.clone(),
            track,
            child,
            queue: Some(tx),
            frames,
            error: None,
            retry: Retry {
                tool: tool.into(),
                row: row.clone(),
                key: key.into(),
                attempt: 0,
                after: Instant::now(),
                connected: Instant::now(),
            },
        };
        thread::Builder::new()
            .name("live-destination-media".into())
            .spawn(move || {
                for bytes in rx {
                    if input.write_all(&bytes).is_err() {
                        break;
                    }
                }
            })?;
        thread::Builder::new()
            .name("live-destination-progress".into())
            .spawn(move || {
                for line in BufReader::new(progress).lines().map_while(Result::ok) {
                    if let Some(n) = line
                        .strip_prefix("frame=")
                        .and_then(|s| s.trim().parse().ok())
                    {
                        counter.store(n, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            })?;
        Ok(sender)
    }
}
#[derive(Default)]
struct State {
    epoch: u64,
    start: Option<Instant>,
    senders: Vec<Sender>,
    init: [Option<Arc<[u8]>>; 2],
    ended: [bool; 2],
    error: Option<String>,
}
#[derive(Default)]
pub struct Broadcast(Mutex<State>);
#[derive(Default, Clone, Serialize)]
pub struct Status {
    pub active: bool,
    pub elapsed: u64,
    pub destinations: Vec<(String, String)>,
    pub error: Option<String>,
}
impl Broadcast {
    pub fn active(&self) -> bool {
        self.0.lock().unwrap().start.is_some()
    }
    pub fn sending_to_studio_site(&self) -> bool {
        let state = self.0.lock().unwrap();
        state.start.is_some() && state.senders.iter().any(|sender| {
            if sender.error.is_some() || sender.frames.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                return false;
            }
            url::Url::parse(&sender.retry.row.server).ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .is_some_and(|host| ["producer.dev", "boomin.ai"].iter().any(|domain| {
                    host == *domain || host.strip_suffix(domain).is_some_and(|subdomain| subdomain.ends_with('.'))
                }))
        })
    }
    pub fn begin(&self, root: &Path, room: &Path) -> Result<(u64, Vec<usize>)> {
        let rows: Vec<_> = channels(root, room)?
            .into_iter()
            .filter(|d| d.enabled)
            .collect();
        ensure!(!rows.is_empty(), "Enable a destination in Channels first");
        let mut outputs = vec![];
        let mut senders = vec![];
        let tool: PathBuf = std::env::current_exe()?.with_file_name("ffmpeg");
        ensure!(!self.active(), "A broadcast is already running");
        for row in rows {
            let key = get_generic_password(SERVICE, &row.credential)
                .with_context(|| format!("Unlock the stream key for {}", row.label))?;
            let output = usize::from(row.vertical);
            let track = outputs
                .iter()
                .position(|o| *o == output)
                .unwrap_or_else(|| {
                    outputs.push(output);
                    outputs.len() - 1
                });
            senders.push(Sender::spawn(&tool, &row, &key, track)?);
        }
        let mut state = self.0.lock().unwrap();
        state.epoch += 1;
        state.start = Some(Instant::now());
        state.init = Default::default();
        state.ended = [false; 2];
        state.error = None;
        state.senders = senders;
        Ok((state.epoch, outputs))
    }
    pub fn end(&self, error: Option<String>) {
        let senders = {
            let mut s = self.0.lock().unwrap();
            s.start = None;
            s.init = Default::default();
            s.error = error;
            std::mem::take(&mut s.senders)
        };
        drop(senders);
    }
    pub fn finish(&self) {
        if !self.active() {
            return;
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let s = self.0.lock().unwrap();
            if s.error.is_some()
                || s.senders.iter().all(|p| s.ended[p.track])
                || Instant::now() >= deadline
            {
                break;
            }
            drop(s);
            thread::sleep(std::time::Duration::from_millis(15));
        }
        let mut senders = {
            let mut s = self.0.lock().unwrap();
            s.start = None;
            s.init = Default::default();
            std::mem::take(&mut s.senders)
        };
        for p in &mut senders {
            p.queue.take();
        }
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        while Instant::now() < deadline
            && senders
                .iter_mut()
                .any(|p| matches!(p.child.try_wait(), Ok(None)))
        {
            thread::sleep(std::time::Duration::from_millis(15));
        }
    }
    pub fn event(&self, epoch: u64, track: usize, kind: u32, bytes: &[u8]) {
        let mut s = self.0.lock().unwrap();
        if s.start.is_none() || epoch != s.epoch {
            return;
        }
        if kind == 3 {
            s.error = Some(String::from_utf8_lossy(bytes).into_owned());
            for p in &mut s.senders {
                p.fail("Encoder stopped");
            }
            return;
        }
        if kind == 2 && track < 2 {
            s.ended[track] = true;
        }
        if kind > 1 {
            return;
        }
        let chunk: Arc<[u8]> = bytes.into();
        if kind == 0 && track < 2 {
            s.init[track] = Some(chunk.clone());
        }
        for p in s.senders.iter_mut().filter(|p| p.track == track) {
            if p.queue
                .as_ref()
                .is_some_and(|tx| tx.try_send(chunk.clone()).is_err())
            {
                p.fail("Destination stalled or disconnected");
            }
        }
    }
    // Pump from the room control worker even while the operator is viewing Settings.
    pub fn poll(&self) {
        let mut s = self.0.lock().unwrap();
        if s.start.is_none() || s.error.is_some() {
            return;
        }
        let init = s.init.clone();
        for p in &mut s.senders {
            if p.error.is_none() && p.child.try_wait().ok().flatten().is_some() {
                p.fail("Connection failed · check server and stream key");
            }
            let frames = p.frames.load(std::sync::atomic::Ordering::Relaxed);
            if p.error.is_none() && frames == 0 && p.retry.connected.elapsed().as_secs() >= 30 {
                p.fail("Connection timed out");
            }
            if p.error.is_some() && p.retry.attempt < 3 && Instant::now() >= p.retry.after {
                let attempt = p.retry.attempt + 1;
                match Sender::spawn(&p.retry.tool, &p.retry.row, &p.retry.key, p.track) {
                    Ok(mut next) => {
                        next.retry.attempt = attempt;
                        if let Some(header) = &init[p.track] {
                            let _ = next.queue.as_ref().unwrap().try_send(header.clone());
                        }
                        *p = next;
                    }
                    Err(_) => {
                        p.retry.attempt = attempt;
                        p.retry.after =
                            Instant::now() + std::time::Duration::from_secs(1 << attempt);
                    }
                }
            }
        }
    }
    pub fn status(&self) -> Status {
        let s = self.0.lock().unwrap();
        let elapsed = s.start.map_or(0, |t| t.elapsed().as_secs());
        let destinations = s
            .senders
            .iter()
            .map(|p| {
                let frames = p.frames.load(std::sync::atomic::Ordering::Relaxed);
                let phase = if let Some(error) = &p.error {
                    if p.retry.attempt < 3 && s.error.is_none() {
                        format!("Retrying · {}", p.retry.attempt + 1)
                    } else {
                        error.clone()
                    }
                } else if frames > 0 {
                    "Sending".into()
                } else if p.retry.attempt > 0 {
                    format!("Reconnecting · {}/3", p.retry.attempt)
                } else {
                    "Connecting…".into()
                };
                (p.label.clone(), phase)
            })
            .collect();
        Status {
            active: s.start.is_some(),
            elapsed,
            destinations,
            error: s.error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Use two actual RTMP listeners. Fixture chunks are the same H.264/AAC bytes emitted by AVFoundation.
    #[test]
    #[ignore = "requires native program fixture, packaged ffmpeg, and loopback sockets"]
    fn paired_rtmp_outputs_survive_one_disconnect() {
        let tool = PathBuf::from(std::env::var_os("LIVE_TEST_FFMPEG").unwrap());
        let fixture = PathBuf::from(std::env::var_os("CLIP_TAKE_FIXTURE").unwrap());
        let dir = tempfile::tempdir().unwrap();
        let mut receivers = Vec::new();
        let mut rows = vec![];
        for track in 0..2 {
            let sock = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let server = format!("rtmp://{}/live", sock.local_addr().unwrap());
            drop(sock);
            let row = Destination {
                id: track.to_string(),
                credential: "fixture".into(),
                label: format!("Local {track}"),
                server: server.clone(),
                vertical: track == 1,
                enabled: true,
            };
            let receiver = Command::new(&tool)
                .args([
                    "-nostdin",
                    "-loglevel",
                    "warning",
                    "-listen",
                    "1",
                    "-i",
                    &format!("{server}/proof"),
                    "-map",
                    "0:v",
                    "-map",
                    "0:a",
                    "-c",
                    "copy",
                    "-flush_packets",
                    "1",
                    "-f",
                    "flv",
                ])
                .arg(dir.path().join(format!("out-{track}.flv")))
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            receivers.push(receiver);
            rows.push(row);
        }
        thread::sleep(std::time::Duration::from_millis(300));
        let broadcast = Broadcast::default();
        {
            let mut state = broadcast.0.lock().unwrap();
            state.start = Some(Instant::now());
            state.epoch = 1;
            for (i, row) in rows.iter().enumerate() {
                state
                    .senders
                    .push(Sender::spawn(&tool, row, b"proof", i).unwrap());
            }
        }
        for index in 0..4 {
            for t in 0..2 {
                let bytes = fs::read(fixture.join(format!("track-{t:02}-{index:08}.mp4"))).unwrap();
                let mut off = 0;
                while &bytes[off + 4..off + 8] != b"moof" {
                    off += u32::from_be_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
                }
                if index == 0 {
                    broadcast.event(1, t, 0, &bytes[..off]);
                }
                broadcast.event(1, t, 1, &bytes[off..]);
            }
            thread::sleep(std::time::Duration::from_millis(650));
            broadcast.poll();
        }
        assert!(
            broadcast
                .status()
                .destinations
                .iter()
                .all(|(_, s)| s == "Sending"),
            "{:?}",
            broadcast.status().destinations
        );
        let before = broadcast.0.lock().unwrap().senders[1]
            .frames
            .load(std::sync::atomic::Ordering::Relaxed);
        receivers[0].kill().unwrap();
        receivers[0].wait().unwrap();
        for index in 4..8 {
            for t in 0..2 {
                let bytes = fs::read(fixture.join(format!("track-{t:02}-{index:08}.mp4"))).unwrap();
                let mut off = 0;
                while &bytes[off + 4..off + 8] != b"moof" {
                    off += u32::from_be_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
                }
                broadcast.event(1, t, 1, &bytes[off..]);
            }
            thread::sleep(std::time::Duration::from_millis(650));
            broadcast.poll();
        }
        assert!(broadcast.0.lock().unwrap().senders[0].retry.attempt > 0);
        assert!(
            broadcast.0.lock().unwrap().senders[1]
                .frames
                .load(std::sync::atomic::Ordering::Relaxed)
                > before
        );
        broadcast.end(None);
        assert!(!broadcast.status().active);
        for (i, mut child) in receivers.into_iter().enumerate() {
            let _ = child.wait();
            let mut logs = String::new();
            use std::io::Read;
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut logs)
                .unwrap();
            assert!(!logs.contains("Unexpected stream"), "{logs}");
            let file = dir.path().join(format!("out-{i}.flv"));
            assert!(Command::new(&tool)
                .args(["-nostdin", "-v", "error", "-i"])
                .arg(file)
                .args(["-map", "0:v:0", "-map", "0:a:0", "-t", "0.3", "-f", "null", "-"])
                .status()
                .unwrap()
                .success());
        }
    }
}

#[cfg(test)]
mod program_acceptance {
    use super::*;
    struct Fixture {
        rows: Vec<Destination>,
        receivers: Vec<Child>,
        root: PathBuf,
        host: Option<Arc<crate::engine::Handle>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(h) = self.host.take() {
                h.closed.store(true, std::sync::atomic::Ordering::Release);
            }
            for child in &mut self.receivers {
                let _ = child.kill();
                let _ = child.wait();
            }
            for row in &self.rows {
                let _ = remove(&self.root, &row.id);
            }
        }
    }
    #[test]
    #[ignore = "requires macOS Metal, temporary Keychain items, bundled ffmpeg and isolated profile"]
    fn fresh_program_through_room_live_controls() {
        let root = crate::workspace_root();
        assert!(root.join("isolated-broadcast-test").is_file() && list(&root).unwrap().is_empty());
        let tool = PathBuf::from(std::env::var_os("LIVE_TEST_FFMPEG").unwrap());
        let mut fixture = Fixture {
            rows: vec![],
            receivers: vec![],
            root: root.clone(),
            host: None,
        };
        for (index, vertical) in [false, true].into_iter().enumerate() {
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            let server = format!("rtmp://127.0.0.1:{port}/live");
            save(
                &root,
                None,
                &format!("Loopback {index}"),
                &server,
                Some("local-proof"),
                vertical,
            )
            .unwrap();
            fixture.rows = list(&root).unwrap();
            let selected = toggle(&root, &root, &fixture.rows[index].id).unwrap();
            assert!(selected[index].enabled);
            let child = Command::new(&tool)
                .args([
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-listen",
                    "1",
                    "-i",
                    &format!("{server}/local-proof"),
                    "-c",
                    "copy",
                    "-y",
                ])
                .arg(root.join(format!("program-{index}.flv")))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            fixture.receivers.push(child);
        }
        let other = tempfile::tempdir().unwrap();
        assert!(channels(&root, other.path())
            .unwrap()
            .iter()
            .all(|r| !r.enabled));
        let h = crate::engine::start(root.clone()).unwrap();
        fixture.host = Some(h.clone());
        let deadline = Instant::now() + std::time::Duration::from_secs(12);
        while h.snapshot().output_frames.contains(&0) {
            assert!(Instant::now() < deadline, "{:?}", h.snapshot().error);
            thread::sleep(std::time::Duration::from_millis(100));
        }
        let run = h
            .request(crate::engine::RoomCommand::BroadcastStart)
            .unwrap();
        assert_eq!(run["ok"], true, "{run}");
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let status = h
                .request(crate::engine::RoomCommand::BroadcastStatus)
                .unwrap();
            if status["broadcast"]["destinations"]
                .as_array()
                .is_some_and(|v| v.len() == 2 && v.iter().all(|s| s[1] == "Sending"))
            {
                break;
            }
            assert!(Instant::now() < deadline, "{status}");
            thread::sleep(std::time::Duration::from_millis(200));
        }
        let end = h
            .request(crate::engine::RoomCommand::BroadcastStop)
            .unwrap();
        assert_eq!(end["broadcast"]["active"], false, "{end}");
        for (index, child) in fixture.receivers.iter_mut().enumerate() {
            let limit = Instant::now() + std::time::Duration::from_secs(4);
            while child.try_wait().unwrap().is_none() {
                assert!(Instant::now() < limit, "Receiver did not stop");
                thread::sleep(std::time::Duration::from_millis(20));
            }
            let output = Command::new(&tool)
                .args(["-nostdin", "-hide_banner", "-i"])
                .arg(root.join(format!("program-{index}.flv")))
                .args([
                    "-map", "0:v:0", "-map", "0:a:0", "-t", "1", "-f", "null", "-",
                ])
                .output()
                .unwrap();
            let log = String::from_utf8_lossy(&output.stderr);
            let snap = h.snapshot();
            let size = if index == 0 {
                snap.project.canvas.landscape
            } else {
                snap.project.canvas.vertical
            };
            assert!(
                output.status.success()
                    && log.contains("Video: h264")
                    && log.contains("Audio: aac")
                    && log.contains(&format!("{}x{}", size.width, size.height)),
                "{log}"
            );
        }
        h.closed.store(true, std::sync::atomic::Ordering::Release);
        let deadline = Instant::now() + std::time::Duration::from_secs(8);
        while !h.done.load(std::sync::atomic::Ordering::Acquire) {
            assert!(Instant::now() < deadline, "Studio teardown timed out");
            thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
