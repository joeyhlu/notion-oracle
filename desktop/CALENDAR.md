# Notion Calendar control

Notion Oracle can put events on your real calendar — Google, iCloud or Outlook — by driving the **Notion Calendar** desktop app the way a person would: bringing it to the front, jumping to the right day, opening a new event and typing the title. This is keystroke automation, not an integration: Notion Calendar has no API, no AppleScript dictionary, and its only deep link (`cron://`) opens events that already exist, not new ones. There's no other way to create an event on your behalf.

## Requirements

- **Notion Calendar must already be open.** Oracle checks this before doing anything and will ask you to open it rather than retrying blindly.
- **On macOS, Notion Oracle needs Accessibility permission** to send keystrokes to another app: **System Settings → Privacy & Security → Accessibility**, enable Notion Oracle. Windows needs no extra permission.

## Default behavior

By default, Oracle leaves the new event **open and unsaved** after typing the title — you glance at it, adjust anything that looks off, and press **Enter** (or click Save) yourself. It can't read the calendar back to confirm an event landed correctly, so it never claims one exists without you confirming it.

Turning on **auto-save** in settings makes Oracle press Enter immediately after typing. Useful once you trust it, but mistakes get saved too, so check the app afterward.

## Two strategies

- **`new-event-key` (default).** Jumps to the target day, presses **C** (Notion Calendar's new-event shortcut) and types the title. The date is exact; the time defaults to whatever Notion Calendar picks for a new event that day, so it may need adjusting in the composer before you save.
- **`command-bar`.** Opens the command bar (**⌘K** / **Ctrl K**) and types one natural-language line — title, date and time together, e.g. "Dentist Sep 7 2026 2pm-3:30pm". This can set the time in one step, but it depends on Notion Calendar correctly parsing that line, which occasionally misreads unusual titles or phrasing.

Ask for either by name ("use the command bar for this") or let Oracle pick the default.

## What it can't do

- **Read your calendar back.** Oracle can't see what's on it or verify an event was created correctly — only you can confirm that by looking at the app.
- **Edit or delete existing events.** It can only create new ones.
- **Run while Notion Calendar is closed.** There's no headless mode; the app has to be visible on screen to receive keystrokes.

## Troubleshooting

- **Nothing happens / a permission-looking error.** On macOS, this is almost always missing Accessibility permission — check **System Settings → Privacy & Security → Accessibility** and make sure Notion Oracle is enabled (toggle it off and back on if it's already listed).
- **Wrong day or time.** Try the other strategy — `new-event-key` for a reliable date, `command-bar` when you need a specific time set automatically — or just fix it in the still-open composer before pressing Save.
- **Text typed into the wrong window.** This means Notion Calendar lost focus mid-run (another window popped up, you clicked away). Bring Notion Calendar to the front and ask Oracle to try again.
