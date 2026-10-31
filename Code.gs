/** Don't modify this script in Google Appscript! Instead modify this file in git and
  push it live **/

// =============================================================================
// GLOBAL CONSTANTS
// =============================================================================

/**
 * Key used in `PropertiesService.getUserProperties()` to store the JSON array
 * of spreadsheet IDs owned/managed by the currently executing Google account.
 */
const USER_PROP_SHEETS_KEY = "DMARC_SHEETS";

/**
 * Column order of the "DMARC Reports" sheet. Existing sheets gain any missing
 * columns at the end on the next run (see `getOrCreateSheet`).
 */
const REPORT_SHEET_HEADERS = [
  "Message ID", "Reporter", "Source IP", "Disposition",
  "DKIM", "SPF", "Domain", "Header From", "Count",
  "Email Date", "Report Date", "Processed Date",
  "DMARC Result", "Envelope To", "DKIM Signatures"
];


// =============================================================================
// 1. INTERACTIVE / RUN-ONCE SETUP FUNCTIONS (Apps Script Editor Toolbar)
// =============================================================================
//
// These zero-argument functions are placed at the very top of the file so they
// appear first in the Apps Script editor's toolbar dropdown.
//
// In a zero-wrapper setup (running directly from this project, or shared with
// your other Google accounts as an Editor):
//   1. Edit `provisionOnce()` below if needed (or leave `domain` empty to use
//      your logged-in Google account's email domain) and click Run.
//   2. The new spreadsheet ID is saved automatically in your account's
//      `PropertiesService.getUserProperties()` (isolated per Google account),
//      and your account's two daily time-driven triggers (`processAllDomains`
//      and `cleanupAllDomains`) are created automatically via `ensureDailyTriggers()`.

/**
 * One-time setup helper to run directly from the Apps Script editor dropdown.
 * Edit `domain` and `options` as needed before clicking Run (or leave `domain`
 * empty to default to your logged-in Google account's email domain).
 *
 * Creates the spreadsheet and its tabs (`Config`, `Help`, `Dashboard`,
 * `DMARC Reports`), creates the `<domain>_dmarc_rua` and
 * `<domain>_dmarc_rua/processed` Gmail labels, creates the Gmail filter,
 * saves the new spreadsheet ID in your account's `UserProperties`, and ensures
 * your two daily triggers (`processAllDomains` and `cleanupAllDomains`) exist.
 *
 * @return {{spreadsheetId: string, url: string, label: string, processedLabel: string, filterCreated: boolean, triggers: Object, registeredSheets: string[]}}
 */
function provisionOnce() {
  const domain = ""; // e.g. "example.com" (leave "" to use your logged-in email's domain)
  const options = {
    // ruaAddresses: ["dmarc-rua@example.com"],          // defaults to dmarc-rua@<domain>
    // ignoreSourceIpPrefixes: "209.85.220., 104.30.",   // known forwarders to silence alerts on
    // processHour: 6, cleanupHour: 7,                   // daily trigger hours (only used when first created)
  };
  return provisionDomain(domain, options);
}

/**
 * Ensure the currently logged-in user has the two daily time-driven triggers
 * (`processAllDomains` and `cleanupAllDomains`) installed on this script project.
 *
 * `ScriptApp.getProjectTriggers()` only returns triggers owned by the current
 * user, so each Editor account gets its own isolated pair of daily triggers
 * without duplicating existing ones. Called automatically by `provisionDomain()`,
 * or can be run directly from the toolbar dropdown if you already provisioned
 * your domains.
 *
 * @param {Object} [options]
 * @param {number} [options.processHour=6] Hour of day (0–23) for `processAllDomains` (default: 6am–7am).
 * @param {number} [options.cleanupHour=7] Hour of day (0–23) for `cleanupAllDomains` (default: 7am–8am).
 * @return {{processTriggerCreated: boolean, cleanupTriggerCreated: boolean, activeTriggerHandlers: string[]}}
 */
function ensureDailyTriggers(options) {
  const o = (options && typeof options === "object") ? options : {};
  const processHour = typeof o.processHour === "number" ? o.processHour : 6;
  const cleanupHour = typeof o.cleanupHour === "number" ? o.cleanupHour : 7;

  const existingTriggers = ScriptApp.getProjectTriggers();
  const existingHandlers = existingTriggers.map(t => t.getHandlerFunction());

  let processTriggerCreated = false;
  let cleanupTriggerCreated = false;

  if (!existingHandlers.includes("processAllDomains")) {
    ScriptApp.newTrigger("processAllDomains")
      .timeBased()
      .everyDays(1)
      .atHour(processHour)
      .create();
    processTriggerCreated = true;
    existingHandlers.push("processAllDomains");
    Logger.log(`Created daily trigger for processAllDomains (at hour ${processHour}).`);
  } else {
    Logger.log("Daily trigger for processAllDomains already exists for current user.");
  }

  if (!existingHandlers.includes("cleanupAllDomains")) {
    ScriptApp.newTrigger("cleanupAllDomains")
      .timeBased()
      .everyDays(1)
      .atHour(cleanupHour)
      .create();
    cleanupTriggerCreated = true;
    existingHandlers.push("cleanupAllDomains");
    Logger.log(`Created daily trigger for cleanupAllDomains (at hour ${cleanupHour}).`);
  } else {
    Logger.log("Daily trigger for cleanupAllDomains already exists for current user.");
  }

  const result = {
    processTriggerCreated: processTriggerCreated,
    cleanupTriggerCreated: cleanupTriggerCreated,
    activeTriggerHandlers: existingHandlers
  };
  Logger.log(`Trigger status for current user: ${JSON.stringify(result)}`);
  return result;
}

/**
 * Inspect all spreadsheet IDs registered in the current user's `UserProperties`
 * and log a detailed table mapping each spreadsheet ID to its domain, sheet
 * title, Gmail label, status (`ACTIVE`, `TRASHED`, or `INACCESSIBLE`), and URL.
 *
 * Select `showRegisteredSheets` in the toolbar dropdown and click Run, then
 * check the Execution log.
 *
 * @return {Array<{spreadsheetId: string, domain: string, sheetName: string, label: string, status: string, url: string}>}
 */
function showRegisteredSheets() {
  const ids = getRegisteredSheets();
  if (ids.length === 0) {
    Logger.log("No spreadsheets are currently registered in UserProperties for this user.");
    return [];
  }
  Logger.log(`Registered DMARC Spreadsheets for current user (${ids.length}):`);
  const details = ids.map((id, idx) => {
    const info = inspectRegisteredSheet(id);
    Logger.log(
      `  [${idx + 1}/${ids.length}] [${info.status}] Domain: ${info.domain} | ` +
      `Sheet: "${info.sheetName}" | Label: ${info.label} | ID: ${info.spreadsheetId}` +
      (info.url ? ` | URL: ${info.url}` : "")
    );
    return info;
  });
  return details;
}

/**
 * Check all spreadsheets registered in the current user's `UserProperties`,
 * detect any that have been moved to Google Drive Trash (or permanently deleted),
 * and unregister them.
 *
 * - When run from a bound Google Sheet UI, prompts with a Yes/No confirmation
 *   dialog listing the trashed sheets before unregistering.
 * - When run from the standalone Apps Script editor (`script.google.com`, which
 *   does not support modal UI prompts), unregisters trashed sheets automatically
 *   unless `dryRun` below is set to `true`.
 *
 * @return {{trashed: Array<Object>, removedIds: string[], remainingIds: string[]}}
 */
function pruneTrashedRegisteredSheets() {
  const dryRun = false; // Set to true to only preview/log trashed sheets without unregistering them
  return cleanupTrashedRegisteredSheets({ dryRun: dryRun });
}

/**
 * One-time helper to remove one or more spreadsheet ID(s) from the currently
 * logged-in user's `UserProperties` list from the editor toolbar.
 * Paste the spreadsheet ID(s) to remove into `sheetIdsToRemove` below, select
 * `unregisterSheetsOnce` in the toolbar dropdown, and click Run.
 *
 * @return {string[]} The updated list of registered spreadsheet IDs for this user.
 */
function unregisterSheetsOnce() {
  const sheetIdsToRemove = [
    // "1_abc123_spreadsheet_id_to_remove"
  ];
  return unregisterSheet(sheetIdsToRemove);
}


// =============================================================================
// 2. DAILY AUTOMATION TRIGGERS & SPREADSHEET EVENT HANDLERS
// =============================================================================
//
// Configure time-driven triggers (Triggers `⏰` → + Add Trigger) on:
//   - `processAllDomains` (daily) — or `processDMARCReports` for a single sheet
//   - `cleanupAllDomains` (daily) — or `deleteOldProcessedDMARCEmails`
//
// Installable triggers in Google Apps Script always run under the Google
// account of the user who created the trigger.

/**
 * Run daily DMARC report processing across multiple spreadsheets from one script.
 *
 * - If `spreadsheetIds` is passed (e.g. from a consumer controller script),
 *   processes each spreadsheet ID in that list.
 * - If no array is passed (e.g. when invoked directly by a time-driven trigger),
 *   automatically reads the trigger owner's registered spreadsheet IDs from
 *   `PropertiesService.getUserProperties()`.
 * - Errors in one domain are logged and do not stop the remaining domains.
 *
 * @param {string|string[]|Object} [spreadsheetIds] Optional spreadsheet ID(s), or trigger event object.
 */
function processAllDomains(spreadsheetIds) {
  resolveSpreadsheetIds(spreadsheetIds).forEach(id => {
    try {
      processDMARCReports(id);
    } catch (e) {
      Logger.log(`processAllDomains: ${id} failed: ${e}`);
    }
  });
}

/**
 * Run daily Gmail cleanup of old processed DMARC emails across multiple spreadsheets.
 *
 * - If `spreadsheetIds` is passed (e.g. from a consumer controller script),
 *   cleans up emails according to each spreadsheet's `Config` tab settings.
 * - If no array is passed (e.g. when invoked directly by a time-driven trigger),
 *   automatically reads the trigger owner's registered spreadsheet IDs from
 *   `PropertiesService.getUserProperties()`.
 * - Errors in one domain are logged and do not stop the remaining domains.
 *
 * @param {string|string[]|Object} [spreadsheetIds] Optional spreadsheet ID(s), or trigger event object.
 */
function cleanupAllDomains(spreadsheetIds) {
  resolveSpreadsheetIds(spreadsheetIds).forEach(id => {
    try {
      deleteOldProcessedDMARCEmails(id);
    } catch (e) {
      Logger.log(`cleanupAllDomains: ${id} failed: ${e}`);
    }
  });
}

