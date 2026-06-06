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
- "Help" sheet with usage and glossary
- Monthly archiving to new sheets and automatic CSV export to Google Drive
- Scheduled PDF summary report sent via email to recipients
- Cleans up processed emails after 7 days and purges old data per retention policy
- No logos or branding images for a clean, professional look
- Easy to deploy and use for non-technical stakeholders

---

## Why Use This Script?

- **Truly automated:** All DMARC report handling is fully automated, including enrichment, archiving, and reporting.
- **Enterprise-ready:** Summary and dashboard provide actionable insights for security and compliance.
- **No logo/branding clutter:** Clean, professional, and organization-neutral.
- **Mailbox hygiene:** Automatically deletes processed emails after 7 days.
- **Easy to deploy:** Just copy, configure, and set up triggers.

---

## Prerequisites

- A Google account with access to Gmail and Google Drive
- A Google Sheet to store DMARC data (create a new one or use an existing one)
- Basic familiarity with Google Apps Script (for setup)

---

## Setup Instructions

### 1. Prepare Your Google Sheet
- Create a new Google Sheet (or use an existing one).
- Note the Sheet's ID (the long string in the URL between `/d/` and `/edit`).

### 2. Add the Script
- Open your Google Sheet.
- Go to **Extensions → Apps Script**.
- Paste the entire script into the editor, replacing any existing code.
- At the **very top of the script**, set the `spreadsheetId` variable to your Sheet's ID:
  ```js
  const spreadsheetId = "YOUR_SPREADSHEET_ID_HERE";
  ```
- **You only need to update this variable in one place for new deployments.**

### 3. Set Up Gmail Filter and Label (Strongly Recommended)

**Why is this important?**  
The script relies on a Gmail label (default: `DMARC`) to find and process DMARC report emails. Proper labeling ensures:
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


### Automating Deployments with Clasp & Git Hooks

If you prefer editing the code locally and want to automate pushing and deploying to Google Apps Script, you can use the preconfigured **clasp** setup:

1. **Install Clasp & Log In:**
   Make sure you have Node.js installed, then run:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
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
   We have included a git **post-commit hook** in the repository under the [.githooks/post-commit](file:///.githooks/post-commit) file.
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
   - The script auto-labels new DMARC emails (with .xml/.zip/.gz attachments) as `DMARC`.
2. **Processing:**
   - It processes all labeled emails, extracts and parses DMARC XML data, deduplicates, and appends the results to the "DMARC Reports" sheet.
   - Data is enriched with country (GeoIP) and plain-language failure reason.
   - After processing, emails are moved to the `DMARC/Processed` label and archived.
3. **Summary & Charts:**
   - The script updates a "Summary" sheet with aggregated data, dynamic charts, date-range filtering, and drill-down links.
4. **Dashboard:**
   - The "Dashboard" sheet provides KPIs and trendline charts for high-level monitoring.
5. **Config & Help:**
   - The "Config" sheet manages report recipients and retention settings. The "Help" sheet provides usage and glossary.
6. **Archiving & Export:**
   - Each month, data is archived to a new sheet and a CSV is exported to a Google Drive folder (configurable, defaults to `DMARC Archives`). To prevent conflicts, CSV files are isolated inside subfolders named after the active Spreadsheet (e.g. `DMARC - domain.com`).
7. **Scheduled Reporting:**
   - A PDF summary is generated and emailed to recipients on a schedule.
8. **Cleanup:**
   - Processed emails older than 7 days are deleted. Data older than the retention period is purged.

---

## Script Functions (Key)

- `autoLabelDMARCReports(ssOrId)`: Labels new DMARC emails in Gmail.
- `processDMARCReports(ssOrId)`: Processes all labeled DMARC emails, parses attachments, appends data, enriches, updates summary, dashboard, and exports CSV. **(Recommended main trigger if you set up the Gmail filter)**.
- `autoLabelAndProcessDMARCReports(ssOrId)`: Runs both labeling and processing in one go (only use as your main trigger if you did not set up the Gmail filter).
- `deleteOldProcessedDMARCEmails(ssOrId)`: Deletes processed DMARC emails older than 7 days (set as a daily trigger).
- `setupConfigSheet(ssOrId)`, `setupHelpSheet(ssOrId)`, `setupDashboardSheet(ssOrId)`: Create and update Config, Help, and Dashboard sheets.
- `purgeOldDMARCData(ssOrId)`: Purges data older than retention period.
- `addDrillDownLinksToSummary(ssOrId)`: Adds drill-down hyperlinks in Summary.
- `sendScheduledDMARCReport(ssOrId)`: Exports Summary as PDF and emails to recipients.
- `applyBranding(ssOrId)`: Applies font/color styling (no logo logic).

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
- **Change the threshold for DKIM/SPF failure alerts:** Edit the value in the Config sheet ("Alert Failure Threshold") (defaults to `3` failures).
- **Change the retention period:** Edit the value in the Config sheet ("Retention Months").
- **Change report recipients:** Edit the value in the Config sheet ("Report Recipients (comma separated)").
- **Change the archive folder name:** Edit the value in the Config sheet ("Google Drive Archive Folder Name"). Each spreadsheet will create its own subfolder matching its spreadsheet name inside this parent folder to keep domain reports isolated.
- **Change the email retention days:** Edit the value in the Config sheet ("Email Retention Days") to specify after how many days processed emails in Gmail should be deleted (defaults to `7` days).

---

## Security & Privacy

- The script only processes emails with the specified label and attachments.
- All extracted data is stored in your Google Sheet and Drive; nothing is sent externally (except for GeoIP lookups, see below).
- You can review and audit all code and logs in Apps Script.

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
  - Check that triggers are set up correctly.
  - Make sure the Sheet ID is correct and you have permission.
  - Ensure you updated the `spreadsheetId` variable at the top of the script.
- **No DMARC emails found?**
  - Check your Gmail filter and label setup.
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

