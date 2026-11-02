@echo off
chcp 65001 >nul
title 人员管理系统 - 服务端
cd /d "%~dp0"

echo.
echo 人员管理系统正在启动...
echo 请使用本机局域网 IP 加 :8080 访问
echo 关闭此窗口即可停止服务。
echo.
node "server\server.js"

echo.
echo 服务已停止，按任意键退出。
pause >nul

