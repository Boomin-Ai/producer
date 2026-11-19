use crate::{Error, Result, VideoFrame, MAX_PLAYERS};
use producer_production_contract::Time;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

static WORKERS: AtomicUsize = AtomicUsize::new(0);
pub fn active_workers() -> usize {
    WORKERS.load(Ordering::Acquire)
}

/// Decoder is created and destroyed on its worker. It need not be Send.
pub trait Decoder {
    fn seek(&mut self, at: Time, cancel: &Cancellation) -> Result<VideoFrame>;
    fn statistics(&self) -> DecodeStatistics {
        DecodeStatistics::default()
    }
}
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeStatistics {
    pub seek_calls: u64,
    pub decoded_frames: u64,
}
pub struct Cancellation {
    shared: Arc<Shared>,
    generation: u64,
    deadline: Instant,
}
impl Cancellation {
    pub fn check(&self) -> Result<()> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if self.shared.generation.load(Ordering::Acquire) != self.generation {
            return Err(Error::Superseded);
        }
        if Instant::now() >= self.deadline {
            return Err(Error::Limit("decode deadline"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestId(pub u64);
#[derive(Debug)]
pub struct Reply {
    pub request: RequestId,
    pub requested: Time,
    pub elapsed: Duration,
    pub request_latency: Duration,
    pub frame: Result<VideoFrame>,
    pub statistics: DecodeStatistics,
}
struct Request {
    generation: u64,
    at: Time,
    submitted: Instant,
}
struct Shared {
    closed: AtomicBool,
    generation: AtomicU64,
    pending: Mutex<Option<Request>>,
    ready: Mutex<Option<Reply>>,
    wake: Condvar,
}
pub struct Player {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}
struct WorkerPermit;
struct WorkerExit(Arc<Shared>);
impl Drop for WorkerExit {
    fn drop(&mut self) {
        self.0.closed.store(true, Ordering::Release);
    }
}
impl Drop for WorkerPermit {
    fn drop(&mut self) {
        WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}
impl Player {
    /// Called from the control lane, not an audio/video callback. Open itself is asynchronous.
    pub fn start<F, D>(open: F) -> Result<Self>
    where
        F: FnOnce() -> Result<D> + Send + 'static,
        D: Decoder + 'static,
    {
        WORKERS
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_PLAYERS).then_some(n + 1)
            })
            .map_err(|_| Error::Limit("decoder workers"))?;
        let permit = WorkerPermit;
        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            pending: Mutex::new(None),
            ready: Mutex::new(None),
            wake: Condvar::new(),
        });
        let state = shared.clone();
        let thread = thread::Builder::new()
            .name("producer-media".into())
            .spawn(move || {
                let _permit = permit;
                let _exit = WorkerExit(state.clone());
                let mut decoder = open();
                loop {
                    let mut slot = state.pending.lock().unwrap();
                    while slot.is_none() && !state.closed.load(Ordering::Acquire) {
                        slot = state.wake.wait(slot).unwrap();
                    }
                    if state.closed.load(Ordering::Acquire) {
                        break;
                    }
                    let request = slot.take().unwrap();
                    drop(slot);
                    let start = Instant::now();
                    let cancel = Cancellation {
                        shared: state.clone(),
                        generation: request.generation,
                        deadline: start + Duration::from_secs(2),
                    };
                    let result = match &mut decoder {
                        Ok(d) => cancel.check().and_then(|()| d.seek(request.at, &cancel)),
                        Err(e) => Err(e.clone()),
                    };
                    let statistics = decoder.as_ref().map(|d| d.statistics()).unwrap_or_default();
                    if !state.closed.load(Ordering::Acquire)
                        && state.generation.load(Ordering::Acquire) == request.generation
                    {
                        let mut ready = state.ready.lock().unwrap();
                        // Recheck after taking the publication lock; poll also fences every reply.
                        if !state.closed.load(Ordering::Acquire)
                            && state.generation.load(Ordering::Acquire) == request.generation
                        {
                            *ready = Some(Reply {
                                request: RequestId(request.generation),
                                requested: request.at,
                                elapsed: start.elapsed(),
                                request_latency: request.submitted.elapsed(),
                                frame: result,
                                statistics,
                            });
                        }
                    }
                }
                // Both native decoder disposal and the permit release occur here.
            })
            .map_err(|e| Error::Decode(e.to_string()))?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }
    /// Replaces the pending scrub. It never waits for file IO, decode or a busy mutex.
    pub fn request(&self, at: Time) -> Result<RequestId> {
        let mut slot = self.shared.pending.try_lock().map_err(|_| Error::Busy)?;
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let generation = self
            .shared
            .generation
            .load(Ordering::Acquire)
            .checked_add(1)
            .ok_or(Error::Limit("generation"))?;
        self.shared.generation.store(generation, Ordering::Release);
        *slot = Some(Request {
            generation,
            at,
            submitted: Instant::now(),
        });
        self.shared.wake.notify_one();
        Ok(RequestId(generation))
    }
    pub fn poll(&self) -> Result<Option<Reply>> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let mut ready = self.shared.ready.try_lock().map_err(|_| Error::Busy)?;
        Ok(ready
            .take()
            .filter(|r| r.request.0 == self.shared.generation.load(Ordering::Acquire)))
    }
    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::Release);
        // A short control-state lock prevents lost wakeup; no decoder owns this during IO.
        // UI callers should use request/poll; close runs on the control executor.
        let mut pending = self.shared.pending.lock().unwrap();
        *pending = None;
        self.shared.wake.notify_one();
    }
    /// Join belongs to shutdown/control execution, never the UI or media callback.
    pub fn shutdown(mut self) -> Result<()> {
        self.close();
        self.thread
            .take()
            .unwrap()
            .join()
            .map_err(|_| Error::Decode("decoder worker panicked".into()))
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        self.close();
    }
}
