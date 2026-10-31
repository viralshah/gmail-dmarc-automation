<div align="center">

<h1>Google Apps Script:<br>
Fully Automated DMARC Report Processor for Gmail & Google Sheets</h1>

</div>

## Overview

This Google Apps Script automates the entire workflow of collecting, parsing, storing, summarizing, and archiving DMARC aggregate reports received via email. It is designed for domain administrators, security teams, and anyone who needs to process DMARC XML reports at scale, with zero manual intervention.

**Key Features:**
- Fully hands-off: zero manual steps after setup
- Automatically labels, processes, and archives all DMARC report emails in Gmail
- Robustly extracts and parses DMARC XML data (including from ZIP/GZ attachments)
- Deduplicates reports to prevent double-processing
- Stores parsed data in a Google Sheet ("DMARC Reports" tab)
- Enriches data with country (GeoIP) and plain-language failure reason
- Provides a professional "Summary" sheet with actionable, enterprise-level reporting, including:
  - Aggregated tables (by org, IP, domain)
  - DKIM/SPF pass/fail rates
  - Dynamic, well-placed charts
  - Date-range and multi-month filtering
  - Drill-down hyperlinks for quick investigation
- "Dashboard" sheet with KPIs and trendline charts
- "Config" sheet for report recipients and retention settings
- "Help" sheet with usage, Summary controls, Config settings, column definitions, and glossary (refreshed on every run)
- Monthly archiving to new sheets and automatic CSV export to Google Drive
- Scheduled PDF summary report sent via email to recipients
- Cleans up processed emails after 30 days (configurable) and purges old data per retention policy
- One script can manage several domains, and several Google accounts can share it, each with its own sheets and triggers
- No logos or branding images for a clean, professional look
- Easy to deploy and use for non-technical stakeholders

---

## Why Use This Script?

- **Truly automated:** All DMARC report handling is fully automated, including enrichment, archiving, and reporting.
- **Enterprise-ready:** Summary and dashboard provide actionable insights for security and compliance.
- **No logo/branding clutter:** Clean, professional, and organization-neutral.
- **Mailbox hygiene:** Automatically deletes processed emails after 30 days (configurable).
- **Easy to deploy:** Run `provisionOnce()` once and the sheet, Gmail labels, filter, and triggers are all created for you.

---

## Prerequisites

