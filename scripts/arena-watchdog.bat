@echo off
rem ArenaWatchdog 计划任务包装（2026-08-06 v2）：
rem 直接跑 bash 时任务会话结束会回收会话内进程树（实测 2026-08-06 23:41：
rem supervisor 被拉起 16s 后被任务终止杀 ^C）——Start-Process 创建完全独立
rem 进程，任务结束不影响看护逻辑与 supervisor 生命周期。
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList '-lc','/d/Code/Projects/arena/scripts/arena-watchdog.sh'"
