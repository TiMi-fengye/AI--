@echo off
chcp 65001 >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo 人员管理系统服务已停止。
pause
