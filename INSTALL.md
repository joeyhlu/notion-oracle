# Installing Notion Oracle — step by step

A complete walkthrough for the desktop app, assuming no prior setup experience. Budget about 15 minutes, most of it waiting on downloads.

If you are comfortable with a terminal, the short version is in [`desktop/README.md`](desktop/README.md).

---

## Part 1 — Download and install

### Pick the right file

On a Mac, click the  menu → **About This Mac**:

- It says **Apple M1 / M2 / M3 / M4** → you want the **arm64** file.
- It says **Intel** → you want the file *without* arm64.

On Windows there is only one choice.

### Download

Go to the [latest release](../../releases/latest) and scroll to **Assets** near the bottom.

| You have | Download |
|---|---|
| Mac, Apple chip | `Notion.Oracle-<version>-arm64.dmg` |
| Mac, Intel chip | `Notion.Oracle-<version>.dmg` |
| Windows | `Notion.Oracle.Setup.<version>.exe` |
| Linux | `Notion.Oracle-<version>.AppImage` |

### Install

- **Mac:** double-click the `.dmg`. A window opens with the app icon next to an Applications folder — drag the icon onto the folder.
- **Windows:** double-click the `.exe` and click through the installer.
- **Linux:** `chmod +x Notion.Oracle-*.AppImage`, then run it.

### The first launch will look blocked. It isn't broken.

These builds carry an ad-hoc signature but are not notarized by Apple (that needs a paid
Apple Developer account), so your computer cannot identify the publisher.

**Mac — try these in order, stopping at the first that works:**

1. Open Applications, **right-click** Notion Oracle → **Open**, then **Open** again in the dialog.
2. If macOS refuses anyway: **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to the message about Notion Oracle. (On macOS Sequoia and later this is
   usually the required route — the right-click trick no longer always works.)
3. If it still says the app is **damaged**, clear the download quarantine flag and re-sign it
   locally:

   ```bash
   xattr -cr "/Applications/Notion Oracle.app"
   codesign --force --deep --sign - "/Applications/Notion Oracle.app"
   ```

Any of these is a one-time step; afterwards the app opens by double-click like anything else.

**Windows:** at "Windows protected your PC", click **More info** → **Run anyway**.

---

## Part 2 — Set it up

The app opens straight into a setup screen with three numbered sections.

### 1. Your AI account

Claude is preselected. The app looks for Claude Code on your machine and reports what it finds.

**If it shows a red ✗ "not found",** click **Install…** and run the command it shows you in a terminal:

- **Mac:** press ⌘+Space, type `Terminal`, Enter. Then:
  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```
- **Windows:** Start → type `PowerShell`, Enter. Then:
  ```powershell
  irm https://claude.ai/install.ps1 | iex
  ```

Then click **Sign in** in the app. A terminal opens running `claude auth login` and your browser asks you to log in — this connects your Claude Pro/Max subscription. Come back and click **Re-check**.

> **Do not continue until you see a green ✓ and the words "Signed in."**

Prefer ChatGPT? Select it instead; it needs the [Codex CLI](https://developers.openai.com/codex/cli) (`npm install -g @openai/codex`) and `codex login`. This path is less tested than Claude's — see the status note in [`desktop/README.md`](desktop/README.md).

### 2. Connect Notion

1. Open [notion.so/profile/integrations](https://www.notion.so/profile/integrations) (the app links to it).
2. Create a **new integration**, name it `Oracle`, type **Internal**, with **read**, **update** and **insert content** capabilities.
3. Copy the **Internal Integration Secret** (starts with `ntn_`) and paste it into the app.
4. **Share your pages — the step everyone forgets.** In Notion go to **Settings → Connections**, find Oracle, and tick your top-level pages. Everything nested underneath is included automatically.
5. Back in the app, click **Test Notion**.

> **If Test Notion reports zero pages, stop and fix step 4.** Nothing else will work until it can see something.

### 3. Preferences (optional)

Custom instructions and the keyboard shortcut. Then click **Save & start**.

---

## Part 3 — Test it, cheapest failures first

Open any Notion page, then press **⌘⇧Space** (Mac) or **Ctrl⇧Space** (Windows).

Run these in order. Each builds on the last, so the first one that fails tells you exactly what is broken.

| # | Ask | Proves |
|---|---|---|
| 1 | "What page am I looking at?" | Hotkey, window detection, AI sign-in and Notion search all work |
| 2 | "Summarize this page in three bullets." | It can read page content, not just titles |
| 3 | "Search my workspace for *something you know exists*." | Your sharing covers what you expect |
| 4 | "Add a bullet list of three fruits to the end of the Oracle Test page." | Writing back to Notion |
| 5 | "Add 'Test event' to my Calendar on Friday." | Database/calendar entries, the fiddliest path |

**Make a throwaway page called `Oracle Test` before test 4** so a mistake costs nothing.

---

## When something breaks

| Symptom | Fix |
|---|---|
| Hotkey does nothing | Another app claimed it. Use the ◎ pill, or the menu-bar / system-tray icon. Rebind in settings. |
| "Not signed in" | Run `claude auth login` (or `codex login`) in a terminal again, then **Re-check**. |
| "I can't find that page" | The Settings → Connections sharing step. |
| Test Notion sees zero pages | Same — the integration has not been added to any page. |
| Mac: "app is damaged" or won't open | Work down the three steps in Part 1 — right-click → Open, then System Settings → Privacy & Security → Open Anyway, then the `xattr` + `codesign` commands. |
| Nothing happens after a long pause | Open a new conversation with **✚**; if it persists, check the AI tool still reports signed in. |

Found something not covered here? [Open an issue](../../issues) with the exact error text and what you asked.
