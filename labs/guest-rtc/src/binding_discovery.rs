//! One owned, cancellable stats job. Presentation only polls completed results.
use serde_json::{json, Value};
use std::{future::Future, time::Duration};
use tokio::task::JoinSet;

#[derive(Debug)]
pub struct Binding {
    pub sid: String,
    pub kind: String,
    pub ssrc: u32,
}
#[derive(Default)]
pub struct Discovery {
    jobs: JoinSet<(u64, i64, Option<Vec<Binding>>)>,
    generation: u64,
    spawned: u64,
    completed: u64,
    empty_results: u64,
    cancelled: u64,
    failed: u64,
    timed_out: u64,
    stale: u64,
    peak: usize,
}
impl Discovery {
    pub fn idle(&self) -> bool {
        self.jobs.is_empty()
    }
    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.jobs.abort_all();
    }
    pub fn request(
        &mut self,
        epoch: i64,
        job: impl Future<Output = Vec<Binding>> + Send + 'static,
    ) -> bool {
        if !self.idle() {
            return false;
        }
        let generation = self.generation;
        self.jobs.spawn(async move {
            (
                generation,
                epoch,
                tokio::time::timeout(Duration::from_millis(250), job)
                    .await
                    .ok(),
            )
        });
        self.spawned += 1;
        self.peak = self.peak.max(self.jobs.len());
        true
    }
    fn finish(
        &mut self,
        result: Result<(u64, i64, Option<Vec<Binding>>), tokio::task::JoinError>,
        epoch: i64,
    ) -> Option<Vec<Binding>> {
        match result {
            Ok((generation, old, bindings)) => {
                self.completed += 1;
                if generation != self.generation || old != epoch {
                    self.stale += 1;
                    return None;
                }
                if bindings.as_ref().is_some_and(Vec::is_empty) {
                    self.empty_results += 1;
                }
                if bindings.is_none() {
                    self.timed_out += 1;
                }
                bindings
            }
            Err(error) => {
                if error.is_cancelled() {
                    self.cancelled += 1;
                } else {
                    self.failed += 1;
                }
                None
            }
        }
    }
    pub fn poll(&mut self, epoch: i64) -> Option<Vec<Binding>> {
        self.jobs
            .try_join_next()
            .and_then(|result| self.finish(result, epoch))
    }
    pub async fn shutdown(&mut self) {
        self.invalidate();
        while let Some(result) = self.jobs.join_next().await {
            self.finish(result, i64::MIN);
        }
    }
    pub fn report(&self) -> Value {
        json!({"capacity":1,"active":self.jobs.len(),"peak_active":self.peak,"spawned":self.spawned,
            "completed":self.completed,"empty_results":self.empty_results,"cancelled":self.cancelled,"failed":self.failed,"timed_out":self.timed_out,"stale_epoch_results":self.stale,
            "overall_timeout_ms":250,"presentation_loop_awaits_stats":false})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Owned(Arc<AtomicUsize>);
    impl Drop for Owned {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn blocked_discovery_does_not_block_playback_and_cancel_releases_owner() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let guard = Owned(dropped.clone());
        let (ready, started) = tokio::sync::oneshot::channel();
        let mut discovery = Discovery::default();
        assert!(discovery.request(1, async move {
            let _guard = guard;
            let _ = ready.send(());
            std::future::pending().await
        }));
        started.await.unwrap();
        assert!(!discovery.request(1, async { vec![] }));
        for _ in 0..100 {
            assert!(discovery.poll(1).is_none());
            tokio::task::yield_now().await;
        }
        discovery.shutdown().await;
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(discovery.idle());
        assert_eq!(discovery.report()["cancelled"], 1);
        assert_eq!(discovery.report()["peak_active"], 1);
    }
    #[tokio::test]
    async fn completed_old_epoch_is_rejected_and_replacement_can_run() {
        let mut discovery = Discovery::default();
        discovery.request(1, async {
            vec![Binding {
                sid: "old".into(),
                kind: "audio".into(),
                ssrc: 1,
            }]
        });
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert!(discovery.poll(2).is_none());
        assert_eq!(discovery.report()["stale_epoch_results"], 1);
        assert!(discovery.request(2, async {
            vec![Binding {
                sid: "new".into(),
                kind: "video".into(),
                ssrc: 2,
            }]
        }));
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        let bindings = discovery.poll(2).unwrap();
        assert_eq!(bindings[0].sid, "new");
        discovery.shutdown().await;
        assert_eq!(discovery.report()["active"], 0);
    }
    #[tokio::test]
    async fn invalidation_rejects_completed_result_even_with_equal_epoch_timestamp() {
        let mut discovery = Discovery::default();
        discovery.request(1, async {
            vec![Binding {
                sid: "old".into(),
                kind: "audio".into(),
                ssrc: 1,
            }]
        });
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        discovery.invalidate();
        assert!(discovery.poll(1).is_none());
        assert_eq!(discovery.report()["stale_epoch_results"], 1);
        discovery.shutdown().await;
    }
    #[tokio::test]
    async fn failed_job_releases_ownership_and_does_not_poison_retry() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let guard = Owned(dropped.clone());
        let mut discovery = Discovery::default();
        discovery.request(1, async move {
            let _guard = guard;
            panic!("injected discovery failure");
        });
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert!(discovery.poll(1).is_none());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(discovery.report()["failed"], 1);
        assert!(discovery.request(1, async { vec![] }));
        discovery.shutdown().await;
        assert_eq!(discovery.report()["active"], 0);
    }
    #[tokio::test]
    async fn overall_timeout_drops_partial_work_and_can_retry() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let guard = Owned(dropped.clone());
        let mut discovery = Discovery::default();
        discovery.request(1, async move {
            let _guard = guard;
            std::future::pending().await
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(discovery.poll(1).is_none());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(discovery.report()["timed_out"], 1);
        assert!(discovery.request(1, async { vec![] }));
        discovery.shutdown().await;
        assert!(discovery.idle());
    }
}
