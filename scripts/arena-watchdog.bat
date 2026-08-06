@echo off
rem ArenaWatchdog scheduled-task wrapper (v2, 2026-08-06).
rem MUST stay pure ASCII: cmd parses batch files with the console codepage
rem (GBK on Chinese Windows), so UTF-8 Chinese comments misalign line parsing
rem and flash a "'...' is not recognized" error window on every task run.
rem The Chinese design notes live in arena-watchdog.sh and AGENTS.md.
rem Direct bash under a task session gets reaped when the session ends,
rem so Start-Process launches a fully detached process instead.
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList '-lc','/d/Code/Projects/arena/arena-ts/scripts/arena-watchdog.sh'"
