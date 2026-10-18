@echo off
rem 一键生成桌面快捷方式：启动 / 停止 DeepSeek API 代理、编辑配置
cd /d "%~dp0"
title 安装 ds2api 桌面快捷方式
echo 正在创建桌面快捷方式，请稍候...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcuts.ps1"
if errorlevel 1 (
  echo.
  echo [错误] 创建失败。请右键本文件 -^> 以管理员身份运行重试。
) else (
  echo.
  echo [OK] 完成！桌面上已生成：
  echo      - 启动DeepSeek代理
  echo      - 停止DeepSeek代理
  echo      - DeepSeek代理配置
)
pause
