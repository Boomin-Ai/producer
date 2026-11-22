//! Explicit, local-only guest transport probe for the Native Dev room.
use crate::platform::Frame;
use std::{collections::VecDeque, io::Read, os::{fd::OwnedFd, unix::net::UnixStream},
    sync::{Arc,Mutex}, time::{Duration,Instant}};
use anyhow::{bail, Context, Result};
use std::{fs, path::Path, process::{Child, Command, Stdio}};

#[derive(Default)]
struct Media {
    audio: VecDeque<(Instant, [i16;480])>,
    thumbnail: Option<(Instant, Arc<Frame>)>,
    video: Option<(Instant, Arc<Frame>)>,
    last_audio: Option<Instant>,
    queue_evictions:u64,
    expired_blocks:u64,
    mixed_blocks:u64,
    empty_reads:u64,
}

#[derive(Clone)]
pub struct Guest(Arc<Mutex<Media>>, Arc<std::path::PathBuf>, Arc<Mutex<VecDeque<(u64,[i16;480])>>>);
impl Guest {
    pub fn from_socket(run:std::path::PathBuf, reader:UnixStream)->Result<Self> {
        let guest=Self(Arc::default(),Arc::new(run),Arc::new(Mutex::new(VecDeque::with_capacity(12))));
        let receiver=guest.clone();
        std::thread::Builder::new().name("producer-rtc-media".into()).spawn(move ||{
            let _=receiver.receive(reader);
            *receiver.0.lock().unwrap()=Media::default();
        })?;
        Ok(guest)
    }
    pub fn program_audio_vitals(&self)->serde_json::Value {
        let m=self.0.lock().unwrap();
        serde_json::json!({"queueEvictions":m.queue_evictions,"expiredBlocks":m.expired_blocks,"mixedBlocks":m.mixed_blocks,"emptyReads":m.empty_reads})
    }
    pub fn recent_media(&self) -> (bool, bool) {
        let media = self.0.lock().unwrap();
        let fresh = |at: Instant| at.elapsed() < Duration::from_secs(1);
        (media.last_audio.is_some_and(fresh), media.video.as_ref().is_some_and(|(at, _)| fresh(*at)))
    }
    pub fn run_dir(&self)->&Path { &self.1 }
    pub fn stall_receipt(&self,start:f64,end:f64)->Result<()> {
        fs::write(self.1.join("stall.json"),serde_json::to_vec(&serde_json::json!({"start":start,"end":end}))?)?;
        Ok(())
    }
    fn receive(&self, mut pipe: UnixStream) -> std::io::Result<()> {
        let mut pixels = vec![0u8;160*90*4];
        loop {
            let mut kind = [0];
            pipe.read_exact(&mut kind)?;
            match kind[0] {
                b'a' => { let mut media = self.0.lock().unwrap(); media.audio.clear(); media.last_audio = None; }
                b'v' => { let mut m=self.0.lock().unwrap(); m.video=None; m.thumbnail=None; }
                b'A' => {
                    let mut bytes = [0;960];
                    pipe.read_exact(&mut bytes)?;
                    let samples = std::array::from_fn(|i| i16::from_le_bytes([bytes[2*i], bytes[2*i+1]]));
                    let mut media = self.0.lock().unwrap();
                    if media.audio.len() == 12 { media.audio.pop_front(); media.queue_evictions+=1; }
                    let now = Instant::now();
                    media.last_audio = Some(now);
                    media.audio.push_back((now, samples));
                }
                b'H' => {
                    let mut packet=[0u8;968];
                    pipe.read_exact(&mut packet)?;
                    let host_ns=u64::from_le_bytes(packet[..8].try_into().unwrap());
                    let samples=std::array::from_fn(|i|i16::from_le_bytes([packet[8+i*2],packet[9+i*2]]));
                    self.push_host_mic(host_ns,samples);
                }
                b'V' | b'W' | b'N' | b'T' => {
                    let (w,h)=if kind[0]!=b'V'{
                        let mut header=[0u8;4];pipe.read_exact(&mut header)?;
                        (u16::from_le_bytes([header[0],header[1]]) as usize,u16::from_le_bytes([header[2],header[3]]) as usize)
                    }else{(160,90)};
                    if !(1..=640).contains(&w)||!(1..=360).contains(&h){return Err(std::io::ErrorKind::InvalidData.into());}
                    let thumbnail=kind[0]==b'T';
                    if thumbnail && (w>160 || h>90){return Err(std::io::ErrorKind::InvalidData.into());}
                    let monitor=thumbnail || kind[0]==b'N';
                    if monitor && (w|h)%2!=0{return Err(std::io::ErrorKind::InvalidData.into());}
                    pixels.resize(if monitor{w*h*3/2}else{w*h*4},0);pipe.read_exact(&mut pixels)?;
                    let frame = (if monitor{Frame::stage(&pixels,w,h)}else{Frame::guest(&pixels,w,h)}).map(|f| (Instant::now(), Arc::new(f)));
                    let mut m=self.0.lock().unwrap();
                    if thumbnail {m.thumbnail=frame;} else {m.video=frame;}
                }
                _ => return Err(std::io::ErrorKind::InvalidData.into()),
            }
        }
    }
    pub fn mix(&self, stereo: &mut [f32]) {
        let Ok(mut media) = self.0.try_lock() else { return };
        while let Some((at, block)) = media.audio.pop_front() {
            if at.elapsed() > Duration::from_millis(120) { media.expired_blocks+=1; continue; }
            for (out, sample) in stereo.chunks_exact_mut(2).zip(block) {
                for channel in out { *channel = (*channel + sample as f32 / 32768.).clamp(-1.,1.); }
            }
            media.mixed_blocks+=1;
            return;
        }
        media.empty_reads+=1;
    }
    // Select the captured 10 ms block nearest the current program slot.
    // Replace the primary microphone contribution before its mute/gain stage.
    fn push_host_mic(&self, stamp:u64, samples:[i16;480]) {
        let mut queue = self.2.lock().unwrap();
        if queue.len() == 12 { queue.pop_front(); }
        queue.push_back((stamp,samples));
    }
    pub fn host_mic(&self, stereo:&mut [f32], at:f64) {
        let Ok(mut host_mic)=self.2.try_lock() else {return};
        let ns=(at*1e9) as u64;
        while let Some(&(stamp,_))=host_mic.front(){
            if stamp>ns.saturating_add(5_000_000){break;}
            let (_,samples)=host_mic.pop_front().unwrap();
            if stamp.saturating_add(5_000_000)<ns {continue;}
            for (dst,v) in stereo.chunks_exact_mut(2).zip(samples){dst.fill(v as f32/32768.);}
            break;
        }
    }
    pub fn thumbnail(&self) -> Option<Arc<Frame>> {
        let media=self.0.lock().unwrap();
        let (at,frame)=media.thumbnail.as_ref()?;
        (at.elapsed()<Duration::from_secs(1)).then(||frame.clone())
    }
    pub fn frame(&self) -> Option<Arc<Frame>> {
        let media = self.0.try_lock().ok()?;
        let (at,frame) = media.video.as_ref()?;
        (at.elapsed() < Duration::from_millis(200)).then(||frame.clone())
    }
}
#[derive(Default)]
pub struct Probe(Option<Child>);

