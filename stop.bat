@echo off
rem 停止 DeepSeek 网页版 API 代理（ds2api）
cd /d "%~dp0"
title 停止 DeepSeek API 代理

if not exist server.pid goto fallback
set /p OLD_PID=<server.pid
taskkill /PID %OLD_PID% /F >nul 2>&1
if errorlevel 1 (
  del /q server.pid >nul 2>&1
  goto fallback
)
del /q server.pid >nul 2>&1
echo [OK] DeepSeek API 代理已停止（PID %OLD_PID%）
goto end

:fallback
rem 兜底：按配置端口找残留的 node 进程（只结束 node，不动其它程序）
set PORT=3000
set KILLED_PID=
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try{(Get-Content -Raw config.json | ConvertFrom-Json).port}catch{3000}"`) do set PORT=%%p
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $_.OwningProcess -Force; Write-Output $_.OwningProcess } }"') do set KILLED_PID=%%i
if not defined KILLED_PID goto nothing
echo [OK] 已结束占用端口 %PORT% 的残留 node 进程（PID %KILLED_PID%）
goto end

:nothing
echo [提示] 未发现正在运行的代理进程。

:end
pause
