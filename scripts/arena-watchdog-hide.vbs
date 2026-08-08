' Arena watchdog hidden launcher (v4, 2026-08-08).
' Node 版：Task Scheduler -> wscript.exe (GUI subsystem: no console window, no flash).
' MUST stay pure ASCII, same reason as the .bat (GBK codepage misparse).
' Start-Process detaches node so the task session end cannot reap it
' (v2 bat semantics, drill-verified 2026-08-06).
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command ""Start-Process -WindowStyle Hidden -FilePath 'node.exe' -ArgumentList '/d/Code/Projects/arena/arena-ts/.worktrees/production-runtime-v3/scripts/arena-watchdog.mjs'""", 0, False