/**
 * Main single-domain processor: pulls labeled DMARC report emails from Gmail,
 * extracts XML/ZIP/GZ attachments, deduplicates by message ID, appends records
 * to the "DMARC Reports" tab, sends immediate alert emails on DMARC failures,
 * updates the Summary and Dashboard tabs, exports the monthly CSV archive to
 * Google Drive, enriches rows with GeoIP Country and plain-language Failure
 * Reason, purges expired rows, and dispatches the scheduled PDF summary report.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function processDMARCReports(ssOrId) {
  const sheetName = "DMARC Reports";

  try {
    const ss = getSpreadsheet(ssOrId);
    Logger.log("Spreadsheet loaded: " + (ss ? "yes" : "no"));
    if (!ss) {
      throw new Error("Could not open spreadsheet. Check spreadsheetId and permissions.");
    }

    // --- Always ensure all setup and branding is up to date ---
    setupConfigSheet(ss); // Ensures Config exists and is correct
    setupHelpSheet(ss);   // Ensures Help tab exists
    setupDashboardSheet(ss); // Ensures Dashboard exists and is up to date

    const labelName = getConfigValue(ss, "DMARC Label Name", "DMARC");
    const processedLabelName = getConfigValue(ss, "DMARC Processed Label Name", "DMARC/Processed");
    const thresholdFailures = parseInt(getConfigValue(ss, "Alert Failure Threshold", 3), 10);
    // Source IPs (or prefixes such as "209.85.220." or "2600:1901:101:") whose
    // failures are expected, e.g. known forwarders, and should never alert.
    const ignoredIpPrefixes = String(getConfigValue(ss, "Alert Ignore Source IP Prefixes (comma separated)", ""))
      .split(",").map(s => s.trim()).filter(Boolean);
    const isIgnoredIp = ip => ignoredIpPrefixes.some(prefix => ip.startsWith(prefix));

    const processedLabel = getOrCreateLabel(processedLabelName);

    // Automatically archive last month's data before processing new reports
    archiveLastMonthDMARCData(ss, sheetName);

    const sheet = getOrCreateSheet(ss, sheetName, REPORT_SHEET_HEADERS);

    // Get headers from sheet to map data to correct columns dynamically (resilient to column order/upgrades)
    const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    // Sheets created by older versions lack the verdict/identity columns; add them at the end.
    ["DMARC Result", "Envelope To", "DKIM Signatures"].forEach(name => {
      if (sheetHeaders.indexOf(name) === -1) {
        sheetHeaders.push(name);
        sheet.getRange(1, sheetHeaders.length).setValue(name).setBackground("#b7e1cd").setFontWeight("bold");
      }
    });
    const colMap = {};
    sheetHeaders.forEach((header, index) => {
      colMap[header] = index;
    });

    // Get existing message IDs for deduplication
    const lastRow = sheet.getLastRow();
    let existingMessageIds = [];
    if (lastRow > 1) {
      const msgIdColIndex = sheetHeaders.indexOf("Message ID") !== -1 ? sheetHeaders.indexOf("Message ID") + 1 : 1;
      existingMessageIds = sheet.getRange(2, msgIdColIndex, lastRow - 1, 1).getValues().flat();
    }

    // Search Gmail threads with DMARC label and attachments
    const threads = GmailApp.search(`label:${labelName} has:attachment -label:${processedLabelName}`);
    Logger.log(`Found ${threads.length} threads with label:${labelName} and attachments`);
    const alerts = [];

    for (const thread of threads) {
      Logger.log(`Processing thread: ${thread.getId()}`);
      for (const msg of thread.getMessages()) {
        const msgId = msg.getId();
        const msgDate = msg.getDate();
        Logger.log(`  Message ID: ${msgId} (Received: ${msgDate})`);
        if (existingMessageIds.includes(msgId)) {
          Logger.log(`    Skipping already processed message: ${msgId}`);
          continue;
        }

        const attachments = msg.getAttachments();
        Logger.log(`    Found ${attachments.length} attachments`);
        for (const attachment of attachments) {
          try {
            const filename = attachment.getName().toLowerCase();
            Logger.log(`      Attachment: ${filename}`);
            let xmlBlobs = [];

            if (filename.endsWith(".zip")) {
              xmlBlobs = Utilities.unzip(attachment.copyBlob());
              Logger.log(`      Unzipped to ${xmlBlobs.length} blobs`);
            } else if (filename.endsWith(".gz")) {
              xmlBlobs = [Utilities.ungzip(attachment.copyBlob())];
              Logger.log(`      GZipped blob processed`);
            } else if (filename.endsWith(".xml")) {
              xmlBlobs = [attachment.copyBlob()];
              Logger.log(`      XML blob processed`);
            } else {
              Logger.log(`      Skipping unsupported file type: ${filename}`);
              continue; // unsupported file type
            }

            for (const blob of xmlBlobs) {
              try {
                Logger.log(`        Attempting XML parse for blob of size ${blob.getBytes().length}`);
                const xml = XmlService.parse(blob.getDataAsString());
                const root = xml.getRootElement();
                const reportMeta = root.getChild("report_metadata");
                const orgName = reportMeta ? reportMeta.getChildText("org_name") : "";
                
                // Parse report date range
                const dateRange = reportMeta ? reportMeta.getChild("date_range") : null;
                const beginSec = dateRange ? parseInt(dateRange.getChildText("begin"), 10) : null;
                const beginDate = beginSec ? new Date(beginSec * 1000) : null;

                const records = root.getChildren("record");
                Logger.log(`        Found ${records.length} <record> elements`);
                for (const record of records) {
                  const row = record.getChild("row");
                  const ip = row ? row.getChildText("source_ip") : "";
                  const count = row ? row.getChildText("count") : "";
                  const policy = row ? row.getChild("policy_evaluated") : null;
                  const disposition = policy ? policy.getChildText("disposition") : "";
                  const dkim = policy ? policy.getChildText("dkim") : "";
                  const spf = policy ? policy.getChildText("spf") : "";
                  const identifiers = record.getChild("identifiers");
                  const headerFrom = identifiers ? identifiers.getChildText("header_from") : "";
                  // Microsoft (and a few others) include the recipient domain; Google does not.
                  const envelopeTo = identifiers ? (identifiers.getChildText("envelope_to") || "") : "";
                  const authResults = record.getChild("auth_results");
                  const dkimDomain = authResults && authResults.getChild("dkim") ? authResults.getChild("dkim").getChildText("domain") : "";
                  const spfDomain = authResults && authResults.getChild("spf") ? authResults.getChild("spf").getChildText("domain") : "";
                  // Every DKIM signature the receiver saw, e.g. "example.com:pass; google.com:pass".
                  // A forwarded or Groups-relayed message carries a second, unaligned signature;
                  // listing them all explains most "DKIM fail" rows at a glance.
                  const dkimSignatures = authResults
                    ? authResults.getChildren("dkim").map(d => `${d.getChildText("domain")}:${d.getChildText("result")}`).join("; ")
                    : "";
                  // The receiver's own DMARC verdict for this record. policy_evaluated.dkim/spf are
                  // already *aligned* results, so DMARC passes if either one passes.
                  const dmarcResult = (dkim === "pass" || spf === "pass") ? "pass" : "fail";

                  // Build row array dynamically matching sheet headers
                  const rowData = new Array(sheetHeaders.length).fill("");
                  if (colMap["Message ID"] !== undefined) rowData[colMap["Message ID"]] = msgId;
                  if (colMap["Reporter"] !== undefined) rowData[colMap["Reporter"]] = orgName;
                  if (colMap["Source IP"] !== undefined) rowData[colMap["Source IP"]] = ip;
                  if (colMap["Disposition"] !== undefined) rowData[colMap["Disposition"]] = disposition;
                  if (colMap["DKIM"] !== undefined) rowData[colMap["DKIM"]] = dkim;
                  if (colMap["SPF"] !== undefined) rowData[colMap["SPF"]] = spf;
                  if (colMap["Domain"] !== undefined) rowData[colMap["Domain"]] = dkimDomain || spfDomain;
                  if (colMap["Header From"] !== undefined) rowData[colMap["Header From"]] = headerFrom;
                  if (colMap["Count"] !== undefined) rowData[colMap["Count"]] = count;
                  if (colMap["Email Date"] !== undefined) rowData[colMap["Email Date"]] = msgDate;
                  if (colMap["Report Date"] !== undefined) rowData[colMap["Report Date"]] = beginDate;
                  if (colMap["Processed Date"] !== undefined) rowData[colMap["Processed Date"]] = new Date();
                  if (colMap["DMARC Result"] !== undefined) rowData[colMap["DMARC Result"]] = dmarcResult;
                  if (colMap["Envelope To"] !== undefined) rowData[colMap["Envelope To"]] = envelopeTo;
                  if (colMap["DKIM Signatures"] !== undefined) rowData[colMap["DKIM Signatures"]] = dkimSignatures;

                  Logger.log(`        Appending row: ${JSON.stringify(rowData)}`);
                  sheet.appendRow(rowData);

                  // Alert only on a DMARC *failure* (both aligned checks failed) that meets the
                  // threshold and did not come from an ignored source. A row with DKIM fail but
                  // SPF pass (or vice versa) is a DMARC pass and was the main source of false alarms.
                  if (dmarcResult === "fail" && parseInt(count, 10) >= thresholdFailures && !isIgnoredIp(ip)) {
                    alerts.push({
                      domain: headerFrom || dkimDomain || spfDomain || "Unknown",
                      orgName: orgName,
                      ip: ip,
                      count: count,
                      dkim: dkim,
                      spf: spf,
                      disposition: disposition,
                      envelopeTo: envelopeTo,
                      dkimSignatures: dkimSignatures,
                      date: beginDate ? Utilities.formatDate(beginDate, Session.getScriptTimeZone(), "yyyy-MM-dd") : "Unknown"
                    });
                  }
                }
              } catch (e) {
                Logger.log(`        XML parse failed: ${e}`);
                continue;
              }
            }

          } catch (err) {
            Logger.log("Error parsing attachment: " + err);
          }
        }

        // Add processed label to processed messages label. This allows for ease of testing instead of moving. 
        // You can re-run the function by just removing the processed label and preserving the original label.
        thread.addLabel(processedLabel);
      }
      thread.moveToArchive();
    }

    // Send alert email if failures detected
    if (alerts.length > 0) {
      const dmarcReportsSheet = ss.getSheetByName("DMARC Reports");
      const sheetUrl = dmarcReportsSheet ? `${ss.getUrl()}#gid=${dmarcReportsSheet.getSheetId()}` : ss.getUrl();
      const sheetName = ss.getName();

      let plainTextBody = `DMARC Alerts for ${sheetName}:\n\n`;
      let htmlAlerts = "";

      alerts.forEach(alert => {
        // Every alert is now a DMARC failure (both aligned checks failed); say what the
        // receiver did with it and which signatures it saw, which is what you need to
        // tell a forwarder or relay from a spoof.
        const failStatus = `DMARC failed; receiver disposition: ${alert.disposition || "unknown"}`;
        const failBadge = `<span style="background-color: #fce8e6; color: #c5221f; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block;">DMARC Failed</span> <span style="background-color: #f1f3f4; color: #3c4043; padding: 4px 8px; border-radius: 4px; font-size: 12px; display: inline-block;">disposition: ${alert.disposition || "unknown"}</span>`;
        const detailLine = [
          alert.envelopeTo ? `Recipient domain: ${alert.envelopeTo}` : "",
          alert.dkimSignatures ? `DKIM signatures: ${alert.dkimSignatures}` : "DKIM signatures: none"
        ].filter(Boolean).join("\n   ");

        plainTextBody += `⚠️ Domain: ${alert.domain}\n`;
        plainTextBody += `   Reporter: ${alert.orgName}\n`;
        plainTextBody += `   Source IP: ${alert.ip}\n`;
        plainTextBody += `   Failures: ${alert.count} times\n`;
        plainTextBody += `   Status: ${failStatus}\n`;
        plainTextBody += `   ${detailLine}\n`;
        plainTextBody += `   Report Date: ${alert.date}\n\n`;

        htmlAlerts += `
          <div style="border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; margin-bottom: 15px; background-color: #ffffff; text-align: left;">
            <h3 style="margin: 0 0 10px 0; color: #202124; font-size: 16px; font-weight: bold; border-bottom: 1px solid #f1f3f4; padding-bottom: 5px;">
              Domain: <span style="color: #1a73e8;">${alert.domain}</span>
            </h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 4px 0; color: #5f6368; width: 120px;"><strong>Reporter:</strong></td>
                <td style="padding: 4px 0; color: #202124;">${alert.orgName}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #5f6368;"><strong>Source IP:</strong></td>
                <td style="padding: 4px 0; color: #202124; font-family: monospace;">${alert.ip}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #5f6368;"><strong>Failure Count:</strong></td>
                <td style="padding: 4px 0; color: #202124; font-weight: bold;">${alert.count}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #5f6368;"><strong>Report Date:</strong></td>
                <td style="padding: 4px 0; color: #202124;">${alert.date}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0 4px 0; color: #5f6368; vertical-align: middle;"><strong>Status:</strong></td>
                <td style="padding: 8px 0 4px 0; vertical-align: middle;">${failBadge}</td>
              </tr>
              ${alert.envelopeTo ? `<tr>
                <td style="padding: 4px 0; color: #5f6368;"><strong>Recipient domain:</strong></td>
                <td style="padding: 4px 0; color: #202124;">${alert.envelopeTo}</td>
              </tr>` : ""}
              <tr>
                <td style="padding: 4px 0; color: #5f6368;"><strong>DKIM signatures:</strong></td>
                <td style="padding: 4px 0; color: #202124; font-family: monospace;">${alert.dkimSignatures || "none"}</td>
              </tr>
            </table>
          </div>
        `;
      });

      plainTextBody += `View full analysis here: ${sheetUrl}\n`;

      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333333; line-height: 1.6;">
          <div style="background-color: #c5221f; color: #ffffff; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h2 style="margin: 0; font-size: 20px; font-weight: 600;">DMARC Failure Alerts Detected</h2>
            <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.9;">Spreadsheet: <strong>${sheetName}</strong></p>
          </div>
          <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; background-color: #fcfcfc;">
            <p style="font-size: 15px; margin-top: 0; color: #202124;">The following sources sent mail that failed DMARC outright (neither aligned DKIM nor aligned SPF passed) at least ${thresholdFailures} times in one report. Rows where only one check failed are DMARC passes and are no longer alerted; see the DKIM Signatures column in the sheet to tell forwarders from spoofs.</p>
            
            ${htmlAlerts}
            
            <div style="margin-top: 25px; text-align: center;">
              <a href="${sheetUrl}" style="background-color: #1a73e8; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; display: inline-block; font-size: 14px;">Open DMARC Analysis Sheet</a>
            </div>
            <p style="font-size: 12px; color: #5f6368; margin-top: 25px; text-align: center; border-top: 1px solid #e0e0e0; padding-top: 15px;">
              This alert was generated automatically by the DMARC Analyzer script.
            </p>
          </div>
        </div>
      `;

      MailApp.sendEmail({
        to: Session.getActiveUser().getEmail(),
        subject: `DMARC Alert: ${alerts.length} failing source${alerts.length === 1 ? "" : "s"} for ${sheetName}`,
        body: plainTextBody,
        htmlBody: htmlBody
      });
    }

    // Update summary sheet with charts and formatting
    updateDMARCSummary(ss);

    // Export monthly CSV archive
    exportMonthlyCSV(ss, sheetName);

    // Enrich DMARC Reports with Country and Failure Reason columns
    enrichDMARCReportsWithGeoAndReason(ss);

    // Purge old data according to Config
    purgeOldDMARCData(ss);

    // Add drill-down links to summary
    addDrillDownLinksToSummary(ss);

    // --- Always apply branding and logo automatically ---
    applyBranding(ss);

    // --- Scheduled report (if on trigger) ---
    sendScheduledDMARCReport(ss);

  } catch (err) {
    Logger.log("Error in processDMARCReports: " + err);
  }
}

/**
 * Move processed DMARC report emails older than the configured retention period
 * (`Email Retention Days` in the `Config` sheet, defaulting to 30 days) to Trash.
 * Run on a daily trigger (or via `cleanupAllDomains`) to keep the mailbox clean.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function deleteOldProcessedDMARCEmails(ssOrId) {
  let processedLabelName = "DMARC/Processed";
  let retentionDays = 30;
  try {
    const ss = getSpreadsheet(ssOrId);
    processedLabelName = getConfigValue(ss, "DMARC Processed Label Name", "DMARC/Processed");
    retentionDays = parseInt(getConfigValue(ss, "Email Retention Days", 30), 10) || 30;
  } catch (e) {
    Logger.log("Could not load spreadsheet config for deleteOldProcessedDMARCEmails: " + e.message);
  }

  var threads = GmailApp.search(`label:"${processedLabelName}" older_than:${retentionDays}d`);
  threads.forEach(function(thread) {
    thread.moveToTrash();
  });
}

/**
 * Spreadsheet edit trigger handler: automatically refreshes the `Summary` tab
 * when the interactive filter control cells (`C2` for date range or `C3` for
 * `ALL` historical months) are modified.
 *
 * @param {Object} e The Google Sheets `onEdit` event object.
 */
