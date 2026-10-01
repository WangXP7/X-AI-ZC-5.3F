@echo off
rem X-AI 公网发布脚本：通过 SSH 隧道把本机 8080 暴露到公网 HTTPS。
rem 前提：先运行 tools\start-x-ai.cmd。访客用隧道 URL + 授权密码访问。
rem 说明：pinggy 免费隧道每次约 60 分钟，过期后重新运行本脚本即可（URL 会变化）。
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================
echo   X-AI 公网发布（SSH 隧道）
echo   本地网关必须在 8080 端口运行
echo   关闭本窗口即停止公网访问
echo ============================================
echo.
echo [1/2] 尝试 pinggy.io（国内可访问；免费隧道约 60 分钟）...
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -p 443 -R0:127.0.0.1:8080 free.pinggy.io
echo.
echo [2/2] pinggy 退出，尝试 localhost.run（部分网络可能无法访问）...
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 80:127.0.0.1:8080 nokey@localhost.run
echo.
echo 隧道均已退出。请重新运行本脚本。
pause
