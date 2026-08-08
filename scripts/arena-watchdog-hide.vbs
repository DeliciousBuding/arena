' Arena watchdog hidden launcher (v5, 2026-08-08).
' Node 版：Task Scheduler -> wscript.exe (GUI subsystem: no console window, no flash).
' v5：worktree 相对解析——arena-watchdog.mjs 与 vbs 同目录，晋升部署永不跳回
' 旧硬编码 worktree（v4 硬编码 .worktrees/production-runtime-v3 的教训）。
' Start-Process 分离 node，任务会话结束不能回收它（v2 bat 语义，drill-verified
' 2026-08-06）。MUST stay pure ASCII（GBK codepage misparse）。
Dim shell, fso, scriptDir, mjsPath, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
mjsPath = scriptDir & "\arena-watchdog.mjs"
cmd = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command ""Start-Process -WindowStyle Hidden -FilePath 'node.exe' -ArgumentList '" & Replace(mjsPath, "'", "''") & "'"""
shell.Run cmd, 0, False
