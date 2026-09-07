# Calendar control

Oracle can read and change your real calendar — the Google, iCloud or Outlook account you see in the Notion Calendar app.

There are two ways it can do that, and the difference matters.

## The good path: the macOS Calendar app (default)

macOS Calendar is scriptable. If your account is added to macOS, Oracle talks to it directly and gets everything: reading your schedule, creating events, moving them, renaming them, deleting them. Changes sync to your account and appear in Notion Calendar like any other event.

**Setup, once:**

1. **System Settings → General → Internet Accounts** → add your Google (or iCloud/Outlook) account and tick **Calendars**.
2. Ask Oracle something calendar-related. macOS will ask whether Notion Oracle may control **Calendar** — allow it.
3. If macOS also asks for **Calendars** access, choose **Full Access**. "Add Only" blocks reading, updating and deleting.

You can check what it sees by asking *"what calendars do I have?"*.

**What you can ask for:**

- *"What's on my calendar this week?"*
- *"Add dentist on Sept 12 at 2pm"* — a bare date instead makes it all-day
- *"Move my 3pm to Thursday"*
- *"Delete the Friday standup"* — it will confirm first unless you named the event exactly

Subscribed calendars such as *Holidays in Canada* are read-only. Oracle refuses to write to one rather than silently putting your event somewhere else.

## The fallback: typing into Notion Calendar

If you are on Windows, or you have not added your account to macOS, Oracle drives the **Notion Calendar app** with keystrokes instead: it brings the app to the front, jumps to the day, presses `C` and types the title.

This is strictly worse and only creates events. It cannot read your calendar, cannot change or delete anything, and cannot verify what it did — so it leaves the new event open for you to press Enter. It needs **Accessibility** permission (System Settings → Privacy & Security → Accessibility) and the Notion Calendar app must be open.

Switch between the two under **How to reach your calendar** in Oracle's settings.

## Limits worth knowing

- **Reads can lag.** macOS pulls from Google on a schedule rather than instantly, so an event added on your phone a minute ago may not show up yet. Oracle asks Calendar to refresh after every write.
- **Deleting is real.** It goes to your actual calendar. Oracle is told to confirm first unless you named the event, but treat it with the same care as deleting it yourself.
- **The permission prompt can reappear after an update.** These builds are ad-hoc signed rather than signed with a paid Apple Developer certificate, and macOS ties permission grants to a signing identity that changes each build. If calendar tools stop working after installing a new version, re-approve Notion Oracle under **Privacy & Security → Automation**.

## When something goes wrong

| Symptom | Fix |
|---|---|
| "macOS blocked access to Calendar" | Privacy & Security → **Automation** → allow Notion Oracle → Calendar. Check **Calendars** grants Full Access too. |
| "Could not reach the macOS Calendar app" | Add your account in **Internet Accounts**, and open Calendar once. |
| "No calendar named X" | Ask *"what calendars do I have?"* and use a name from that list. |
| Event created but not in Notion Calendar | Give it a moment to sync, then refresh Notion Calendar. Check it went to the account you expected, not a local On My Mac calendar. |
| Wrong day or time | Say what you wanted; Oracle can move it with `calendar_update_event`. Times come from your machine's timezone. |
