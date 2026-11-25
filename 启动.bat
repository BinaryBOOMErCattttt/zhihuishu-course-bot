@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul

echo ========================================
echo   刷题 / 刷课 自动化框架
echo ========================================
echo.

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [错误] 未找到 Node.js
    echo 请安装 Node.js 20+ 或把 node.exe 放到 node\ 目录
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

rem ---- 首次运行生成配置 ----
if not exist "config.json" (
  echo [首次运行] 生成 config.json ...
  copy /y "config.example.json" "config.json" >nul
)

rem ---- 检查 studyUrl 是否为空 ----
set "NEED_EDIT="
"%NODE_EXE%" -e "try{const c=require('./config.json');if(!c.studyUrl||!c.studyUrl.trim())process.exit(9);}catch(e){process.exit(9);}"
if errorlevel 9 set "NEED_EDIT=1"

if defined NEED_EDIT (
  echo.
  echo ========================================
  echo   [!] 需要填写课程学习页地址
  echo ========================================
  echo.
  echo  studyUrl 是必填项，没有它只能打开站点首页，
  echo  扫不到任何视频。
  echo.
  echo  怎么拿：
  echo    1. 浏览器打开你的课程学习页
  echo    2. 复制地址栏的完整 URL
  echo       形如 https://.../stuStudy?recruitAndCourseId=...
  echo    3. 粘贴到 config.json 的 "studyUrl" 字段
  echo.
  echo  按任意键用记事本打开 config.json ...
  pause >nul
  notepad config.json

  "%NODE_EXE%" -e "try{const c=require('./config.json');if(!c.studyUrl||!c.studyUrl.trim()){console.log('');console.log('[!] studyUrl 仍为空，已退出。');process.exit(9);}}catch(e){console.log('[!] config.json 读取失败:',e.message);process.exit(9);}"
  if errorlevel 9 (
    echo.
    pause
    exit /b 1
  )
)

rem ---- 首次运行安装题库 ----
if not exist "data\quiz-bank.json" (
  echo [首次运行] 安装内置题库 ...
  "%NODE_EXE%" tools\bank.js install zhihuishu-mental-health
  echo.
)

echo 启动服务 ...
start "" http://127.0.0.1:4319
"%NODE_EXE%" server.js

echo.
echo 服务已停止。
pause
