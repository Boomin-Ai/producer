//! Local guest program video has its own output deadline. Scene preparation
//! publishes an immutable snapshot; live guest input is sampled on each tick.
use crate::{p0_call::Guest, platform::{self, Draw, Frame, RenderTarget}, visuals::Visuals};
use producer_native_media::boundary::OutputSize;
use std::{sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},thread,time::{Duration,Instant}};

pub struct Scene {
    pub frames: [Option<Arc<Frame>>;8],
    pub draws: [Vec<Draw>;2],
    pub sizes: [OutputSize;2],
    pub visuals: Arc<Visuals>,
    pub dj_title: Option<Arc<platform::TextCache>>,
    pub revision: u64,
    pub guest_slot: Option<usize>,
}

#[derive(Default)]
struct State {
    latest: Mutex<Option<Arc<Scene>>>,
    stop: AtomicBool,
    sent: AtomicU64,
    refused: AtomicU64,
}

type TickLog = std::sync::mpsc::SyncSender<(u64,f64,f64,f64,f64,u8)>;

struct Slot {
    trace: Option<(TickLog,u64,f64,f64)>,
    scene: Arc<Scene>,
    frames: [Option<Arc<Frame>>;8],
    pts: f64,
    relief_at: Instant,
    accepted: std::sync::atomic::AtomicU8,
    state: Arc<State>,
}

fn render_worker(target: RenderTarget, state: Arc<State>, relief: bool)
    -> std::io::Result<(std::sync::mpsc::SyncSender<Arc<Slot>>,thread::JoinHandle<()>)> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Arc<Slot>>(1);
    let name = if relief {"program-render-relief"} else {"program-render"};
    let worker = thread::Builder::new().name(name.into()).spawn(move || {
        unsafe extern "C" { fn pthread_set_qos_class_self_np(class:u32,relative:i32)->i32; }
        unsafe { pthread_set_qos_class_self_np(0x21,0); }
        for slot in rx {
            if relief {
                thread::sleep(slot.relief_at.saturating_duration_since(Instant::now()));
            }
            for (i,size) in slot.scene.sizes.iter().enumerate() {
                let bit=1<<i;
                if slot.accepted.load(Ordering::Acquire)&bit != 0 {continue;}
                if target.render_with_dj(i,size.width,size.height,&slot.scene.draws[i],&slot.frames,
                    &slot.scene.visuals.text,slot.scene.dj_title.as_deref(),slot.pts,slot.scene.revision) {
                    slot.accepted.fetch_or(bit,Ordering::Release);
                    state.sent.fetch_add(1,Ordering::Relaxed);
                }
            }
        }
    })?;
    Ok((tx,worker))
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mask = self.accepted.load(Ordering::Acquire);
        if let Some((tx,tick,wake,late)) = &self.trace {
            let _ = tx.try_send((*tick,*wake,*late,self.pts,platform::host_time(),mask));
        }
        let missed = 2 - mask.count_ones();
        self.state.refused.fetch_add(u64::from(missed),Ordering::Relaxed);
    }
}
pub struct Clock { state:Arc<State>, worker:Option<thread::JoinHandle<()>> }
impl Clock {
    pub fn start(target:RenderTarget,guest:Guest)->std::io::Result<Self> {
        let state=Arc::new(State::default());
        let lane=state.clone();
        let profile=guest.run_dir().parent().expect("call profile");
        let reference=profile.join("p0-reference-clock").is_file();
        // Fixed fault for A/B qualification, selected separately from the ordinary witness.
        let mut overrun=cfg!(debug_assertions) && profile.join("p0-test-overrun").is_file();
        let trace=if profile.join("p0-trace").is_file() {
            use std::io::Write;
            let mut file=std::fs::File::create(guest.run_dir().join("ticks.csv"))?;
            writeln!(file,"tick,wake,late,pts,end,mask")?;
            let (tx,rx)=std::sync::mpsc::sync_channel::<(u64,f64,f64,f64,f64,u8)>(128);
            thread::Builder::new().name("p0-clock-log".into()).spawn(move||{
                for (i,w,l,p,e,m) in rx {if writeln!(file,"{i},{w:.9},{l:.9},{p:.9},{e:.9},{m}").is_err(){break;}}
            })?;Some(tx)
        }else{None};
        let (primary_tx,primary) = render_worker(target.clone(),state.clone(),false)?;
        let (relief_tx,relief) = render_worker(target,state.clone(),true)?;
        let worker=thread::Builder::new().name("program-video-clock".into()).spawn(move || {
            let period=Duration::from_nanos(1_000_000_000/30);
            // Interactive deadlines for local, paired program video.
            if !reference {
                unsafe extern "C" {fn pthread_set_qos_class_self_np(class:u32,relative:i32)->i32;}
                unsafe {pthread_set_qos_class_self_np(0x21,0);}
            }
            let experiment_start=Instant::now();
            let mut tick=0u64;
            let mut deadline=Instant::now();
            while !lane.stop.load(Ordering::Acquire) {
                tick+=1;
                let wake=platform::host_time();
                let late=Instant::now().saturating_duration_since(deadline).as_secs_f64();
                let scene=lane.latest.lock().unwrap().clone();
                if let Some(scene)=scene {
                    let mut frames=scene.frames.clone();
                    if let Some(slot)=scene.guest_slot {frames[slot]=guest.frame();}
                    let pts=platform::host_time();
                    let slot=Arc::new(Slot {scene, frames, pts, relief_at:Instant::now()+Duration::from_millis(8),
                        accepted:0.into(),state:lane.clone(),
                        trace:trace.as_ref().filter(|_|tick<=6000).map(|tx|(tx.clone(),tick,wake,late))});
                    let _=primary_tx.try_send(slot.clone());
                    let _=relief_tx.try_send(slot);
                    if overrun && experiment_start.elapsed()>=Duration::from_secs(9) {
                        overrun=false;
                        thread::sleep(Duration::from_millis(62));
                    }

                }
                deadline+=period;
                let now=Instant::now();
                if deadline<=now {
                    if reference {deadline=now+period;} else {
                        // Skip expired slots and keep the original 30 Hz phase.
                        let past=now.duration_since(deadline).as_nanos();
                        deadline=now+Duration::from_nanos((period.as_nanos()-past%period.as_nanos()) as u64);
                    }
                }
                thread::sleep(deadline.saturating_duration_since(now));
            }
            drop((primary_tx,relief_tx));
            let _=primary.join();
            let _=relief.join();
        })?;
        Ok(Self{state,worker:Some(worker)})
    }
    pub fn publish(&self,scene:Scene)->(u64,u64) {
        *self.state.latest.lock().unwrap()=Some(Arc::new(scene));
        (self.state.sent.swap(0,Ordering::Relaxed),self.state.refused.swap(0,Ordering::Relaxed))
    }
}
impl Drop for Clock {
    fn drop(&mut self) {
        self.state.stop.store(true,Ordering::Release);
        if let Some(worker)=self.worker.take(){let _=worker.join();}
    }
}
