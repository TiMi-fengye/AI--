@echo off
chcp 65001 >nul
netsh advfirewall firewall add rule name="人员管理系统 TCP 8080" dir=in action=allow protocol=TCP localport=8080 profile=private
if errorlevel 1 (
  echo 请右键本文件并选择“以管理员身份运行”。
) else (
  echo 防火墙已放行 TCP 8080，局域网用户可以访问系统。
)
pause
