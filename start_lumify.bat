@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\activate.bat (
    echo Virtual environment not found.
    echo Run: python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat
echo Starting Lumify...
start "Lumify Server" python run.py
timeout /t 2 /nobreak >nul
start http://127.0.0.1:5000