impl Probe {
    pub fn start(&mut self, root: &Path) -> Result<(u32,Guest)> {
        if let Some(child) = &mut self.0 {
            if child.try_wait()?.is_none() { bail!("Witness call already running"); }
        }
        let helper = std::env::current_exe()?.with_file_name("producer-guest-rtc-lab");
        let token = root.join("p0-token");
        if !token.is_file() { bail!("Missing loopback fixture token"); }
        let run = root.join(format!("p0-call-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?.as_nanos()));
        fs::create_dir(&run)?;
        let log = fs::File::create(run.join("transport.log"))?;
        let (reader, writer) = UnixStream::pair()?;
        let guest = Guest(Arc::default(),Arc::new(run.clone()),Arc::new(Mutex::new(VecDeque::with_capacity(12))));
        let receiver = guest.clone();
        std::thread::Builder::new().name("p0-guest-ingest".into()).spawn(move || {
            let _ = receiver.receive(reader);
            *receiver.0.lock().unwrap() = Media::default();
        })?;
        let mut command=Command::new(helper);
        command.env_clear();
        // Keep the second socket alive through spawn. The child inherits only
        // its write end; the OS closes it when the helper exits.
        let mut mic_socket = None;
        if root.join("p0-physical-route").is_file() {
            if !root.join("p0-sdk-only").is_file() {
                use std::os::{fd::AsRawFd, unix::process::CommandExt};
                let (mut input, output) = UnixStream::pair()?;
                // Default Darwin socket buffers admit only eight complete 968-byte
                // packets. Provision one socket write deadline of timestamped PCM.
                let bytes:libc::c_int = 22 * 968;
                for (fd, option) in [(output.as_raw_fd(), libc::SO_SNDBUF),
                                     (input.as_raw_fd(), libc::SO_RCVBUF)] {
                    let status = unsafe { libc::setsockopt(fd, libc::SOL_SOCKET, option,
                        (&bytes as *const libc::c_int).cast(), std::mem::size_of_val(&bytes) as _) };
                    if status != 0 {
                        return Err(std::io::Error::last_os_error()).context("Size program microphone socket");
                    }
                }
                let mic_guest = guest.clone();
                let trace_path = root.join("p0-trace").exists().then(|| run.join("program-mic-received.json"));
                std::thread::Builder::new().name("program-mic-ingest".into()).spawn(move || {
                    unsafe extern "C" { fn pthread_set_qos_class_self_np(class:u32,relative:i32)->i32; }
                    let reader_qos = unsafe { pthread_set_qos_class_self_np(0x19,0) };
                    let mut packet = [0u8;968];
                    let mut received = 0u64;
                    let mut last_stamp = 0;
                    let mut out_of_order = 0;
                    while input.read_exact(&mut packet).is_ok() {
                        let stamp = u64::from_le_bytes(packet[..8].try_into().unwrap());
                        let samples = std::array::from_fn(|i| i16::from_le_bytes([packet[8+i*2],packet[9+i*2]]));
                        mic_guest.push_host_mic(stamp,samples);
                        received += 1;
                        if stamp <= last_stamp { out_of_order += 1; }
                        last_stamp = stamp;
                    }
                    if let Some(path) = trace_path {
                        let summary = serde_json::json!({"received": received, "nonmonotonic": out_of_order,"reader_qos_status":reader_qos,"requested_socket_bytes":bytes});
                        let _ = fs::write(path, summary.to_string());
                    }
                })?;
                let fd = output.as_raw_fd();
                command.env("PRODUCER_P0_PROGRAM_MIC","1").env("PRODUCER_P0_MIC_FD",fd.to_string());
                unsafe { command.pre_exec(move || {
                    if libc::fcntl(fd,libc::F_SETFD,0) == -1 {return Err(std::io::Error::last_os_error());}
                    Ok(())
                }); }
                mic_socket = Some(output);
            }
            command.env("LIVEKIT_LAB_PHYSICAL_CAPTURE","1").env("LIVEKIT_LAB_GUEST_MONITOR","1")
                .env("LIVEKIT_LAB_PHYSICAL_SPEECH",root.join("silence.wav")).env("PRODUCER_P0_DEVICE_PROOF",&run);
        }
        let child = command.env("PATH", "/usr/bin:/bin")
            .env("HOME", root).env("LIVEKIT_LAB_URL", if cfg!(debug_assertions) && root.join("p0-fixed-ssrc").is_file() { "ws://127.0.0.1:7885" } else { "ws://127.0.0.1:7880" })
            .arg("transport").arg(token).arg(run.join("host.json")).arg(if root.join("p0-sustained").is_file() {"155"} else {"22"})
            .env("PRODUCER_P0_PIPE","1").stdin(Stdio::from(OwnedFd::from(writer))).stdout(log.try_clone()?).stderr(log)
            .spawn().context("Start bundled loopback guest probe")?;
        drop(mic_socket);
        let pid = child.id();
        self.0 = Some(child);
        Ok((pid,guest))
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 { let _ = child.kill(); let _ = child.wait(); }
    }
}