function onEdit(e) {
  if (!e) return;
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() === "Summary") {
    const row = range.getRow();
    const col = range.getColumn();
    // C2 is row 2 col 3; C3 is row 3 col 3
    if ((row === 2 || row === 3) && col === 3) {
      updateDMARCSummary(sheet.getParent());
    }
  }
}


// =============================================================================
// 3. DOMAIN PROVISIONING, SHEET INITIALIZATION & USER PROPERTIES
// =============================================================================
//
// Programmatic provisioning and sheet setup functions.
// `provisionDomain` needs the Gmail advanced service (`Gmail`) enabled in order
// to create the Gmail filter automatically (enabled in this library's
// `appsscript.json`; a consumer script calling it must also enable
// Services → + → Gmail API).

/**
 * Create and configure everything for one domain: the spreadsheet with its
 * `Config`, `Help`, `Dashboard`, and `DMARC Reports` tabs, the Gmail labels,
 * and the Gmail filter that labels incoming aggregate reports.
 *
 * Fully idempotent: if a spreadsheet for `domain` is already registered in the
 * executing user's `UserProperties` (matching the domain's `DMARC Label Name`
 * in `Config` or the spreadsheet title) and has not been trashed, reuses that
 * spreadsheet instead of creating a duplicate (unless `options.forceCreate` is
 * `true`).
 *
 * @param {string} [domain]          e.g. "example.com". Defaults to the active user's email domain.
 * @param {Object} [options]
 * @param {string|string[]} [options.ruaAddresses]  Address(es) in the domain's DMARC rua tag
 *        that reports arrive at, used as the filter's "to:" criteria. Defaults to
 *        "dmarc-rua@<domain>". Several addresses become an OR.
 * @param {string} [options.recipients]  Digest recipients; defaults to the running user.
 * @param {string} [options.sheetName]   Defaults to "<Domain> DMARC Report Analysis".
 * @param {string} [options.ignoreSourceIpPrefixes]  Known forwarders to never alert on.
 * @param {number} [options.retentionMonths=12]
 * @param {number} [options.emailRetentionDays=30]
 * @param {number} [options.alertThreshold=3]
 * @param {string} [options.reportFrequency="Weekly"]
 * @param {boolean} [options.forceCreate=false]  If `true`, creates a new spreadsheet even if one is already registered.
 * @param {boolean} [options.createTriggers=true]  If `false`, skips `ensureDailyTriggers()`.
 * @param {number} [options.processHour=6]  Passed to `ensureDailyTriggers()`; only applies when the trigger is first created.
 * @param {number} [options.cleanupHour=7]  Passed to `ensureDailyTriggers()`; only applies when the trigger is first created.
 * @return {{spreadsheetId: string, url: string, label: string, processedLabel: string, filterCreated: boolean, alreadyExisted: boolean, registeredSheets: string[]}}
 */
function provisionDomain(domain, options) {
  const userEmail = Session.getActiveUser().getEmail() || "";
  const resolvedDomain = (typeof domain === "string" && domain.trim())
    ? domain.trim()
    : (userEmail.includes("@") ? userEmail.split("@")[1] : "");
  if (!resolvedDomain) {
    throw new Error("provisionDomain: domain is required (pass a domain or edit provisionOnce)");
  }
  const o = options || {};
  const cap = resolvedDomain.charAt(0).toUpperCase() + resolvedDomain.slice(1);
  const sheetName = o.sheetName || `${cap} DMARC Report Analysis`;
  const label = `${resolvedDomain}_dmarc_rua`;
  const processedLabel = `${label}/processed`;
  const ruaList = [].concat(o.ruaAddresses || [`dmarc-rua@${resolvedDomain}`]);

  // Check if a spreadsheet for this domain is already registered in UserProperties
  let ss = !o.forceCreate ? findRegisteredSheetForDomain(resolvedDomain, sheetName, label) : null;
  const alreadyExisted = Boolean(ss);

  if (alreadyExisted) {
    Logger.log(`Domain ${resolvedDomain} already has a registered spreadsheet (${ss.getId()}); reusing it instead of creating a duplicate.`);
    setupConfigSheet(ss);
    if (o.recipients !== undefined) setConfigValue(ss, "Report Recipients (comma separated)", o.recipients);
    if (o.retentionMonths !== undefined) setConfigValue(ss, "Retention Months", o.retentionMonths);
    if (o.reportFrequency !== undefined) setConfigValue(ss, "Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)", o.reportFrequency);
    if (o.emailRetentionDays !== undefined) setConfigValue(ss, "Email Retention Days", o.emailRetentionDays);
    if (o.alertThreshold !== undefined) setConfigValue(ss, "Alert Failure Threshold", o.alertThreshold);
    if (o.ignoreSourceIpPrefixes !== undefined) setConfigValue(ss, "Alert Ignore Source IP Prefixes (comma separated)", o.ignoreSourceIpPrefixes);
    setupHelpSheet(ss);
    setupDashboardSheet(ss);
    getOrCreateSheet(ss, "DMARC Reports", REPORT_SHEET_HEADERS);
  } else {
    // Create new spreadsheet and initialize tabs
    ss = SpreadsheetApp.create(sheetName);
    setupConfigSheet(ss);
    setConfigValue(ss, "Report Recipients (comma separated)", o.recipients || userEmail);
    setConfigValue(ss, "Retention Months", o.retentionMonths || 12);
    setConfigValue(ss, "DMARC Label Name", label);
    setConfigValue(ss, "DMARC Processed Label Name", processedLabel);
    setConfigValue(ss, "Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)", o.reportFrequency || "Weekly");
    setConfigValue(ss, "Google Drive Archive Folder Name", "DMARC Archives");
    setConfigValue(ss, "Email Retention Days", o.emailRetentionDays || 30);
    setConfigValue(ss, "Alert Failure Threshold", o.alertThreshold || 3);
    setConfigValue(ss, "Alert Ignore Source IP Prefixes (comma separated)", o.ignoreSourceIpPrefixes || "");
    setupHelpSheet(ss);
    setupDashboardSheet(ss);
    getOrCreateSheet(ss, "DMARC Reports", REPORT_SHEET_HEADERS);
    const defaultSheet = ss.getSheetByName("Sheet1");
    if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
  }

  // Save/confirm the spreadsheet ID in the running user's UserProperties
  const registeredSheets = registerSheet(ss.getId());

  // Gmail labels
  getOrCreateLabel(label);
  getOrCreateLabel(processedLabel);

  // Gmail filter: to:(rua addresses) -> apply label, skip inbox
  const filterCreated = createReportFilter(label, ruaList);

  // Daily time-driven triggers (processAllDomains & cleanupAllDomains) for current user
  const triggers = o.createTriggers !== false ? ensureDailyTriggers(o) : null;

  const result = {
    spreadsheetId: ss.getId(),
    url: ss.getUrl(),
    label: label,
    processedLabel: processedLabel,
    filterCreated: filterCreated,
    alreadyExisted: alreadyExisted,
    triggers: triggers,
    registeredSheets: registeredSheets
  };
  Logger.log(`Provisioned ${resolvedDomain}: ${JSON.stringify(result)}`);
  if (!filterCreated) {
    Logger.log(`Create the Gmail filter by hand: to:(${ruaList.join(" OR ")}) → apply label "${label}", skip the inbox.`);
  }
  return result;
}

/**
 * Check if any spreadsheet currently registered in the user's `UserProperties`
 * already belongs to the given domain (matching either its `DMARC Label Name`
 * in `Config` or its spreadsheet title). Skips trashed or inaccessible sheets.
 *
 * @param {string} domain    e.g. "example.com"
 * @param {string} sheetName Expected title, e.g. "Example.com DMARC Report Analysis"
 * @param {string} label     Expected Gmail label, e.g. "example.com_dmarc_rua"
 * @return {SpreadsheetApp.Spreadsheet|null} The existing Spreadsheet, or `null` if none found.
 */
function findRegisteredSheetForDomain(domain, sheetName, label) {
  const registeredIds = getRegisteredSheets();
  const targetName = (sheetName || "").toLowerCase();
  const targetLabel = (label || "").toLowerCase();
  for (const id of registeredIds) {
    try {
      if (DriveApp.getFileById(id).isTrashed()) continue;
      const candidate = SpreadsheetApp.openById(id);
      const candidateName = (candidate.getName() || "").toLowerCase();
      const candidateLabel = String(getConfigValue(candidate, "DMARC Label Name", "")).trim().toLowerCase();
      if ((targetLabel && candidateLabel === targetLabel) || (targetName && candidateName === targetName)) {
        return candidate;
      }
    } catch (e) {
      Logger.log(`findRegisteredSheetForDomain: skipping inaccessible sheet ${id}: ${e}`);
    }
  }
  return null;
}

/**
 * Create the Gmail filter that labels incoming DMARC reports and archives them
 * (skips the inbox), using the Gmail Advanced Service (`Gmail.Users.Settings.Filters`).
 * Returns `false` (and logs instructions) if the service is not enabled or if
 * an equivalent filter already exists.
 *
 * @param {string} labelName     The Gmail label name to apply.
 * @param {string[]} toAddresses Recipient `rua` addresses for the filter's `to:` criteria.
 * @return {boolean} `true` if the filter exists or was created; `false` otherwise.
 */
