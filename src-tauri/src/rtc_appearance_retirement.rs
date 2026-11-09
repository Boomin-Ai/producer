//! Appearance-only retirement barrier. Failed cleanup retains the exact owner.
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::Mutex;

pub type Close<'a> = Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send + 'a>>;
pub trait Owner: Send + 'static {
    fn id(&self) -> &str;
    fn terminal_finished(&self) -> bool;
    fn close(&mut self) -> Close<'_>;
}

/// Cancellation of an IPC waiter cannot cancel this supervisor or expose an
/// empty slot. An error remains owned and is returned again on exact-ID Stop.
pub async fn retire<T: Owner>(
    slot: Arc<Mutex<Option<T>>>,
    expected: Option<String>,
) -> Result<(), &'static str> {
    tokio::spawn(async move {
        let mut owner = slot.lock_owned().await;
        if !owner
            .as_ref()
            .is_some_and(|owner| expected.as_deref().is_none_or(|id| owner.id() == id))
        {
            return Ok(());
        }
        let result = owner
            .as_mut()
            .expect("matched appearance owner")
            .close()
            .await;
        if result.is_ok() {
            owner.take();
        }
        result
    })
    .await
    .map_err(|_| "Native appearance retirement supervisor failed")?
}

/// The caller already holds the start/stop slot lock. Only a completely
/// finished, clean terminal owner can be replaced by another appearance ID.
pub async fn reap_finished<T: Owner>(
    slot: &mut Option<T>,
    next_id: &str,
) -> Result<bool, &'static str> {
    if !slot
        .as_ref()
        .is_some_and(|owner| owner.id() != next_id && owner.terminal_finished())
    {
        return Ok(false);
    }
    slot.as_mut()
        .expect("finished appearance owner")
        .close()
        .await?;
    slot.take();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::recovery::{publication_retired, terminal_finished, CleanupFailure};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;
    struct FakeOwner {
        id: &'static str,
        cleanup: Arc<CleanupFailure>,
        outcome: Result<(), &'static str>,
        finished: bool,
        gate: Option<oneshot::Receiver<()>>,
        entered: Option<oneshot::Sender<()>>,
        calls: Arc<AtomicUsize>,
    }
    impl FakeOwner {
        fn new(id: &'static str, outcome: Result<(), &'static str>, finished: bool) -> Self {
            Self {
                id,
                cleanup: Arc::new(CleanupFailure::default()),
                outcome,
                finished,
                gate: None,
                entered: None,
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }
    impl Owner for FakeOwner {
        fn id(&self) -> &str {
            self.id
        }
        fn terminal_finished(&self) -> bool {
            self.cleanup.result().is_ok() && terminal_finished("error", self.finished)
        }
        fn close(&mut self) -> Close<'_> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::Relaxed);
                if let Some(entered) = self.entered.take() {
                    let _ = entered.send(());
                }
                if let Some(gate) = self.gate.take() {
                    gate.await.map_err(|_| "test gate closed")?;
                }
                self.finished = true;
                self.cleanup.connection(&self.outcome);
                self.cleanup.result()
            })
        }
    }
    #[tokio::test]
    async fn failed_cleanup_retains_owner_repeat_stop_errors_and_new_start_is_refused() {
        let slot = Arc::new(Mutex::new(Some(FakeOwner::new(
            "old",
            Err("Native RTC close failed"),
            true,
        ))));
        assert_eq!(
            retire(slot.clone(), Some("old".into())).await,
            Err("Native RTC close failed")
        );
        slot.lock().await.as_mut().unwrap().outcome = Ok(());
        assert_eq!(
            retire(slot.clone(), Some("old".into())).await,
            Err("Native RTC close failed")
        );
        let mut owner = slot.lock().await;
        assert!(!reap_finished(&mut owner, "new").await.unwrap());
        assert_eq!(owner.as_ref().unwrap().id(), "old");
        assert_eq!(owner.as_ref().unwrap().calls.load(Ordering::Relaxed), 2);
    }
    #[tokio::test]
    async fn expected_publication_expiry_and_clean_join_allow_a_new_epoch() {
        let old = FakeOwner::new(
            "old",
            publication_retired(Err("Native program lease expired")),
            true,
        );
        let mut slot = Some(old);
        assert!(reap_finished(&mut slot, "next-host-epoch").await.unwrap());
        assert!(slot.is_none());
        slot = Some(FakeOwner::new("next-host-epoch", Ok(()), false));
        assert_eq!(slot.as_ref().unwrap().id(), "next-host-epoch");
    }
    #[tokio::test]
    async fn cancelling_stop_waiter_keeps_the_barrier_until_owned_cleanup_finishes() {
        let (entered, seen) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut owner = FakeOwner::new("old", Ok(()), false);
        owner.entered = Some(entered);
        owner.gate = Some(gate);
        let slot = Arc::new(Mutex::new(Some(owner)));
        let retiring = slot.clone();
        let waiter = tokio::spawn(async move { retire(retiring, Some("old".into())).await });
        seen.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        assert!(
            slot.try_lock().is_err(),
            "a successor must remain behind cleanup"
        );
        release.send(()).unwrap();
        let owner = tokio::time::timeout(std::time::Duration::from_secs(1), slot.lock())
            .await
            .unwrap();
        assert!(owner.is_none());
    }
    #[tokio::test]
    async fn stale_stop_never_closes_a_successor() {
        let next = FakeOwner::new("new", Ok(()), false);
        let calls = next.calls.clone();
        let slot = Arc::new(Mutex::new(Some(next)));
        retire(slot.clone(), Some("old".into())).await.unwrap();
        assert_eq!(slot.lock().await.as_ref().unwrap().id(), "new");
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }
}
