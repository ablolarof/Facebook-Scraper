# Automation — scrape every hour without touching anything

The extension has a built-in trigger: opening a Facebook URL with
`?tlv_auto_scrape=1` (or `&tlv_auto_scrape=1`) starts a **30-minute scrape
automatically** about 4 seconds after the page renders, with a high
duplicate threshold (200 consecutive duplicates) so it captures everything
new since the last run. No popup, no clicking.

This folder schedules that URL to open every hour on Windows:

| File | Purpose |
|------|---------|
| `trigger.bat` | Finds `chrome.exe` and opens the chronological groups feed with `tlv_auto_scrape=1`. |
| `scraper_task.xml` | Ready-to-import Task Scheduler task that runs `trigger.bat` hourly. |

## Setup

1. Make sure the extension is loaded in your **default Chrome profile**, and
   that profile is logged in to Facebook.
2. Edit `scraper_task.xml`: replace both `C:\PATH\TO\REPO` occurrences with
   your clone's folder.
3. Import the task — either Task Scheduler → *Action* → *Import Task…*, or:

   ```
   schtasks /Create /TN "TLV Rentals Scraper" /XML scraper_task.xml
   ```

That's it. Every hour a Chrome window opens on the groups feed, the scrape
runs for up to 30 minutes, and (if Telegram notifications are configured)
matching new posts land on your phone.

## Notes & caveats

- **The computer must be on and you must be logged in to Windows** — the
  task uses an interactive logon, because it opens a visible Chrome window.
  The screen does *not* need to be unlocked, and the window doesn't need
  focus: the scrape runs inside the page regardless of mouse or keyboard.
- **Scrape length is fixed at 30 minutes max** (it stops earlier if it hits
  the end of the feed / duplicate threshold). The hourly cadence plus a
  30-minute window comfortably covers a full hour of new posts.
- **Windows accumulate** — each run opens a new Chrome window and nothing
  closes it. Close them when you pass by, or reuse one: Chrome navigates an
  existing window if you drop `--new-window` from `trigger.bat`.
- Non-Windows: any scheduler works — the whole trick is just "open this URL
  on a schedule". On macOS/Linux use cron with
  `google-chrome "https://www.facebook.com/?filter=all&sk=h_chr&tlv_auto_scrape=1"`.