function createReportFilter(labelName, toAddresses) {
  if (typeof Gmail === "undefined") {
    Logger.log("Gmail advanced service is not enabled in this script; skipping filter creation.");
    return false;
  }
  const labels = Gmail.Users.Labels.list("me").labels || [];
  const labelObj = labels.find(l => l.name === labelName);
  if (!labelObj) {
    Logger.log(`Label ${labelName} not visible through the Gmail API yet; skipping filter creation.`);
    return false;
  }
  const criteriaTo = toAddresses.length === 1 ? toAddresses[0] : `(${toAddresses.join(" OR ")})`;
  const existing = (Gmail.Users.Settings.Filters.list("me").filter || [])
    .some(f => f.criteria && f.criteria.to === criteriaTo);
  if (existing) {
    Logger.log(`A filter for to:${criteriaTo} already exists; leaving it.`);
    return true;
  }
  Gmail.Users.Settings.Filters.create({
    criteria: { to: criteriaTo },
    action: { addLabelIds: [labelObj.id], removeLabelIds: ["INBOX"] }
  }, "me");
  return true;
}

/**
 * Read the current user's registered spreadsheet IDs from `UserProperties`.
 * `UserProperties` are scoped per Google account (`Session.getEffectiveUser()`),
 * so multiple editors/triggers on the same script project each have their own
 * independent list of sheets.
 *
 * @return {string[]} Array of spreadsheet IDs registered for the current user.
 */
