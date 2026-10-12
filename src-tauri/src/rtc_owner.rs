//! Single serialized owner of the native host connection and room lease.
//! Media attachment is deliberately not available until its authority adapter exists.
use crate::rtc_control::{Control, Operator};
use producer_guest_runtime::Connection;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{sync::oneshot, task::JoinHandle};

pub struct HostOwner {
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), &'static str>>>,
    lifetime: Weak<()>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}
impl HostOwner {
    pub async fn start(control: Control) -> Result<Self, &'static str> {
        let (mut owner, connected) = Self::spawn(control, None);
        match connected.await {
            Ok(Ok(())) => Ok(owner),
            Ok(Err(error)) => {
                let _ = owner.close().await;
                Err(error)
            }
            Err(_) => {
                let _ = owner.close().await;
                Err("Native RTC startup task failed")
            }
        }
    }
    pub async fn start_with_media(
        control: Control,
        media: Box<dyn producer_guest_runtime::GuestMedia>,
    ) -> Result<Self, &'static str> {
        let (mut owner, connected) = Self::spawn(control, Some(media));
        match connected.await {
            Ok(Ok(())) => Ok(owner),
            Ok(Err(error)) => {
                let _ = owner.close().await;
                Err(error)
            }
            Err(_) => {
                let _ = owner.close().await;
                Err("Native RTC startup task failed")
            }
        }
    }
    fn spawn(
        control: Control,
        media: Option<Box<dyn producer_guest_runtime::GuestMedia>>,
    ) -> (Self, oneshot::Receiver<Result<(), &'static str>>) {
        let (stop, mut stopped) = oneshot::channel();
        let (ready, connected) = oneshot::channel();
        let lifetime = Arc::new(());
        let probe = Arc::downgrade(&lifetime);
        // The task, rather than the caller's cancellable start future, owns
        // connection initialization. Cancellation signals stop; it never drops
        // Room::connect halfway through native initialization.
        let task = tokio::spawn(async move {
            let _lifetime = lifetime;
            let mut control = control;
            let started = async {
                control.open().await?;
                control.command("start").await?;
                let session = control.session().await?;
                let mut connection = Connection::connect_with_media(&session, media).await?;
                if control.lease_expires_at_ms().unwrap_or(0) <= now() || !connection.healthy() {
                    let _ = connection.close().await;
                    return Err("Native RTC authority expired during connection");
                }
                match control.media_authority().await {
                    Ok(snapshot) => {
                        if connection.media_authority(snapshot).is_err() {
                            let _ = connection.close().await;
                            return Err("Native media authority handoff failed");
                        }
                    }
                    Err(error) => {
                        let _ = connection.close().await;
                        return Err(error);
                    }
                }
                Ok(connection)
            }
            .await;
            let mut connection = match started {
                Ok(connection) => connection,
                Err(error) => {
                    let _ = control.end().await;
                    let _ = ready.send(Err(error));
                    return Err(error);
                }
            };
            if stopped.try_recv() != Err(oneshot::error::TryRecvError::Empty)
                || ready.send(Ok(())).is_err()
            {
                let closed = connection.close().await;
                let ended = control.end().await;
                closed?;
                ended?;
                return Ok(());
            }
            let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            heartbeat.tick().await;
            let mut safety = tokio::time::interval(Duration::from_millis(100));
            safety.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut authority_poll = tokio::time::interval(Duration::from_secs(1));
            authority_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut failure = None;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    _ = safety.tick() => {
                        if !connection.healthy() || control.lease_expires_at_ms().unwrap_or(0) <= now() {
                            failure = Some("Native RTC connection or lease lost"); break;
                        }
                    }
                    _ = heartbeat.tick() => {
                        if control.renew().await.is_err() {
                            failure = Some("Native RTC renewal failed"); break;
                        }
                    }
                    _ = authority_poll.tick() => {
                        match control.media_authority().await {
                            Ok(snapshot) => {if connection.media_authority(snapshot).is_err(){failure=Some("Native media authority handoff failed");break;}},
                            Err(_) => {failure=Some("Native media authority refresh failed");break;}
                        }
                    }
                }
            }
            // Close SDK before ending authority; queue/media adapters must retire
            // before this boundary once they are installed. All normal exits join.
            let closed = connection.close().await;
            let ended = control.end().await;
            if let Some(error) = failure {
                return Err(error);
            }
            closed?;
            ended?;
            Ok(())
        });
        (
            Self {
                stop: Some(stop),
                task: Some(task),
                lifetime: probe,
            },
            connected,
        )
    }
    pub fn task_lifetime(&self) -> Weak<()> {
        self.lifetime.clone()
    }
    pub async fn close(&mut self) -> Result<(), &'static str> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| "Native RTC owner task failed")??;
        }
        Ok(())
    }
}
impl Drop for HostOwner {
    fn drop(&mut self) {
        // Dropping the control handle wakes the task. The task owns no handle
        // back-reference and completes SDK close/end even if its join is detached.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
#[cfg(debug_assertions)]
pub fn selftest(path: &std::path::Path) -> Result<(), &'static str> {
    let bytes = std::fs::read(path).map_err(|_| "Staging operator profile unavailable")?;
    if bytes.len() > 32768 {
        return Err("Staging operator profile too large");
    }
    let operator: Operator =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid staging operator profile")?;
    let runtime = tokio::runtime::Runtime::new().map_err(|_| "Native RTC runtime unavailable")?;
    runtime.block_on(async {
        let mut owner = HostOwner::start(Control::new(operator.clone())?).await?;
        tokio::time::sleep(Duration::from_secs(22)).await;
        let lifetime = owner.task_lifetime();
        owner.close().await?;
        if lifetime.strong_count() != 0 { return Err("Native RTC owner remained alive after close"); }
        // Repeated close must have no task, SDK room or authority left to own.
        owner.close().await?;
        // Drop while startup is still pending. The owning task must finish its
        // initialization and clean up, rather than dropping Room::connect.
        let (pending,ready)=HostOwner::spawn(Control::new(operator)?,None);
        let lifetime=pending.task_lifetime();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(pending);drop(ready);
        let until=std::time::Instant::now()+Duration::from_secs(30);
        while lifetime.strong_count()!=0 {
            if std::time::Instant::now()>=until{return Err("Native startup cancellation did not retire");}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        println!("Native SDK owner proof passed: hosted join, two lease renewals, SDK close, event task join, run end, startup cancellation");
        Ok(())
    })
}
