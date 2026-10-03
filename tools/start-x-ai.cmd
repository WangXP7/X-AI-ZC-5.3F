@echo off
rem X-AI 启动入口（1.1.2）：调用启动器，复用或启动本机服务（首选 4183），守护保活，健康检查通过后打开浏览器。
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================
echo   X-AI 本地视频创作台
echo   授权密码见: private\auth-password.txt
echo ============================================
python tools\launch.py %*
if errorlevel 1 pause
