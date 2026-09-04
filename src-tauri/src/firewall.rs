//! Windows Firewall for guest media.
//!
//! Guests' WebRTC media reaches Producer directly, so an inbound allow rule
//! for Producer.exe must exist on every profile. The installer adds one
//! (windows/hooks.nsh); this is the runtime backstop for a per-user install
//! that couldn't elevate, a rule the user deleted, or a moved binary. Every
//! non-Windows build answers `ok` — nothing to check.

use crate::error::EngineResult;

/// The rule name the installer, the check and the repair all agree on.
#[allow(dead_code)]
pub const RULE_NAME: &str = "Boomin Producer";

#[derive(serde::Serialize)]
pub struct FirewallStatus {
    /// `ok` — rule present (or not a Windows build); `missing` — netsh found
    /// no rule by that name; `unknown` — couldn't ask (netsh failed to run).
    pub status: &'static str,
    /// Diagnostic text for the log, never shown verbatim as the headline.
    pub detail: Option<String>,
}

#[cfg(target_os = "windows")]
mod win {
    use super::{FirewallStatus, RULE_NAME};
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// `netsh advfirewall firewall show rule name="…"` exits 0 when a rule
    /// matches and 1 ("No rules match the specified criteria.") when none
    /// does — the exit code is the signal, so localized output can't fool us.
    pub fn status() -> FirewallStatus {
        let out = Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "show",
                "rule",
                &format!("name={RULE_NAME}"),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match out {
            Ok(o) if o.status.success() => FirewallStatus {
                status: "ok",
                detail: None,
            },
            Ok(o) => FirewallStatus {
                status: "missing",
                detail: Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
            },
            Err(e) => FirewallStatus {
                status: "unknown",
                detail: Some(e.to_string()),
            },
        }
    }

    /// Add the rule for the running binary, elevated (UAC prompt) via
    /// PowerShell `Start-Process -Verb RunAs`. Waits for netsh to finish so
    /// the caller can re-check immediately; a declined prompt surfaces as a
    /// non-zero exit and the rule simply stays missing.
    pub fn allow() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().replace('\'', "''");
        let args = format!(
            "advfirewall firewall add rule name=\"{RULE_NAME}\" dir=in action=allow program=\"{exe}\" enable=yes profile=any"
        );
        // Single-quoted PowerShell literal: no expansion, `''` is the escape.
        let script = format!(
            "Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '{}'",
            args.replace('\'', "''")
        );
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

/// Is the inbound allow rule for Producer present?
#[tauri::command]
pub async fn firewall_status() -> EngineResult<FirewallStatus> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(win::status)
            .await
            .map_err(|e| crate::error::EngineError::Other(e.to_string()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(FirewallStatus {
            status: "ok",
            detail: None,
        })
    }
}

/// Add the rule (UAC prompt), then report the fresh status.
#[tauri::command]
pub async fn firewall_allow() -> EngineResult<FirewallStatus> {
    #[cfg(target_os = "windows")]
    {
        let res = tauri::async_runtime::spawn_blocking(win::allow)
            .await
            .map_err(|e| crate::error::EngineError::Other(e.to_string()))?;
        let mut st = tauri::async_runtime::spawn_blocking(win::status)
            .await
            .map_err(|e| crate::error::EngineError::Other(e.to_string()))?;
        if let Err(e) = res {
            if st.status != "ok" {
                st.detail = Some(e);
            }
        }
        Ok(st)
    }
    #[cfg(not(target_os = "windows"))]
    {
        firewall_status().await
    }
}
