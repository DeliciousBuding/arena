' Arena watchdog hidden launcher (dynamic release worktree, 2026-08-08).
' MUST stay pure ASCII. Resolve arena-watchdog.sh next to this VBS so a promoted
' production worktree never jumps back to an older hard-coded worktree.
Dim shell, fso, scriptDir, shPath, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shPath = scriptDir & "\arena-watchdog.sh"
cmd = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command ""Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList '" & Replace(shPath, "'", "''") & "'"""
shell.Run cmd, 0, False
