@echo off
setlocal enabledelayedexpansion
title stop ds2api
cd /d "%~dp0"

set "PORT=3210"
set "FOUND="

rem --- 找到端口上的所有监听进程并停止 ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
  set "PID=%%p"
  echo 正在停止 PID !PID! ...
  taskkill /F /PID !PID! >nul 2>&1
  if errorlevel 1 (
    echo   停止失败（进程已退出或无权限^)
  ) else (
    echo   已停止。
    set "FOUND=1"
  )
)

if exist "server.pid" del /q "server.pid" >nul 2>&1

if not defined FOUND (
  echo ds2api 未在运行（端口 %PORT% 上没有监听^)。
)
endlocal
