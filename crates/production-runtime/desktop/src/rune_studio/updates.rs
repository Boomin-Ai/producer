use super::*;
use crate::native_update::{self, Client, Prepared, Release};

const CHECK_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(super) struct Updates {
    app: Option<PathBuf>,
    next_check: Option<Instant>,
    check: Option<mpsc::Receiver<anyhow::Result<Option<Release>>>>,
    candidate: Option<Release>,
    download: Option<(Release, mpsc::Receiver<anyhow::Result<Prepared>>)>,
    prepared: Option<Prepared>,
    _previous_bundle: Option<Prepared>,
    error: Option<String>,
    pub(super) open: bool,
}

impl Updates {
    pub fn start(&mut self) {
        self.app = native_update::installed_app();
    }

    pub fn poll(&mut self) -> bool {
        if self.app.is_none() {
            return false;
        }
        let mut changed = false;
        if let Some(check) = &self.check {
            match check.try_recv() {
                Ok(result) => {
                    self.check = None;
                    if let Ok(candidate) = result {
                        if self.candidate != candidate {
                            self.candidate = candidate;
                            self.error = None;
                            if let Some(previous) = self.prepared.take() {
                                std::thread::spawn(move || drop(previous));
                            }
                            self.open &= self.candidate.is_some();
                            changed = true;
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => self.check = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        let now = Instant::now();
        if self.check.is_none() && self.next_check.is_none_or(|next| next <= now) {
            self.next_check = Some(now + CHECK_INTERVAL);
            let (send, receive) = mpsc::channel();
            self.check = Some(receive);
            std::thread::spawn(move || {
                let result =
                    Client::new().and_then(|client| client.check(env!("CARGO_PKG_VERSION")));
                let _ = send.send(result);
            });
        }
        if let Some((release, download)) = &self.download {
            let result = match download.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => {
                    Some(Err(anyhow::anyhow!("Download stopped")))
                }
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                if self.candidate.as_ref() == Some(release) {
                    match result {
                        Ok(prepared) => self.prepared = Some(prepared),
                        Err(error) => self.error = Some(error.to_string()),
                    }
                }
                self.download = None;
                changed = true;
            }
        }
        changed
    }

    fn download(&mut self) {
        if self.download.is_some() {
            return;
        }
        let Some((app, release)) = self.app.clone().zip(self.candidate.clone()) else {
            return;
        };
        let (send, receive) = mpsc::channel();
        self.download = Some((release.clone(), receive));
        self.error = None;
        std::thread::spawn(move || {
            let result = Client::new().and_then(|client| client.prepare(&app, &release));
            let _ = send.send(result);
        });
    }

    fn install(&mut self, tx: &mut Tx) {
        let Some(prepared) = self.prepared.as_ref() else {
            return;
        };
        match prepared.install() {
            Ok(()) => {
                self._previous_bundle = self.prepared.take();
                tx.relaunch();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }
}

pub(super) fn available(s: &Studio) -> bool {
    s.updates.candidate.is_some()
}

pub(super) fn toggle(s: &mut Studio) {
    s.settings.profile_open = false;
    s.updates.open = !s.updates.open;
}

pub(super) fn popover(root: El, s: &Studio, width: f32, height: f32, live: bool) -> El {
    let Some(candidate) = s.updates.candidate.as_ref().filter(|_| s.updates.open) else {
        return root;
    };
    let version = format!("Producer {}", candidate.version);
    let left = if live { 12. } else { 61. };
    let mut sheet = col()
        .key("update-details")
        .role("dialog")
        .label("Producer update")
        .focus_return(if live {
            "producer-update-live"
        } else {
            "producer-update"
        })
        .absolute(left, (height - 220.).max(8.))
        .w((width - left - 12.).clamp(200., 308.))
        .padding(13.)
        .gap(9.)
        .fill(color(PANEL))
        .border(1., color(theme::TRANSPORT_BORDER))
        .radius(12.)
        .child(
            title(version.clone(), 15., 650., TEXT)
                .key("update-version")
                .label(version),
        );

    if let Some(error) = &s.updates.error {
        sheet = sheet
            .child(
                text(error.clone())
                    .font(TextStyle::new(12., 500.))
                    .color(color(MUTED))
                    .wrap(),
            )
            .child(button(
                "update-downloads-page",
                "Download installer",
                false,
                |s| {
                    if std::process::Command::new("/usr/bin/open")
                        .arg("https://producer.dev/download/macos")
                        .spawn()
                        .is_err()
                    {
                        s.updates.error = Some("Could not open Producer downloads".into());
                    }
                },
            ));
    }
    sheet = if s.updates.download.is_some() {
        sheet.child(title("Downloading and verifying…", 12., 500., MUTED))
    } else if s.updates.prepared.is_some() {
        if let Some(studio) = &s.live {
            let blocker = studio.switch_blocker().or_else(|| {
                (s.chat.busy() || s.editor.is_some())
                    .then_some("Finish editing before closing the studio.")
            });
            sheet
                .child(title(
                    blocker.unwrap_or("Close the studio to restart Producer."),
                    12.,
                    500.,
                    MUTED,
                ))
                .child(
                    button("update-close-studio", "Close studio", false, |s| {
                        s.close_room()
                    })
                    .disabled(blocker.is_some()),
                )
        } else {
            sheet.child(
                button("update-restart", "Restart to update", true, |_| {}).on_press_tx(
                    |s: &mut Studio, tx| {
                        if s.live.is_none() && s.room_transition.is_none() {
                            s.updates.install(tx);
                        }
                    },
                ),
            )
        }
    } else {
        sheet.child(button("update-download", "Download update", true, |s| {
            s.updates.download()
        }))
    };
    root.child(
        el().absolute(0., 0.)
            .w_full()
            .h_full()
            .key("dismiss-update")
            .on_press(|s: &mut Studio| s.updates.open = false),
    )
    .child(sheet)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_version_appears_only_after_pressing_the_sidebar_icon() {
        let mut rt = rune::App::new(AppSpec::new(
            "Update UI test",
            (720., 420.),
            || Studio::new(PathBuf::new()),
            super::super::view,
        ))
        .headless_runtime((720., 420.), rune::Env::default());
        rt.frame(0.);
        assert!(rt.find("producer-update").is_none());
        rt.update(|studio, _| {
            studio.updates.candidate = Some(
                serde_json::from_value(json!({
                    "version": "0.5.99", "length": 100, "sha256": "", "signature": ""
                }))
                .unwrap(),
            );
        });
        rt.frame(0.);
        let (x, y) = rt.find("producer-update").unwrap();
        assert!(rt.find("update-details").is_none());
        assert!(rt.find("update-version").is_none());
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert!(rt.find("update-details").is_some());
        assert!(rt.find("update-download").is_some());
        assert!(rt
            .elements()
            .iter()
            .any(|el| el.key.as_deref() == Some("update-version")
                && el.label.as_deref() == Some("Producer 0.5.99")));
        rt.pointer_down(500., 60.);
        rt.pointer_up(500., 60.);
        rt.frame(0.02);
        assert!(rt.find("update-details").is_none());
    }
}
