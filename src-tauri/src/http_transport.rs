//! Credential-free, process-wide HTTP pools. macOS native trust-store loading
//! is synchronous; build each policy once on the blocking pool, never inside
//! an async command's poll. Tokens, brands and endpoint URLs stay per request.

use reqwest::Client;
use tokio::sync::OnceCell;

#[cfg(test)]
#[path = "http_transport_tests.rs"]
mod policy_tests;

static GENERAL: OnceCell<Client> = OnceCell::const_new();
#[cfg(feature = "guest-rtc-pilot")]
static RTC_CONTROL: OnceCell<Client> = OnceCell::const_new();

async fn initialized(
    cell: &'static OnceCell<Client>,
    build: impl FnOnce() -> Result<Client, &'static str> + Send + 'static,
) -> Result<Client, &'static str> {
    if let Some(client) = cell.get() {
        return Ok(client.clone());
    }
    // An IPC waiter can disappear during startup. Its cancellation must not
    // discard the running blocking builder and start another trust-store scan.
    // The finite supervisor owns initialization until the cell is published.
    tokio::spawn(async move {
        cell.get_or_try_init(|| async move {
            tokio::task::spawn_blocking(build)
                .await
                .map_err(|_| "HTTP setup failed")?
        })
        .await
        .cloned()
    })
    .await
    .map_err(|_| "HTTP setup failed")?
}

/// The same TLS, proxy and redirect defaults as the former Client::new().
pub(crate) async fn general() -> Result<Client, &'static str> {
    initialized(&GENERAL, || {
        Client::builder().build().map_err(|_| "HTTP setup failed")
    })
    .await
}

/// Authority requests must never follow a redirect. Keep their separate pool
/// and existing five-second default; individual permission reads shorten it.
#[cfg(feature = "guest-rtc-pilot")]
pub(crate) async fn rtc_control() -> Result<Client, &'static str> {
    initialized(&RTC_CONTROL, || {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|_| "HTTP setup failed")
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_first_use_builds_once_without_blocking_the_executor() {
        let cell: &'static OnceCell<Client> = Box::leak(Box::new(OnceCell::new()));
        let builds = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let count = builds.clone();
        let first = tokio::spawn(initialized(cell, move || {
            count.fetch_add(1, Ordering::SeqCst);
            let _ = entered_tx.send(());
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("executor did not release the blocking builder");
            Ok(Client::builder().build().unwrap())
        }));
        // This single-thread runtime must be able to resume while the builder
        // is still waiting for a release that only this task can provide.
        entered_rx.await.unwrap();
        assert!(!first.is_finished());
        let mut waiters = vec![first];
        for _ in 1..12 {
            let builds = builds.clone();
            waiters.push(tokio::spawn(initialized(cell, move || {
                builds.fetch_add(1, Ordering::SeqCst);
                panic!("concurrent initializer duplicated the blocking builder")
            })));
        }
        tokio::task::yield_now().await;
        assert!(cell.get().is_none());
        release_tx.send(()).unwrap();
        for waiter in waiters {
            waiter.await.unwrap().unwrap();
        }
        assert_eq!(builds.load(Ordering::SeqCst), 1);
        initialized(cell, || panic!("warm pool rebuilt"))
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_first_waiter_does_not_restart_the_running_builder() {
        let cell: &'static OnceCell<Client> = Box::leak(Box::new(OnceCell::new()));
        let builds = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let count = builds.clone();
        let first = tokio::spawn(initialized(cell, move || {
            count.fetch_add(1, Ordering::SeqCst);
            let _ = entered_tx.send(());
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("cancelled waiter did not release its owned builder");
            Ok(Client::builder().build().unwrap())
        }));
        entered_rx.await.unwrap();
        first.abort();
        let count = builds.clone();
        let second = tokio::spawn(initialized(cell, move || {
            count.fetch_add(1, Ordering::SeqCst);
            panic!("cancelled initializer was duplicated")
        }));
        release_tx.send(()).unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(builds.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_initialization_can_retry_without_publishing_a_bad_pool() {
        let cell: &'static OnceCell<Client> = Box::leak(Box::new(OnceCell::new()));
        assert!(initialized(cell, || Err("HTTP setup failed"))
            .await
            .is_err());
        assert!(cell.get().is_none());
        initialized(cell, || Ok(Client::builder().build().unwrap()))
            .await
            .unwrap();
        assert!(cell.get().is_some());
    }
}
