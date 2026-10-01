@echo off
rem X-AI 启动脚本：启动授权密码网关（127.0.0.1:8080）并打开浏览器。
rem 授权密码保存在 private\auth-password.txt（首次运行自动生成并显示）。
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================
echo   X-AI 本地视频创作台
echo   授权密码见: private\auth-password.txt
echo   本机地址:   http://127.0.0.1:8080/
echo ============================================
python tools\server.py --open
pause
