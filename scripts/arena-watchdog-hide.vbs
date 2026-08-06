' Arena watchdog hidden launcher (v3, 2026-08-06).
' Task Scheduler -> wscript.exe (GUI subsystem: no console window, no flash).
' MUST stay pure ASCII, same reason as the .bat (GBK codepage misparse).
' Start-Process detaches bash so the task session end cannot reap it
' (v2 bat semantics, drill-verified 2026-08-06).
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command ""Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList '-lc','/d/Code/Projects/arena/arena-ts/scripts/arena-watchdog.sh'""", 0, False
