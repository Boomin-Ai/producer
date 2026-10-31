//! Native streaming transcription. Credentials never cross IPC; audio callback
//! writes only a bounded atomic ring. Networking and serialization run off-thread.
use std::sync::{atomic::{AtomicBool,AtomicU32,AtomicU64,AtomicUsize,Ordering},OnceLock};
use futures_util::{SinkExt,StreamExt};
use tauri::Emitter;
use tokio_tungstenite::{connect_async,tungstenite::{client::IntoClientRequest,Message}};
const CAP:usize=16384; // ~341 ms at the engine's fixed 48 kHz, mono.
static RING:OnceLock<Vec<AtomicU32>>=OnceLock::new();
static WRITE:AtomicUsize=AtomicUsize::new(0);
static READ:AtomicUsize=AtomicUsize::new(0);
static SOURCE:AtomicUsize=AtomicUsize::new(0);
static GENERATION:AtomicU64=AtomicU64::new(0);
static ACTIVE:AtomicBool=AtomicBool::new(false);
const CREDENTIAL:&str="deepgram-live-transcription";
#[derive(Clone,serde::Serialize)]
pub struct Update {pub session:u64,pub state:String,pub text:String,pub is_final:bool,pub message:Option<String>}
fn emit(app:&tauri::AppHandle,session:u64,state:&str,text:String,is_final:bool,message:Option<String>){let _=app.emit("live://transcript",Update{session,state:state.into(),text,is_final,message});}
/// Single selected microphone producer; no locks, allocation, networking or OBS calls.
pub unsafe fn capture(key:usize,plane:*const f32,frames:usize){
 if SOURCE.load(Ordering::Relaxed)!=key||!ACTIVE.load(Ordering::Relaxed)||plane.is_null()||frames>8192{return;}
 let Some(gain)=super::audio_reactive::input_gain(key)else{return;};if gain<=0.{return;}
 let Some(ring)=RING.get()else{return;};let start=WRITE.load(Ordering::Relaxed);
 for i in 0..frames {let v=*plane.add(i)*gain;ring[(start+i)%CAP].store(if v.is_finite(){v.clamp(-1.,1.).to_bits()}else{0},Ordering::Relaxed);}
 let end=start+frames;READ.fetch_max(end.saturating_sub(CAP),Ordering::AcqRel);WRITE.store(end,Ordering::Release);
}
fn drain()->Vec<u8>{
 let Some(ring)=RING.get()else{return vec![];};let end=WRITE.load(Ordering::Acquire);let start=READ.load(Ordering::Relaxed).max(end.saturating_sub(CAP));
 let mut bytes=Vec::with_capacity((end-start)*2);
 for i in start..end {let f=f32::from_bits(ring[i%CAP].load(Ordering::Relaxed));let v=(f.clamp(-1.,1.)*32767.) as i16;bytes.extend_from_slice(&v.to_le_bytes());}
 READ.fetch_max(end,Ordering::AcqRel);bytes
}
fn key()->Result<String,String>{
 #[cfg(feature="sets-v2-dev")]
 {
  let path=std::path::PathBuf::from(std::env::var_os("HOME").ok_or("Home directory unavailable")?).join("Library/Application Support/ai.boomin.producer.sets-v2-dev/secrets/deepgram-key.txt");
  if let Ok(raw)=std::fs::read_to_string(path){let value=raw.trim().trim_matches('"').trim();let value=value.strip_prefix("Token ").unwrap_or(value);if !value.is_empty()&&value.len()<512&&value.bytes().all(|b|b.is_ascii_graphic()) {super::creds::store(CREDENTIAL,value).map_err(|_|"Could not secure the Deepgram key in the OS keychain")?;return Ok(value.into());}}
 }
 super::creds::resolve(CREDENTIAL).map_err(|_|"Save a Deepgram key before starting captions".into())
}
pub fn stop(session:u64){if GENERATION.load(Ordering::Acquire)==session{GENERATION.fetch_add(1,Ordering::AcqRel);ACTIVE.store(false,Ordering::Release);SOURCE.store(0,Ordering::Release);READ.store(WRITE.load(Ordering::Acquire),Ordering::Release);}}
pub async fn start(app:tauri::AppHandle)->Result<u64,String>{
 if ACTIVE.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err("Captions are already running".into());}
 let session=GENERATION.fetch_add(1,Ordering::AcqRel)+1;
 let result:Result<u64,String>=async {
  let source=super::audio_reactive::first_input().ok_or("Add and unmute a microphone before starting captions")?;
  let secret=key()?;
  RING.get_or_init(||(0..CAP).map(|_|AtomicU32::new(0)).collect());READ.store(WRITE.load(Ordering::Acquire),Ordering::Release);
  let mut request="wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=48000&channels=1&interim_results=true&endpointing=300&punctuate=true&smart_format=true".into_client_request().map_err(|_|"Invalid transcription connection")?;
  request.headers_mut().insert("Authorization",format!("Token {secret}").parse().map_err(|_|"Invalid Deepgram key format")?);
  emit(&app,session,"connecting",String::new(),false,None);
  let connection=tokio::time::timeout(std::time::Duration::from_secs(10),connect_async(request)).await.map_err(|_|"Deepgram connection timed out")?.map_err(|_|"Deepgram connection failed; check the key, access and network")?;
  if GENERATION.load(Ordering::Acquire)!=session{return Err("Caption start was canceled".into());}
  SOURCE.store(source,Ordering::Release);emit(&app,session,"listening",String::new(),false,None);
  tauri::async_runtime::spawn(async move {
   let (mut sink,mut stream)=connection.0.split();let mut ticker=tokio::time::interval(std::time::Duration::from_millis(40));let mut committed=String::new();let mut last_audio=std::time::Instant::now();let mut failure=None;
   loop {
    if GENERATION.load(Ordering::Acquire)!=session {break;}
    tokio::select!{
     _=ticker.tick()=>{
      if GENERATION.load(Ordering::Acquire)!=session {break;}
      if super::audio_reactive::input_gain(source).is_none(){failure=Some("Caption microphone disconnected. Select a microphone and restart captions.".to_string());break;}
      let bytes=drain();
      if !bytes.is_empty(){if !matches!(tokio::time::timeout(std::time::Duration::from_secs(2),sink.send(Message::Binary(bytes))).await,Ok(Ok(()))){failure=Some("Transcription connection interrupted".into());break;}last_audio=std::time::Instant::now();}
      else if last_audio.elapsed().as_secs()>=3{if !matches!(tokio::time::timeout(std::time::Duration::from_secs(2),sink.send(Message::Text("{\"type\":\"KeepAlive\"}".into()))).await,Ok(Ok(()))){failure=Some("Transcription connection interrupted".into());break;}last_audio=std::time::Instant::now();}
     },
     incoming=stream.next()=>{match incoming{
      Some(Ok(Message::Text(raw)))=>{
       if let Ok(v)=serde_json::from_str::<serde_json::Value>(&raw){
        if v["type"]=="Error"{failure=Some("Deepgram could not transcribe this stream".into());break;}
        if v["type"]=="Results"{
         let text=v["channel"]["alternatives"][0]["transcript"].as_str().unwrap_or("").trim();if text.is_empty(){if v["speech_final"].as_bool().unwrap_or(false){committed.clear();}continue;}
         let final_result=v["is_final"].as_bool().unwrap_or(false);
         let display=merge_caption(&committed,text);
         if final_result{committed=display.clone();}
         if GENERATION.load(Ordering::Acquire)==session{emit(&app,session,"listening",display,final_result,None);}
         if v["speech_final"].as_bool().unwrap_or(false){committed.clear();}
        }
       }
      },
      Some(Ok(Message::Ping(p)))=>{let _=sink.send(Message::Pong(p)).await;},
      Some(Ok(Message::Close(_)))|None|Some(Err(_))=>{failure=Some("Transcription connection closed. Restart captions to reconnect.".into());break;},
      _=>{}
     }}
    }
   }
   let _=tokio::time::timeout(std::time::Duration::from_secs(1),sink.send(Message::Text("{\"type\":\"CloseStream\"}".into()))).await;
   if GENERATION.load(Ordering::Acquire)==session{ACTIVE.store(false,Ordering::Release);SOURCE.store(0,Ordering::Release);emit(&app,session,if failure.is_some(){"error"}else{"stopped"},String::new(),false,failure);}
  });
  Ok(session)
 }.await;
 if result.is_err(){stop(session);}
 result.map_err(String::from)
}
fn merge_caption(committed:&str,partial:&str)->String{
 let joined=if committed.is_empty(){partial.to_string()}else{format!("{committed} {partial}")};let chars:Vec<char>=joined.chars().collect();if chars.len()<=160{return joined;}let tail:String=chars[chars.len()-160..].iter().collect();tail.split_once(' ').map(|(_,s)|s.to_string()).unwrap_or(tail)
}
#[cfg(test)]mod tests{use super::*;#[test]fn captions_bound_and_merge(){assert_eq!(merge_caption("one","two"),"one two");assert!(merge_caption("",&"é ".repeat(200)).chars().count()<=160);}}
