@echo off
REM TLV Rentals - hourly scrape trigger
REM
REM Opens Chrome on the chronological groups feed with the extension's
REM auto-scrape URL parameter. The content script starts a 30-minute scrape
REM by itself ~4 seconds after the page loads - no clicking, no Python,
REM no mouse automation required.
REM
REM Point Windows Task Scheduler at this file (see scraper_task.xml for a
REM ready-to-import hourly task, and README.md for setup instructions).

setlocal

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" (
    echo [TLV Rentals] Chrome not found - edit trigger.bat and set CHROME to your chrome.exe path.
    exit /b 1
)

start "" "%CHROME%" --new-window "https://www.facebook.com/?filter=all&sk=h_chr&tlv_auto_scrape=1"
exit /b 0