function getRegisteredSheets() {
  try {
    const raw = PropertiesService.getUserProperties().getProperty(USER_PROP_SHEETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (e) {
    Logger.log(`getRegisteredSheets: failed to parse UserProperties: ${e}`);
    return [];
  }
}

/**
 * Retrieve metadata (domain, sheet title, configured Gmail label, Drive status,
 * and URL) for a single registered spreadsheet ID.
 *
 * @param {string} id The spreadsheet ID to inspect.
 * @return {{spreadsheetId: string, domain: string, sheetName: string, label: string, status: string, url: string}}
 */
function inspectRegisteredSheet(id) {
  let isTrashed = false;
  try {
    isTrashed = DriveApp.getFileById(id).isTrashed();
  } catch (e) {
    return {
      spreadsheetId: id,
      domain: "Unknown",
      sheetName: "(Inaccessible or deleted)",
      label: "-",
      status: "INACCESSIBLE",
      url: ""
    };
  }

  try {
    const ss = SpreadsheetApp.openById(id);
    const sheetName = ss.getName() || "";
    const label = String(getConfigValue(ss, "DMARC Label Name", "")).trim();
    // Derive domain from "<domain>_dmarc_rua" label if possible, else from "<Domain> DMARC Report Analysis" title
    let domain = "";
    if (label && label.endsWith("_dmarc_rua")) {
      domain = label.slice(0, -"_dmarc_rua".length);
    } else if (sheetName) {
      const m = sheetName.match(/^(\S+)\s+DMARC\s+Report\s+Analysis$/i) || sheetName.match(/DMARC\s*-\s*(\S+)/i);
      if (m) domain = m[1].toLowerCase();
    }
    return {
      spreadsheetId: id,
      domain: domain || label || sheetName || "Unknown",
      sheetName: sheetName,
      label: label || "DMARC",
      status: isTrashed ? "TRASHED" : "ACTIVE",
      url: ss.getUrl()
    };
  } catch (e) {
    return {
      spreadsheetId: id,
      domain: "Unknown",
      sheetName: isTrashed ? "(Trashed spreadsheet)" : "(Inaccessible spreadsheet)",
      label: "-",
      status: isTrashed ? "TRASHED" : "INACCESSIBLE",
      url: ""
    };
  }
}

/**
 * Check all spreadsheets registered in the current user's `UserProperties`,
 * identify any that are in Google Drive Trash (or inaccessible/deleted), and
 * unregister them.
 *
 * If called from a Google Sheet UI context (`SpreadsheetApp.getUi()`), prompts
 * the user with a Yes/No confirmation dialog before unregistering. If called
 * from the standalone Apps Script editor (where UI dialogs are unavailable),
 * unregisters automatically unless `options.dryRun` is `true`.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] If `true`, only logs trashed sheets without removing them.
 * @return {{trashed: Array<Object>, removedIds: string[], remainingIds: string[]}}
 */
function cleanupTrashedRegisteredSheets(options) {
  const o = options || {};
  const ids = getRegisteredSheets();
  if (ids.length === 0) {
    Logger.log("No spreadsheets are registered in UserProperties for this user.");
    return { trashed: [], removedIds: [], remainingIds: [] };
  }

  const inspected = ids.map(id => inspectRegisteredSheet(id));
  const trashed = inspected.filter(info => info.status === "TRASHED" || info.status === "INACCESSIBLE");

  if (trashed.length === 0) {
    Logger.log(`All ${ids.length} registered spreadsheet(s) are active (none in Trash).`);
    return { trashed: [], removedIds: [], remainingIds: ids };
  }

  const summaryLines = trashed.map(
    info => `- [${info.status}] Domain: ${info.domain} | Sheet: "${info.sheetName}" | ID: ${info.spreadsheetId}`
  ).join("\n");

  Logger.log(`Found ${trashed.length} trashed/inaccessible registered spreadsheet(s):\n${summaryLines}`);

  if (o.dryRun) {
    Logger.log("Dry run enabled (dryRun: true); no spreadsheets were unregistered.");
    return { trashed: trashed, removedIds: [], remainingIds: ids };
  }

  // Prompt for confirmation if running inside a Spreadsheet UI context
  try {
    const ui = SpreadsheetApp.getUi();
    const response = ui.alert(
      "Unregister Trashed DMARC Sheets?",
      `The following ${trashed.length} registered spreadsheet(s) are in Trash or inaccessible:\n\n${summaryLines}\n\nUnregister them from UserProperties now?`,
      ui.ButtonSet.YES_NO
    );
    if (response !== ui.Button.YES) {
      Logger.log("User cancelled unregistering trashed spreadsheets.");
      return { trashed: trashed, removedIds: [], remainingIds: ids };
    }
  } catch (e) {
    // Running from standalone Apps Script editor or trigger where SpreadsheetApp.getUi() is unavailable; proceed automatically.
  }

  const idsToRemove = trashed.map(info => info.spreadsheetId);
  const remainingIds = unregisterSheet(idsToRemove);
  Logger.log(`Unregistered ${idsToRemove.length} trashed/inaccessible spreadsheet(s): ${JSON.stringify(idsToRemove)}`);
  return { trashed: trashed, removedIds: idsToRemove, remainingIds: remainingIds };
}

/**
 * Add one or more spreadsheet IDs to the current user's `UserProperties` list.
 * Called automatically by `provisionDomain()`, or can be called manually (or
 * via `registerExistingSheetsOnce()`) to register an already-existing spreadsheet.
 *
 * @param {string|string[]} spreadsheetIdOrIds One spreadsheet ID or an array of IDs.
 * @return {string[]} The updated list of registered spreadsheet IDs for this user.
 */
function registerSheet(spreadsheetIdOrIds) {
  const incoming = [].concat(spreadsheetIdOrIds || [])
    .map(id => (typeof id === "string" ? id.trim() : ""))
    .filter(id => id && id !== "YOUR_SPREADSHEET_ID_HERE");
  const current = getRegisteredSheets();
  incoming.forEach(id => {
    if (!current.includes(id)) current.push(id);
  });
  PropertiesService.getUserProperties().setProperty(USER_PROP_SHEETS_KEY, JSON.stringify(current));
  Logger.log(`Registered sheets for current user: ${JSON.stringify(current)}`);
  return current;
}

/**
 * Remove one or more spreadsheet IDs from the current user's `UserProperties` list.
 * Can be called programmatically or via `unregisterSheetsOnce()` from the toolbar.
 *
 * @param {string|string[]} spreadsheetIdOrIds One spreadsheet ID or an array of IDs to remove.
 * @return {string[]} The updated list of registered spreadsheet IDs for this user.
 */
function unregisterSheet(spreadsheetIdOrIds) {
  const toRemove = [].concat(spreadsheetIdOrIds || [])
    .map(id => (typeof id === "string" ? id.trim() : ""))
    .filter(Boolean);
  const current = getRegisteredSheets().filter(id => !toRemove.includes(id));
  PropertiesService.getUserProperties().setProperty(USER_PROP_SHEETS_KEY, JSON.stringify(current));
  Logger.log(`Registered sheets for current user after removal: ${JSON.stringify(current)}`);
  return current;
}

/**
 * Resolve spreadsheet IDs passed explicitly or fall back to the current user's
 * registered sheets in `UserProperties`. Safely ignores the timer event object
 * that Google Apps Script passes as the first argument to time-driven triggers.
 *
 * @param {string|string[]|Object} [spreadsheetIds] Explicit ID(s) or trigger event object.
 * @return {string[]} Resolved list of spreadsheet IDs to process.
 */
function resolveSpreadsheetIds(spreadsheetIds) {
  if (Array.isArray(spreadsheetIds)) {
    return spreadsheetIds.filter(Boolean);
  }
  if (typeof spreadsheetIds === "string" && spreadsheetIds.trim()) {
    return [spreadsheetIds.trim()];
  }
  const registered = getRegisteredSheets();
  if (registered.length === 0) {
    Logger.log("No spreadsheets passed or registered in UserProperties for this user. Run provisionOnce() or registerSheet(id) first.");
  }
  return registered;
}

/**
 * Create or upgrade the `Config` worksheet tab with default settings (report
 * recipients, retention months, Gmail label names, report frequency, Drive
 * archive folder name, email retention days, alert threshold, and ignored IPs).
 * Preserves existing user values when adding newly introduced config keys.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function setupConfigSheet(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  let configSheet = ss.getSheetByName('Config');
  const defaults = [
    ["Report Recipients (comma separated)", Session.getActiveUser().getEmail()],
    ["Retention Months", 12],
    ["DMARC Label Name", "DMARC"],
    ["DMARC Processed Label Name", "DMARC/Processed"],
    ["Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)", "Weekly"],
    ["Google Drive Archive Folder Name", "DMARC Archives"],
    ["Email Retention Days", 30],
    ["Alert Failure Threshold", 3],
    ["Alert Ignore Source IP Prefixes (comma separated)", ""]
  ];

  if (!configSheet) {
    configSheet = ss.insertSheet('Config');
    configSheet.getRange(1, 1, 1, 2).setValues([["Setting", "Value"]]);
    configSheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
    configSheet.getRange(1, 1, 1, 2).setBackground("#b7e1cd").setFontWeight("bold");
    configSheet.setColumnWidths(1, 2, 260);
    configSheet.setFrozenRows(1);
    configSheet.setTabColor("#333333");
  } else {
    // If the Config sheet already exists, ensure new configuration settings are added
    const data = configSheet.getDataRange().getValues();
    
    // Check if we need to migrate the old key name
    let oldKeyRowIndex = -1;
    let hasNewKey = false;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === "Email Report Frequency (Daily/Weekly/Monthly/Never)") {
        oldKeyRowIndex = i + 1; // 1-indexed row number
      } else if (data[i][0] === "Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)") {
        hasNewKey = true;
      }
    }
    
    // Migrate key if needed
    if (oldKeyRowIndex !== -1 && !hasNewKey) {
      configSheet.getRange(oldKeyRowIndex, 1).setValue("Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)");
    }
    
    // Refresh data and add any other missing defaults
    const updatedData = configSheet.getDataRange().getValues();
    const existingKeys = updatedData.slice(1).map(row => row[0]);
    defaults.forEach(pair => {
      if (!existingKeys.includes(pair[0])) {
        configSheet.appendRow(pair);
      }
    });
  }
}

/**
 * Create or refresh the `Help` worksheet tab with usage instructions, column
 * definitions for `DMARC Reports`, and a DMARC/DKIM/SPF glossary.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function setupHelpSheet(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  let helpSheet = ss.getSheetByName('Help');
  if (!helpSheet) helpSheet = ss.insertSheet('Help');
  helpSheet.clear();
  
  // Title Block
  helpSheet.getRange(1, 1).setValue('DMARC Reporting Tool - Help & Documentation')
    .setFontWeight('bold').setFontSize(16).setFontColor('#1a73e8').setFontFamily('Arial');
  
  // Section: Usage Instructions
  helpSheet.getRange(3, 1).setValue('Usage Instructions:').setFontWeight('bold').setFontSize(12).setFontFamily('Arial');
  const instructions = [
    ['1. DMARC reports are processed automatically from your Gmail once a day: emails with the "DMARC Label Name" label are parsed, then moved to the "DMARC Processed Label Name" label.'],
    ['2. The "DMARC Reports" sheet contains all parsed data.'],
    ['3. The "Summary" and "Dashboard" sheets provide visual analytics. Summary shows the current month by default; see Summary Controls below.'],
    ['4. The "Config" sheet lets you set report recipients, retention, alerting, and label names (see Config Settings below).'],
    ['5. Data older than the retention period is purged automatically.'],
    ['6. Processed emails older than the retention days are cleaned from Gmail automatically.'],
    ['7. An alert email is sent when a source fails DMARC outright (neither aligned DKIM nor aligned SPF passed) at least "Alert Failure Threshold" times in one report. A row where only one check failed is a DMARC pass and does not alert.'],
    ['8. This Help tab is rewritten on every daily run, so edits made here are not kept.']
  ];
  helpSheet.getRange(4, 1, instructions.length, 1).setValues(instructions).setFontFamily('Arial').setFontSize(10);

  // Section: Summary Controls
  let startRow = 4 + instructions.length + 2;
  helpSheet.getRange(startRow, 1).setValue('Summary Controls:').setFontWeight('bold').setFontSize(12).setFontFamily('Arial');
  const summaryControls = [
    ['Cell', 'Usage'],
    ['Summary!C2', 'Date range as YYYY-MM-DD:YYYY-MM-DD (e.g. 2025-05-01:2025-05-30). Leave blank for all dates. The Summary refreshes when you edit this cell.'],
    ['Summary!C3', 'Type ALL to aggregate every month of data (including archived months), or leave blank for the current month only. The Summary refreshes when you edit this cell.']
  ];
  helpSheet.getRange(startRow + 1, 1, summaryControls.length, 2).setValues(summaryControls).setFontFamily('Arial').setFontSize(10);
  helpSheet.getRange(startRow + 1, 1, 1, 2).setFontWeight('bold').setBackground('#f1f3f4').setBorder(true, true, true, true, null, null, null, null);
  helpSheet.getRange(startRow + 1, 1, summaryControls.length, 2).setBorder(true, true, true, true, true, true);

  // Section: Config Settings
  startRow = startRow + summaryControls.length + 3;
  helpSheet.getRange(startRow, 1).setValue('Config Settings:').setFontWeight('bold').setFontSize(12).setFontFamily('Arial');
  const configDefs = [
    ['Setting', 'Description'],
    ['Report Recipients (comma separated)', 'Who receives the scheduled PDF summary and the failure alerts.'],
    ['Retention Months', 'Rows older than this many months are purged from "DMARC Reports" (default 12).'],
    ['DMARC Label Name', 'Gmail label the script reads reports from (provisioned sheets use <domain>_dmarc_rua).'],
    ['DMARC Processed Label Name', 'Gmail label processed reports are moved to (provisioned sheets use <domain>_dmarc_rua/processed).'],
    ['Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)', 'How often the PDF summary is emailed: Daily (every run), Weekly (Mondays), Fortnightly (every other Monday), Monthly (the 1st), or Never.'],
    ['Google Drive Archive Folder Name', 'Parent Drive folder for the monthly CSV exports; each spreadsheet gets its own subfolder named after it.'],
    ['Email Retention Days', 'Processed report emails older than this many days are moved to Gmail Trash (default 30).'],
    ['Alert Failure Threshold', 'Minimum DMARC-fail count for one source in one report before it alerts (default 3).'],
    ['Alert Ignore Source IP Prefixes (comma separated)', 'IPs or prefixes (e.g. 209.85.220., 104.30.) of known forwarders whose failures should not alert. Rows are still recorded.']
  ];
  helpSheet.getRange(startRow + 1, 1, configDefs.length, 2).setValues(configDefs).setFontFamily('Arial').setFontSize(10);
  helpSheet.getRange(startRow + 1, 1, 1, 2).setFontWeight('bold').setBackground('#f1f3f4').setBorder(true, true, true, true, null, null, null, null);
  helpSheet.getRange(startRow + 1, 1, configDefs.length, 2).setBorder(true, true, true, true, true, true);

  // Section: Column Definitions
  startRow = startRow + configDefs.length + 3;
  helpSheet.getRange(startRow, 1).setValue('DMARC Reports - Column Definitions:').setFontWeight('bold').setFontSize(12).setFontFamily('Arial');
  
  const colDefs = [
    ['Column Header', 'Description'],
    ['Message ID', 'Unique identifier for the processed email message containing the report.'],
    ['Reporter', 'The organization that generated and sent the DMARC report (e.g. google.com, yahoo.com).'],
    ['Source IP', 'The IP address of the mail server that sent the email.'],
    ['Disposition', 'The DMARC policy action applied to the message (none, quarantine, reject).'],
    ['DKIM', 'The receiver\'s *aligned* DKIM result (pass/fail): did a valid signature from the Header From domain exist? A second, unaligned signature (e.g. a forwarder\'s) does not count here; see DKIM Signatures.'],
    ['SPF', 'The receiver\'s *aligned* SPF result (pass/fail). Fails on any forwarded message because the envelope sender is rewritten.'],
    ['Domain', 'The domain identifier parsed from the DKIM/SPF auth results.'],
    ['Header From', 'The domain name found in the "From:" header of the email message (the domain being authenticated).'],
    ['Count', 'The number of emails received from the Source IP matching this authentication status during the reporting period.'],
    ['Email Date', 'The timestamp/date when the DMARC report email was received in your Gmail inbox.'],
    ['Report Date', 'The starting timestamp/date of the DMARC report\'s window (retrieved from the XML\'s date_range begin tag).'],
    ['Processed Date', 'The timestamp when the report was parsed and appended to this spreadsheet.'],
    ['DMARC Result', 'pass if either the aligned DKIM or the aligned SPF result passed, otherwise fail. This is the verdict that the policy (none/quarantine/reject) acts on, and the only thing the daily alert fires on.'],
    ['Envelope To', 'The recipient domain, when the reporter includes it (Microsoft does, Google does not). Useful for identifying which correspondent\'s mail system is rewriting your messages.'],
    ['DKIM Signatures', 'Every DKIM signature the receiver saw, as domain:result pairs. Your own domain passing alongside a third-party domain means a mailing list or forwarder re-signed the message.'],
    ['Country', 'The country name associated with the source IP address (enriched via GeoIP lookup).'],
    ['Failure Reason', 'Plain-language reading of the DMARC Result and Disposition for this row.']
  ];
  
  helpSheet.getRange(startRow + 1, 1, colDefs.length, 2).setValues(colDefs).setFontFamily('Arial').setFontSize(10);
  
  // Format the Column Definitions headers
  helpSheet.getRange(startRow + 1, 1, 1, 2).setFontWeight('bold').setBackground('#f1f3f4').setBorder(true, true, true, true, null, null, null, null);
  
  // Border around definitions
  helpSheet.getRange(startRow + 1, 1, colDefs.length, 2).setBorder(true, true, true, true, true, true);
  
  // Section: Glossary
  startRow = startRow + colDefs.length + 3;
  helpSheet.getRange(startRow, 1).setValue('Glossary:').setFontWeight('bold').setFontSize(12).setFontFamily('Arial');
  
  const glossary = [
    ['Term', 'Definition'],
    ['DMARC', 'Domain-based Message Authentication, Reporting & Conformance. An email authentication protocol.'],
    ['DKIM', 'DomainKeys Identified Mail. Cryptographic signature-based email authentication.'],
    ['SPF', 'Sender Policy Framework. IP list-based email authentication.'],
    ['Disposition', 'The policy action applied to an email failing authentication: none (log only), quarantine (spam), or reject (block).'],
    ['Alignment', 'A DKIM or SPF pass only counts for DMARC if the domain that passed matches the Header From domain. Forwarders and mailing lists typically break SPF alignment but leave an intact DKIM signature, so DMARC still passes.'],
    ['Alert Ignore Source IP Prefixes', 'Config setting: comma-separated IPs or prefixes (e.g. 209.85.220., 104.30.) whose DMARC failures are expected and should not raise the daily alert.']
  ];
  helpSheet.getRange(startRow + 1, 1, glossary.length, 2).setValues(glossary).setFontFamily('Arial').setFontSize(10);
  helpSheet.getRange(startRow + 1, 1, 1, 2).setFontWeight('bold').setBackground('#f1f3f4').setBorder(true, true, true, true, null, null, null, null);
  helpSheet.getRange(startRow + 1, 1, glossary.length, 2).setBorder(true, true, true, true, true, true);
  
  // Auto-fit columns
  helpSheet.autoResizeColumn(1);
  helpSheet.autoResizeColumn(2);
  helpSheet.setColumnWidth(1, 200);
  helpSheet.setColumnWidth(2, 550);
  helpSheet.setTabColor('#FFD700');
}

/**
 * Create or refresh the `Dashboard` worksheet tab with high-level KPI metrics
 * (Total Messages, DKIM Failures, SPF Failures) and a failure trendline chart.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function setupDashboardSheet(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  let dashboard = ss.getSheetByName('Dashboard');
  if (!dashboard) dashboard = ss.insertSheet('Dashboard');
  dashboard.clear();
  dashboard.setTabColor('#000000');
  dashboard.getRange(1, 1).setValue('DMARC Dashboard').setFontWeight('bold').setFontSize(16).setFontFamily('Arial').setFontColor('#000000').setBackground('#FFFFFF');
  dashboard.getRange(2, 1).setValue('Key Metrics').setFontWeight('bold').setFontSize(12).setFontFamily('Arial').setFontColor('#000000');
  // Pull summary stats from DMARC Reports
  const reports = ss.getSheetByName('DMARC Reports');
  if (!reports) return;
  const data = reports.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0];
  const countCol = headers.indexOf('Count');
  const dkimCol = headers.indexOf('DKIM');
  const spfCol = headers.indexOf('SPF');
  let totalMsgs = 0, dkimFails = 0, spfFails = 0;
  for (let i = 1; i < data.length; i++) {
    totalMsgs += parseInt(data[i][countCol], 10) || 0;
    if (data[i][dkimCol] === 'fail') dkimFails++;
    if (data[i][spfCol] === 'fail') spfFails++;
  }
  dashboard.getRange(3, 1, 3, 2).setValues([
    ['Total Messages', totalMsgs],
    ['DKIM Failures', dkimFails],
    ['SPF Failures', spfFails]
  ]);
  dashboard.getRange(3, 1, 3, 1).setFontWeight('bold').setFontFamily('Arial').setFontColor('#000000');
  dashboard.getRange(3, 2, 3, 1).setFontFamily('Arial').setFontColor('#000000');
  dashboard.getRange(1, 1, 6, 2).setBackground('#FFFFFF');
  // Trendline chart for failures over time
  const dateCol = headers.indexOf('Processed Date');
  let trendData = {};
  for (let i = 1; i < data.length; i++) {
    const date = new Date(data[i][dateCol]);
    const key = date.toISOString().slice(0, 10);
    if (!trendData[key]) trendData[key] = { dkim: 0, spf: 0 };
    if (data[i][dkimCol] === 'fail') trendData[key].dkim++;
    if (data[i][spfCol] === 'fail') trendData[key].spf++;
  }
  const trendRows = Object.keys(trendData).sort().map(date => [date, trendData[date].dkim, trendData[date].spf]);
  if (trendRows.length) {
    dashboard.getRange(8, 1, 1, 3).setValues([["Date", "DKIM Failures", "SPF Failures"]]);
    dashboard.getRange(8, 1, 1, 3).setFontWeight('bold').setFontFamily('Arial').setFontColor('#000000').setBackground('#e3e3e3');
    dashboard.getRange(9, 1, trendRows.length, 3).setValues(trendRows);
    dashboard.getRange(9, 1, trendRows.length, 3).setFontFamily('Arial').setFontColor('#000000');
    // Add chart with legend and axis titles
    const chart = dashboard.newChart()
      .setChartType(Charts.ChartType.LINE)
      .addRange(dashboard.getRange(8, 1, trendRows.length + 1, 3))
      .setPosition(2, 4, 0, 0)
      .setOption('title', 'Failures Over Time')
      .setOption('legend', { position: 'right' })
      .setOption('hAxis', { title: 'Date' })
      .setOption('vAxis', { title: 'Failure Count' })
      .build();
    dashboard.insertChart(chart);
    // Add a clear explanation above the chart
    dashboard.getRange(6, 4).setValue('Chart: Blue = DKIM Failures, Red = SPF Failures').setFontColor('#1565c0').setFontSize(10).setFontWeight('bold');
  }
  dashboard.setColumnWidths(1, 4, 140);
  dashboard.setFrozenRows(1);
}


// =============================================================================
// 4. SUMMARY, DASHBOARD STYLING & DATA ENRICHMENT
// =============================================================================

/**
 * Update or create the `Summary` worksheet tab with aggregated tables (Reporting
 * Org, Failing IP, Top Sending Domains, DKIM/SPF Pass/Fail counts), colored
 * formatting, and dynamic charts.
 *
 * Preserves and applies the interactive filter controls in cells:
 * - `C2`: Date range filter (`YYYY-MM-DD:YYYY-MM-DD`)
 * - `C3`: Set to `ALL` to aggregate across all historical monthly archive tabs
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 */
function updateDMARCSummary(ss) {
  if (!ss) return;
  let summarySheet = ss.getSheetByName("Summary");
  let dateRange = "";
  let useAll = "";

  if (!summarySheet) {
    summarySheet = ss.insertSheet("Summary");
  } else {
    // Read the filter control values BEFORE clearing the sheet
    dateRange = summarySheet.getRange("C2").getValue();
    useAll = summarySheet.getRange("C3").getValue();

    summarySheet.clear();
    const charts = summarySheet.getCharts();
    charts.forEach(function(chart) { summarySheet.removeChart(chart); });
  }

  // --- Write Controls Block First ---
  summarySheet.getRange("B1").setValue("Controls:").setFontWeight("bold").setFontSize(11);
  summarySheet.getRange("B2").setValue("Date Range (YYYY-MM-DD:YYYY-MM-DD)").setFontWeight("bold").setBackground("#e3e3e3");
  summarySheet.getRange("C2").setValue(dateRange || "").setNote("Enter a date range here, e.g. 2025-05-01:2025-05-30. Leave blank for all dates.");
  summarySheet.getRange("B3").setValue("Type 'ALL' to aggregate all months").setFontWeight("bold").setBackground("#e3e3e3");
  summarySheet.getRange("C3").setValue(useAll || "").setNote("Type ALL to aggregate all months of data, or leave blank for current month only.");
  summarySheet.getRange("B1:C3").setBorder(true, true, true, true, true, true).setBackground("#f9f9f9");

  // --- Data Preparation ---
  let data;
  const rawSheet = ss.getSheetByName("DMARC Reports");
  if (!rawSheet) {
    summarySheet.getRange("B5").setValue("No 'DMARC Reports' sheet found. Please run setup first.").setFontStyle("italic");
    formatSummarySheetStyles(summarySheet, ss);
    return;
  }

  if (useAll && useAll.toString().toUpperCase() === 'ALL') {
    data = getAllDMARCData(ss, "DMARC Reports");
  } else {
    data = rawSheet.getDataRange().getValues();
  }

  if (!data || data.length < 2) {
    summarySheet.getRange("B5").setValue("No DMARC data available. Run the processor to pull reports.").setFontStyle("italic");
    formatSummarySheetStyles(summarySheet, ss);
    return;
  }

  // Filter by date range if set
  let isFiltered = false;
  if (dateRange && typeof dateRange === "string" && dateRange.includes(":")) {
    const [start, end] = dateRange.split(":");
    const startDate = new Date(start);
    const endDate = new Date(end);
    const headers = data[0];
    const dateCol = headers.indexOf("Processed Date") !== -1 ? headers.indexOf("Processed Date") : data[0].length - 1;
    data = [headers].concat(data.slice(1).filter(function(row) {
      const d = new Date(row[dateCol]);
      return d >= startDate && d <= endDate;
    }));
    isFiltered = true;
  }

  if (data.length < 2) {
    const msg = isFiltered 
      ? "No DMARC data found matching the date range: " + dateRange
      : "No DMARC data available.";
    summarySheet.getRange("B5").setValue(msg).setFontStyle("italic");
    formatSummarySheetStyles(summarySheet, ss);
    return;
  }
  const headers = data[0];
  const orgIndex = headers.indexOf("Reporter");
  const ipIndex = headers.indexOf("Source IP");
  const dkimIndex = headers.indexOf("DKIM");
  const spfIndex = headers.indexOf("SPF");
  // Aggregate counts by org and failing IPs
  const orgMap = {};
  const failMap = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const org = row[orgIndex];
    const ip = row[ipIndex];
    const dkim = row[dkimIndex];
    const spf = row[spfIndex];
    orgMap[org] = (orgMap[org] || 0) + 1;
    if (dkim !== "pass" || spf !== "pass") {
      failMap[ip] = (failMap[ip] || 0) + 1;
    }
  }
  const orgEntries = Object.entries(orgMap).sort(function(a, b) { return b[1] - a[1]; });
  const failEntries = Object.entries(failMap).sort(function(a, b) { return b[1] - a[1]; });

  // --- Additional Analysis Section ---
  // 1. Top sending domains (from 'Domain' column)
  const domainIndex = headers.indexOf("Domain");
  const domainMap = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const domain = row[domainIndex];
    if (domain) domainMap[domain] = (domainMap[domain] || 0) + 1;
  }
  const domainEntries = Object.entries(domainMap).sort((a, b) => b[1] - a[1]);

  // 2. Pass/fail rates (DKIM, SPF)
  let dkimPass = 0, dkimFail = 0, spfPass = 0, spfFail = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[dkimIndex] === "pass") dkimPass++; else dkimFail++;
    if (row[spfIndex] === "pass") spfPass++; else spfFail++;
  }

  // --- Professional Summary Layout ---

  // Section: Reporting Org Table
  let rowPtr = 5;
  summarySheet.getRange(rowPtr, 2, 1, 2).setValues([["Reporting Org", "Report Count"]]);
  summarySheet.getRange(rowPtr, 2, 1, 2).setBackground("#b7e1cd").setFontWeight("bold");
  if (orgEntries.length) {
    summarySheet.getRange(rowPtr + 1, 2, orgEntries.length, 2).setValues(orgEntries);
    summarySheet.getRange(rowPtr, 2, orgEntries.length + 1, 2).setBorder(true, true, true, true, true, true);
  }
  rowPtr += orgEntries.length + 3;

  // Section: Failing IP Table
  summarySheet.getRange(rowPtr, 2, 1, 2).setValues([["Failing IP", "Failure Count"]]);
  summarySheet.getRange(rowPtr, 2, 1, 2).setBackground("#f4cccc").setFontWeight("bold");
  if (failEntries.length) {
    summarySheet.getRange(rowPtr + 1, 2, failEntries.length, 2).setValues(failEntries);
    summarySheet.getRange(rowPtr, 2, failEntries.length + 1, 2).setBorder(true, true, true, true, true, true);
  }
  rowPtr += failEntries.length + 3;

  // Section: Top Sending Domains
  if (domainEntries.length) {
    summarySheet.getRange(rowPtr, 2, 1, 2).setValues([["Top Sending Domain", "Count"]]);
    summarySheet.getRange(rowPtr, 2, 1, 2).setBackground("#cfe2f3").setFontWeight("bold");
    summarySheet.getRange(rowPtr + 1, 2, domainEntries.length, 2).setValues(domainEntries);
    summarySheet.getRange(rowPtr, 2, domainEntries.length + 1, 2).setBorder(true, true, true, true, true, true);
    rowPtr += domainEntries.length + 3;
  }

  // Section: DKIM/SPF Pass/Fail Table
  summarySheet.getRange(rowPtr, 2, 1, 4).setValues([["DKIM Pass", "DKIM Fail", "SPF Pass", "SPF Fail"]]);
  summarySheet.getRange(rowPtr, 2, 1, 4).setBackground("#ffe599").setFontWeight("bold");
  summarySheet.getRange(rowPtr + 1, 2, 1, 4).setValues([[dkimPass, dkimFail, spfPass, spfFail]]);
  summarySheet.getRange(rowPtr, 2, 2, 4).setBorder(true, true, true, true, true, true);
  rowPtr += 4;

  // --- Chart Placement (dynamic, non-overlapping, right side) ---
  // Use only row-based positioning for titles and charts, not pixel offsets, to guarantee correct stacking in Google Sheets.
  let chartCol = 7; // Column G for charts
  let chartRow = 2;
  const chartPadding = 8; // rows to skip after each chart for guaranteed separation
  function placeChartWithTitle(title, chartRange, chartType, chartRows, chartCols) {
    // Place the title in the current row
    summarySheet.getRange(chartRow, chartCol, 1, chartCols || 2).merge().setValue(title).setFontWeight("bold").setFontSize(12);
    // Place the chart directly below the title, using row-based positioning
    const chart = summarySheet.newChart()
      .setChartType(chartType)
      .addRange(chartRange)
      .setPosition(chartRow + 1, chartCol, 0, 0)
      .setOption('title', '')
      .build();
    summarySheet.insertChart(chart);
    // Move chartRow pointer down by chartRows (height of chart) + title + padding
    chartRow += chartRows + 1 + chartPadding;
  }
  if (orgEntries.length > 0) {
    const pieChartRange = summarySheet.getRange(5, 2, orgEntries.length + 1, 2);
    placeChartWithTitle("Report Counts by Org", pieChartRange, Charts.ChartType.PIE, Math.max(orgEntries.length + 8, 12));
  }
  if (failEntries.length > 0) {
    const barChartRange = summarySheet.getRange(5 + orgEntries.length + 3, 2, Math.min(6, failEntries.length + 1), 2);
    placeChartWithTitle("Top Failing IPs", barChartRange, Charts.ChartType.BAR, Math.max(Math.min(6, failEntries.length + 1) + 8, 12));
  }
  if (domainEntries.length > 0) {
    const domainChartRange = summarySheet.getRange(rowPtr - domainEntries.length - 3, 2, Math.min(6, domainEntries.length + 1), 2);
    placeChartWithTitle("Top Sending Domains", domainChartRange, Charts.ChartType.BAR, Math.max(Math.min(6, domainEntries.length + 1) + 8, 12));
  }
  // Pass/fail pie chart
  const pfChartRange = summarySheet.getRange(rowPtr - 3, 2, 1, 4);
  placeChartWithTitle("DKIM/SPF Pass/Fail", pfChartRange, Charts.ChartType.PIE, 12, 4);

  // Auto-resize and style the Summary sheet
  formatSummarySheetStyles(summarySheet, ss);
}

