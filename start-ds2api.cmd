@echo off
setlocal EnableDelayedExpansion
title ds2api
cd /d "%~dp0"

set "NODE_EXE=node"
if exist "D:\Program Files\nodejs\node.exe" set "NODE_EXE=D:\Program Files\nodejs\node.exe"

rem --- 已在运行？（端口 3210）---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3210 "') do (
  echo ds2api 已在运行（PID %%p^)：http://127.0.0.1:3210/v1
  goto :done
)

if not exist "log" mkdir "log"
set "DS2_ROOT=%CD%"

rem 以后台方式启动 node（关掉本窗口不影响服务），日志写到 log\ 下
powershell -NoProfile -Command "$p = Start-Process -FilePath $env:NODE_EXE -ArgumentList 'server.js' -WorkingDirectory $env:DS2_ROOT -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:DS2_ROOT 'log\ds2api.out.log') -RedirectStandardError (Join-Path $env:DS2_ROOT 'log\ds2api.err.log') -PassThru; Write-Host ('ds2api 已启动（后台运行）PID=' + $p.Id)"

echo.
echo   API    : http://127.0.0.1:3210/v1
echo   Health : http://127.0.0.1:3210/health
echo   Log    : %DS2_ROOT%\log
echo   本窗口可以关闭，服务在后台继续运行。
echo.
:done
endlocal
