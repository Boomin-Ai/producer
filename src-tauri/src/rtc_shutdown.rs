//! Stop intent and owned retirement. No SDK, media, credentials or room IDs.
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Mutex};

pub struct CloseHandle {
    flag: Arc<AtomicBool>,
    wake: watch::Sender<bool>,
}
pub struct CloseIntent {
    flag: Arc<AtomicBool>,
    wake: watch::Receiver<bool>,
}
pub enum Mutation<T> {
    NotStarted,
    Completed(T),
    Closing(T),
}
pub fn channel() -> (CloseHandle, CloseIntent) {
    let flag = Arc::new(AtomicBool::new(false));
    let (wake, receiver) = watch::channel(false);
    (
        CloseHandle {
            flag: flag.clone(),
            wake,
        },
        CloseIntent {
            flag,
            wake: receiver,
        },
    )
}
impl CloseHandle {
    pub fn request(&self) {
        self.flag.store(true, Ordering::Release);
        self.wake.send_replace(true);
    }
}
impl CloseIntent {
    pub fn requested(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
    pub async fn wait(&mut self) {
        if self.requested() {
            return;
        }
        while self.wake.changed().await.is_ok() {
            if self.requested() {
                return;
            }
        }
        self.flag.store(true, Ordering::Release);
    }
    /// Only for read-only work. Dropping this future cannot cancel a mutation.
    pub async fn read<F: Future>(&mut self, future: F) -> Option<F::Output> {
        if self.requested() {
            return None;
        }
        tokio::select! {
            biased;
            _ = self.wait() => None,
            value = future => if self.requested() { None } else { Some(value) },
        }
    }
    /// After a mutation starts, await exactly that future even if stop wins.
    /// Its own transport deadline remains authoritative; never replay it.
    pub async fn mutation<F: Future, Q: FnOnce()>(
        &mut self,
        future: F,
        quiesce: Q,
    ) -> Mutation<F::Output> {
        if self.requested() {
            quiesce();
            return Mutation::NotStarted;
        }
        tokio::pin!(future);
        let mut admitted = false;
        tokio::select! {
            biased;
            _ = self.wait() => {
                quiesce();
                if admitted { Mutation::Closing(future.await) } else { Mutation::NotStarted }
            },
            value = std::future::poll_fn(|cx| {
                // The first poll admits this exact operation. A stop that wins
                // before admission must not cause the stop branch to start it.
                admitted=true;
                future.as_mut().poll(cx)
            }) => {
                if self.requested() { quiesce(); Mutation::Closing(value) }
                else { Mutation::Completed(value) }
            }
        }
    }
}

/// The owned mutex guard fences new starts until retirement really completes.
/// The command awaits the task. If its IPC waiter is cancelled, the task still
/// owns the guard and joins old cleanup; cancellation never publishes a vacancy.
pub async fn retire<T, F, Fut>(
    slot: Arc<Mutex<Option<T>>>,
    epoch: Option<Arc<AtomicU64>>,
    matches: impl FnOnce(&T) -> bool + Send + 'static,
    close: F,
    observe: Option<fn(&'static str, Duration, Option<bool>)>,
) -> Result<(), &'static str>
where
    T: Send + 'static,
    F: FnOnce(T) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), &'static str>> + Send + 'static,
{
    let expected = epoch.as_ref().map(|epoch| epoch.load(Ordering::Acquire));
    let dispatched = Instant::now();
    tokio::spawn(async move {
        if let Some(observe) = observe {
            observe("native.rtc.stop.dispatch_wait", dispatched.elapsed(), None);
        }
        let waiting = Instant::now();
        let mut owner = slot.lock_owned().await;
        if let Some(observe) = observe {
            observe("native.rtc.stop.owner_lock", waiting.elapsed(), None);
        }
        if epoch
            .as_ref()
            .zip(expected)
            .is_some_and(|(epoch, expected)| epoch.load(Ordering::Acquire) != expected)
            || !owner.as_ref().is_some_and(matches)
        {
            return Ok(());
        }
        let value = owner.take().expect("matched owner");
        let result = close(value).await;
        drop(owner);
        result
    })
    .await
    .map_err(|_| "Native RTC retirement task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::oneshot;
    #[tokio::test]
    async fn stop_winning_before_first_poll_never_starts_post() {
        let (close, mut intent) = channel();
        drop(close); // Closed stop channel wins the biased select immediately.
        let calls = AtomicUsize::new(0);
        assert!(matches!(
            intent
                .mutation(
                    async {
                        calls.fetch_add(1, Ordering::Relaxed);
                    },
                    || {}
                )
                .await,
            Mutation::NotStarted
        ));
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
    #[tokio::test]
    async fn cancelled_waiter_before_lock_still_retires_selected_epoch() {
        let slot = Arc::new(Mutex::new(Some(7)));
        let epoch = Arc::new(AtomicU64::new(1));
        let held = slot.lock().await;
        let (entered, seen) = oneshot::channel();
        let (closed, done) = oneshot::channel();
        let owned = slot.clone();
        let waiter = tokio::spawn(async move {
            let _ = entered.send(());
            retire(
                owned,
                Some(epoch),
                |v| *v == 7,
                move |_| async move {
                    let _ = closed.send(());
                    Ok(())
                },
                None,
            )
            .await
        });
        seen.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        drop(held);
        done.await.unwrap();
        assert!(slot.lock().await.is_none());
    }
    #[tokio::test]
    async fn stale_same_room_stop_never_follows_replacement_but_barrier_drains_current() {
        for scoped in [true, false] {
            let slot = Arc::new(Mutex::new(None));
            let epoch = Arc::new(AtomicU64::new(1));
            let old_retirement = slot.lock().await;
            let next_slot = slot.clone();
            let next_epoch = epoch.clone();
            let (queued, seen) = oneshot::channel();
            let replacement = tokio::spawn(async move {
                let _ = queued.send(());
                let mut owner = next_slot.lock().await;
                next_epoch.fetch_add(1, Ordering::AcqRel);
                *owner = Some(7); // Same room, different owner instance.
            });
            seen.await.unwrap();
            let retiring = slot.clone();
            let fence = if scoped { Some(epoch.clone()) } else { None };
            let (queued, seen) = oneshot::channel();
            let stop = tokio::spawn(async move {
                let _ = queued.send(());
                retire(retiring, fence, |v| *v == 7, |_| async { Ok(()) }, None).await
            });
            seen.await.unwrap();
            drop(old_retirement);
            replacement.await.unwrap();
            stop.await.unwrap().unwrap();
            assert_eq!(*slot.lock().await, if scoped { Some(7) } else { None });
        }
    }
    #[tokio::test]
    async fn same_room_noop_start_keeps_existing_stop_valid() {
        let slot = Arc::new(Mutex::new(Some(7)));
        let epoch = Arc::new(AtomicU64::new(1));
        let held = slot.lock().await;
        let next = slot.clone();
        let generation = epoch.clone();
        let (queued, seen) = oneshot::channel();
        let start = tokio::spawn(async move {
            let _ = queued.send(());
            let mut owner = next.lock().await;
            if owner.is_none() {
                generation.fetch_add(1, Ordering::AcqRel);
                *owner = Some(7);
            }
        });
        seen.await.unwrap();
        let retiring = slot.clone();
        let generation = epoch.clone();
        let (queued, seen) = oneshot::channel();
        let stop = tokio::spawn(async move {
            let _ = queued.send(());
            retire(
                retiring,
                Some(generation),
                |v| *v == 7,
                |_| async { Ok(()) },
                None,
            )
            .await
        });
        seen.await.unwrap();
        drop(held);
        start.await.unwrap();
        stop.await.unwrap().unwrap();
        assert_eq!(epoch.load(Ordering::Acquire), 1);
        assert!(slot.lock().await.is_none());
    }
    async fn retire_fixture<F, Fut>(
        slot: Arc<Mutex<Option<i32>>>,
        matches: impl FnOnce(&i32) -> bool + Send + 'static,
        close: F,
    ) -> Result<(), &'static str>
    where
        F: FnOnce(i32) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), &'static str>> + Send + 'static,
    {
        retire(
            slot,
            Some(Arc::new(AtomicU64::new(0))),
            matches,
            close,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn stop_cancels_read_without_starting_followup_mutation() {
        let (close, mut intent) = channel();
        close.request();
        let calls = AtomicUsize::new(0);
        assert!(intent
            .read(async {
                calls.fetch_add(1, Ordering::Relaxed);
            })
            .await
            .is_none());
        assert!(matches!(
            intent
                .mutation(
                    async {
                        calls.fetch_add(1, Ordering::Relaxed);
                    },
                    || {}
                )
                .await,
            Mutation::NotStarted
        ));
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
    #[tokio::test]
    async fn in_flight_mutation_is_quiesced_then_drained_once() {
        let (close, mut intent) = channel();
        let (entered, seen) = oneshot::channel();
        let (release, finish) = oneshot::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let quiet = Arc::new(AtomicBool::new(false));
        let (count, quiesced) = (calls.clone(), quiet.clone());
        let task = tokio::spawn(async move {
            intent
                .mutation(
                    async move {
                        count.fetch_add(1, Ordering::Relaxed);
                        let _ = entered.send(());
                        finish.await.unwrap();
                        17
                    },
                    move || {
                        quiesced.store(true, Ordering::Release);
                    },
                )
                .await
        });
        seen.await.unwrap();
        close.request();
        while !quiet.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        assert!(!task.is_finished());
        release.send(()).unwrap();
        assert!(matches!(task.await.unwrap(), Mutation::Closing(17)));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn cancelled_waiter_cannot_expose_new_owner_before_old_cleanup() {
        let slot = Arc::new(Mutex::new(Some(7)));
        let (entered, seen) = oneshot::channel();
        let (release, finish) = oneshot::channel();
        let owned = slot.clone();
        let waiter = tokio::spawn(async move {
            retire_fixture(
                owned,
                |v| *v == 7,
                move |_| async move {
                    let _ = entered.send(());
                    finish.await.unwrap();
                    Ok(())
                },
            )
            .await
        });
        seen.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        assert!(slot.try_lock().is_err());
        let next = slot.clone();
        let started = tokio::spawn(async move {
            let mut owner = next.lock().await;
            assert!(owner.is_none());
            *owner = Some(9);
        });
        tokio::task::yield_now().await;
        assert!(!started.is_finished());
        release.send(()).unwrap();
        started.await.unwrap();
        assert_eq!(*slot.lock().await, Some(9));
    }
    #[tokio::test]
    async fn wrong_owner_and_repeated_retirement_do_not_close_new_owner() {
        let slot = Arc::new(Mutex::new(Some(7)));
        retire_fixture(
            slot.clone(),
            |v| *v == 9,
            |_| async { panic!("wrong owner retired") },
        )
        .await
        .unwrap();
        assert_eq!(*slot.lock().await, Some(7));
        assert_eq!(
            retire_fixture(slot.clone(), |v| *v == 7, |_| async { Err("end failed") }).await,
            Err("end failed")
        );
        retire_fixture(
            slot.clone(),
            |v| *v == 7,
            |_| async { panic!("retired twice") },
        )
        .await
        .unwrap();
        *slot.lock().await = Some(9);
        retire_fixture(
            slot.clone(),
            |v| *v == 7,
            |_| async { panic!("stale stop retired replacement") },
        )
        .await
        .unwrap();
        assert_eq!(*slot.lock().await, Some(9));
    }
}