/**
 * Auto-resize columns and rows on the `Summary` sheet and apply tab colors to
 * `Summary` and `DMARC Reports`.
 *
 * @param {SpreadsheetApp.Sheet} summarySheet The Summary worksheet.
 * @param {SpreadsheetApp.Spreadsheet} ss     The parent Spreadsheet object.
 */
function formatSummarySheetStyles(summarySheet, ss) {
  summarySheet.autoResizeColumns(1, summarySheet.getMaxColumns());
  // Manually set minimum width for key columns to ensure full header visibility
  summarySheet.setColumnWidth(2, 140); // B: e.g. 'Reporting Org', 'Failing IP', etc.
  summarySheet.setColumnWidth(3, 120); // C: e.g. 'Report Count', 'Failure Count', etc.
  summarySheet.setColumnWidth(4, 120); // D: e.g. 'SPF Pass', etc.
  summarySheet.setColumnWidth(5, 120); // E: e.g. 'SPF Fail', etc.
  summarySheet.autoResizeRows(1, summarySheet.getMaxRows());

  try {
    const dmarcSheet = ss.getSheetByName("DMARC Reports");
    if (dmarcSheet) dmarcSheet.setTabColor("#4285F4");
  } catch (e) {}
  try {
    if (summarySheet) summarySheet.setTabColor("#34A853");
  } catch (e) {}
}