- A Google account with access to Gmail and Google Drive (the account that receives the DMARC `rua` reports)
- The **Gmail API advanced service** enabled in the script project (already declared in this repo's `appsscript.json`; if you paste `Code.gs` by hand, add it under **Services → `+` → Gmail API**). Needed only so `provisionDomain` can create the Gmail filter.
- Basic familiarity with Google Apps Script (for setup)
- You do **not** need to create a Google Sheet first; `provisionOnce()` creates it. (Only the legacy manual setup below needs an existing sheet.)

---

## Setup Instructions

### Recommended: Automated One-Click Setup (`provisionOnce`)
1. Create a standalone Apps Script project at [script.google.com](https://script.google.com), paste [`Code.gs`](Code.gs), and enable **Services → `+` → Gmail API** (or clone this repo and run `clasp push`).
2. In `provisionOnce()` at the top of `Code.gs`, edit `domain` / `options` if needed (or leave `domain = ""` to automatically use your logged-in Google account's email domain).
3. Select **`provisionOnce`** in the toolbar dropdown and click **Run**.
   - Automatically creates the `<Domain> DMARC Report Analysis` Google Sheet and all its tabs (`Config`, `Help`, `Dashboard`, `DMARC Reports`).
   - Automatically creates the `<domain>_dmarc_rua` and `<domain>_dmarc_rua/processed` Gmail labels and the inbox-skipping Gmail filter.
   - Automatically saves the spreadsheet ID in your account's `PropertiesService.getUserProperties()`.
   - Automatically installs your two daily time-driven triggers (`processAllDomains` and `cleanupAllDomains`) via `ensureDailyTriggers()`. By default processing runs between 6–7am and cleanup between 7–8am, in the project time zone (`Europe/London` in `appsscript.json`; change `timeZone` there or under **Project Settings** if you are elsewhere). To pick other hours, set `processHour` / `cleanupHour` in `provisionOnce()`'s `options` (or run `ensureDailyTriggers({ processHour: 2, cleanupHour: 3 })`). These only apply when the triggers are first created; existing triggers are never edited or duplicated, so delete them in the Triggers tab first to change the time. Pass `createTriggers: false` to skip trigger creation entirely.
4. Google asks you to authorize the script the first time you run it (see [Security & Privacy](#security--privacy) for the scopes). Approve it with the account that receives the reports.
5. Run `showRegisteredSheets` to confirm the sheet is registered, and check the **Triggers (`⏰`)** tab for the two rows marked **Owned by: Me**.

---

### Alternative: Manual Single-Sheet Setup (Legacy)

#### 1. Prepare Your Google Sheet
- Create a new Google Sheet (or use an existing one).
- Note the Sheet's ID (the long string in the URL between `/d/` and `/edit`).

#### 2. Add the Script
- Open your Google Sheet and go to **Extensions → Apps Script** (or open a standalone script).
- Paste the script into the editor, replacing any existing code.
- If using a standalone script without `provisionOnce()`, set the `spreadsheetId` variable in the **Legacy** section at the bottom of `Code.gs` (or register it via `registerExistingSheetsOnce()`):
  ```js
  const spreadsheetId = "YOUR_SPREADSHEET_ID_HERE";
  ```

#### 3. Set Up Gmail Filter and Label (Strongly Recommended)

**Why is this important?**  
The script relies on a Gmail label (default for manually set-up sheets: `DMARC`; sheets created by `provisionOnce` use `<domain>_dmarc_rua` and create the filter for you) to find and process DMARC report emails. Proper labeling ensures:
- Only DMARC reports are processed (no false positives).
- Your inbox stays clean—DMARC emails are archived automatically.
- The script can run on a schedule without manual intervention.

**How to set up the filter:**

1. In Gmail, go to **Settings → Filters and Blocked Addresses → Create a new filter**.
2. In the "Has the words" field, enter:
    ```
    "Report domain:" OR DMARC OR "Aggregate report"
    ```
3. Click **Create filter**.
4. On the next screen, check:
    - **Apply the label:** Select or create a label named `DMARC`
    - **Skip the Inbox (Archive it)** (this keeps your inbox clean)
5. Click **Create filter** to save.

**Result:**  
All incoming DMARC report emails will be labeled as `DMARC` and automatically archived. The script will process only these labeled emails, keeping your inbox uncluttered.

> **Note:**  
> If you use a different label name, update the `labelName` variable in the script accordingly.

### 4. Set Up Triggers
- In the Apps Script editor, click the clock icon (Triggers) in the left sidebar.
- Add two time-driven triggers:
  1. **DMARC Processing** (daily):
     - **Function:** Select `processDMARCReports` if you set up the recommended Gmail filter in Step 3. If you did *not* set up the Gmail filter and want the script to search and label the emails for you, select `autoLabelAndProcessDMARCReports` instead.
     - **Event source:** Time-driven
     - **Type:** Day timer (choose a time)
  2. **deleteOldProcessedDMARCEmails** (daily):
     - **Function:** `deleteOldProcessedDMARCEmails`
     - **Event source:** Time-driven
     - **Type:** Day timer (choose a time)

---

## Library Usage

This script is structured to be fully compatible as a Google Apps Script library. You can include it in other projects and pass the spreadsheet ID or a `Spreadsheet` object dynamically, bypassing global configuration.

### How to use this script as a Library:

1. **Deploy as a Library:**
   - In the Apps Script editor of this script, click **Deploy > New deployment**.
   - Select type **Library**, give it a description (e.g., "DMARC Library"), and click **Deploy**.
   - Copy the **Library ID** from the deployment details.

2. **Add to another project:**
   - Open your container Google Sheet or separate project script.
   - Go to **Extensions > Apps Script**.
   - Next to **Libraries** on the left sidebar, click the **+** (Add a library) button.
   - Paste the Library ID, click **Look up**, select the latest version, choose an identifier (e.g., `DMARC`), and click **Add**.

3. **Call functions dynamically:**
   You can now call the processing function and pass the target spreadsheet ID (or an open `Spreadsheet` object) as an argument:

   ```js
   function myCustomTrigger() {
     const mySpreadsheetId = "YOUR_SPREADSHEET_ID_HERE";
     
     // Process reports and update sheet dynamically
     DMARC.processDMARCReports(mySpreadsheetId);
     
     // Or auto-label and process
     DMARC.autoLabelAndProcessDMARCReports(mySpreadsheetId);
   }
   ```

   *Note: If no spreadsheet ID or object is passed, the functions will automatically fall back to the active spreadsheet of the container script, or the legacy global `spreadsheetId` variable if defined.*


### One script per mailbox: provisioning and the controller pattern

Every library function accepts a spreadsheet ID, so you do not need a bound
script per sheet. You can manage one or more domains from a single script in two ways:

#### Option A: Zero-wrapper setup (run directly from this script via `UserProperties`)
If you own this script project (or share it with your other Google accounts as an **Editor**), you don't need any wrapper script at all:
1. Open the script in the Apps Script editor (`script.google.com`).
2. In `provisionOnce()` at the top of `Code.gs`, edit `domain` / `options` if needed (or leave `domain = ""` to automatically use your logged-in Google account's email domain).
3. Select **`provisionOnce`** (the very first item in the toolbar dropdown) and click **Run**.
   - It creates the spreadsheet and its tabs, populates `Config`, creates the `<domain>_dmarc_rua` and `<domain>_dmarc_rua/processed` Gmail labels, creates the Gmail filter (`to:(<rua addresses>) → apply label, skip inbox`), **saves the new `spreadsheetId` in your account's `PropertiesService.getUserProperties()`**, and **automatically creates your account's two daily time-driven triggers (`processAllDomains` and `cleanupAllDomains`)** via `ensureDailyTriggers()`.
   - Because `UserProperties` and installable triggers are isolated per Google account, multiple accounts with Editor access on the same script project each keep their own separate list of spreadsheets and run under their own Gmail/Drive context.
   - **How Triggers appear in the UI (`Me` vs. `Other user`):** In the **Triggers (`⏰`)** tab, Google Apps Script lists all triggers attached to the project across all Editor accounts in a single table. Look at the **`Owned by`** column:
     - Rows with **`Owned by: Me`** belong to your currently logged-in account and run under your identity (reading only your `UserProperties` and your Gmail/Drive).
     - Rows with **`Owned by: Other user`** belong to another Editor account and run strictly under *their* identity (reading only their `UserProperties` and their Gmail/Drive).
     - Each account that uses the project will have its own pair of `processAllDomains` and `cleanupAllDomains` rows in this table.
   - **Important (`Script Properties` UI vs. `UserProperties`):** Do **not** set `SHEETS` under **Project Settings (`⚙️`) → Script Properties**—that UI edits global `ScriptProperties`, which are shared across all users of the project. Google's Apps Script IDE does not have a UI screen for per-user `UserProperties`; instead:
     - **To add a newly provisioned sheet (and auto-create daily triggers):** Run `provisionOnce()` (saves to your `UserProperties` and calls `ensureDailyTriggers()` automatically).
     - **To install daily triggers if your sheets are already provisioned:** Select `ensureDailyTriggers` in the toolbar dropdown and click **Run**.
     - **To view your saved sheets (and which domain each belongs to):** Select `showRegisteredSheets` in the toolbar dropdown and click **Run** (prints each sheet's domain, title, Gmail label, status, ID, and URL in the Execution log).
     - **To automatically check and unregister trashed sheets:** Select `pruneTrashedRegisteredSheets` in the toolbar dropdown and click **Run** (prompts for confirmation when run from a Sheet UI, or unregisters trashed sheets automatically from the editor; set `dryRun = true` inside it to preview first).
     - **To unregister/remove a specific sheet:** Paste its ID into `unregisterSheetsOnce()` at the top of `Code.gs` and click **Run**.
     - **To migrate/register a legacy pre-existing sheet:** Paste its ID into `registerExistingSheetsOnce()` in the Legacy section at the bottom of `Code.gs` and click **Run**.

#### Option B: External library consumer controller script (for read-only Viewers)
When sharing the library with external users who have **Viewer** (read-only) access, or if you prefer listing your sheet IDs explicitly in code, keep **one small script per mailbox** that imports the library as `DMARC` (with **Services → + → Gmail API** enabled so `provisionDomain` can create filters):

```js
// Controller script (any standalone or bound Apps Script project in the mailbox
// that receives the reports). Library added as `DMARC`; Services → + → Gmail API
// enabled so provisionDomain can create filters.
const SHEETS = [
  "1_abc123...",   // example.com
  "1_def456...",   // example.org
];
function runDailyDMARCProcessor() { DMARC.processAllDomains(SHEETS); }
function runDailyCleanup()        { DMARC.cleanupAllDomains(SHEETS); }
```

Install two daily time-driven triggers on `runDailyDMARCProcessor` and
`runDailyCleanup`. A failure in one domain is logged and does not stop the rest.

> **Note:** pass `createTriggers: false` when calling `provisionDomain` from a
> controller script. Otherwise it installs triggers on `processAllDomains` /
> `cleanupAllDomains` in *your* script, where those functions only exist as
> `DMARC.processAllDomains` / `DMARC.cleanupAllDomains`, so the triggers would
> fail. If that already happened, delete those two rows in the Triggers tab.

**Adding a domain** from a consumer controller script is one call:

```js
function provisionExampleDomain() {
  const r = DMARC.provisionDomain("example.com", {
    ruaAddresses: ["dmarc-rua@example.com", "dmarc-rua+sub.example@example.com"],
    ignoreSourceIpPrefixes: "209.85.220., 104.30., 2600:1901:101:",
    createTriggers: false   // this script has its own triggers (below); see note
  });
  Logger.log(r.spreadsheetId);   // paste into SHEETS (also saved to UserProperties)
}
```

`provisionDomain(domain, options)` is idempotent: if a spreadsheet for `domain`
is already registered in `UserProperties` (and not trashed), it reuses that
spreadsheet instead of creating a duplicate (unless `options.forceCreate` is
`true`). Rerunning it is safe: an existing matching filter and existing triggers
are left alone. Otherwise it creates the spreadsheet (named
`<Domain> DMARC Report Analysis` unless `options.sheetName` says otherwise),
runs the Config/Help/Dashboard setup, fills Config with the standard values
(`<domain>_dmarc_rua` label and its `/processed` sub-label, recipients
defaulting to the running user, 12-month retention, 30-day email retention,
threshold 3, and `options.ignoreSourceIpPrefixes`), saves the spreadsheet ID in
`UserProperties`, creates both Gmail labels, and creates the Gmail filter
`to:(<rua addresses>) → apply label, skip inbox`. The filter step needs the
**Gmail advanced service** in the calling script; if it is not enabled,
everything else is done and the log tells you what filter to create by hand.
`options.ruaAddresses` defaults to `dmarc-rua@<domain>`; pass the address(es)
actually in your DMARC `rua` tag. It also installs the running user's daily
triggers via `ensureDailyTriggers` (`options.processHour` / `options.cleanupHour`
set the hours, defaults 6 and 7; `options.createTriggers: false` skips this,
e.g. when your controller script has its own triggers). Other options:
`recipients`, `sheetName`, `retentionMonths` (12), `emailRetentionDays` (30),
`alertThreshold` (3), `reportFrequency` (`Weekly`).

Existing per-sheet wrappers keep working; the patterns can coexist in one
mailbox as long as a given sheet is only run by one of them.

### Automating Deployments with Clasp & Git Hooks

If you prefer editing the code locally and want to automate pushing and deploying to Google Apps Script, you can use the preconfigured **clasp** setup:

1. **Install Clasp & Log In:**
   Make sure you have Node.js installed, then run:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
   *Note: If you ever want to log out and clean up your local clasp login credentials later, run `clasp logout`.*
2. **Enable Google Apps Script API:**
   Go to [https://script.google.com/home/usersettings](https://script.google.com/home/usersettings) and set **Google Apps Script API** to **ON**.
3. **Configure your Script ID:**
   Create a `.clasp.json` file in the root directory (this file is ignored by git so it won't be committed). It should look like this:
   ```json
   {
     "scriptId": "YOUR_SCRIPT_ID_HERE",
     "rootDir": "./"
   }
   ```
   Replace `"YOUR_SCRIPT_ID_HERE"` with your actual Google Apps Script project's Script ID (found under **Project Settings** > **IDs** > **Script ID** in the Apps Script editor).
4. **Git Auto-Deploy Hook:**
   We have included a git **post-commit hook** in the repository under the [.githooks/post-commit](.githooks/post-commit) file.
   - To activate the hook for your local repository, configure Git to use the `.githooks` directory:
     ```bash
     git config core.hooksPath .githooks
     chmod +x .githooks/post-commit
     ```
   - Every time you run `git commit`, git will automatically run the hook.
   - The hook will push your updated `Code.gs` and `appsscript.json` to Google Apps Script (`clasp push`).
   - It will automatically increment the version number and create a new version using your git commit message as the version description (`clasp version`).
   - It will find your library deployment and update it to point to the new version automatically (`clasp deploy`).

*Note: If clasp is not logged in or you haven't replaced the placeholder Script ID, the hook will fail silently and skip the deploy process, so your standard git commits won't be blocked.*

---

## How It Works

1. **Labeling:**
   - For provisioned sheets, the Gmail filter created by `provisionDomain` labels incoming reports sent to your `rua` address(es) as `<domain>_dmarc_rua` and skips the inbox.
   - For legacy setups, either your own Gmail filter or `autoLabelDMARCReports` applies the label from the Config sheet (default `DMARC`).
2. **Processing:**
   - Each day `processAllDomains` runs `processDMARCReports` for every sheet registered to the trigger owner (a failure in one domain is logged and does not stop the rest).
   - It processes all labeled emails, extracts and parses DMARC XML data, deduplicates, and appends the results to the "DMARC Reports" sheet.
   - Data is enriched with country (GeoIP) and plain-language failure reason.
   - Sources that fail DMARC outright at least `Alert Failure Threshold` times in one report trigger an alert email.
   - After processing, emails are moved to the processed label (`<domain>_dmarc_rua/processed`, or `DMARC/Processed` for legacy setups) and archived.
3. **Summary & Charts:**
   - The script updates a "Summary" sheet with aggregated data, dynamic charts, date-range filtering, and drill-down links.
4. **Dashboard:**
   - The "Dashboard" sheet provides KPIs and trendline charts for high-level monitoring.
5. **Config & Help:**
   - The "Config" sheet manages report recipients, labels, alerting, and retention settings. The "Help" sheet explains usage, the Summary controls, every Config setting, the report columns, and a glossary. It is rewritten on each run, so don't edit it by hand.
6. **Archiving & Export:**
   - Each month, data is archived to a new sheet and a CSV is exported to a Google Drive folder (configurable, defaults to `DMARC Archives`). To prevent conflicts, CSV files are isolated inside subfolders named after the active Spreadsheet (e.g. `DMARC - domain.com`).
7. **Scheduled Reporting:**
   - A PDF summary is generated and emailed to recipients on a schedule.
8. **Cleanup:**
   - Each day `cleanupAllDomains` trashes processed emails older than `Email Retention Days` (default 30). Data older than `Retention Months` (default 12) is purged.

---

## Script Functions (Key)

### Interactive Toolbar & Provisioning Functions
- `provisionOnce()` / `provisionDomain(domain, options)` — idempotently create (or reuse) the spreadsheet, `Config`/`Help`/`Dashboard`/`DMARC Reports` tabs, Gmail labels, Gmail filter, and daily triggers for a domain; saves the spreadsheet ID in the running user's `UserProperties`.
- `ensureDailyTriggers(options)` — idempotently install the two daily time-driven triggers (`processAllDomains` and `cleanupAllDomains`) for the currently logged-in user.
- `showRegisteredSheets()` — inspect all spreadsheets registered in the current user's `UserProperties` and log their domain, sheet title, Gmail label, status (`ACTIVE`/`TRASHED`/`INACCESSIBLE`), ID, and URL.
- `pruneTrashedRegisteredSheets()` / `cleanupTrashedRegisteredSheets(options)` — detect registered spreadsheets that have been moved to Google Drive Trash and unregister them (prompts for Yes/No confirmation when run from a Sheet UI).
- `unregisterSheetsOnce()` / `unregisterSheet(ids)` / `registerSheet(ids)` / `getRegisteredSheets()` — manage the current user's spreadsheet IDs in `UserProperties`.

### Daily Automation & Core Functions
- `processAllDomains(ids)` / `cleanupAllDomains(ids)` — run the daily report processing or Gmail cleanup across all sheets (uses `ids` if passed, or falls back to the running user's registered sheets in `UserProperties`).
- `processDMARCReports(ssOrId)` — process labeled DMARC emails for a single spreadsheet, parse attachments, append data, enrich, update Summary/Dashboard, export CSV, and send alerts/scheduled reports.
- `deleteOldProcessedDMARCEmails(ssOrId)` — trash processed DMARC emails older than configured retention days (`Email Retention Days` in `Config`).
- `setupConfigSheet(ssOrId)`, `setupHelpSheet(ssOrId)`, `setupDashboardSheet(ssOrId)` — create and update `Config`, `Help`, and `Dashboard` sheets.
- `purgeOldDMARCData(ssOrId)` — purge rows older than `Retention Months` in `Config`.
- `addDrillDownLinksToSummary(ssOrId)` — add drill-down hyperlinks in `Summary`.
- `sendScheduledDMARCReport(ssOrId, force)` — export `Summary` as PDF and email to recipients.
- `applyBranding(ssOrId)` — apply font/color styling.

### Legacy / Backward-Compatibility Functions (at bottom of `Code.gs`)
- `registerExistingSheetsOnce()` — manually register pre-existing spreadsheet IDs into `UserProperties`.
- `autoLabelDMARCReports(ssOrId)` / `autoLabelAndProcessDMARCReports(ssOrId)` — search and label DMARC emails in Gmail (only needed if not using a Gmail filter).
- `onOpen()` / `forceSendScheduledDMARCReport()` — add a **DMARC Tools** menu (Process DMARC Reports / Send Email Report Now) to the Sheets UI. Only works when the script is bound to the spreadsheet (**Extensions → Apps Script**); provisioned sheets don't get the menu.
- `listSheetNames(ssOrId)` — log the tab names of a spreadsheet (diagnostic).

---

## Customization

- **Change the DMARC label name:** Edit the value in the Config sheet ("DMARC Label Name").
- **Change the processed label name:** Edit the value in the Config sheet ("DMARC Processed Label Name").
- **Change report frequency:** Edit the value in the Config sheet ("Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)"). Options are:
  - `Daily`: Sends a PDF report on every daily processing run.
  - `Weekly`: Sends a PDF report once a week on Mondays.
  - `Fortnightly`: Sends a PDF report once every two weeks on Mondays.
  - `Monthly`: Sends a PDF report once a month on the 1st of the month.
  - `Never`: Disables scheduled PDF email reports entirely.
- **Change the threshold for DMARC failure alerts:** Edit the value in the Config sheet ("Alert Failure Threshold") (defaults to `3` failures). An alert fires only for a record whose **DMARC Result is fail**, i.e. neither the aligned DKIM nor the aligned SPF check passed. A row where one check failed and the other passed is a DMARC pass (common with forwarders and mailing lists) and no longer alerts.
- **Silence known forwarders:** Put their IPs or IP prefixes in the Config sheet ("Alert Ignore Source IP Prefixes (comma separated)"), e.g. `209.85.220., 104.30.`. Matching is a simple prefix match on the source IP string; rows are still recorded in the sheet, they just do not alert.
- **New columns since this change:** `DMARC Result` (the receiver's verdict per record), `Envelope To` (recipient domain, when the reporter supplies it; Microsoft does), and `DKIM Signatures` (every signature seen, as `domain:result`). Existing sheets gain the three columns automatically on the next run.
- **Change the retention period:** Edit the value in the Config sheet ("Retention Months").
- **Change report recipients:** Edit the value in the Config sheet ("Report Recipients (comma separated)").
- **Change the archive folder name:** Edit the value in the Config sheet ("Google Drive Archive Folder Name"). Each spreadsheet will create its own subfolder matching its spreadsheet name inside this parent folder to keep domain reports isolated.
- **Change the email retention days:** Edit the value in the Config sheet ("Email Retention Days") to specify after how many days processed emails in Gmail should be deleted (defaults to `30` days). Sheets created before this default changed keep whatever value is in their Config sheet; edit it there if you want 30.

---

## Security & Privacy

- The script only processes emails with the specified label and attachments.
- All extracted data is stored in your Google Sheet and Drive; nothing is sent externally (except for GeoIP lookups, see below).
- You can review and audit all code and logs in Apps Script.
- The scopes the script asks for are declared in `appsscript.json` (`oauthScopes`): Gmail modify and basic settings (labels, filters, cleanup), Sheets, Drive (CSV export and trash checks), installing triggers, external requests (GeoIP and PDF export), sending mail (alerts and PDF reports), and your email address (default domain and recipients). See [LIBRARY_GUIDE.md](LIBRARY_GUIDE.md#best-practices--security-scopes) for what each one is used for.
- **Upgrading an existing install:** when a new version adds a scope, Google asks you to authorize again. Daily triggers fail with an authorization error until you do, so run any function (e.g. `showRegisteredSheets`) from the editor once after updating and approve the prompt. Every account that has its own triggers needs to do this.

---

## GeoIP Enrichment & Rate Limits

- The script enriches DMARC data with country information using the free [ip-api.com](http://ip-api.com/) GeoIP service.
- **ip-api.com free tier is limited to 45 requests per minute and 15,000 requests per day per IP address.**
- For most organizations, this is sufficient. If you process very high volumes, you may hit this limit and some country lookups will return "Unknown".
- No API key is required for the free tier. Data is sent only for IP address lookups (country field only).
- If you exceed the per-minute or daily limit, the script will not fail, but some rows will have "Unknown" for country. The next day, enrichment will resume for new IPs.
- **How to estimate your usage:** One lookup is made per unique IP address in your DMARC data per run. If the same IP appears in multiple reports, it is only enriched once (unless you clear the "Country" column). Most organizations see tens to a few hundred unique IPs per day. Large organizations or those under attack may see thousands.
- **If you process a backlog or a large batch:** You may hit the per-minute limit (45/minute). The script will enrich as many as possible, and the rest will show "Unknown" for country in that run.
- **If you process thousands of new unique IPs every day:** You may hit the daily limit (15,000/day). Again, the script will show "Unknown" for any IPs over the limit.
- For higher limits or guaranteed service, consider a paid ip-api.com plan or alternative GeoIP provider (see script for where to modify). Providers like ipinfo.io, ipdata.co, ipgeolocation.io, and MaxMind offer higher limits and/or batch lookups.
- The script is resilient: all DMARC data is still processed and reported, even if some country lookups are not available.

---

## Troubleshooting

- **Script not running?**
  - Open the **Triggers (`⏰`)** tab and check there's a `processAllDomains` and a `cleanupAllDomains` row marked **Owned by: Me**. Rows marked **Owned by: Other user** belong to another account and only process *that* account's sheets. If yours are missing, run `ensureDailyTriggers`.
  - Run `showRegisteredSheets` and check the Execution log. If no sheets are listed, the triggers have nothing to process: run `provisionOnce` (or `registerExistingSheetsOnce` for an older sheet). Sheets showing `TRASHED` or `INACCESSIBLE` can be removed with `pruneTrashedRegisteredSheets` / `unregisterSheetsOnce`.
  - Check **Executions** for authorization errors. After an update that adds a scope you need to re-authorize (see [Security & Privacy](#security--privacy)).
  - Don't put sheet IDs under **Project Settings → Script Properties**; the script reads your per-user `UserProperties`, not Script Properties.
  - Legacy single-sheet setups only: make sure the `spreadsheetId` variable in the **Legacy** section at the bottom of `Code.gs` is set, or pass the ID to the functions.
- **No DMARC emails found?**
  - Check the label in the Config sheet ("DMARC Label Name") matches the label your emails actually have.
  - If `provisionOnce` logged that it skipped the filter, either the Gmail API advanced service isn't enabled or the new label wasn't visible to the Gmail API yet. Enable the service if needed and run `provisionOnce` again (it reuses the existing sheet and won't duplicate the filter), or create the logged filter by hand.
  - Make sure `ruaAddresses` matched the address(es) in your DMARC record's `rua` tag. The filter only matches mail sent `to:` those addresses.
- **Errors in parsing?**
  - Some malformed DMARC reports may not parse; these are skipped and logged.
- **Permission errors?**
  - Make sure you have authorized the script to access Gmail, Drive, and Sheets.

---

## Quotas & Limits

Google Apps Script and related Google services (Gmail, Sheets, Drive) have daily quotas and limits. For most users, these are sufficient for typical DMARC report processing, but heavy use or large volumes may hit these limits. If a quota is exceeded, the script will pause until the next day.

**Key quotas (as of May 2025, subject to change):**
- **Gmail:**
  - Read/modify: ~1,500 messages/day (consumer), higher for Workspace
  - Sending emails: 100/day (consumer), 1,500/day (Workspace)
- **Google Sheets:**
  - Write cells: 50,000,000 cells/day
  - Read cells: 100,000,000 cells/day
  - Calls to SpreadsheetApp: 90 minutes/day
- **Google Drive:**
  - Create files: 2100/day
  - Write operations: 10,000/day
- **Apps Script total runtime:**
  - 6 minutes per execution (consumer), 30 minutes (Workspace)
  - 90 minutes total script runtime per day (consumer), 6 hours (Workspace)

See the [official quotas documentation](https://developers.google.com/apps-script/guides/services/quotas) for the latest details and Workspace-specific limits.

**Note:**
- If you exceed a quota, the script will stop and resume the next day.
- For most domains, DMARC report volume is well within free quotas.
- Large organizations or high-volume domains may need a Google Workspace account for higher limits.

---

## Credits

- Script developed and refined with the help of the open-source community.
- Inspired by the need for a truly hands-off, robust DMARC automation tool for Google Workspace users.

---

## License

This script is provided as-is, without warranty. You are free to use, modify, and share it. Attribution appreciated.

---

## Feedback & Contributions

If you find this script useful or have suggestions, please open an issue or submit a pull request!

---

## Screenshots: Example Output

Below are example screenshots of the tool's output in Google Sheets. (Sensitive data is pixelated.)

**Summary Sheet:**
![Summary Sheet 1](https://github.com/rkruk/gmail-dmarc-automation/blob/main/images/Screenshot_1.png)

**Dashboard Sheet:**
![Dashboard Sheet](https://github.com/rkruk/gmail-dmarc-automation/blob/main/images/Screenshot_3.png)

**DMARC Reports Sheet:**
![DMARC Reports Sheet](https://github.com/rkruk/gmail-dmarc-automation/blob/main/images/Screenshot_4.png)

