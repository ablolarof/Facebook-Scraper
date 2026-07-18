@echo off
REM TLV Rentals - hourly scrape trigger
REM
REM Launches trigger.ps1 hidden in the background. The script opens Chrome
REM on the chronological groups feed with the extension's auto-scrape URL
REM parameter (30-minute scrape starts by itself), remembers the exact
REM window it opened, and closes that window - only that window - after
REM 50 minutes, so hourly runs don't pile up Chrome windows.
REM
REM Point Windows Task Scheduler at this file (see scraper_task.xml for a
REM ready-to-import hourly task, and README.md for setup instructions).

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0trigger.ps1"
exit /b 0
