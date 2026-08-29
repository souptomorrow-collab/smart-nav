@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   智慧導航 - 本機伺服器
echo   啟動後請開啟瀏覽器前往 http://localhost:8080
echo   按 Ctrl+C 可停止伺服器
echo ================================================
start "" http://localhost:8080
py -m http.server 8080 2>nul || python -m http.server 8080 2>nul || npx -y serve -l 8080 .
