//! Owned native delivery workers. No detached task, unbounded command queue,
//! retimestamping, or late-frame fallback. Reset fences concurrent producers.
use crate::{
    presentation::Scheduled,
    queue::{Captured, Queue},
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
// Existing lab shim changes only the disposable worker's macOS QoS.
pub(crate) fn worker_qos() -> Option<(i32, i32, i32)> {
    #[cfg(all(target_os = "macos", feature = "physical-aec"))]
    {
        unsafe extern "C" {
            fn lab_publisher_thread_qos(previous: *mut i32, effective: *mut i32) -> i32;
        }
        let (mut previous, mut effective) = (0, 0);
        let result = unsafe { lab_publisher_thread_qos(&mut previous, &mut effective) };
        Some((result, previous, effective))
    }
    #[cfg(not(all(target_os = "macos", feature = "physical-aec")))]
    {
        None
    }
}
struct State<T> {
    queue: Scheduled<T>,
    stopped: bool,
    max_tick_gap_us: u128,
    max_submit_us: u128,
    epoch: u64,
    qos: Option<(i32, i32, i32)>,
}
pub struct Deadline<T> {
    shared: Arc<(Mutex<State<T>>, Condvar, Mutex<()>)>,
    thread: Option<JoinHandle<()>>,
    contention: Arc<AtomicU64>,
    retired: Arc<AtomicU64>,
    failed: bool,
}
impl<T: Send + 'static> Deadline<T> {
    pub fn start(
        name: &str,
        capacity: usize,
        mut submit: impl FnMut(Instant, T) + Send + 'static,
    ) -> std::io::Result<Self> {
        let shared = Arc::new((
            Mutex::new(State {
                queue: Scheduled::new(capacity),
                stopped: false,
                max_tick_gap_us: 0,
                max_submit_us: 0,
                epoch: 0,
                qos: None,
            }),
            Condvar::new(),
            Mutex::new(()),
        ));
        let owner = shared.clone();
        let thread = thread::Builder::new().name(name.into()).spawn(move || {
            let (lock, wake, submission) = &*owner;
            lock.lock().unwrap().qos = worker_qos();
            let mut previous = Instant::now();
            loop {
                let serial = submission.lock().unwrap();
                let mut state = lock.lock().unwrap();
                let now = Instant::now();
                state.max_tick_gap_us = state
                    .max_tick_gap_us
                    .max(now.saturating_duration_since(previous).as_micros());
                previous = now;
                if state.stopped {
                    state.queue.clear();
                    break;
                }
                // Hold the same lock as reset. Once reset returns, a retired
                // publication can no longer be submitted, even if previously due.
                for _ in 0..capacity {
                    if state.stopped {
                        break;
                    }
                    let Some((stamp, value)) = state.queue.pop_due(Instant::now()) else {
                        break;
                    };
                    // Writers remain free to enqueue while native output runs.
                    drop(state);
                    let submit_started = Instant::now();
                    submit(stamp, value);
                    let submit_us = submit_started.elapsed().as_micros();
                    state = lock.lock().unwrap();
                    state.max_submit_us = state.max_submit_us.max(submit_us);
                }
                drop(serial);
                let _ = wake.wait_timeout(state, Duration::from_millis(2)).unwrap();
            }
        })?;
        Ok(Self {
            shared,
            thread: Some(thread),
            contention: Arc::new(AtomicU64::new(0)),
            retired: Arc::new(AtomicU64::new(0)),
            failed: false,
        })
    }
    /// A producer is tied to the publication epoch observed when acquired.
    /// Cloning it never retains the worker owner or its join handle.
    pub fn producer(&self) -> Producer<T> {
        Producer {
            shared: self.shared.clone(),
            contention: self.contention.clone(),
            retired: self.retired.clone(),
            epoch: self.shared.0.lock().unwrap().epoch,
        }
    }
    #[cfg(test)]
    pub fn push(&self, stamp: Instant, value: T) -> bool {
        self.producer().push(stamp, value)
    }
    #[cfg(test)]
    pub fn clear(&self) {
        let _serial = self.shared.2.lock().unwrap();
        self.shared.0.lock().unwrap().queue.clear();
    }
    /// Retire every previously acquired producer, including one currently
    /// computing a frame. Once reset returns, old output cannot be submitted.
    pub fn reset(&self) {
        let _serial = self.shared.2.lock().unwrap();
        let mut state = self.shared.0.lock().unwrap();
        state.epoch = state
            .epoch
            .checked_add(1)
            .expect("delivery epoch exhausted");
        state.queue.clear();
    }
    pub fn shutdown(&mut self) {
        self.shared
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stopped = true;
        self.shared.1.notify_all();
        if let Some(thread) = self.thread.take() {
            self.failed = thread.join().is_err();
        }
        self.shared
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .queue
            .clear();
    }
    pub fn report(&self) -> Value {
        let state = self.shared.0.lock().unwrap_or_else(|p| p.into_inner());
        let mut report = state.queue.report();
        report["enqueue_contention_dropped"] = json!(self.contention.load(Ordering::Relaxed));
        report["active_after_shutdown"] = json!(self.thread.is_some());
        report["worker_failed"] = json!(self.failed);
        report["max_tick_gap_us"] = json!(state.max_tick_gap_us);
        report["max_native_submit_us"] = json!(state.max_submit_us);
        report["publication_epoch"] = json!(state.epoch);
        report["retired_producer_dropped"] = json!(self.retired.load(Ordering::Relaxed));
        report["worker_qos_result_previous_effective"] = json!(state.qos);
        report
    }
}
/// Bounded enqueue handle. It cannot restart or own the delivery thread.
/// Epoch comparison and enqueue occur under the same queue lock as reset.
pub struct Producer<T> {
    shared: Arc<(Mutex<State<T>>, Condvar, Mutex<()>)>,
    contention: Arc<AtomicU64>,
    retired: Arc<AtomicU64>,
    epoch: u64,
}
impl<T> Clone for Producer<T> {
    fn clone(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            contention: self.contention.clone(),
            retired: self.retired.clone(),
            epoch: self.epoch,
        }
    }
}
impl<T> Producer<T> {
    pub fn reset_and_renew(&self) -> Self {
        let _serial = self.shared.2.lock().unwrap();
        let mut state = self.shared.0.lock().unwrap();
        // A retired coordinator cannot reset its replacement publication.
        if state.epoch != self.epoch || state.stopped {
            return self.clone();
        }
        state.epoch = state
            .epoch
            .checked_add(1)
            .expect("delivery epoch exhausted");
        state.queue.clear();
        Self {
            shared: self.shared.clone(),
            contention: self.contention.clone(),
            retired: self.retired.clone(),
            epoch: state.epoch,
        }
    }
    pub fn push(&self, stamp: Instant, value: T) -> bool {
        if let Ok(mut state) = self.shared.0.try_lock() {
            if state.epoch != self.epoch {
                self.retired.fetch_add(1, Ordering::Relaxed);
                return false;
            }
            if !state.stopped {
                state.queue.push(stamp, value);
                self.shared.1.notify_one();
                return true;
            }
        } else {
            self.contention.fetch_add(1, Ordering::Relaxed);
        }
        false
    }
}
impl<T> Drop for Deadline<T> {
    fn drop(&mut self) {
        self.shared
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stopped = true;
        self.shared.1.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
/// Poll the SDK's existing bounded PCM queues independently of room work.
pub struct Drain<T> {
    queue: Arc<Queue<T>>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    failed: bool,
    discarded_shutdown: u64,
    max_poll_gap_us: Arc<AtomicU64>,
    qos: Arc<Mutex<Option<(i32, i32, i32)>>>,
}
impl<T: Send + 'static> Drain<T> {
    pub fn start(
        name: &str,
        capacity: usize,
        max_age: Duration,
        mut collect: impl FnMut() -> Vec<Captured<T>> + Send + 'static,
    ) -> std::io::Result<Self> {
        let queue = Arc::new(Queue::new(capacity, max_age));
        let handoff = queue.clone();
        let max_poll_gap_us = Arc::new(AtomicU64::new(0));
        let gap = max_poll_gap_us.clone();
        let qos = Arc::new(Mutex::new(None));
        let priority = qos.clone();
        let (stop, wake) = mpsc::channel();
        let thread = thread::Builder::new().name(name.into()).spawn(move || {
            *priority.lock().unwrap() = worker_qos();
            let mut previous = Instant::now();
            loop {
                if !matches!(wake.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                    break;
                }
                let now = Instant::now();
                gap.fetch_max(
                    now.saturating_duration_since(previous).as_micros() as u64,
                    Ordering::Relaxed,
                );
                previous = now;
                for value in collect() {
                    handoff.push(value);
                }
                if !matches!(
                    wake.recv_timeout(Duration::from_millis(5)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    break;
                }
            }
        })?;
        Ok(Self {
            queue,
            stop: Some(stop),
            thread: Some(thread),
            failed: false,
            discarded_shutdown: 0,
            max_poll_gap_us,
            qos,
        })
    }
    pub fn queue(&self) -> Arc<Queue<T>> {
        self.queue.clone()
    }
    pub fn pop(&self) -> Option<Captured<T>> {
        self.queue.pop(Instant::now())
    }
    pub fn shutdown(&mut self) {
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            self.failed = thread.join().is_err();
        }
        while self.pop().is_some() {
            self.discarded_shutdown += 1;
        }
    }
    pub fn report(&self) -> Value {
        json!({"queue":self.queue.stats(),"active_after_shutdown":self.thread.is_some(),"worker_failed":self.failed,
            "discarded_shutdown":self.discarded_shutdown,"max_poll_gap_us":self.max_poll_gap_us.load(Ordering::Relaxed),"poll_interval_ms":5,"worker_qos_result_previous_effective":*self.qos.lock().unwrap()})
    }
}
impl<T> Drop for Drain<T> {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deadline_progresses_without_owner_polling_and_clear_waits_for_inflight_submission() {
        let (began, started) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let mut worker = Deadline::start("deadline-test", 2, move |_, value| {
            began.send(value).unwrap();
            if value == 1 {
                resume.recv().unwrap();
            }
        })
        .unwrap();
        while !worker.push(Instant::now(), 1) {
            thread::yield_now();
        }
        assert_eq!(started.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        assert!(worker.push(Instant::now() + Duration::from_secs(60), 2)); // native submit does not lock the queue
        assert_eq!(worker.contention.load(Ordering::Relaxed), 0);
        thread::scope(|scope| {
            let (done, cleared) = mpsc::channel();
            let owner = &worker;
            scope.spawn(move || {
                owner.clear();
                done.send(()).unwrap();
            });
            assert!(cleared.try_recv().is_err());
            release.send(()).unwrap();
            cleared.recv_timeout(Duration::from_secs(1)).unwrap();
        });
        while !worker.push(Instant::now(), 3) {
            thread::yield_now();
        }
        assert_eq!(started.recv_timeout(Duration::from_secs(1)).unwrap(), 3);
        worker.shutdown();
        assert_eq!(worker.report()["pending"], 0);
        assert_eq!(worker.report()["active_after_shutdown"], false);
    }
    #[test]
    fn reset_clears_future_frames_and_failed_submit_releases_owner() {
        let (sent, received) = mpsc::channel();
        let mut worker = Deadline::start("reset-test", 2, move |_, value| {
            let _ = sent.send(value);
        })
        .unwrap();
        while !worker.push(Instant::now() + Duration::from_secs(60), 1) {
            thread::yield_now();
        }
        worker.clear();
        while !worker.push(Instant::now(), 2) {
            thread::yield_now();
        }
        assert_eq!(received.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
        worker.shutdown();
        assert_eq!(worker.report()["flushed"], 1);
        let mut failed = Deadline::start("failure-test", 2, |_, _: u8| {
            panic!("injected submit failure")
        })
        .unwrap();
        while !failed.push(Instant::now(), 1) {
            thread::yield_now();
        }
        while !failed.thread.as_ref().unwrap().is_finished() {
            thread::yield_now();
        }
        failed.shutdown();
        assert_eq!(failed.report()["worker_failed"], true);
    }
    #[test]
    fn stale_coordinator_cannot_reset_a_replacement_producer() {
        let (sent, received) = mpsc::channel();
        let mut worker = Deadline::start("coordinator-fence", 2, move |_, v| {
            sent.send(v).unwrap();
        })
        .unwrap();
        let old = worker.producer();
        worker.reset();
        let replacement = worker.producer();
        let stale = old.reset_and_renew();
        assert_eq!(worker.report()["publication_epoch"], 1);
        assert!(!stale.push(Instant::now(), 1));
        while !replacement.push(Instant::now(), 2) {
            thread::yield_now();
        }
        assert_eq!(received.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
        let fresh = replacement.reset_and_renew();
        assert_eq!(worker.report()["publication_epoch"], 2);
        assert!(!replacement.push(Instant::now(), 3));
        while !fresh.push(Instant::now(), 4) {
            thread::yield_now();
        }
        assert_eq!(received.recv_timeout(Duration::from_secs(1)).unwrap(), 4);
        worker.shutdown();
    }
    #[test]
    fn retired_producer_cannot_enqueue_after_reset_or_owner_drop() {
        let (sent, received) = mpsc::channel();
        let mut worker = Deadline::start("epoch-test", 2, move |_, value| {
            let _ = sent.send(value);
        })
        .unwrap();
        for n in 0..100 {
            let old = worker.producer();
            let delayed = old.clone();
            while !old.push(Instant::now() + Duration::from_secs(60), n) {
                thread::yield_now();
            }
            worker.reset();
            let retired = worker.retired.clone();
            thread::spawn(move || {
                // A simultaneous queue read may cause a contention rejection;
                // retry until the epoch check itself has rejected this producer.
                while retired.load(Ordering::Relaxed) < n + 1 {
                    assert!(!delayed.push(Instant::now(), n));
                    thread::yield_now();
                }
            })
            .join()
            .unwrap();
            let current = worker.producer();
            while !current.push(Instant::now(), n + 1000) {
                thread::yield_now();
            }
            assert_eq!(
                received.recv_timeout(Duration::from_secs(1)).unwrap(),
                n + 1000
            );
        }
        assert_eq!(worker.report()["publication_epoch"], 100);
        assert_eq!(worker.report()["retired_producer_dropped"], 100);
        assert_eq!(worker.report()["flushed"], 100);
        let remaining = worker.producer();
        worker.shutdown();
        drop(worker);
        assert!(!remaining.push(Instant::now(), 9999));
        assert!(received.try_recv().is_err());
    }
    #[test]
    fn reset_waits_for_native_output_then_rejects_delayed_old_producer() {
        let (sent, received) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let mut worker = Deadline::start("epoch-inflight", 2, move |_, value| {
            sent.send(value).unwrap();
            resume.recv().unwrap();
        })
        .unwrap();
        let old = worker.producer();
        while !old.push(Instant::now(), 1) {
            thread::yield_now();
        }
        assert_eq!(received.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        thread::scope(|scope| {
            let (entered, waiting) = mpsc::channel();
            let (done, finished) = mpsc::channel();
            let owner = &worker;
            scope.spawn(move || {
                entered.send(()).unwrap();
                owner.reset();
                done.send(()).unwrap();
            });
            waiting.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(finished.recv_timeout(Duration::from_millis(20)).is_err());
            release.send(()).unwrap();
            finished.recv_timeout(Duration::from_secs(1)).unwrap();
        });
        assert!(!old.push(Instant::now(), 2));
        worker.shutdown();
        assert!(worker.report()["max_native_submit_us"].as_u64().unwrap() >= 20_000);
        assert_eq!(worker.report()["pending"], 0);
    }
    #[test]
    fn one_hundred_start_partial_use_drop_cycles_release_every_owner() {
        struct Owner(Arc<AtomicU64>);
        impl Drop for Owner {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let released = Arc::new(AtomicU64::new(0));
        for n in 0..100 {
            let owner = Owner(released.clone());
            let (sent, received) = mpsc::channel();
            let worker = Deadline::start("cycle-test", 2, move |_, value| {
                let _keep = &owner;
                let _ = sent.send(value);
            })
            .unwrap();
            while !worker.push(Instant::now(), n) {
                thread::yield_now();
            }
            assert_eq!(received.recv_timeout(Duration::from_secs(1)).unwrap(), n);
            worker.push(Instant::now() + Duration::from_secs(60), n);
            drop(worker);
            let owner = Owner(released.clone());
            let (sent, received) = mpsc::channel();
            let mut drain = Drain::start("drain-test", 3, Duration::from_millis(100), move || {
                let _keep = &owner;
                let _ = sent.send(());
                vec![Captured {
                    at: Instant::now(),
                    value: n,
                }]
            })
            .unwrap();
            received.recv_timeout(Duration::from_secs(1)).unwrap();
            drain.shutdown();
            assert_eq!(drain.report()["active_after_shutdown"], false);
            assert_eq!(drain.report()["queue"]["pending_frames"], 0);
        }
        assert_eq!(released.load(Ordering::Relaxed), 200);
    }
}
