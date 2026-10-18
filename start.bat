@echo off
rem 启动 DeepSeek 网页版 API 代理（ds2api）
rem 关闭本窗口即停止服务；也可用"停止DeepSeek代理"快捷方式结束
cd /d "%~dp0"
title DeepSeek API 代理 (ds2api)

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist config.json (
  if exist config.example.json (
    copy /y config.example.json config.json >nul
    echo [提示] 已从 config.example.json 生成 config.json
  )
)

if exist server.pid goto checkpid
goto start

:checkpid
set /p OLD_PID=<server.pid
tasklist /FI "PID eq %OLD_PID%" 2>nul | findstr /i "node.exe" >nul
if not errorlevel 1 goto running

:start
echo 正在启动 DeepSeek API 代理...（日志见本窗口，关闭窗口即停止）
node server.js
if exist server.pid del /q server.pid
goto end

:running
echo [提示] 代理已在运行（PID %OLD_PID%），无需重复启动。
echo        如需重启，请先运行"停止DeepSeek代理"。
goto end

:nonode
echo [错误] 未找到 Node.js。请先安装 Node.js 18 或更高版本：https://nodejs.org

:end
pause
