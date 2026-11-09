//! Native appearance recovery decisions. No credential, SDK or media ownership.

/// Expiring the old authorization stops publication on purpose. Once its
/// worker has actually joined, that result must not kill the appearance owner.
pub fn publication_retired(result: Result<(), &'static str>) -> Result<(), &'static str> {
    match result {
        Err(
            "Native program lease expired" | "Native program audio publication deadline missed",
        ) => Ok(()),
        other => other,
    }
}
pub fn retirement_result(
    publication: Result<(), &'static str>,
    connection: Result<(), &'static str>,
) -> Result<(), &'static str> {
    connection.and(publication_retired(publication))
}

/// A failed cleanup cannot become a successful no-owner Stop on the next try.
#[derive(Default)]
pub struct CleanupFailure(std::sync::Mutex<Option<&'static str>>);
impl CleanupFailure {
    pub fn record(&self, error: &'static str) {
        let mut stored = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if stored.is_none() {
            *stored = Some(error);
        }
    }
    pub fn publication(&self, result: &Result<(), &'static str>) {
        if let Err(error) = result {
            if failure_code(error) == "cleanup_failed" {
                self.record(error);
            }
        }
    }
    pub fn connection(&self, result: &Result<(), &'static str>) {
        if let Err(error) = result {
            self.record(error);
        }
    }
    pub fn result(&self) -> Result<(), &'static str> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map_or(Ok(()), Err)
    }
}

/// A fresh guest state/session is required after these operational races.
/// Schema, grant, identity, capture and cleanup failures remain fatal.
pub fn retry_operation(error: &str) -> bool {
    matches!(
        error,
        "Native appearance request failed"
            | "Native appearance response unavailable"
            | "Native appearance connection unavailable"
            | "Native appearance authorization changed"
            | "Native appearance authority expired"
            | "Native appearance session expired"
            | "Native appearance authority changed during connect"
            | "Native appearance authority changed during publish"
            | "Native appearance lease expired before capture"
            | "Native appearance subscription permissions failed"
            | "Native appearance permissions timed out"
            | "Native appearance authority binding changed"
            | "Native RTC connection failed"
            | "Native RTC connection unavailable"
            | "Native receive pipeline already owned"
    )
}
#[derive(Debug, PartialEq, Eq)]
pub enum OperationFailure {
    Retry,
    Stopped,
    Fatal,
}
pub fn operation_failed(error: &str, stopped: bool) -> OperationFailure {
    if !retry_operation(error) && error != "Native appearance stopped" {
        OperationFailure::Fatal
    } else if stopped {
        OperationFailure::Stopped
    } else {
        OperationFailure::Retry
    }
}

pub fn terminal_finished(phase: &str, finished: bool) -> bool {
    finished && matches!(phase, "gone" | "error")
}

/// Fixed classifications only: never provider text, endpoints or credentials.
pub fn failure_code(error: &str) -> &'static str {
    match error {
        "Native appearance stopped" => "stopped",
        "Native program lease expired" => "publication_expired",
        "Native program audio publication deadline missed" => "publication_late",
        "Native appearance authority expired"
        | "Native appearance session expired"
        | "Native appearance lease expired before capture" => "authority_expired",
        "Native appearance authority changed during connect"
        | "Native appearance authority changed during publish"
        | "Native appearance authority binding changed"
        | "Native appearance authorization changed" => "authority_changed",
        "Native appearance request failed"
        | "Native appearance response unavailable"
        | "Native appearance connection unavailable" => "authority_unavailable",
        "Native RTC connection failed" | "Native RTC connection unavailable" => "transport_lost",
        "Native receive pipeline already owned" => "receiver_busy",
        "Native appearance subscription permissions failed"
        | "Native appearance permissions timed out" => "permissions_unavailable",
        "Native appearance authority mismatch"
        | "Native appearance session mismatch"
        | "Native appearance connection invalid" => "authority_invalid",
        "Native program capture queue or format fault" => "capture_fault",
        "Native program audio capture remained absent" => "audio_capture_absent",
        "Native program audio submission failed" | "Native program audio unexpectedly queued" => {
            "audio_sdk_failed"
        }
        "Native program video publication stopped" => "video_sdk_failed",
        "Native appearance connection retirement failed"
        | "Native appearance publisher retirement failed"
        | "Native RTC receiver retirement worker failed"
        | "Native RTC event task failed"
        | "Native RTC close failed"
        | "Native appearance retirement task failed"
        | "Native program worker failed" => "cleanup_failed",
        _ => "native_failure",
    }
}

