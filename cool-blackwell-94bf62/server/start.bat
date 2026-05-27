@echo off
:: TLV Rentals — Training Data Server
:: Run this once before using the dashboard.
:: The server collects your labeled posts into training.db
:: so they survive browser-data clears and are ready for model training later.

cd /d "%~dp0"

:: Install dependencies on first run (skipped if already installed)
pip install -r requirements.txt --quiet

echo.
echo [TLV Rentals] Server starting at http://localhost:8765
echo [TLV Rentals] Leave this window open while labeling posts.
echo [TLV Rentals] Press Ctrl+C to stop.
echo.

python -m uvicorn server:app --host 127.0.0.1 --port 8765
