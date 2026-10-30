//! A bounded post-fader microphone envelope for trusted Set graphics.
//! Meter sampling stays on the engine thread; graphics reads one atomic value.
use std::sync::{atomic::{AtomicU64, Ordering}, OnceLock};
use std::time::Instant;
static START:OnceLock<Instant>=OnceLock::new();
static SAMPLE:AtomicU64=AtomicU64::new(0);
pub fn publish(level:f32){
 let now=START.get_or_init(Instant::now).elapsed().as_millis() as u32;
 let level=if level.is_finite(){level.clamp(0.,1.)}else{0.};
 SAMPLE.store(((now as u64)<<32)|(level*1_000_000.) as u64,Ordering::Relaxed);
}
fn sample_level(packed:u64,now:u32)->f32{
 let age=now.wrapping_sub((packed>>32) as u32);
 if age>=350{return 0.;}
 let level=(packed as u32) as f32/1_000_000.;
 let decay=if age<=150{1.}else{(350-age) as f32/200.};
 (level*decay).clamp(0.,1.)
}
#[no_mangle]
pub extern "C" fn producer_audio_reactive_level()->f32{
 let Some(start)=START.get()else{return 0.;};
 sample_level(SAMPLE.load(Ordering::Relaxed),start.elapsed().as_millis() as u32)
}
#[cfg(test)] mod tests{
 use super::*;
 #[test]fn silence_and_expiry(){let v=(100u64<<32)|500_000;assert_eq!(sample_level(v,100),0.5);assert_eq!(sample_level(v,450),0.);assert!(sample_level(v,350)<0.5);}
 #[test]fn timestamp_wrap(){let v=((u32::MAX-30)as u64)<<32|1_000_000;assert_eq!(sample_level(v,20),1.);}
 #[test]fn bad_values_are_silent(){publish(f32::NAN);assert_eq!(producer_audio_reactive_level(),0.);}
}
