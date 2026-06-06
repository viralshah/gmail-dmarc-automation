# DMARC Analyzer: Apps Script Library Deployment & Sharing Guide

This guide explains how to deploy the automated DMARC report processor as a **Google Apps Script Library**, share it with external users (both inside and outside your organization), and import it into another Google Sheet or standalone script.

---

## Table of Contents
1. [How Apps Script Libraries Work](#1-how-apps-script-libraries-work)
2. [Step 1: Deploying the Library](#step-1-deploying-the-library)
3. [Step 2: Sharing with External Users](#step-2-sharing-with-external-users)
4. [Step 3: Importing the Library (For Consumers)](#step-3-importing-the-library-for-consumers)
5. [Step 4: Usage Code Example](#step-4-usage-code-example)
6. [Best Practices & Security Scopes](#best-practices--security-scopes)

---

## 1. How Apps Script Libraries Work

A Google Apps Script library is a script project whose functions can be called by other scripts. 

- **Execution Context:** When an external user calls your library, the code runs in *their* context. For example, when they call `DMARC.processDMARCReports()`, it searches *their* Gmail for DMARC emails and writes to *their* Google Sheet.
- **Resource Ownership:** The library project file itself remains in your Google Drive. Other users only need **Read/View access** to the library's script project file to execute its code.

---

## Step 1: Deploying the Library

To make your code available as a library, you must create a versioned **Deployment**.

1. Open your Apps Script editor.
2. In the top-right corner, click **Deploy** > **New deployment**.
3. Click the gear icon (**Select type**) next to "Configuration" and select **Library**.
4. Enter a description (e.g., `DMARC Analyzer Library v1.0.0`).
5. Click **Deploy**.
6. Copy the **Script ID** (also called the Library ID) shown in the deployment details. You will need to share this ID with your users.
   - *Example format:* `1x2y3z..._A-B-C...`

> [!TIP]
> Whenever you modify your library's code in the future, you must create a **new version** by going to **Deploy** > **Manage deployments** > **Edit** > select **New version** under Version, and click **Deploy**.

---

## Step 2: Sharing with External Users

Since your library is stored as a file in Google Drive, external users must have **Viewer** permissions on the script project file to use it.

### Option A: Sharing with Specific People
1. Open the Apps Script editor.
2. Click the **Share** button in the top right (or locate the script project file in Google Drive and right-click > **Share**).
3. Add the email addresses of the folks outside your organization.
4. Set their role to **Viewer** (do **not** make them Editors, or they can alter your library source code).
5. Click **Send**.

### Option B: Sharing with Anyone (Public Read-Only)
If you want to share it with the public or any user with the link:
1. Locate the Apps Script project file in your Google Drive.
2. Right-click the file and select **Share** > **Share**.
3. Under **General access**, change it from "Restricted" to **Anyone with the link**.
4. Ensure the role is set to **Viewer**.
5. Click **Done**.

> [!WARNING]
> ### Enterprise (Google Workspace) Constraints
> If your Google account is managed by an organization (Workspace/G Suite), your IT Administrator may have disabled sharing Google Drive files outside the organization. 
> 
> **How to verify & bypass:**
> - If you try to share the file with an external address and get a warning saying *"Sharing outside [YourOrg] is disabled"*, your admin blocks external sharing.
> - **Solution 1:** Ask your Google Workspace administrator to whitelist external sharing for this specific file or your user account.
> - **Solution 2 (Recommended for open-source/public tools):** Copy the library code and create the Apps Script project using a standard consumer Google account (`@gmail.com`). Consumer accounts have no domain restriction policies and can share files freely with anyone.

---

## Step 3: Importing the Library (For Consumers)

Once you share the **Script ID** and ensure permissions are configured, other users can import it into their own projects:

1. Open the Google Sheet where they want the DMARC reports to reside.
2. Click **Extensions** > **Apps Script**.
3. In the left sidebar next to **Libraries**, click the **+** (Add a library) button.
4. Paste the **Script ID** you provided into the box and click **Look up**.
5. Select the latest version from the dropdown menu.
6. In the **Identifier** field, type `DMARC` (this is the name used to reference the library in the code).
7. Click **Add**.

---

## Step 4: Usage Code Example

The user will write a simple starter script in their own Apps Script editor to trigger the library functions.

### Standard Setup (Active Spreadsheet)
If the script is bound to a Google Sheet, they don't even need to pass a spreadsheet ID! The library automatically detects and uses the active sheet (and will load configuration options like report labels directly from the sheet's `Config` tab):

```javascript
// Run this once manually to initialize the Config, Help, Dashboard, and Reports tabs.
function setupDMARC() {
  DMARC.setupConfigSheet();
  DMARC.setupHelpSheet();
  DMARC.setupDashboardSheet();
}

// Main daily trigger function
function runDailyDMARCProcessor() {
  // Pulls DMARC emails from Gmail, parses, aggregates, and exports
  DMARC.autoLabelAndProcessDMARCReports();
}

// Clean up trigger function (removes processed labels from Gmail threads older than 7 days)
function runDailyCleanup() {
  DMARC.deleteOldProcessedDMARCEmails();
}
```

### Advanced Setup (Explicit Spreadsheet ID)
If the user is running a standalone script (not bound to a sheet) or wants to update a specific sheet:

```javascript
function runDailyDMARCProcessor() {
  const targetSpreadsheetId = "1_abc123XYZ_your_external_sheet_id";
  
  // Explicitly target a spreadsheet for processing
  DMARC.autoLabelAndProcessDMARCReports(targetSpreadsheetId);
}

function runDailyCleanup() {
  const targetSpreadsheetId = "1_abc123XYZ_your_external_sheet_id";
  
  // Explicitly target a spreadsheet for label settings and cleanup
  DMARC.deleteOldProcessedDMARCEmails(targetSpreadsheetId);
}
```

---

## Best Practices & Security Scopes

### 1. Permissions & Authorization
When external users run your library for the first time, Google will ask them to authorize the following scopes:
- `https://www.googleapis.com/auth/gmail.modify` (to read and label DMARC emails)
- `https://www.googleapis.com/auth/spreadsheets` (to edit the sheet)
- `https://www.googleapis.com/auth/drive` (to export CSV reports)
- `https://www.googleapis.com/auth/script.external_request` (for GeoIP lookups via `ip-api.com`)
- `https://www.googleapis.com/auth/script.send_mail` (to email PDF summary reports)

All authorization prompts will state that the script belongs to *your* email address (the library owner). Let your users know to expect this.

### 2. Restricting API Access (Optional)
If you want to ensure the library is not used with unauthorized sheets, you can log spreadsheet edits or add domain validation inside the library. However, since they run the code inside their own container, they control their own data boundaries.
