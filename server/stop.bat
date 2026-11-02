@echo off
echo 正在停止人员管理系统服务...
taskkill /f /im node.exe >nul 2>&1
echo 服务已停止。
timeout /t 2 /nobreak >nul