/**
 * Add clickable `HYPERLINK` formulas in the `Summary` sheet's Reporting Org and
 * Failing IP tables to jump to the `DMARC Reports` sheet.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function addDrillDownLinksToSummary(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  const summary = ss.getSheetByName('Summary');
  const reports = ss.getSheetByName('DMARC Reports');
  if (!summary || !reports) return;
  const data = summary.getDataRange().getValues();
  // Add links for Reporting Org and Failing IP tables
  for (let row = 6; row < data.length; row++) {
    // Reporting Org links (col 2)
    const org = data[row][1];
    if (org && typeof org === 'string' && org !== '' && org !== 'Reporting Org') {
      summary.getRange(row + 1, 2).setFormula(`=HYPERLINK("#gid=${reports.getSheetId()}&filter=Reporter:${org}", "${org}")`);
    }
    // Failing IP links (col 2, after org table)
    if (data[row][1] && data[row][0] && data[row][0].match(/\d+\.\d+\.\d+\.\d+/)) {
      const ip = data[row][0];
      summary.getRange(row + 1, 2).setFormula(`=HYPERLINK("#gid=${reports.getSheetId()}&filter=Source IP:${ip}", "${ip}")`);
    }
  }
}

/**
 * Enrich rows in the `DMARC Reports` tab with two additional columns:
 * - `Country`: Resolved from `Source IP` via the free `ip-api.com` GeoIP API.
 * - `Failure Reason`: Plain-language explanation of the `DMARC Result`,
 *   aligned `DKIM`/`SPF` status, and receiver `Disposition`.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function enrichDMARCReportsWithGeoAndReason(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  const sheet = ss.getSheetByName("DMARC Reports");
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0];
  let ipCol = headers.indexOf("Source IP");
  let dispCol = headers.indexOf("Disposition");
  let dkimCol = headers.indexOf("DKIM");
  let spfCol = headers.indexOf("SPF");
  let countCol = headers.indexOf("Count");
  // Add columns if not present
  let countryCol = headers.indexOf("Country");
  let reasonCol = headers.indexOf("Failure Reason");
  let needHeaderUpdate = false;
  if (countryCol === -1) { headers.push("Country"); countryCol = headers.length - 1; needHeaderUpdate = true; }
  if (reasonCol === -1) { headers.push("Failure Reason"); reasonCol = headers.length - 1; needHeaderUpdate = true; }
  if (needHeaderUpdate) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    // Always style the entire header row (including new columns) to match: light green, bold
    var headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
    headerRange.setBackground(null); // Clear any previous background
    headerRange.setFontWeight("normal"); // Clear any previous font weight
    headerRange.setBackground("#b7e1cd");
    headerRange.setFontWeight("bold");

    // Ensure all data columns (including new ones) have consistent number formatting and alignment
    for (var col = 1; col <= sheet.getLastColumn(); col++) {
      sheet.setColumnWidth(col, 120); // Set a reasonable default width for all columns
      sheet.getRange(1, col, sheet.getLastRow()).setHorizontalAlignment("left");
      sheet.getRange(1, col, sheet.getLastRow()).setVerticalAlignment("middle");
      // Optionally, auto-resize columns for content
      sheet.autoResizeColumn(col);
    }
  }
  // Prepare to update rows
  let updates = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const ip = row[ipCol];
    const disp = row[dispCol];
    const dkim = row[dkimCol];
    const spf = row[spfCol];
    const count = row[countCol];
    // Failure Reason logic
    let reason = "";
    if (disp === "reject") {
      if (dkim === "fail" && spf === "fail") reason = "Both DKIM and SPF failed. Message rejected.";
      else if (dkim === "fail") reason = "DKIM failed. Message rejected.";
      else if (spf === "fail") reason = "SPF failed. Message rejected.";
      else reason = "Rejected for other policy reason.";
    } else if (disp === "none") {
      if (dkim === "fail" && spf === "fail") reason = "DMARC failed (neither aligned DKIM nor aligned SPF passed); policy is 'none', delivered anyway.";
      else if (dkim === "fail") reason = "DMARC passed on SPF (DKIM not aligned). No action taken.";
      else if (spf === "fail") reason = "DMARC passed on DKIM (SPF not aligned; typical of forwarding). No action taken.";
      else reason = "DMARC passed on both DKIM and SPF.";
    } else if (disp === "quarantine") {
      if (dkim === "fail" && spf === "fail") reason = "DMARC failed; receiver quarantined the message (spam folder).";
      else reason = `DMARC passed but receiver reports quarantine (DKIM: ${dkim}, SPF: ${spf}); likely a local policy override.`;
    } else {
      reason = `Disposition: ${disp}, DKIM: ${dkim}, SPF: ${spf}`;
    }
    // GeoIP lookup (ip-api.com, free, but rate-limited)
    let country = row[countryCol] || "";
    if (!country && ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      try {
        const response = UrlFetchApp.fetch(`http://ip-api.com/json/${ip}?fields=country`, {muteHttpExceptions:true, timeout:5});
        const geo = JSON.parse(response.getContentText());
        country = geo && geo.country ? geo.country : "Unknown";
      } catch (e) { country = "Unknown"; }
    }
    // Prepare update
    let updateRow = row.slice();
    updateRow[countryCol] = country;
    updateRow[reasonCol] = reason;
    updates.push(updateRow);
  }
  // Write back enriched data
  if (updates.length) {
    sheet.getRange(2, 1, updates.length, headers.length).setValues(updates);
    // Auto-resize new columns and all rows for visibility
    sheet.autoResizeColumn(countryCol + 1);
    sheet.autoResizeColumn(reasonCol + 1);
    sheet.autoResizeRows(1, sheet.getLastRow());
  }
}

/**
 * Apply consistent, logo-free typography and background styling to the
 * `Dashboard` and `Summary` tabs.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function applyBranding(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  const dashboard = ss.getSheetByName('Dashboard');
  const summary = ss.getSheetByName('Summary');
  // Branding for Dashboard
  if (dashboard) {
    dashboard.getRange(1, 1, dashboard.getMaxRows(), dashboard.getMaxColumns())
      .setFontFamily('Arial').setFontColor('#000000').setBackground('#FFFFFF');
    // Remove all images from Dashboard
    const dashboardImages = dashboard.getImages();
    dashboardImages.forEach(function(img) { img.remove(); });
    // Clear any previous logo/error message
    dashboard.getRange(1, 7).clearContent();
  }
  // Branding for Summary
  if (summary) {
    summary.getRange(1, 1, summary.getMaxRows(), summary.getMaxColumns())
      .setFontFamily('Arial').setFontColor('#000000').setBackground('#FFFFFF');
    // Remove all images from Summary
    const summaryImages = summary.getImages();
    summaryImages.forEach(function(img) { img.remove(); });
    // Clear any previous logo/error message
    summary.getRange(1, 7).clearContent();
  }
}


// =============================================================================
// 5. SCHEDULED EMAIL REPORTS, ARCHIVING & DATA RETENTION
// =============================================================================

/**
 * Export the `Summary` worksheet tab as a landscape A4 PDF and email it to the
 * recipients listed in the `Config` tab when due according to the configured
 * report frequency (or immediately when `force` is `true`).
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 * @param {boolean} [force] If `true`, bypasses the schedule frequency check and sends immediately.
 */
function sendScheduledDMARCReport(ssOrId, force) {
  const ss = getSpreadsheet(ssOrId);
  if (!force && !shouldSendReport(ss)) {
    Logger.log("Skipping scheduled DMARC report email based on frequency config.");
    return;
  }
  const configSheet = ss.getSheetByName('Config');
  if (!configSheet) return;
  const recipients = configSheet.getRange(2, 2).getValue();
  const summarySheet = ss.getSheetByName('Summary');
  if (!summarySheet) return;
  // Export summary as PDF
  const url = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?format=pdf&gid=${summarySheet.getSheetId()}&portrait=false&size=A4&fitw=true&sheetnames=false&printtitle=false&pagenumbers=false&gridlines=false&fzr=false`;
  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const blob = response.getBlob().setName('DMARC_Summary.pdf');
  // Send email
  const sheetName = ss.getName();
  const ssUrl = `${ss.getUrl()}#gid=${summarySheet.getSheetId()}`;
  const subject = `DMARC Summary Report: ${sheetName}`;
  const plainTextBody = `Please find attached the latest DMARC summary report for ${sheetName}.\n\nYou can access the live DMARC Analysis Google Sheet here:\n${ssUrl}`;
  const htmlBody = `<p>Please find attached the latest DMARC summary report for <strong>${sheetName}</strong>.</p>` +
                   `<p>You can access the live DMARC Analysis Google Sheet here: <a href="${ssUrl}">${sheetName}</a>.</p>` +
                   `<br><hr style="border: 0; border-top: 1px solid #ddd;"><p style="font-size: 11px; color: #666;">This is an automated report generated by the DMARC Analyzer script.</p>`;

  MailApp.sendEmail({
    to: recipients,
    subject: subject,
    body: plainTextBody,
    htmlBody: htmlBody,
    attachments: [blob]
  });
}

/**
 * Determine whether the scheduled PDF report email should be sent today based
 * on the `Email Report Frequency` setting in the `Config` tab:
 * - `Daily`: always sends.
 * - `Weekly`: sends on Mondays (day 1).
 * - `Fortnightly`: sends on Mondays of even-numbered ISO weeks.
 * - `Monthly`: sends on the 1st of the month.
 * - `Never`: never sends.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @return {boolean} `true` if a report should be dispatched today.
 */
function shouldSendReport(ss) {
  let frequency = getConfigValue(ss, "Email Report Frequency (Daily/Weekly/Fortnightly/Monthly/Never)", "");
  if (!frequency) {
    frequency = getConfigValue(ss, "Email Report Frequency (Daily/Weekly/Monthly/Never)", "Weekly");
  }
  const now = new Date();
  const freqLower = frequency.toString().trim().toLowerCase();
  
  if (freqLower === "daily") {
    return true;
  } else if (freqLower === "weekly") {
    return now.getDay() === 1; // 1 = Monday
  } else if (freqLower === "fortnightly") {
    if (now.getDay() !== 1) return false;
    // Calculate ISO 8601 week number to send every two weeks (even weeks)
    const tempDate = new Date(now.valueOf());
    const dayNum = (now.getDay() + 6) % 7;
    tempDate.setDate(tempDate.getDate() - dayNum + 3);
    const firstThursday = tempDate.valueOf();
    tempDate.setMonth(0, 1);
    if (tempDate.getDay() !== 4) {
      tempDate.setMonth(0, 1 + ((4 - tempDate.getDay() + 7) % 7));
    }
    const weekNum = 1 + Math.ceil((firstThursday - tempDate) / 604800000);
    return weekNum % 2 === 0;
  } else if (freqLower === "monthly") {
    return now.getDate() === 1; // 1st of the month
  }
  return false;
}

/**
 * Move last month's DMARC rows from `DMARC Reports` into a dedicated `YYYY-MM`
 * monthly archive sheet tab, keeping only the current month's rows in the main
 * `DMARC Reports` sheet.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @param {string} sheetName              The main report sheet name (`"DMARC Reports"`).
 */
function archiveLastMonthDMARCData(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return; // No data
  const headers = data[0];
  const dateCol = headers.indexOf("Processed Date") !== -1 ? headers.indexOf("Processed Date") : headers.length - 1;
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthNum = lastMonth.getMonth();
  const lastMonthYear = lastMonth.getFullYear();
  // Filter last month's data
  const lastMonthRows = data.filter(function(row, i) {
    if (i === 0) return false;
    const date = new Date(row[dateCol]);
    return date.getMonth() === lastMonthNum && date.getFullYear() === lastMonthYear;
  });
  if (lastMonthRows.length === 0) return;
  // Create or get archive sheet
  const archiveSheetName = `${lastMonthYear}-${String(lastMonthNum + 1).padStart(2, "0")}`;
  let archiveSheet = ss.getSheetByName(archiveSheetName);
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet(archiveSheetName);
    archiveSheet.appendRow(headers);
  }
  // Append last month's rows to archive sheet
  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, lastMonthRows.length, headers.length)
    .setValues(lastMonthRows);
  // Remove last month's rows from main sheet
  for (let i = data.length - 1; i > 0; i--) {
    const date = new Date(data[i][dateCol]);
    if (date.getMonth() === lastMonthNum && date.getFullYear() === lastMonthYear) {
      sheet.deleteRow(i + 1);
    }
  }
}

/**
 * Export the current month's `DMARC Reports` rows as a CSV file inside Google
 * Drive under `<Archive Folder Name>/<Spreadsheet Name>/DMARC_Report_YYYY_MM.csv`.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @param {string} sheetName              The main report sheet name (`"DMARC Reports"`).
 */
