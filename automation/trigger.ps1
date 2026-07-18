# TLV Rentals - scheduled scrape trigger with auto-close.
#
# Launched (hidden) by trigger.bat. Opens Chrome on the chronological groups
# feed with the extension's auto-scrape URL parameter, remembers the exact
# window it opened, and closes THAT WINDOW ONLY after $CloseAfterMinutes -
# so hourly runs don't pile up Chrome windows and slow the machine down.
#
# Safety rules:
#   - If the new window can't be identified, nothing is ever closed.
#   - Before closing, the handle is re-checked to still be a live, visible
#     Chrome window (protects against handle reuse / manual close).
#   - Only the tracked window receives WM_CLOSE - other Chrome windows and
#     the browser itself are untouched (unless this was the last window, in
#     which case Chrome exits, which also pauses Telegram bot polling until
#     the next run).
#
# Run with -Probe to verify Chrome detection and the Win32 helper compile
# without opening anything.

param([switch]$Probe)

$CloseAfterMinutes = 50   # scrape maxes out at 30 min; 50 leaves slack
$Url = 'https://www.facebook.com/?filter=all&sk=h_chr&tlv_auto_scrape=1'

$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Output '[TLV Rentals] Chrome not found - edit trigger.ps1.'
    exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TlvWin32 {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    public const uint WM_CLOSE = 0x0010;

    static bool HasChromeClass(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString() == "Chrome_WidgetWin_1";
    }
    public static List<IntPtr> ChromeWindows() {
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (IsWindowVisible(h) && HasChromeClass(h)) found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool IsLiveChromeWindow(IntPtr h) {
        return IsWindow(h) && IsWindowVisible(h) && HasChromeClass(h);
    }
}
"@

if ($Probe) {
    $n = ([TlvWin32]::ChromeWindows()).Count
    Write-Output "[TLV Rentals] Probe OK - chrome: $chrome | open Chrome windows: $n"
    exit 0
}

$before = [TlvWin32]::ChromeWindows()
Start-Process -FilePath $chrome -ArgumentList "--new-window", $Url

# Identify the window this launch created (poll up to 15 s).
$newWindow = [IntPtr]::Zero
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $created = @([TlvWin32]::ChromeWindows() | Where-Object { $before -notcontains $_ })
    if ($created.Count -gt 0) { $newWindow = $created[0]; break }
}

# Never close anything we did not open.
if ($newWindow -eq [IntPtr]::Zero) {
    Write-Output '[TLV Rentals] Could not identify the new window - it will stay open.'
    exit 0
}

Start-Sleep -Seconds ($CloseAfterMinutes * 60)

if ([TlvWin32]::IsLiveChromeWindow($newWindow)) {
    [void][TlvWin32]::PostMessage($newWindow, [TlvWin32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    Write-Output "[TLV Rentals] Closed the scrape window after $CloseAfterMinutes minutes."
}
