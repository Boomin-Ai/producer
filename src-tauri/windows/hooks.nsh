; Tauri v2 NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; Guests reach Producer's WebRTC media ports directly, so Windows Firewall
; must allow inbound traffic to Producer.exe on EVERY profile. Left to the
; first-run prompt, the rule lands on whichever profile the user happens to
; be on (often "Public" only), and guest media silently never connects.
; Rust's firewall_status() detects a missing rule at runtime and offers an
; elevated repair; this hook makes that the exception, not the norm.

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
