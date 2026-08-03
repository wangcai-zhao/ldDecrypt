@echo off
chcp 65001 >nul 2>nul
title ldDecrypt 网络导出接收端
cd /d "%~dp0"

REM ===== 可选配置：需要时把前面 rem 去掉并修改 =====
REM 访问令牌（务必与受控机网页 ④ 填写的令牌保持一致）
rem set TOKEN=abc123
REM 监听端口（默认 4000）
rem set PORT=4000
REM 文件保存目录（默认：本程序所在目录\received）
set "DIR=%~dp0received"
rem set "DIR=D:\我的解密文件"

echo ============================================
echo   ldDecrypt 网络导出接收端
echo ============================================

REM 优先使用同目录下的打包 exe（双击即可，无需安装 Node）
if exist "%~dp0ldDecrypt-receiver.exe" (
  echo 正在使用内置可执行文件启动...
  "%~dp0ldDecrypt-receiver.exe"
  goto :eof
)

REM 否则用 Node.js 运行（需已安装 Node.js）
where node >nul 2>nul
if %errorlevel%==0 (
  echo 正在使用 Node.js 启动...
  node "%~dp0export-receiver.js"
) else (
  echo.
  echo [错误] 未检测到 Node.js，且同目录没有 ldDecrypt-receiver.exe
  echo 请先安装 Node.js：https://nodejs.org （安装时勾选 Add to PATH）
  echo 或把 ldDecrypt-receiver.exe 放到本文件同一目录下再运行。
  pause
)
