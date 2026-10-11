//! One owned diagnostic worker and one replaceable snapshot, never a FIFO.
//! Collection/parsing may block this worker; presentation only tries the mailbox.
use serde_json::{json, Value};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
struct Mailbox<T> {
    value: Option<T>,
    collected: u64,
    replaced: u64,
    errors: u64,
    max_collection_us: u128,
}
impl<T> Default for Mailbox<T> {
    fn default() -> Self {
        Self {
            value: None,
            collected: 0,
            replaced: 0,
            errors: 0,
            max_collection_us: 0,
        }
    }
}
pub struct Worker<T: Send + 'static = Value> {
    mailbox: Arc<Mutex<Mailbox<T>>>,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    consumed: u64,
    shutdown_us: u128,
}
impl<T: Send + 'static> Worker<T> {
    pub fn start(
        interval: Duration,
        mut collect: impl FnMut() -> Result<T, String> + Send + 'static,
    ) -> Self {
        assert!(!interval.is_zero());
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let shared = mailbox.clone();
        let (stop, wake) = mpsc::channel();
        let thread = thread::spawn(move || loop {
            // Disconnect also stops an owner dropped during error unwinding.
            if !matches!(wake.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                break;
            }
            let began = Instant::now();
            let value = collect();
            let elapsed = began.elapsed().as_micros();
            {
                let mut slot = shared.lock().unwrap();
                slot.max_collection_us = slot.max_collection_us.max(elapsed);
                match value {
                    Ok(value) => {
                        slot.collected += 1;
                        slot.replaced += u64::from(slot.value.replace(value).is_some());
                    }
                    Err(_) => {
                        slot.errors += 1;
                    }
                }
            }
            if !matches!(
                wake.recv_timeout(interval),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                break;
            }
        });
        Self {
            mailbox,
            stop: Some(stop),
            thread: Some(thread),
            consumed: 0,
            shutdown_us: 0,
        }
    }
    pub fn take(&mut self) -> Option<T> {
        let value = self.mailbox.try_lock().ok()?.value.take();
        self.consumed += u64::from(value.is_some());
        value
    }
    pub fn shutdown(&mut self) {
        let began = Instant::now();
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                self.mailbox.lock().unwrap().errors += 1;
            }
        }
        self.shutdown_us += began.elapsed().as_micros();
    }
    pub fn report(&self) -> Value {
        let slot = self.mailbox.lock().unwrap();
        json!({"capacity":1,"pending":u64::from(slot.value.is_some()),"collected":slot.collected,
            "replaced":slot.replaced,"consumed":self.consumed,"errors":slot.errors,"max_collection_us":slot.max_collection_us,
            "active_after_shutdown":self.thread.is_some(),"shutdown_us":self.shutdown_us,"presentation_waits_for_collection":false})
    }
}
impl<T: Send + 'static> Drop for Worker<T> {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_collection_does_not_block_consumer_and_shutdown_joins_owner() {
        let (began, started) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let (dropped, retired) = mpsc::channel();
        struct Owner(mpsc::Sender<()>);
        impl Drop for Owner {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let owner = Owner(dropped);
        let mut worker = Worker::start(Duration::from_secs(60), move || {
            let _keep = &owner;
            began.send(()).unwrap();
            resume.recv().unwrap();
            Ok(json!({"current":1}))
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        for _ in 0..100 {
            assert!(worker.take().is_none());
        }
        release.send(()).unwrap();
        worker.shutdown();
        retired.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(worker.take().unwrap()["current"], 1);
        assert_eq!(worker.report()["active_after_shutdown"], false);
    }
    #[test]
    fn repeated_start_drop_releases_every_collector_and_never_queues_history() {
        for _ in 0..100 {
            let (began, started) = mpsc::channel();
            let mut worker = Worker::start(Duration::from_secs(60), move || {
                let _ = began.send(());
                Ok(json!(1))
            });
            started.recv_timeout(Duration::from_secs(1)).unwrap();
            worker.shutdown();
            let report = worker.report();
            assert_eq!(report["collected"], 1);
            assert_eq!(report["pending"], 1);
            assert_eq!(report["active_after_shutdown"], false);
        }
        let mut mailbox = Mailbox::default();
        for n in 0..1000 {
            mailbox.replaced += u64::from(mailbox.value.replace(json!(n)).is_some());
        }
        assert_eq!(mailbox.value, Some(json!(999)));
        assert_eq!(mailbox.replaced, 999);
    }
}
