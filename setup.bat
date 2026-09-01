@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title 大肥鱼 · DeepSeek-Whale-Pet 一键设置

echo ============================================================
echo   大肥鱼 · DeepSeek-Whale-Pet 一键设置
echo   只引导配置，不会覆盖你已存在的 config / config.local。
echo ============================================================
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

rem ---------- 1. 检测 Node.js ----------
echo [1/3] 检测 Node.js ...
set "NODE_OK="
where node >nul 2>nul && set "NODE_OK=1"
if not defined NODE_OK (
  echo   [!] 未检测到 Node.js。
  echo       桌宠（Electron 版）需要 Node.js 18+。
  echo       请到 https://nodejs.org 安装后重新运行本脚本。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   [OK] Node.js %%v
echo.

rem ---------- 2. 生成主配置模板 ----------
echo [2/3] 生成主配置 config.json（若不存在）...
set "CFG=%APPDATA%\deepseek-whale-pet\config.json"
if not exist "%CFG%" (
  if not exist "config.example.json" (
    echo   [!] 缺少 config.example.json，请检查解压是否完整。
    pause
    exit /b 1
  )
  if not exist "%APPDATA%\deepseek-whale-pet" mkdir "%APPDATA%\deepseek-whale-pet"
  copy /y "config.example.json" "%CFG%" >nul
  echo   [OK] 已生成 %CFG%
  echo       随后请右键小鲸鱼 →「设置」填入你的 API Key。
) else (
  echo   [跳过] 已存在 %CFG%，保留你自己的配置。
)
echo.

rem ---------- 3. 本地进阶配置模板 ----------
echo [3/3] 检查本地进阶配置 chat-workspace\config.local.json...
set "LCFG=%ROOT%chat-workspace\config.local.json"
if not exist "%LCFG%" (
  echo   [提示] 本地进阶（本地模型委派 / 文件 MCP / 生图）为可选功能，默认关闭。
  echo           需要本地模型时，请按 README「本地进阶」章节新建 chat-workspace\config.local.json，
  echo           其中 llmBaseUrl / localModelPath / localWhitelist 等按你自己的机器填写。
  echo           没有本地模型也能用基础版（余额 + 云端聊天），无需担心。
) else (
  echo   [跳过] 已存在 %LCFG%，保留你的本地配置。
)
echo.

echo ============================================================
echo 设置完成！
echo   - 想立刻运行？开发调试用：  npm install 之后  npx electron resources
echo   - 想看界面/打包成 exe？详见 README.md「发布」章节。
echo   - 打开对话默认快捷键：Alt+Q
echo ============================================================
echo.
pause