/// Candidate-only functional diagnostics, bounded even during repeated churn.
pub struct Diagnostics {
    remaining: usize,
    previous: Option<&'static str>,
}
impl Diagnostics {
    pub fn new() -> Self {
        Self {
            remaining: 64,
            previous: None,
        }
    }
    fn record(&mut self, code: &'static str) -> Option<&'static str> {
        if self.remaining == 0 || self.previous == Some(code) {
            return None;
        }
        self.previous = Some(code);
        self.remaining -= 1;
        Some(code)
    }
    pub fn note(&mut self, code: &'static str) {
        if let Some(code) = self.record(code) {
            eprintln!("[native-appearance] {code}");
        }
    }
    /// Called once at owner termination; reserve a fixed final classification
    /// even if recovery churn consumed the 64 transition records.
    pub fn terminal(&self, error: &str) {
        eprintln!(
            "[native-appearance] terminal_error cause={}",
            failure_code(error)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_gap_expiry_is_an_owned_retirement_not_a_terminal_owner_failure() {
        let expired = publication_retired(Err("Native program lease expired"));
        let connection_closed = Ok(());
        assert_eq!(expired.and(connection_closed), Ok(()));
        assert_eq!(
            retirement_result(Err("Native program lease expired"), Ok(())),
            Ok(())
        );
        assert_eq!(
            retirement_result(
                Err("Native program capture queue or format fault"),
                Err("Native RTC close failed")
            ),
            Err("Native RTC close failed")
        );
        assert_eq!(
            publication_retired(Err("Native program worker failed")),
            Err("Native program worker failed")
        );
        assert_eq!(
            publication_retired(Err("Native program lease expired"))
                .and(Err::<(), _>("Native RTC close failed")),
            Err("Native RTC close failed")
        );
    }

    #[test]
    fn retry_requires_an_operational_race_and_never_a_permission_or_cleanup_bypass() {
        for error in [
            "Native appearance authority expired",
            "Native RTC connection unavailable",
            "Native appearance subscription permissions failed",
            "Native appearance authority changed during connect",
        ] {
            assert!(retry_operation(error), "{error}");
        }
        for error in [
            "Native appearance authority mismatch",
            "Native appearance session mismatch",
            "Native appearance connection retirement failed",
            "Native program capture queue or format fault",
        ] {
            assert!(!retry_operation(error), "{error}");
        }
        assert_eq!(
            operation_failed("Native appearance connection retirement failed", true),
            OperationFailure::Fatal
        );
        assert_eq!(
            operation_failed("Native appearance stopped", true),
            OperationFailure::Stopped
        );
        assert_eq!(
            operation_failed("Native RTC connection unavailable", false),
            OperationFailure::Retry
        );
    }

    #[test]
    fn a_successor_only_reaps_a_terminal_owner_whose_task_has_finished() {
        for phase in ["starting", "waiting", "live", "reconnecting"] {
            assert!(!terminal_finished(phase, false));
            assert!(!terminal_finished(phase, true));
        }
        for phase in ["gone", "error"] {
            assert!(!terminal_finished(phase, false));
            assert!(terminal_finished(phase, true));
        }
    }
    #[test]
    fn cleanup_failure_is_sticky_while_clean_terminal_failures_can_be_released() {
        let cleanup = CleanupFailure::default();
        cleanup.publication(&Err("Native program capture queue or format fault"));
        assert_eq!(cleanup.result(), Ok(()));
        cleanup.connection(&Err("Native RTC close failed"));
        cleanup.connection(&Ok(()));
        cleanup.publication(&Ok(()));
        assert_eq!(cleanup.result(), Err("Native RTC close failed"));
        cleanup.record("Native appearance retirement task failed");
        assert_eq!(cleanup.result(), Err("Native RTC close failed"));
    }

    #[test]
    fn diagnostics_are_fixed_and_bounded_during_recovery() {
        assert_eq!(
            failure_code("secret provider/token payload"),
            "native_failure"
        );
        let mut diagnostics = Diagnostics::new();
        let mut records = 0;
        for i in 0..1000 {
            if diagnostics
                .record(if i % 2 == 0 {
                    "waiting"
                } else {
                    "reconnecting"
                })
                .is_some()
            {
                records += 1;
            }
        }
        assert_eq!(records, 64);
    }
}
