@echo off
rem ArenaWatchdog fallback wrapper. MUST stay pure ASCII.
rem Delegate to the sibling VBS so the active release worktree is resolved dynamically.
wscript.exe //B "%~dp0arena-watchdog-hide.vbs"