function exportMonthlyCSV(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  const parentFolderName = getConfigValue(ss, "Google Drive Archive Folder Name", "DMARC Archives");
  let parentFolder;
  const parentFolders = DriveApp.getFoldersByName(parentFolderName);
  if (parentFolders.hasNext()) {
    parentFolder = parentFolders.next();
  } else {
    parentFolder = DriveApp.createFolder(parentFolderName);
  }

  // Isolate by spreadsheet name to support multi-domain setup using the same parent archive folder
  const subfolderName = ss.getName();
  let targetFolder;
  const subfolders = parentFolder.getFoldersByName(subfolderName);
  if (subfolders.hasNext()) {
    targetFolder = subfolders.next();
  } else {
    targetFolder = parentFolder.createFolder(subfolderName);
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return; // No data to export

  // Filter data for current month
  const currentDate = new Date();
  const currentMonth = currentDate.getMonth();
  const currentYear = currentDate.getFullYear();

  const headers = data[0];
  const dateCol = headers.indexOf("Processed Date") !== -1 ? headers.indexOf("Processed Date") : headers.length - 1;
  const filteredData = data.filter((row, i) => {
    if (i === 0) return true; // headers
    const date = new Date(row[dateCol]);
    return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
  });

  if (filteredData.length < 2) return; // No data for current month

  // Convert to CSV
  const csvContent = filteredData.map(row =>
    row.map(cell => `"${(cell + "").replace(/"/g, '""')}"`).join(",")
  ).join("\r\n");

  const fileName = `DMARC_Report_${currentYear}_${(currentMonth + 1).toString().padStart(2, "0")}.csv`;
  // Create or overwrite existing file in the domain-specific subfolder
  const existingFiles = targetFolder.getFilesByName(fileName);
  while (existingFiles.hasNext()) {
    existingFiles.next().setTrashed(true);
  }

  targetFolder.createFile(fileName, csvContent, MimeType.PLAIN_TEXT);
}

/**
 * Delete rows from `DMARC Reports` whose `Processed Date` is older than the
 * `Retention Months` setting in the `Config` tab (defaults to 12 months).
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function purgeOldDMARCData(ssOrId) {
  const ss = getSpreadsheet(ssOrId);
  const configSheet = ss.getSheetByName('Config');
  if (!configSheet) return;
  const retentionMonths = parseInt(configSheet.getRange(3, 2).getValue(), 10) || 12;
  const mainSheet = ss.getSheetByName('DMARC Reports');
  if (!mainSheet) return;
  const data = mainSheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0];
  const dateCol = headers.indexOf('Processed Date');
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - retentionMonths, now.getDate());
  for (let i = data.length - 1; i > 0; i--) {
    const rowDate = new Date(data[i][dateCol]);
    if (rowDate < cutoff) {
      mainSheet.deleteRow(i + 1);
    }
  }
}

/**
 * Aggregate DMARC report rows across `DMARC Reports` and all `YYYY-MM` monthly
 * archive tabs when the `Summary` control cell `C3` is set to `ALL`.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @param {string} mainSheetName          The main report sheet name (`"DMARC Reports"`).
 * @return {Array<Array<*>>} 2D array of rows starting with the header row.
 */
function getAllDMARCData(ss, mainSheetName) {
  const sheets = ss.getSheets();
  let allData = [];
  let headers = null;
  sheets.forEach(function(sheet) {
    const name = sheet.getName();
    if (name === mainSheetName || /^\d{4}-\d{2}$/.test(name)) {
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return;
      if (!headers) headers = data[0];
      allData = allData.concat(data.slice(1));
    }
  });
  return headers ? [headers].concat(allData) : [];
}


// =============================================================================
// 6. CORE SPREADSHEET, CONFIG & GMAIL HELPERS
// =============================================================================

/**
 * Resolve a target `Spreadsheet` object in the following priority order:
 * 1. An explicitly passed `Spreadsheet` object or spreadsheet ID string.
 *    (Ignores timer event objects passed by Google Apps Script triggers.)
 * 2. The global `spreadsheetId` variable (if set and not the default placeholder).
 * 3. The active spreadsheet of a container-bound script.
 * 4. The single spreadsheet registered in the current user's `UserProperties`.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 * @return {SpreadsheetApp.Spreadsheet}
 */
function getSpreadsheet(ssOrId) {
  if (ssOrId) {
    if (typeof ssOrId === 'string') {
      return SpreadsheetApp.openById(ssOrId);
    }
    if (typeof ssOrId.getSheetByName === 'function') {
      return ssOrId;
    }
    // Otherwise ssOrId is a trigger event object (e.g. from a time-driven trigger); ignore it.
  }
  if (typeof spreadsheetId !== 'undefined' && spreadsheetId && spreadsheetId !== "YOUR_SPREADSHEET_ID_HERE") {
    return SpreadsheetApp.openById(spreadsheetId);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    return active;
  }
  const registered = getRegisteredSheets();
  if (registered.length === 1) {
    return SpreadsheetApp.openById(registered[0]);
  }
  if (registered.length > 1) {
    throw new Error("Multiple spreadsheets registered in UserProperties (" + registered.length + "). Use processAllDomains / cleanupAllDomains, or pass a specific Spreadsheet ID.");
  }
  throw new Error("No active spreadsheet found. Run provisionOnce() or registerSheet(id), or provide a Spreadsheet ID.");
}

/**
 * Retrieve a setting value from the `Config` worksheet tab.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @param {string} key                    The setting name in column A.
 * @param {*} defaultValue                Fallback value if the key is missing or blank.
 * @return {*} The configured value or `defaultValue`.
 */
function getConfigValue(ss, key, defaultValue) {
  const configSheet = ss.getSheetByName('Config');
  if (!configSheet) return defaultValue;
  const data = configSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      const val = data[i][1];
      return (val !== undefined && val !== "") ? val : defaultValue;
    }
  }
  return defaultValue;
}

/**
 * Write a setting in the `Config` worksheet tab, updating the existing row in
 * column B or appending a new `[key, value]` row if the key is not yet present.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @param {string} key                    The setting name in column A.
 * @param {*} value                       The value to write in column B.
 */
function setConfigValue(ss, key, value) {
  const configSheet = ss.getSheetByName('Config');
  if (!configSheet) throw new Error("Config sheet missing; run setupConfigSheet first.");
  const data = configSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      configSheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  configSheet.appendRow([key, value]);
}

/**
 * Get or create a worksheet tab with the given `headers`. If the sheet already
 * exists, preserves all historical rows and appends any missing headers from
 * `headers` to the end of row 1.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss The target Spreadsheet object.
 * @param {string} name                   The worksheet tab name.
 * @param {string[]} headers              Expected column header names.
 * @return {SpreadsheetApp.Sheet} The created or updated worksheet.
 */
function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  } else {
    // Upgrade headers safely if there is existing data to prevent wiping history
    const lastCol = sheet.getLastColumn();
    let existingHeaders = [];
    if (lastCol > 0) {
      existingHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    }
    
    // Find headers in 'headers' list that are not present in 'existingHeaders'
    const missingHeaders = headers.filter(h => !existingHeaders.includes(h));
    if (missingHeaders.length > 0) {
      // Append missing headers to the end of the first row
      sheet.getRange(1, lastCol + 1, 1, missingHeaders.length).setValues([missingHeaders]);
    }
  }
  // Always ensure header formatting is present for all columns (including new ones)
  var headerCols = sheet.getLastColumn();
  var headerRange = sheet.getRange(1, 1, 1, headerCols);
  headerRange.clearFormat(); // Remove all previous formatting
  headerRange.setBackground("#b7e1cd");
  headerRange.setFontWeight("bold");
  headerRange.setFontColor("#000000");
  headerRange.setFontSize(10);

  // Ensure all data columns (including new ones) have consistent number formatting and alignment
  for (var col = 1; col <= sheet.getLastColumn(); col++) {
    sheet.setColumnWidth(col, 120); // Set a reasonable default width for all columns
    sheet.getRange(1, col, sheet.getLastRow()).setHorizontalAlignment("left");
    sheet.getRange(1, col, sheet.getLastRow()).setVerticalAlignment("middle");
    // Optionally, auto-resize columns for content
    sheet.autoResizeColumn(col);
  }
  return sheet;
}

/**
 * Get an existing Gmail user label by name, or create it if it does not exist.
 *
 * @param {string} name The Gmail label name (e.g. `"example.com_dmarc_rua"`).
 * @return {GmailApp.GmailLabel}
 */
function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}


// =============================================================================
// 7. LEGACY / BACKWARD-COMPATIBILITY FUNCTIONS
// =============================================================================
//
// Retained at the bottom of the file so older single-sheet, container-bound, or
// filterless setups continue working without cluttering the top of the Apps
// Script toolbar dropdown.

/**
 * Optional fallback Spreadsheet ID for legacy single-sheet standalone setups.
 * Prefer `provisionOnce()` / `UserProperties` or passing spreadsheet IDs to
 * library functions instead of hardcoding an ID here.
 */
const spreadsheetId = "YOUR_SPREADSHEET_ID_HERE";

/**
 * Legacy migration helper to manually register pre-existing spreadsheet ID(s)
 * (created before `provisionOnce()` existed) into the currently logged-in
 * user's `UserProperties`.
 *
 * @return {string[]} The updated list of registered spreadsheet IDs for this user.
 */
function registerExistingSheetsOnce() {
  const existingSheetIds = [
    // "1_abc123_your_existing_spreadsheet_id"
  ];
  return registerSheet(existingSheetIds);
}

/**
 * Legacy combined trigger helper: searches Gmail to auto-label recent DMARC
 * report emails and then processes them in a single run.
 * (Only needed if you did not configure a Gmail filter or `provisionDomain` to
 * apply the label on arrival.)
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function autoLabelAndProcessDMARCReports(ssOrId) {
  autoLabelDMARCReports(ssOrId);
  processDMARCReports(ssOrId);
}

/**
 * Legacy auto-labeler: searches Gmail messages from the last 7 days with common
 * DMARC report subjects and `.xml`, `.zip`, or `.gz` attachments, and applies
 * the configured DMARC label.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function autoLabelDMARCReports(ssOrId) {
  let labelName = "DMARC";
  try {
    const ss = getSpreadsheet(ssOrId);
    labelName = getConfigValue(ss, "DMARC Label Name", "DMARC");
  } catch (e) {
    Logger.log("Could not load spreadsheet config for autoLabelDMARCReports, using default 'DMARC' label: " + e.message);
  }

  // Search for emails from common DMARC senders with .xml/.zip/.gz attachments in the last 7 days
  var threads = GmailApp.search(
    'newer_than:7d (subject:"Report domain:" OR subject:"DMARC" OR subject:"Aggregate report") has:attachment'
  );
  var label = getOrCreateLabel(labelName);
  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var hasDMARC = messages.some(function(msg) {
      var attachments = msg.getAttachments();
      return attachments.some(function(att) {
        var name = att.getName().toLowerCase();
        return name.endsWith('.xml') || name.endsWith('.zip') || name.endsWith('.gz');
      });
    });
    var threadLabels = thread.getLabels().map(function(l) { return l.getName(); });
    if (hasDMARC && threadLabels.indexOf(label.getName()) === -1) {
      thread.addLabel(label);
    }
  });
}

/**
 * Legacy container-bound spreadsheet open trigger handler: adds the
 * "DMARC Tools" custom menu to the Google Sheets UI.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("DMARC Tools")
    .addItem("Process DMARC Reports", "processDMARCReports")
    .addItem("Send Email Report Now", "forceSendScheduledDMARCReport")
    .addToUi();
}

/**
 * Legacy menu callback helper: immediately dispatches the PDF summary email
 * report for the active spreadsheet, bypassing the configured schedule frequency.
 */
function forceSendScheduledDMARCReport() {
  sendScheduledDMARCReport(undefined, true);
}

/**
 * Legacy diagnostic helper: logs the names of all worksheet tabs in the target
 * spreadsheet.
 *
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or Spreadsheet object.
 */
function listSheetNames(ssOrId) {
  var ss = getSpreadsheet(ssOrId);
  var sheets = ss.getSheets();
  var names = sheets.map(function(sheet) { return sheet.getName(); });
  Logger.log(names);
}
