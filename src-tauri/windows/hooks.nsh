; Tauri v2 NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; Guests reach Producer's WebRTC media ports directly, so Windows Firewall
; must allow inbound traffic to Producer.exe on EVERY profile. Left to the
; first-run prompt, the rule lands on whichever profile the user happens to
; be on (often "Public" only), and guest media silently never connects.
; Rust's firewall_status() detects a missing rule at runtime and offers an
; elevated repair; this hook makes that the exception, not the norm.
;
; PREINSTALL exists because of the in-app updater: it hands this installer to
; ShellExecuteW and only then calls std::process::exit(0) on the app, so file
; extraction can begin while Windows still holds the write lock on the running
; producer.exe. The user sees "Error opening file for writing ... producer.exe"
; with Abort/Retry/Ignore and the update never lands. Wait for the lock to drop
; (bounded, ~6s) before writing anything. Core NSIS instructions only, and a
; no-op on a first install or if the wait times out.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Waiting for Producer to close"
  StrCpy $R1 0
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 producer_lock_done
  producer_lock_wait:
    ClearErrors
    FileOpen $R0 "$INSTDIR\${MAINBINARYNAME}.exe" a
    IfErrors 0 producer_lock_free
    IntOp $R1 $R1 + 1
    IntCmp $R1 24 producer_lock_done producer_lock_sleep producer_lock_done
    producer_lock_sleep:
    Sleep 250
    Goto producer_lock_wait
  producer_lock_free:
    FileClose $R0
  producer_lock_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Allowing Producer through Windows Firewall (all profiles)"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Boomin Producer"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Boomin Producer" dir=in action=allow program="$INSTDIR\${MAINBINARYNAME}.exe" enable=yes profile=any'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing the Producer firewall rule"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Boomin Producer"'
  Pop $0
!macroend
