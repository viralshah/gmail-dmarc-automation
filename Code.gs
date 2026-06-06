const spreadsheetId = "YOUR_SPREADSHEET_ID_HERE";

/**
 * Helper to get a Spreadsheet object.
 * Resolves in the following priority order:
 * 1. An explicitly passed Spreadsheet object or spreadsheet ID string.
 * 2. The global `spreadsheetId` variable (if set and not the default placeholder).
 * 3. The active spreadsheet of the container script.
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 * @return {SpreadsheetApp.Spreadsheet}
 */
function getSpreadsheet(ssOrId) {
  if (ssOrId) {
    if (typeof ssOrId === 'string') {
      return SpreadsheetApp.openById(ssOrId);
    }
    return ssOrId;
  }
  if (typeof spreadsheetId !== 'undefined' && spreadsheetId && spreadsheetId !== "YOUR_SPREADSHEET_ID_HERE") {
    return SpreadsheetApp.openById(spreadsheetId);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error("No active spreadsheet found. Please provide a Spreadsheet ID.");
  }
  return active;
}

/**
 * Helper to retrieve a setting value from the Config sheet.
 * @param {SpreadsheetApp.Spreadsheet} ss The spreadsheet object.
 * @param {string} key The setting name/key.
 * @param {*} defaultValue The fallback value if key is not found or empty.
 * @return {*}
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
 * Main function: Process DMARC reports from Gmail, parse attachments,
 * append data to spreadsheet, update summary with charts and colors,
 * and export monthly CSV archive.
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 */
function processDMARCReports(ssOrId) {
  const sheetName = "DMARC Reports";
  const thresholdFailures = 3;

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

    const processedLabel = getOrCreateLabel(processedLabelName);

    // Automatically archive last month's data before processing new reports
    archiveLastMonthDMARCData(ss, sheetName);

    const sheet = getOrCreateSheet(ss, sheetName, [
      "Message ID", "Reporter", "Source IP", "Disposition",
      "DKIM", "SPF", "Domain", "Header From", "Count",
      "Email Date", "Report Date", "Processed Date"
    ]);

    // Get headers from sheet to map data to correct columns dynamically (resilient to column order/upgrades)
    const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
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
                  const authResults = record.getChild("auth_results");
                  const dkimDomain = authResults && authResults.getChild("dkim") ? authResults.getChild("dkim").getChildText("domain") : "";
                  const spfDomain = authResults && authResults.getChild("spf") ? authResults.getChild("spf").getChildText("domain") : "";

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

                  Logger.log(`        Appending row: ${JSON.stringify(rowData)}`);
                  sheet.appendRow(rowData);

                  // Alert if failed DKIM or SPF exceeds threshold
                  if ((dkim === "fail" || spf === "fail") && parseInt(count, 10) >= thresholdFailures) {
                    alerts.push({
                      domain: headerFrom || dkimDomain || spfDomain || "Unknown",
                      orgName: orgName,
                      ip: ip,
                      count: count,
                      dkim: dkim,
                      spf: spf,
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
      const sheetUrl = ss.getUrl();
      const sheetName = ss.getName();

      let plainTextBody = `DMARC Alerts for ${sheetName}:\n\n`;
      let htmlAlerts = "";

      alerts.forEach(alert => {
        let failStatus = "";
        let failBadge = "";

        if (alert.dkim === "fail" && alert.spf === "fail") {
          failStatus = "Both DKIM & SPF failed";
          failBadge = `<span style="background-color: #fce8e6; color: #c5221f; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block;">Both DKIM & SPF Failed</span>`;
        } else if (alert.dkim === "fail") {
          failStatus = "DKIM failed (SPF passed/none)";
          failBadge = `<span style="background-color: #fce8e6; color: #c5221f; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block;">DKIM Failed</span> <span style="background-color: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block;">SPF Passed/None</span>`;
        } else {
          failStatus = "SPF failed (DKIM passed/none)";
          failBadge = `<span style="background-color: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block;">DKIM Passed/None</span> <span style="background-color: #fce8e6; color: #c5221f; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; display: inline-block;">SPF Failed</span>`;
        }

        plainTextBody += `⚠️ Domain: ${alert.domain}\n`;
        plainTextBody += `   Reporter: ${alert.orgName}\n`;
        plainTextBody += `   Source IP: ${alert.ip}\n`;
        plainTextBody += `   Failures: ${alert.count} times\n`;
        plainTextBody += `   Status: ${failStatus}\n`;
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
            <p style="font-size: 15px; margin-top: 0; color: #202124;">The following DMARC failures exceeded the alert threshold of ${thresholdFailures} failures:</p>
            
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
        subject: `DMARC Alert: SPF/DKIM Failures for ${sheetName}`,
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
 * Get or create Gmail label by name
 */
function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * Get or create a sheet with headers; clears if exists
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
 * Archive last month's DMARC data to a new sheet and keep only current month's data in DMARC Reports
 * Call this at the start of each month (e.g. in your main trigger)
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
 * Export the current month's DMARC report data as a CSV file
 * stored in a 'DMARC Archives' folder in Google Drive
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
 * Add custom menu to spreadsheet UI to manually trigger DMARC processing and report dispatching
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("DMARC Tools")
    .addItem("Process DMARC Reports", "processDMARCReports")
    .addItem("Send Email Report Now", "forceSendScheduledDMARCReport")
    .addToUi();
}

/**
 * Automatically update the DMARC Summary sheet when control cells (C2, C3) are modified
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

/**
 * Helper to force send the scheduled report from the spreadsheet UI menu.
 */
function forceSendScheduledDMARCReport() {
  sendScheduledDMARCReport(undefined, true);
}

/**
 * Auto-label DMARC reports in the last 7 days from common senders
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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
 * Combined function: Auto-label and process DMARC reports in one go.
 * Run this function on a daily (or more frequent) trigger for full automation.
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 */
function autoLabelAndProcessDMARCReports(ssOrId) {
  autoLabelDMARCReports(ssOrId);
  processDMARCReports(ssOrId);
}

/**
 * List all sheet names in the active spreadsheet
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 */
function listSheetNames(ssOrId) {
  var ss = getSpreadsheet(ssOrId);
  var sheets = ss.getSheets();
  var names = sheets.map(function(sheet) { return sheet.getName(); });
  Logger.log(names);
}

/**
 * Delete DMARC/Processed emails older than 7 days
 * Run this on a daily trigger to keep mailbox clean
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 */
function deleteOldProcessedDMARCEmails(ssOrId) {
  let processedLabelName = "DMARC/Processed";
  let retentionDays = 7;
  try {
    const ss = getSpreadsheet(ssOrId);
    processedLabelName = getConfigValue(ss, "DMARC Processed Label Name", "DMARC/Processed");
    retentionDays = parseInt(getConfigValue(ss, "Email Retention Days", 7), 10) || 7;
  } catch (e) {
    Logger.log("Could not load spreadsheet config for deleteOldProcessedDMARCEmails: " + e.message);
  }

  var threads = GmailApp.search(`label:"${processedLabelName}" older_than:${retentionDays}d`);
  threads.forEach(function(thread) {
    thread.moveToTrash();
  });
}

/**
 * Aggregate DMARC data from all archive sheets and the current sheet for enterprise-level reporting
 * Returns an array of all rows (with headers)
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

/**
 * Update or create the summary sheet with aggregated data,
 * colored formatting and charts for better visualization
 * Allows filtering by date range if D1 cell is set (format: YYYY-MM-DD:YYYY-MM-DD)
 * If D2 cell is set to 'ALL', aggregates across all archive sheets and current
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
 * Auto-resize and style the Summary sheet columns/rows and update tab colors
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
 * Add drill-down hyperlinks in the Summary sheet to jump to filtered data in DMARC Reports
 */
/**
 * Add drill-down hyperlinks in the Summary sheet to jump to filtered data in DMARC Reports
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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
 * Create a Config sheet for settings (email recipients, retention, etc.)
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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
    ["Email Retention Days", 7]
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
 * Purge/archive DMARC data older than the retention period set in Config sheet
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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
 * Enrich DMARC Reports with Country and Failure Reason columns
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 */
// --- Add IP Country and Failure Reason columns to DMARC Reports sheet ---
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
      if (dkim === "fail" && spf === "fail") reason = "Both DKIM and SPF failed, but policy is 'none'. No action taken.";
      else if (dkim === "fail") reason = "DKIM failed, but policy is 'none'. No action taken.";
      else if (spf === "fail") reason = "SPF failed, but policy is 'none'. No action taken.";
      else reason = "Passed authentication, no action taken.";
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
 * Add a Documentation/Help sheet with usage, contact, and glossary
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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
    ['1. DMARC reports are processed automatically from your Gmail.'],
    ['2. The "DMARC Reports" sheet contains all parsed data.'],
    ['3. The "Summary" and "Dashboard" sheets provide visual analytics.'],
    ['4. The "Config" sheet lets you set report recipients, retention, and label names.'],
    ['5. Data older than the retention period is purged automatically.'],
    ['6. Processed emails older than the retention days are cleaned from Gmail automatically.']
  ];
  helpSheet.getRange(4, 1, instructions.length, 1).setValues(instructions).setFontFamily('Arial').setFontSize(10);
  
  // Section: Column Definitions
  let startRow = 4 + instructions.length + 2;
  helpSheet.getRange(startRow, 1).setValue('DMARC Reports - Column Definitions:').setFontWeight('bold').setFontSize(12).setFontFamily('Arial');
  
  const colDefs = [
    ['Column Header', 'Description'],
    ['Message ID', 'Unique identifier for the processed email message containing the report.'],
    ['Reporter', 'The organization that generated and sent the DMARC report (e.g. google.com, yahoo.com).'],
    ['Source IP', 'The IP address of the mail server that sent the email.'],
    ['Disposition', 'The DMARC policy action applied to the message (none, quarantine, reject).'],
    ['DKIM', 'Result of DKIM signature verification (pass, fail, none).'],
    ['SPF', 'Result of SPF domain validation (pass, fail, none).'],
    ['Domain', 'The domain identifier parsed from the DKIM/SPF auth results.'],
    ['Header From', 'The domain name found in the "From:" header of the email message (the domain being authenticated).'],
    ['Count', 'The number of emails received from the Source IP matching this authentication status during the reporting period.'],
    ['Email Date', 'The timestamp/date when the DMARC report email was received in your Gmail inbox.'],
    ['Report Date', 'The starting timestamp/date of the DMARC report\'s window (retrieved from the XML\'s date_range begin tag).'],
    ['Processed Date', 'The timestamp when the report was parsed and appended to this spreadsheet.'],
    ['Country', 'The country name associated with the source IP address (enriched via GeoIP lookup).'],
    ['Failure Reason', 'Plain-language explanation for why the email failed SPF/DKIM validation.']
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
    ['Disposition', 'The policy action applied to an email failing authentication: none (log only), quarantine (spam), or reject (block).']
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
 * Add a Dashboard sheet with high-level KPIs and trendlines
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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

/**
 * Apply styling/branding to Dashboard and Summary sheets
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
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

/**
 * Helper to determine if the report email should be sent based on Config frequency.
 * - Daily: always sends.
 * - Weekly: sends on Mondays (day 1).
 * - Fortnightly: sends on Mondays of even-numbered weeks.
 * - Monthly: sends on the 1st of the month.
 * - Never: does not send.
 * 
 * @param {SpreadsheetApp.Spreadsheet} ss
 * @return {boolean}
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
 * Scheduled email report: send PDF summary to recipients from Config
 * 
 * @param {string|SpreadsheetApp.Spreadsheet} [ssOrId] Optional spreadsheet ID or object.
 * @param {boolean} [force] If true, bypasses the frequency check and sends immediately.
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
  MailApp.sendEmail({
    to: recipients,
    subject: 'Scheduled DMARC Report',
    body: 'Please find attached the latest DMARC summary report.',
    attachments: [blob]
  });
}
