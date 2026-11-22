//! Device-owned peer session. Signaling codes are available only on explicit
//! local request. The ordinary room snapshot contains route and health only.
use crate::{p0_call::Guest,rtc_signaling as signal};
use std::sync::atomic::{AtomicBool,Ordering};
use sha2::{Digest, Sha256};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write}, os::{fd::AsRawFd, unix::{net::UnixStream,process::CommandExt}},
    path::Path, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc,Mutex},
    time::{Duration,Instant}
};

pub struct Peer {
    child: Child,
    input: Arc<Mutex<ChildStdin>>,
    cancel: Arc<AtomicBool>,
    observed: Arc<Mutex<Observed>>,
    started: Instant,

}

struct Observed {
    status: Value,
    code: Option<Value>,
    ever_connected: bool,
    link: Option<String>,
    reply: Option<Value>,
}

pub fn idle() -> Value {
    json!({"phase":"idle","routePolicy":"directOnly","hostedRelayEnabled":false})
}

/// A portable room file must never transfer a qualification to another Mac.
pub fn capacity(root:&Path)->Value {
    let unknown=json!({"testedGuests":null,"productionQualified":false});
    let Ok(bytes)=std::fs::read(root.join("rtc-capacity.json")) else {return unknown};
    let Ok(receipt)=serde_json::from_slice::<Value>(&bytes) else {return unknown};
    let Ok(device)=Command::new("/usr/sbin/ioreg").args(["-rd1","-c","IOPlatformExpertDevice"]).output() else {return unknown};
    use sha2::{Digest,Sha256};
    let registry=String::from_utf8_lossy(&device.stdout);
    let Some(uuid)=registry.lines().find_map(|line|line.split_once("\"IOPlatformUUID\" = \"").and_then(|(_,id)|id.strip_suffix('"'))) else {return unknown};
    if receipt["deviceKey"]!=format!("{:x}",Sha256::digest(uuid.as_bytes())) {return unknown}
    json!({"testedGuests":receipt["testedGuests"],"workload":receipt["workload"],"productionQualified":false})
}

pub fn description(code:&str, kind:&str) -> Result<Value> {
    if code.len()>96000 { bail!("Call code is too large"); }
    let d:Value=serde_json::from_str(code).context("Copy a Producer RTC call code first")?;
    let sdp=d["sdp"].as_str().unwrap_or_default();
    if d["protocol"]!="producer-rtc/1" || d["type"]!=kind || !sdp.starts_with("v=0") ||
        !sdp.contains("a=fingerprint:sha-256 ") || !sdp.contains("a=candidate:") ||
        sdp.lines().any(|l|l.contains(" typ relay")) {
        bail!("Expected a direct Producer RTC {kind} code");
    }
    Ok(d)
}

