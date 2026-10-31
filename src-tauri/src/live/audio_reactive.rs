//! A bounded post-fader microphone envelope for trusted Set graphics.
//! Audio callbacks publish per-input atomics; graphics reads them every frame.
use std::sync::{atomic::{AtomicU64,AtomicUsize, Ordering}, OnceLock};
use std::time::Instant;
static START:OnceLock<Instant>=OnceLock::new();
static SAMPLE:AtomicU64=AtomicU64::new(0);
struct Input {key:AtomicUsize,sample:AtomicU64,gain:AtomicU64}
static INPUTS:[Input;16]=[const{Input{key:AtomicUsize::new(0),sample:AtomicU64::new(0),gain:AtomicU64::new(0)}};16];
fn packed(level:f32,now:u32)->u64{let level=if level.is_finite(){level.clamp(0.,1.)}else{0.};((now as u64)<<32)|(level*1_000_000.) as u64}
pub fn register(key:usize,gain:f32,muted:bool){
 START.get_or_init(Instant::now);
 if key==0{return;}
 for input in &INPUTS{if input.key.compare_exchange(0,key,Ordering::Relaxed,Ordering::Relaxed).is_ok(){input.sample.store(0,Ordering::Relaxed);input.gain.store(if muted{0}else{(gain.clamp(0.,1.)*1_000_000.) as u64},Ordering::Relaxed);return;}}
}
pub fn configure(key:usize,gain:f32,muted:bool){for input in &INPUTS{if input.key.load(Ordering::Relaxed)==key{input.gain.store(if muted{0}else{(gain.clamp(0.,1.)*1_000_000.) as u64},Ordering::Relaxed);}}}
pub fn unregister(key:usize){for input in &INPUTS{if input.key.load(Ordering::Relaxed)==key{input.key.store(0,Ordering::Relaxed);input.sample.store(0,Ordering::Relaxed);input.gain.store(0,Ordering::Relaxed);}}}
/// Audio callback: no allocation, locks, source calls or destructive meter reads.
pub fn audio_sample(key:usize,level:f32){
 let Some(start)=START.get()else{return;};let now=start.elapsed().as_millis() as u32;
 for input in &INPUTS{if input.key.load(Ordering::Relaxed)==key{input.sample.store(packed(level,now),Ordering::Relaxed);return;}}
}
pub fn publish(level:f32){
 let now=START.get_or_init(Instant::now).elapsed().as_millis() as u32;
 let level=if level.is_finite(){level.clamp(0.,1.)}else{0.};
 SAMPLE.store(((now as u64)<<32)|(level*1_000_000.) as u64,Ordering::Relaxed);
}
fn sample_level(packed:u64,now:u32)->f32{
 let age=now.wrapping_sub((packed>>32) as u32);
 if age>=120{return 0.;}
 let level=(packed as u32) as f32/1_000_000.;
 let decay=if age<=40{1.}else{(120-age) as f32/80.};
 (level*decay).clamp(0.,1.)
}
#[no_mangle]
pub extern "C" fn producer_audio_reactive_level()->f32{
 let Some(start)=START.get()else{return 0.;};
 let now=start.elapsed().as_millis() as u32;
 let mut level=sample_level(SAMPLE.load(Ordering::Relaxed),now);
 for input in &INPUTS{if input.key.load(Ordering::Relaxed)!=0{level=level.max(sample_level(input.sample.load(Ordering::Relaxed),now)*input.gain.load(Ordering::Relaxed) as f32/1_000_000.);}}
 // About -44 dBFS: keep background hiss from animating the graphic.
 if level<0.006{0.}else{((level-0.006)/0.994).clamp(0.,1.)}
}
#[cfg(test)] mod tests{
 use super::*;
 #[test]fn silence_and_expiry(){let v=(100u64<<32)|500_000;assert_eq!(sample_level(v,100),0.5);assert_eq!(sample_level(v,450),0.);assert!(sample_level(v,180)<0.5);}
 #[test]fn timestamp_wrap(){let v=((u32::MAX-30)as u64)<<32|1_000_000;assert_eq!(sample_level(v,5),1.);}
 #[test]fn direct_audio_mute_gain_and_cleanup(){let key=999;register(key,0.5,false);audio_sample(key,0.8);assert!(producer_audio_reactive_level()>0.3);configure(key,1.,true);assert_eq!(producer_audio_reactive_level(),0.);configure(key,0.,false);assert_eq!(producer_audio_reactive_level(),0.);unregister(key);assert_eq!(producer_audio_reactive_level(),0.);publish(f32::NAN);assert_eq!(producer_audio_reactive_level(),0.);}
}

/// Read-only source identity/gain for native transcription; no microphone activation.
pub fn first_input()->Option<usize>{INPUTS.iter().find_map(|i|{let key=i.key.load(Ordering::Acquire);(key!=0&&i.gain.load(Ordering::Relaxed)>0).then_some(key)})}
pub fn input_gain(key:usize)->Option<f32>{INPUTS.iter().find(|i|i.key.load(Ordering::Acquire)==key&&key!=0).map(|i|i.gain.load(Ordering::Relaxed) as f32/1_000_000.)}