impl Peer {
    pub fn start(root:&Path, room_link:Option<&str>, lan:bool, rehearsal:bool, start_muted:bool, display_name:Option<&str>, program:Arc<Mutex<Option<Arc<crate::platform::Shared>>>>) -> Result<(Self,Guest)> {
        let join=room_link.map(signal::parse).transpose()?;
        let session_id=crate::stage_history::new_id()?;
        let identity=if join.is_some(){Some(json!({"id":crate::stage_history::participant(root)?,"name":crate::stage_history::name(display_name.or(if rehearsal{Some("Witness guest")}else{None}))}))}else{None};
        let mut host=None;
        if join.is_none() {
            let cfg:Value=serde_json::from_slice(&std::fs::read(root.join("rtc-signaling.json")).context("Configure the studio signaling service first")?)?;
            host=Some((signal::origin(cfg["origin"].as_str().context("Missing signaling origin")?)?,cfg["createKey"].as_str().context("Missing studio signaling credential")?.to_owned()));
        }
        let helper=std::env::current_exe()?.with_file_name("producer-rtc");
        let (reader,writer)=UnixStream::pair()?;
        let fd=writer.as_raw_fd();
        let (stage_reader, stage_writer)=UnixStream::pair()?;
        let stage_fd=join.is_none().then(||stage_reader.as_raw_fd());
        let media=Guest::from_socket(root.join("producer-rtc-session"),reader)?;
        let mut command=Command::new(helper);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        command.env("PRODUCER_RTC_MEDIA_FD",fd.to_string());
        if join.is_some(){command.arg("--stage-monitor");}
        if start_muted {command.arg("--start-muted");}
        if lan {command.arg("--lan");}
        if rehearsal {command.arg("--rehearsal");} else {command.arg("--camera");}
        if let Some(fd)=stage_fd {command.env("PRODUCER_STAGE_RETURN_FD",fd.to_string());}
        unsafe { command.pre_exec(move ||{
            if libc::fcntl(fd,libc::F_SETFD,0)<0 { return Err(std::io::Error::last_os_error()); }
            if let Some(s)=stage_fd {if libc::fcntl(s,libc::F_SETFD,0)<0 {return Err(std::io::Error::last_os_error());}}
            Ok(())
        }); }
        let mut child=command.spawn().context("Open bundled Producer RTC peer")?;
        drop(writer);
        drop(stage_reader);
        let stdout=child.stdout.take().unwrap();
        let input=child.stdin.take().unwrap();
        let observed=Arc::new(Mutex::new(Observed {
            status:json!({"sessionId":session_id,"role":if join.is_none(){"host"}else{"guest"},"phase":"gathering","routePolicy":"directOnly","hostedRelayEnabled":false,"discovery":if lan{"local interfaces"}else{"STUN + local interfaces"}}),
            code:None,ever_connected:false,link:None,reply:None
        }));
        let thread_state=observed.clone();
        let peer=Self{child,input:Arc::new(Mutex::new(input)),observed,started:Instant::now(),cancel:Arc::new(AtomicBool::new(false))};
        if stage_fd.is_some() {
            let done=peer.cancel.clone();
            let mut sink=stage_writer;
            let health=peer.observed.clone();
            // This dedicated writer can block during helper startup. Ending the peer closes its socket.
            std::thread::Builder::new().name("producer-stage-return".into()).spawn(move || {
                let mut pixels=vec![0u8;640*360*3/2];
                let mut sent=0u64;
                while !done.load(Ordering::Acquire) {
                    let tick=Instant::now();
                    let frame=program.lock().unwrap().as_ref().and_then(|m|m.frame(3));
                    if let Some(f)=frame {
                        extern "C" {fn nr_stage_copy(frame:*mut std::ffi::c_void,out:*mut u8)->bool;}
                        if unsafe{nr_stage_copy(f.ptr.as_ptr(),pixels.as_mut_ptr())} {
                            if sink.write_all(&pixels).is_err(){health.lock().unwrap().status["stageReturn"]=json!("closed");break;}
                            sent+=1;
                            if sent%30==1 {health.lock().unwrap().status["stageReturnFrames"]=json!(sent);}
                        } else {health.lock().unwrap().status["stageReturn"]=json!("unsupported surface");}
                    }
                    std::thread::sleep(Duration::from_millis(33).saturating_sub(tick.elapsed()));
                }
            })?;
        }
        std::thread::Builder::new().name("producer-rtc-events".into()).spawn(move ||{
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(event)=serde_json::from_str::<Value>(&line) else {continue};
                let mut s=thread_state.lock().unwrap();
                if let Some(d)=event.get("description") {
                    s.code=Some(d.clone()); s.status["codeReady"]=json!(true);
                    if !s.ever_connected {s.status["phase"]=json!("waiting");}
                }
                if let Some(phase)=event.get("phase") {
                    s.status["phase"]=phase.clone(); s.ever_connected |= phase=="connected";
                    if phase=="connected" {s.status["pendingAdmission"]=json!(false);s.code=None;s.status["codeReady"]=json!(false);}
                }
                for k in ["reason","warning","stats","stageTally","guestMuted","microphoneEnabled","cameraEnabled"] {if let Some(v)=event.get(k){s.status[k]=v.clone();}}
            }
            let mut s=thread_state.lock().unwrap();
            if s.status["phase"]!="failed" {s.status["phase"]=json!("ended");}
            s.code=None;s.status["codeReady"]=json!(false);
        })?;
        let shared=peer.observed.clone();
        let sink=peer.input.clone();
        let cancel=peer.cancel.clone();
        std::thread::Builder::new().name("producer-room-link".into()).spawn(move ||{
            let exchange=(|| -> Result<()> {
                let limit=Instant::now()+Duration::from_secs(115);
                let active=|| !cancel.load(Ordering::Acquire) && Instant::now()<limit;
                if let Some(link)=&join {
                    let offer=signal::request("GET",&format!("{}/offer",link.page),&link.guest,None)?;
                    Self::write(&sink,&json!({"description":description(&offer.to_string(),"offer")?}))?;
                } else {Self::write(&sink,&json!({"offer":true}))?;}
                let mut code=loop{
                    if !active(){bail!("Room link expired");}
                    if let Some(d)=shared.lock().unwrap().code.clone(){break d;}
                    std::thread::sleep(Duration::from_millis(80));
                };
                if let Some(link)=join {
                    code["guest"]=json!(identity);
                    shared.lock().unwrap().status["answerFingerprint"]=json!(format!("{:x}",Sha256::digest(code["sdp"].as_str().context("Missing answer SDP")?.as_bytes())));
                    signal::request("POST",&format!("{}/answer",link.page),&link.guest,Some(&code))?;
                    shared.lock().unwrap().status["pendingAdmission"]=json!(true);
                    return Ok(());
                }
                let (base,key)=host.unwrap();
                let created=signal::request("POST",&format!("{base}/sessions"),&key,Some(&code))?;
                let url=created["link"].as_str().context("Missing room link")?;
                let link=signal::parse(url)?;
                if url::Url::parse(&link.page)?.origin().ascii_serialization()!=base {bail!("Signaling origin changed");}
                let owner=created["owner"].as_str().context("Missing room owner capability")?;
                {let mut s=shared.lock().unwrap();s.link=Some(url.into());s.status["linkReady"]=json!(true);}
                let result=(||->Result<()>{
                    while active(){
                        let r=signal::request("GET",&format!("{}/answer",link.page),owner,None)?;
                        if !r["answer"].is_null(){
                            let reply=description(&r["answer"].to_string(),"answer")?;
                            let mut s=shared.lock().unwrap();
                            s.status["displayName"]=json!(crate::stage_history::name(reply["guest"]["name"].as_str()));
                            let id=reply["guest"]["id"].as_str().filter(|v|v.len()==32 && v.bytes().all(|c|c.is_ascii_hexdigit())).unwrap_or(&session_id);
                            s.status["participantId"]=json!(id);s.reply=Some(reply);s.status["admitReady"]=json!(true);
                            s.status["linkReady"]=json!(false);s.link=None;return Ok(());
                        }
                        std::thread::sleep(Duration::from_millis(750));
                    }
                    bail!("Room link expired")
                })();
                let _=signal::request("POST",&format!("{}/close",link.page),owner,None);
                result
            })();
            if let Err(e)=exchange {let mut s=shared.lock().unwrap();s.status["phase"]=json!("failed");s.status["reason"]=json!(e.to_string());s.status["linkReady"]=json!(false);s.link=None;}
        })?;
        Ok((peer,media))
    }
    fn write(input:&Mutex<ChildStdin>,cmd:&Value)->Result<()> {
        let mut w=input.lock().unwrap();serde_json::to_writer(&mut *w,cmd)?;w.write_all(b"\n")?;w.flush()?;Ok(())
    }
    pub fn set_media(&self, microphone:Option<bool>,camera:Option<bool>)->Result<()> {
        if let Some(on)=microphone {Self::write(&self.input,&json!({"microphone":on}))?;}
        if let Some(on)=camera {Self::write(&self.input,&json!({"camera":on}))?;}
        Ok(())
    }
    pub fn mute_guest(&self, muted:bool)->Result<()> {
        Self::write(&self.input,&json!({"guestMuted":muted}))
    }
    pub fn tally(&self, staged:bool)->Result<()> {Self::write(&self.input,&json!({"stage":staged}))}
    pub fn admit(&mut self, attestation:Option<(&str,&str,&str)>)->Result<()> {
        let mut s=self.observed.lock().unwrap();
        let reply=s.reply.as_ref().context("No guest is waiting for admission")?;
        if let Some((session, fingerprint, brand)) = attestation {
            let hash = format!("{:x}", Sha256::digest(reply["sdp"].as_str().context("Missing answer SDP")?.as_bytes()));
            if s.status["sessionId"] != session || hash != fingerprint || brand.trim().is_empty() {
                bail!("Workspace admission no longer matches the waiting peer");
            }
        }
        Self::write(&self.input,&json!({"description":reply}))?;
        if let Some((_,_,brand))=attestation {s.status["verifiedBoominBrand"]=json!(crate::stage_history::name(Some(brand)));}
        s.reply=None;s.status["admitReady"]=json!(false);Ok(())
    }
    pub fn link(&self)->Result<String>{
        self.observed.lock().unwrap().link.clone().context("Room link is not ready")
    }
    pub fn status(&mut self)->Value {
        let mut s=self.observed.lock().unwrap();
        if !s.ever_connected && self.started.elapsed()>Duration::from_secs(120) && !matches!(s.status["phase"].as_str(),Some("ended"|"failed")) {
            s.status["phase"]=json!("failed");s.status["reason"]=json!("Direct call timed out. End the call and create a fresh invite.");
        }
        if s.status["phase"]=="failed" && !self.cancel.swap(true,Ordering::AcqRel) {
            let _=self.child.kill();
            s.code=None;s.reply=None;s.link=None;
            s.status["linkReady"]=json!(false);s.status["admitReady"]=json!(false);
        }
        let stats = &s.status["stats"];
        let direct = |kind: &Value| matches!(kind.as_str(), Some("host" | "srflx" | "prflx"));
        let route = if s.status["phase"] == "connected" && direct(&stats["local"]) && direct(&stats["remote"]) {
            "direct"
        } else { "unconfirmed" };
        if s.status["mediaRoute"] != route {
            s.status["mediaRoute"] = json!(route);
            s.status["mediaRouteSinceMs"] = json!(self.started.elapsed().as_millis());
        }
        s.status.clone()
    }
}
impl Drop for Peer {fn drop(&mut self){self.cancel.store(true,Ordering::Release);let _=self.child.kill();let _=self.child.wait();}}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_rejects_wrong_role_and_relay() {
        let mut d=json!({"protocol":"producer-rtc/1","type":"offer","sdp":"v=0\r\na=fingerprint:sha-256 FF\r\na=candidate:1 1 udp 1 127.0.0.1 1 typ host\r\n"});
        assert!(description(&d.to_string(),"offer").is_ok());
        assert!(description(&d.to_string(),"answer").is_err());
        d["sdp"]=json!(d["sdp"].as_str().unwrap().replace("typ host","typ relay"));
        assert!(description(&d.to_string(),"offer").is_err());
    }
}
