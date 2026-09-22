const DestinationAdapter = require('./destinationAdapter');
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const clientStorageService = require('./clientStorageService');
const cryptoService = require('./cryptoService');
const googleTokenStore = require('./googleTokenStore');

const SALES_SHEET = 'Sales Transactions Raw Data';
const INVENTORY_SHEET = 'Inventory On Hand Raw Data';
const PURCHASES_SHEET = 'Purchase Transactions Raw data';
const LOG_SHEET = 'Sync Log';
const COVER_SHEET = '📋 Cover & Index';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Returns `count` calendar months ending at (and including) the month containing
 * refDate, oldest first. Used to drive the "Sales Trend Analysis" tab's rolling
 * month columns from the sync's actual reference date instead of a hardcoded year.
 */
/**
 * Converts a 1-based column index to its A1 letter (1 -> A, 2 -> B, 27 -> AA, ...).
 */
function colLetter(oneBasedIdx) {
  let s = '';
  let n = oneBasedIdx;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Escapes a value for safe embedding inside a double-quoted Sheets formula string literal.
 */
function escapeFormulaString(value) {
  return String(value).replace(/"/g, '""');
}

function getTrailingMonths(refDate, count) {
  const anchor = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), 1));
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const monthDate = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    months.push({
      year: monthDate.getUTCFullYear(),
      monthName: MONTH_NAMES[monthDate.getUTCMonth()],
      isoDate: monthDate.toISOString().split('T')[0]
    });
  }
  return months;
}

class GoogleSheetsAdapter extends DestinationAdapter {
  constructor(clientId, userOAuthAccount) {
    super(clientId, userOAuthAccount);
    if (!clientId) {
      // Never silently fall back to a real tenant here — a caller that forgot to
      // resolve its own clientId must fail loudly, not read/write the master
      // tenant's Google Sheets storage and OAuth tokens instead.
      throw new Error('GoogleSheetsAdapter requires an explicit clientId.');
    }
    this.clientId = clientStorageService.validateClientId(clientId);
    this.storageDir = clientStorageService.getClientGoogleSheetsDir(this.clientId);
    this.user = userOAuthAccount;
    this.userOAuthAccount = userOAuthAccount;

    this.masterTemplateId = process.env.GoogleMasterTemp || process.env.MASTER_TEMPLATE_ID || '1uxdMS8pATOVdGQWD-VFniQ0RbMZOtjJE';
    this.authClient = null;
    this.drive = null;
    this.sheets = null;
  }

  async getGoogleClients() {
    if (this.drive && this.sheets) {
      return { drive: this.drive, sheets: this.sheets };
    }

    // 1. Prefer the database — durable, tenant-scoped, survives redeploys
    //    (unlike the local token.json file on Render's ephemeral disk).
    let userTokens = await googleTokenStore.getClientGoogleTokens(this.clientId);

    // 2. Fall back to the token carried on the session for this request
    //    (covers a brand-new Google user who hasn't picked a client_id yet).
    if (!userTokens && this.userOAuthAccount && this.userOAuthAccount.googleTokensEncrypted) {
      try {
        const decrypted = cryptoService.decrypt(this.userOAuthAccount.googleTokensEncrypted);
        if (decrypted) userTokens = JSON.parse(decrypted);
      } catch (_) {}
    } else if (!userTokens && this.userOAuthAccount && this.userOAuthAccount.access_token) {
      userTokens = {
        access_token: this.userOAuthAccount.access_token,
        refresh_token: this.userOAuthAccount.refresh_token
      };
    }

    if (userTokens) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2Client.setCredentials(userTokens);
      oauth2Client.on('tokens', (refreshedTokens) => {
        googleTokenStore.mergeAndSaveClientGoogleTokens(this.clientId, refreshedTokens)
          .catch(e => console.warn('[GOOGLE SHEETS] DB token refresh save error:', e.message));
      });
      this.authClient = oauth2Client;
    } else {
      // Look for credentials file
      const credPathCandidate1 = path.resolve(__dirname, '../../', process.env.GOOGLE_CREDENTIALS_PATH || '../cin7-sheets/oauth-credentials.json');
      const credPathCandidate2 = path.resolve(__dirname, '../../../cin7-sheets/oauth-credentials.json');
      const credPath = fs.existsSync(credPathCandidate1) ? credPathCandidate1 : (fs.existsSync(credPathCandidate2) ? credPathCandidate2 : null);

      if (credPath && fs.existsSync(credPath)) {
        const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        const config = rawCreds.installed || rawCreds.web || rawCreds;
        
        // If token file exists nearby
        const tokenPath = path.join(path.dirname(credPath), 'token.json');
        let token = null;
        if (fs.existsSync(tokenPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            if (raw && raw.encrypted) {
              const decrypted = cryptoService.decrypt(raw.encrypted);
              if (decrypted) token = JSON.parse(decrypted);
            } else {
              token = raw;
            }
          } catch (e) {
            console.warn('[GOOGLE OAUTH] Notice parsing token.json:', e.message);
          }
        }

        const oauth2Client = new google.auth.OAuth2(
          config.client_id || process.env.GOOGLE_CLIENT_ID,
          config.client_secret || process.env.GOOGLE_CLIENT_SECRET,
          config.redirect_uris ? config.redirect_uris[0] : 'http://localhost'
        );

        if (token) {
          oauth2Client.setCredentials(token);
          // Self-heal: this legacy file only exists on this same ephemeral disk
          // instance right now, so also copy it into the durable DB store.
          googleTokenStore.saveClientGoogleTokens(this.clientId, token)
            .catch(e => console.warn('[GOOGLE SHEETS] DB token backfill error:', e.message));
        }

        oauth2Client.on('tokens', (refreshedTokens) => {
          googleTokenStore.mergeAndSaveClientGoogleTokens(this.clientId, refreshedTokens)
            .catch(e => console.warn('[GOOGLE SHEETS] DB token refresh save error:', e.message));
          try {
            let current = {};
            if (fs.existsSync(tokenPath)) {
              try {
                const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
                if (raw && raw.encrypted) {
                  const decrypted = cryptoService.decrypt(raw.encrypted);
                  if (decrypted) current = JSON.parse(decrypted);
                } else {
                  current = raw;
                }
              } catch (_) {}
            }
            const merged = { ...current, ...refreshedTokens };
            const encryptedPayload = cryptoService.encrypt(JSON.stringify(merged));
            fs.writeFileSync(tokenPath, JSON.stringify({ encrypted: encryptedPayload }, null, 2));
            console.log('[GOOGLE OAUTH] ✅ Tokens refreshed, encrypted, and saved to token.json');
          } catch (e) {
            console.warn('[GOOGLE OAUTH] Warning saving refreshed tokens:', e.message);
          }
        });

        this.authClient = oauth2Client;
      } else {
        // Fallback default auth
        const auth = new google.auth.GoogleAuth({
          scopes: [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets'
          ]
        });
        this.authClient = auth;
      }
    }

    this.drive = google.drive({ version: 'v3', auth: this.authClient });
    this.sheets = google.sheets({ version: 'v4', auth: this.authClient });
    return { drive: this.drive, sheets: this.sheets };
  }

  /**
   * Clones the Master Google Sheet Template into a BRAND NEW spreadsheet for every sync.
   * Preserves all tabs, formatting, formulas, dashboards, and KPI sections.
   * Dynamically includes Client Company Name and User Name/Email in the title to avoid tenant sheet collisions.
   */
  async createGoogleSheetFromTemplate(clientEmail = null, metadata = {}) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    // 1. Resolve client company name
    let clientName = metadata?.clientName || metadata?.companyName;
    if (!clientName && this.clientId) {
      try {
        const clientRec = await db.getOne('SELECT company_name FROM clients WHERE id = ?', [this.clientId]);
        if (clientRec && clientRec.company_name) {
          clientName = clientRec.company_name;
        }
      } catch (err) {
        console.warn(`[GOOGLE SHEETS] Could not load client company name for ${this.clientId}:`, err.message);
      }
    }
    if (!clientName) {
      clientName = this.clientId || 'Client';
    }

    // 2. Resolve user who initiated sync
    const userObj = this.user || this.userOAuthAccount;
    let syncer = metadata?.syncedBy || metadata?.userName;
    if (!syncer && userObj) {
      syncer = userObj.full_name || userObj.fullName || userObj.name || userObj.email;
    }
    if (!syncer && clientEmail) {
      syncer = clientEmail;
    }
    if (!syncer || syncer === 'System') {
      try {
        const u = await db.getOne('SELECT full_name, email FROM users WHERE client_id = ? ORDER BY created_at ASC', [this.clientId]);
        if (u) {
          syncer = u.full_name || u.email || syncer;
        }
      } catch (e) {}
    }
    if (!syncer) {
      syncer = 'System';
    }

    // Sanitize any characters that could cause issues
    const safeClientName = String(clientName).trim().replace(/[\\/:\*\?"<>\|]/g, '');
    const safeSyncer = String(syncer).trim().replace(/[\\/:\*\?"<>\|]/g, '');
    const fileName = `Controller Reporting - ${safeClientName} - Synced by ${safeSyncer} - ${timestamp}`;

    console.log(`[GOOGLE SHEETS] Cloning Master Template (${this.masterTemplateId}) into BRAND-NEW sheet: ${fileName}`);
    const { drive } = await this.getGoogleClients();

    // 1. Cloning: drive.files.copy (Brand new copy of Master Template)
    const copyResponse = await drive.files.copy({
      fileId: this.masterTemplateId,
      requestBody: {
        name: fileName
      },
      fields: 'id, name, webViewLink, webContentLink'
    });

    const fileId = copyResponse.data.id;
    const fileUrl = copyResponse.data.webViewLink || `https://docs.google.com/spreadsheets/d/${fileId}/edit`;

    console.log(`Generated NEW Spreadsheet ID: ${fileId}`);
    console.log(`Generated NEW Spreadsheet URL: ${fileUrl}`);

    // Write the resolved client company name into the Cover & Index landing page.
    // KPI Dashboard!A1, Sales Dashboard!A1 and Cost Inputs!A1 reference this cell via
    // formula, so setting it once here is enough for the client's real name to show
    // everywhere instead of the master template's placeholder text.
    try {
      await this.injectSheetData(fileId, COVER_SHEET, 'A2', [[String(clientName).trim()]]);
      console.log(`[GOOGLE SHEETS] Wrote company name "${clientName}" into '${COVER_SHEET}'!A2`);
    } catch (nameErr) {
      console.warn(`[GOOGLE SHEETS] Could not write company name into '${COVER_SHEET}'!A2:`, nameErr.message);
    }

    // 4. Granting Access: explicit user email only. Deliberately NOT granting
    //    "anyone with the link" access — every raw sales/inventory/PO workbook this
    //    creates would otherwise be readable by anyone on the internet who obtains the
    //    file ID, which also lets any tenant's own Google credentials read another
    //    tenant's sheet if the ID leaks (see /api/sync/pull-sheets tenant scoping).
    const targetViewerEmail = (this.user && this.user.email) || clientEmail || null;
    if (targetViewerEmail) {
      try {
        console.log(`[GOOGLE SHEETS] Granting permissions to: ${targetViewerEmail}`);
        const permRes = await drive.permissions.create({
          fileId: fileId,
          sendNotificationEmail: false,
          requestBody: {
            role: 'writer',
            type: 'user',
            emailAddress: targetViewerEmail
          },
          fields: 'id, type, role, emailAddress'
        });
        console.log(`[GOOGLE SHEETS] Writer permission granted successfully to ${targetViewerEmail}:`, permRes.data);
      } catch (permErr) {
        console.warn(`[GOOGLE SHEETS] Initial permission grant notice for ${targetViewerEmail}: ${permErr.message}. Retrying as reader...`);
        try {
          const permRetry = await drive.permissions.create({
            fileId: fileId,
            requestBody: {
              role: 'reader',
              type: 'user',
              emailAddress: targetViewerEmail
            },
            fields: 'id, type, role, emailAddress'
          });
          console.log(`[GOOGLE SHEETS] Reader permission granted on retry to ${targetViewerEmail}:`, permRetry.data);
        } catch (retryErr) {
          console.error(`[GOOGLE SHEETS] Failed to grant permission to ${targetViewerEmail}:`, retryErr.message);
        }
      }
    }

    // Save destination file record in DB
    const recordId = `dest-${uuidv4().substring(0, 8)}`;
    await db.query(
      `INSERT INTO destination_files (id, client_id, provider, file_id, file_name, file_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [recordId, this.clientId, 'google', fileId, fileName, fileUrl]
    );

    return {
      id: recordId,
      client_id: this.clientId,
      provider: 'google',
      file_id: fileId,
      file_name: fileName,
      file_url: fileUrl
    };
  }

  async getOrCreateDestination(clientEmail = null, metadata = {}) {
    return await this.createGoogleSheetFromTemplate(clientEmail, metadata);
  }

  async injectSheetData(spreadsheetId, sheetName, rangeA1, values) {
    try {
      const { sheets } = await this.getGoogleClients();
      const targetRange = `'${sheetName}'!${rangeA1}`;
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: targetRange,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      console.log(`[GOOGLE SHEETS] Injected ${values.length} rows into live Google Sheet ${spreadsheetId} [Range: ${targetRange}]`);
      return res;
    } catch (err) {
      console.error(`[GOOGLE SHEETS ERROR] Live sheet injection failed for range '${sheetName}'!${rangeA1}:`, err.message);
      throw err;
    }
  }

  async verifyDataWritten(spreadsheetId, expectedCounts = {}) {
    const { sheets } = await this.getGoogleClients();
    const salesRead = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${SALES_SHEET}'!A7:G9`
    });
    const invRead = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${INVENTORY_SHEET}'!A7:E9`
    });
    const poRead = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${PURCHASES_SHEET}'!A7:F9`
    });

    const salesRows = salesRead.data.values || [];
    const invRows = invRead.data.values || [];
    const poRows = poRead.data.values || [];

    console.log(`[VERIFY READ-BACK] Spreadsheet ${spreadsheetId}:`);
    console.log(`- Sales data: ${salesRows.length > 0 ? 'PASS' : (expectedCounts.sales === 0 ? 'PASS (0 expected)' : 'FAIL')} (${salesRows.length} sample rows read)`);
    console.log(`- Inventory data: ${invRows.length > 0 ? 'PASS' : (expectedCounts.inventory === 0 ? 'PASS (0 expected)' : 'FAIL')} (${invRows.length} sample rows read)`);
    console.log(`- PO data: ${poRows.length > 0 ? 'PASS' : (expectedCounts.purchase === 0 ? 'PASS (0 expected)' : 'FAIL')} (${poRows.length} sample rows read)`);

    if (expectedCounts.sales > 0 && salesRows.length === 0) {
      throw new Error(`Data verification failed: Sales raw data was not found on read-back for spreadsheet ${spreadsheetId}`);
    }
    if (expectedCounts.inventory > 0 && invRows.length === 0) {
      throw new Error(`Data verification failed: Inventory raw data was not found on read-back for spreadsheet ${spreadsheetId}`);
    }
    if (expectedCounts.purchase > 0 && poRows.length === 0) {
      throw new Error(`Data verification failed: Purchase Orders raw data was not found on read-back for spreadsheet ${spreadsheetId}`);
    }

    return { salesRows, invRows, poRows };
  }

  async syncSales(salesData, clientEmail = null, targetDest = null, metadata = {}) {
    const dest = targetDest || await this.createGoogleSheetFromTemplate(clientEmail, metadata);
    console.log(`Using Spreadsheet ID: ${dest.file_id}`);
    console.log(`Using Spreadsheet URL: ${dest.file_url}`);

    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    
    let doc = { worksheets: {} };
    if (fs.existsSync(filePath)) {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const mappedRows = salesData.rows.map(r => {
      if (Array.isArray(r) && r.length >= 20) return r;
      const saleId = r[0] || 'SO-1001';
      const orderNum = r[1] || 'ORD-2026';
      const customer = r[2] || 'Enterprise Client';
      const date = r[3] || new Date().toISOString().split('T')[0];
      const status = r[4] || 'Complete';
      const totalAmount = parseFloat(r[5] || 0);
      const cogs = parseFloat((totalAmount * 0.55).toFixed(2));
      const profit = parseFloat((totalAmount - cogs).toFixed(2));

      return [
        date.substring(0, 7), date, orderNum, date, `INV-${orderNum}`,
        `SKU-${saleId}`, `Cin7 Commercial Item (${orderNum})`, 'VNC Brand',
        'General Goods', 'Finished Goods', 'Synced', customer, status, 'each',
        'FULFILLED', 'Enterprise', 'Cin7 Automated Sync', 'Shopify web',
        1, totalAmount, totalAmount, cogs, profit, 0, profit, (profit/totalAmount || 0)
      ];
    });

    const headers = ['Month', 'Order date', 'Order #', 'Invoice date', 'Document #', 'SKU', 'Product', 'Brand', 'Category', 'Family', 'Product tags', 'Customer', 'Invoice status', 'Unit', 'Shipment status', 'Customer tags', 'Sales representative', 'Sales Channel', 'Quantity', 'Invoice', 'Sale', 'COGS', 'Profit less journals', 'Journals', 'Profit', 'Profit %'];

    doc.worksheets = doc.worksheets || {};
    doc.worksheets[SALES_SHEET] = {
      headers,
      rows: mappedRows
    };

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));

    console.log("Before Sales write:");
    console.log(`Sales rows: ${mappedRows.length}`);
    console.log(`Sales range: '${SALES_SHEET}'!A7`);
    await this.injectSheetData(dest.file_id, SALES_SHEET, 'A7', mappedRows);
    console.log("Sales write completed");

    return dest;
  }

  async syncInventory(inventoryData, clientEmail = null, targetDest = null) {
    const dest = targetDest || await this.getOrCreateDestination(clientEmail);
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    
    let doc = { worksheets: {} };
    if (fs.existsSync(filePath)) {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const headers = ['Location', 'SKU', 'Product', 'Unit', 'Quantity on hand', 'Allocated', 'On order', 'In transit', 'Unit cost', 'Stock on hand', 'Available'];

    doc.worksheets = doc.worksheets || {};
    doc.worksheets[INVENTORY_SHEET] = {
      headers,
      rows: inventoryData.rows
    };

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));

    console.log("Before Inventory write:");
    console.log(`Inventory rows: ${inventoryData.rows.length}`);
    console.log(`Inventory range: '${INVENTORY_SHEET}'!A7`);
    await this.injectSheetData(dest.file_id, INVENTORY_SHEET, 'A7', inventoryData.rows);
    console.log("Inventory write completed");

    return dest;
  }

  async syncPurchaseOrders(purchaseData, clientEmail = null, targetDest = null) {
    const dest = targetDest || await this.getOrCreateDestination(clientEmail);
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    
    let doc = { worksheets: {} };
    if (fs.existsSync(filePath)) {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const headers = ['Year', 'Month', 'Supplier', 'Expiry date', 'PO #', 'Invoice #', 'Brand', 'Category', 'Family', 'SKU', 'Product', 'Unit', 'Location', 'Batch #', 'Status', 'Quantity', 'Main cost', 'Additional cost', 'Journal cost', 'Tax'];

    doc.worksheets = doc.worksheets || {};
    doc.worksheets[PURCHASES_SHEET] = {
      headers,
      rows: purchaseData.rows
    };

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));

    console.log("Before Purchase Order write:");
    console.log(`PO rows: ${purchaseData.rows.length}`);
    console.log(`PO range: '${PURCHASES_SHEET}'!A7`);
    await this.injectSheetData(dest.file_id, PURCHASES_SHEET, 'A7', purchaseData.rows);
    console.log("PO write completed");
    console.log("Google Sheet data injection completed");

    return dest;
  }

  async updateSyncLog(logEntry, clientEmail = null, targetDest = null) {
    const dest = targetDest || await this.getOrCreateDestination(clientEmail);
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    
    let doc = { worksheets: {} };
    if (fs.existsSync(filePath)) {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    doc.worksheets = doc.worksheets || {};
    doc.worksheets[LOG_SHEET] = doc.worksheets[LOG_SHEET] || { headers: ['Timestamp', 'Status', 'Range', 'Detail', 'Run ID'], rows: [] };
    
    const newLogRow = [
      new Date().toLocaleString(),
      logEntry.status,
      'Last 30 days',
      `${logEntry.syncType.toUpperCase()} - ${logEntry.detail}`,
      logEntry.runId
    ];

    doc.worksheets[LOG_SHEET].rows.push(newLogRow);
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));

    try {
      await this.injectSheetData(dest.file_id, LOG_SHEET, 'A2', [newLogRow]);
    } catch (e) {
      console.log(`[GOOGLE SHEETS] Notice: ${LOG_SHEET} tab not present in this template, skipping log tab update.`);
    }

    return dest;
  }

  /**
   * Dynamically adapts the cloned template's reporting formulas to match the client's actual Cin7 products & channels.
   * This ensures the client sees real calculated revenue, COGS, margins, and stock levels rather than $0.
   * @param {{dateRange?: string, startDate?: string, endDate?: string}} syncWindow the sync's selected filter
   *   range (as chosen when the sync was triggered) — drives which 10 trailing months "Sales Trend Analysis" covers.
   */
  async updateClonedReportFormulas(spreadsheetId, salesData, invData, syncWindow = {}) {
    try {
      console.log(`[DYNAMIC REPORTS] Adapting cloned reporting sheets in ${spreadsheetId} to live Cin7 catalog...`);
      const { sheets } = await this.getGoogleClients();

      // 1. Determine top products by revenue from live Cin7 sales data
      const salesByProduct = {};
      salesData.rows.forEach(r => {
        const sku = r[5] || 'SKU';
        const name = r[6] || sku;
        const saleAmt = parseFloat(r[21] || 0);
        const cogs = parseFloat(r[22] || 0);
        const qty = parseInt(r[19] || 1);

        if (!salesByProduct[sku]) {
          salesByProduct[sku] = { sku, name, revenue: 0, cogs: 0, qty: 0, count: 0 };
        }
        salesByProduct[sku].revenue += saleAmt;
        salesByProduct[sku].cogs += cogs;
        salesByProduct[sku].qty += qty;
        salesByProduct[sku].count += 1;
      });

      const topProducts = Object.values(salesByProduct)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 6);

      // Determine top inventory products
      const invProducts = (invData.rows || []).slice(0, 10).map(r => ({
        location: r[0],
        sku: r[1],
        name: r[2]
      }));

      // Determine the live, per-tenant sales-channel taxonomy directly from this sync's
      // sales data — no hardcoded channel list. Every distinct raw Cin7 channel value
      // shows up, ranked by revenue (same approach as topProducts above), so the report
      // reflects whatever channels this specific client actually sells through.
      const salesByChannel = {};
      salesData.rows.forEach(r => {
        const channel = String(r[17] || '').trim();
        if (!channel) return;
        const saleAmt = parseFloat(r[20] || 0);
        if (!salesByChannel[channel]) salesByChannel[channel] = { channel, revenue: 0 };
        salesByChannel[channel].revenue += saleAmt;
      });
      const liveChannels = Object.values(salesByChannel).sort((a, b) => b.revenue - a.revenue);

      // The master template ships with a fixed number of channel slots in three places.
      // When a client has more distinct channels than the template provides, insert extra
      // columns/rows (format-inherited from the last existing slot) so every channel gets
      // its own column/row instead of being dropped or double-counted into someone else's.
      const COGS_SHEET_NAME = 'COGS & Profitability by Channel';
      const TREND_SHEET_NAME = 'Sales Trend Analysis';
      const KPI_SHEET_NAME = 'KPI Dashboard';
      const COGS_BASE_CHANNEL_SLOTS = 12; // columns B..M
      const TREND_BASE_CHANNEL_SLOTS = 13; // rows 4..16
      const KPI_BASE_CHANNEL_SLOTS = 10; // rows 12..21

      const extraCogsCols = Math.max(0, liveChannels.length - COGS_BASE_CHANNEL_SLOTS);
      const extraTrendRows = Math.max(0, liveChannels.length - TREND_BASE_CHANNEL_SLOTS);
      const extraKpiRows = Math.max(0, liveChannels.length - KPI_BASE_CHANNEL_SLOTS);

      if (extraCogsCols > 0 || extraTrendRows > 0 || extraKpiRows > 0) {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets(properties(sheetId,title))'
        });
        const sheetIdByName = {};
        (meta.data.sheets || []).forEach(s => { sheetIdByName[s.properties.title] = s.properties.sheetId; });

        const structuralRequests = [];
        if (extraCogsCols > 0 && sheetIdByName[COGS_SHEET_NAME] !== undefined) {
          // Insert before column N (0-based index 13, i.e. right before the existing Total column).
          structuralRequests.push({
            insertDimension: {
              range: { sheetId: sheetIdByName[COGS_SHEET_NAME], dimension: 'COLUMNS', startIndex: 13, endIndex: 13 + extraCogsCols },
              inheritFromBefore: true
            }
          });
        }
        if (extraTrendRows > 0 && sheetIdByName[TREND_SHEET_NAME] !== undefined) {
          // Insert before row 17 (0-based index 16, i.e. right before TOTAL REVENUE).
          structuralRequests.push({
            insertDimension: {
              range: { sheetId: sheetIdByName[TREND_SHEET_NAME], dimension: 'ROWS', startIndex: 16, endIndex: 16 + extraTrendRows },
              inheritFromBefore: true
            }
          });
        }
        if (extraKpiRows > 0 && sheetIdByName[KPI_SHEET_NAME] !== undefined) {
          // Insert before row 22 (0-based index 21, i.e. right before the Product Performance section).
          structuralRequests.push({
            insertDimension: {
              range: { sheetId: sheetIdByName[KPI_SHEET_NAME], dimension: 'ROWS', startIndex: 21, endIndex: 21 + extraKpiRows },
              inheritFromBefore: true
            }
          });
        }

        if (structuralRequests.length > 0) {
          console.log(`[DYNAMIC REPORTS] ${liveChannels.length} live sales channels detected — growing template (COGS +${extraCogsCols} cols, Trend +${extraTrendRows} rows, KPI +${extraKpiRows} rows)`);
          await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: structuralRequests } });
        }
      }

      // Row/column count each channel section now actually has available, after any growth above.
      const cogsChannelSlots = Math.max(COGS_BASE_CHANNEL_SLOTS, liveChannels.length);
      const trendChannelSlots = Math.max(TREND_BASE_CHANNEL_SLOTS, liveChannels.length);
      const kpiChannelSlots = Math.max(KPI_BASE_CHANNEL_SLOTS, liveChannels.length);

      const batchData = [];

      // A. "COGS & Profitability by Channel" — Product x Channel matrix. Channel columns
      // start at B; the Total column always sits immediately after the last channel slot
      // (unused slots beyond liveChannels.length, when a client has fewer channels than the
      // template's base capacity, are cleared rather than left showing stale placeholder data).
      const cogsTotalCol = colLetter(2 + cogsChannelSlots);
      for (let i = 0; i < cogsChannelSlots; i++) {
        const col = colLetter(2 + i);
        const ch = liveChannels[i];

        batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}4`, values: [[ch ? ch.channel : '']] });
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}13`, values: [[ch ? ch.channel : '']] });

        topProducts.forEach((p, pi) => {
          const rowNum = 5 + pi; // Revenue rows 5 to 10
          const cogsRowNum = 14 + pi; // COGS rows 14 to 19
          if (ch) {
            const chLit = escapeFormulaString(ch.channel);
            const skuLit = escapeFormulaString(p.sku);
            batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}${rowNum}`, values: [[`=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${skuLit}",'Sales Transactions Raw Data'!S:S,"${chLit}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`]] });
            batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}${cogsRowNum}`, values: [[`=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!G:G,"${skuLit}",'Sales Transactions Raw Data'!S:S,"${chLit}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`]] });
          } else {
            batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}${rowNum}`, values: [[0]] });
            batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}${cogsRowNum}`, values: [[0]] });
          }
        });

        // Per-column TOTAL REVENUE (11) / TOTAL COGS (20) / GROSS PROFIT (21) / GM% (22)
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}11`, values: [[`=SUM(${col}5:${col}10)`]] });
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}20`, values: [[`=SUM(${col}14:${col}19)`]] });
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}21`, values: [[`=${col}11-${col}20`]] });
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${col}22`, values: [[`=IF(${col}11=0,"-",${col}21/${col}11)`]] });
      }
      // Total column, repositioned to sit right after the last live channel slot.
      batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}4`, values: [['Total']] });
      batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}13`, values: [['Total']] });
      for (const rowNum of [5, 6, 7, 8, 9, 10]) {
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}${rowNum}`, values: [[`=SUM(B${rowNum}:${colLetter(1 + cogsChannelSlots)}${rowNum})`]] });
      }
      for (const rowNum of [14, 15, 16, 17, 18, 19]) {
        batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}${rowNum}`, values: [[`=SUM(B${rowNum}:${colLetter(1 + cogsChannelSlots)}${rowNum})`]] });
      }
      batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}11`, values: [[`=SUM(${cogsTotalCol}5:${cogsTotalCol}10)`]] });
      batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}20`, values: [[`=SUM(${cogsTotalCol}14:${cogsTotalCol}19)`]] });
      batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}21`, values: [[`=${cogsTotalCol}11-${cogsTotalCol}20`]] });
      batchData.push({ range: `'${COGS_SHEET_NAME}'!${cogsTotalCol}22`, values: [[`=IF(${cogsTotalCol}11=0,"-",${cogsTotalCol}21/${cogsTotalCol}11)`]] });

      // A2. "KPI Dashboard" — CHANNEL PERFORMANCE cards (rows 12+), one per live channel,
      // ranked by revenue. Product Performance / Inventory Alerts sections below were already
      // shifted down (if needed) by the structural insert above, and need no changes of their
      // own — they reference other sheets by fixed row, not by their own position.
      for (let i = 0; i < kpiChannelSlots; i++) {
        const rowNum = 12 + i;
        const ch = liveChannels[i];
        const cogsCol = colLetter(2 + i); // same channel, same index, in the COGS sheet
        if (ch) {
          const chLit = escapeFormulaString(ch.channel);
          batchData.push({ range: `'${KPI_SHEET_NAME}'!A${rowNum}`, values: [[ch.channel]] });
          batchData.push({ range: `'${KPI_SHEET_NAME}'!B${rowNum}`, values: [[`=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!S:S,"${chLit}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`]] });
          batchData.push({ range: `'${KPI_SHEET_NAME}'!C${rowNum}`, values: [[`='${COGS_SHEET_NAME}'!${cogsCol}22`]] });
          batchData.push({ range: `'${KPI_SHEET_NAME}'!D${rowNum}`, values: [[`=IF($B$5=0,"-",B${rowNum}/$B$5)`]] });
        } else {
          batchData.push({ range: `'${KPI_SHEET_NAME}'!A${rowNum}:D${rowNum}`, values: [['', '', '', '']] });
        }
      }

      // B. "Product Margin Analysis"
      topProducts.forEach((p, i) => {
        const rowNum = 5 + i;
        batchData.push({ range: `'Product Margin Analysis'!A${rowNum}`, values: [[p.sku]] });
        batchData.push({
          range: `'Product Margin Analysis'!B${rowNum}:D${rowNum}`,
          values: [[
            `=SUMIFS('Sales Transactions Raw Data'!T:T,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`,
            `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`,
            `=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`
          ]]
        });
      });

      // C. "Inventory & MOS Analysis" (Rows 5 to 12)
      const mosWarehouses = ['Amazon FBA', 'Founders', 'NJ Warehouse', 'NY Warehouse', 'NOBL'];
      invProducts.slice(0, 8).forEach((p, i) => {
        const rowNum = 5 + i;
        if (p.sku) {
          batchData.push({ range: `'Inventory & MOS Analysis'!A${rowNum}:B${rowNum}`, values: [[p.sku, p.name || p.sku]] });
          
          // Warehouse stock formulas
          const whFormulas = mosWarehouses.map(wh => 
            `=SUMIFS('Inventory On Hand Raw Data'!E:E,'Inventory On Hand Raw Data'!B:B,"${p.sku}",'Inventory On Hand Raw Data'!A:A,"*${wh}*")`
          );
          batchData.push({ range: `'Inventory & MOS Analysis'!C${rowNum}:G${rowNum}`, values: [whFormulas] });
          
          // Sales average & MOS formula
          const avgSalesForm = `=IFERROR((SUMIFS('Sales Transactions Raw Data'!T:T,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods",'Sales Transactions Raw Data'!B:B,"September")+SUMIFS('Sales Transactions Raw Data'!T:T,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods",'Sales Transactions Raw Data'!B:B,"October")+SUMIFS('Sales Transactions Raw Data'!T:T,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods",'Sales Transactions Raw Data'!B:B,"November"))/3,0)`;
          batchData.push({ range: `'Inventory & MOS Analysis'!I${rowNum}`, values: [[avgSalesForm]] });
        }
      });

      // D. "Inventory Movements" (Rows 5 to 36 for 8 products)
      const movementMonths = [
        { col: 'C', month: 'March' },
        { col: 'D', month: 'July' },
        { col: 'E', month: 'August' },
        { col: 'F', month: 'September' },
        { col: 'G', month: 'October' },
        { col: 'H', month: 'November' }
      ];

      invProducts.slice(0, 8).forEach((p, i) => {
        const rowHeader = 5 + i * 4;
        const rowSold = 6 + i * 4;
        const rowPurchased = 7 + i * 4;
        const rowNet = 8 + i * 4;

        if (p.sku) {
          // Section header product name
          batchData.push({ range: `'Inventory Movements'!A${rowHeader}`, values: [[p.name || p.sku]] });

          // SKU labels
          batchData.push({ range: `'Inventory Movements'!A${rowSold}`, values: [[p.sku]] });
          batchData.push({ range: `'Inventory Movements'!A${rowPurchased}`, values: [[p.sku]] });
          batchData.push({ range: `'Inventory Movements'!A${rowNet}`, values: [[p.sku]] });

          // Month formulas for Units Sold
          const soldFormulas = movementMonths.map(({ month }) => 
            `=SUMIFS('Sales Transactions Raw Data'!T:T,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!B:B,"${month}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`
          );
          batchData.push({ range: `'Inventory Movements'!C${rowSold}:H${rowSold}`, values: [soldFormulas] });

          // Month formulas for Units Purchased
          const purchasedFormulas = movementMonths.map(({ month }) => 
            `=SUMIFS('Purchase Transactions Raw data'!P:P,'Purchase Transactions Raw data'!J:J,"${p.sku}",'Purchase Transactions Raw data'!B:B,"${month}")`
          );
          batchData.push({ range: `'Inventory Movements'!C${rowPurchased}:H${rowPurchased}`, values: [purchasedFormulas] });

          // Net Movement formulas
          const netFormulas = movementMonths.map(({ col }) => 
            `=${col}${rowPurchased}-${col}${rowSold}`
          );
          batchData.push({ range: `'Inventory Movements'!C${rowNet}:H${rowNet}`, values: [netFormulas] });
        }
      });

      // E. "Weekly Order Tracker" (Handle case-insensitive and variant invoice statuses)
      batchData.push({
        range: "'Weekly Order Tracker'!B7:C7",
        values: [[
          `=COUNTIFS('Sales Transactions Raw Data'!M:M,"*INVOIC*")`,
          `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!M:M,"*INVOIC*")`
        ]]
      });
      batchData.push({
        range: "'Weekly Order Tracker'!B8:C8",
        values: [[
          `=COUNTIFS('Sales Transactions Raw Data'!M:M,"*CREDIT*")`,
          `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!M:M,"*CREDIT*")`
        ]]
      });

      // Reference date driving every dynamic year/month formula below (Monthly Order
      // Activity Summary and Sales Trend Analysis) — the sync's own custom end date if
      // one was selected, otherwise the moment this sync is running. Nothing past this
      // point should ever hardcode a year or month literal.
      const trendRefDate = (syncWindow.dateRange === 'custom' && syncWindow.endDate)
        ? new Date(syncWindow.endDate)
        : new Date();

      // Fixes a corrupted formula found in the master template: a mangled external-workbook
      // reference ('[1]Sales I18Transactions Raw Data') that produced #VALUE! for every
      // client's "Unshipped / Pending" row and broke the TOTAL row beneath it.
      batchData.push({
        range: "'Weekly Order Tracker'!B14",
        values: [[`=COUNTIFS('Sales Transactions Raw Data'!P:P,"<>Shipped",'Sales Transactions Raw Data'!P:P,"<>")`]]
      });

      // "Monthly Order Activity Summary" (rows 29-34) — same treatment as Sales Trend
      // Analysis: fully regenerated every sync from the sync's own reference date so no
      // year/month is ever hardcoded. Column A gets the real month date; columns B-H
      // derive their month/year criteria from that same row's own date cell.
      const activityMonths = getTrailingMonths(trendRefDate, 6);
      const activityRows = [29, 30, 31, 32, 33, 34];

      activityRows.forEach((row, idx) => {
        const dateCell = `$A${row}`;
        batchData.push({ range: `'Weekly Order Tracker'!A${row}`, values: [[activityMonths[idx].isoDate]] });
        batchData.push({
          range: `'Weekly Order Tracker'!B${row}`,
          values: [[`=COUNTIFS('Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}))`]]
        });
        batchData.push({
          range: `'Weekly Order Tracker'!C${row}`,
          values: [[`=COUNTIFS('Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}),'Sales Transactions Raw Data'!N:N,"Invoiced")+COUNTIFS('Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}),'Sales Transactions Raw Data'!N:N,"Invoiced / credited")`]]
        });
        batchData.push({
          range: `'Weekly Order Tracker'!E${row}:F${row}`,
          values: [[
            `=COUNTIFS('Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}),'Sales Transactions Raw Data'!P:P,"Shipped")`,
            `=COUNTIFS('Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}),'Sales Transactions Raw Data'!P:P,"<>Shipped",'Sales Transactions Raw Data'!P:P,"<>")`
          ]]
        });
        batchData.push({
          range: `'Weekly Order Tracker'!G${row}:H${row}`,
          values: [[
            `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}))`,
            `=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!B:B,TEXT(${dateCell},"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${dateCell}))`
          ]]
        });
      });

      // F. "Sales Dashboard" Chart Data 3 (Top Products)
      topProducts.forEach((p, i) => {
        const rowNum = 26 + i;
        batchData.push({ range: `'Sales Dashboard'!A${rowNum}`, values: [[p.name || p.sku]] });
        batchData.push({
          range: `'Sales Dashboard'!B${rowNum}`,
          values: [[`=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`]]
        });
      });

      // G. "Sales Trend Analysis" — fully regenerated on every sync from the same
      // trendRefDate above, instead of a hardcoded year baked into the template. Fixes
      // both the stale-year bug and the scrambled per-column formulas found in the master
      // template (some columns referenced the wrong raw-data column or the wrong channel).
      const trendMonths = getTrailingMonths(trendRefDate, 10);
      const monthCols = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

      // Cover & Index "Data Period / Generated" line — dynamic based on sync period & current date.
      // Derived from syncWindow settings (custom/presets) or the trailing-months window, plus real sync timestamp.
      const firstMonth = trendMonths[0];
      const lastMonth = trendMonths[trendMonths.length - 1];
      let dataPeriod = '';
      if (syncWindow.dateRange === 'custom' && syncWindow.startDate && syncWindow.endDate) {
        const s = new Date(syncWindow.startDate);
        const e = new Date(syncWindow.endDate);
        dataPeriod = `${s.toLocaleString('default', { month: 'short' })} ${s.getDate()}, ${s.getFullYear()} – ${e.toLocaleString('default', { month: 'short' })} ${e.getDate()}, ${e.getFullYear()}`;
      } else if (syncWindow.dateRange === '30d') {
        dataPeriod = 'Last 30 Days';
      } else if (syncWindow.dateRange === '60d') {
        dataPeriod = 'Last 60 Days';
      } else if (syncWindow.dateRange === '90d') {
        dataPeriod = 'Last 90 Days';
      } else if (syncWindow.dateRange === '180d') {
        dataPeriod = 'Last 6 Months';
      } else if (syncWindow.dateRange === '365d' || syncWindow.dateRange === '12m') {
        dataPeriod = 'Last 12 Months';
      } else {
        dataPeriod = firstMonth.year === lastMonth.year
          ? `${firstMonth.monthName} – ${lastMonth.monthName} ${firstMonth.year}`
          : `${firstMonth.monthName} ${firstMonth.year} – ${lastMonth.monthName} ${lastMonth.year}`;
      }
      batchData.push({
        range: `'${COVER_SHEET}'!A5`,
        values: [[`Data Period: ${dataPeriod}  |  Generated: ${trendRefDate.toDateString()}`]]
      });

      // Header row: real dates driving every formula below via TEXT(col$3,"mmmm") / YEAR(col$3)
      batchData.push({ range: "'Sales Trend Analysis'!B3:K3", values: [trendMonths.map(m => m.isoDate)] });

      // Channel rows (4..4+trendChannelSlots-1), same live/ranked taxonomy as the COGS sheet
      // above. Unused slots (when a client has fewer channels than the template's base 13)
      // are cleared rather than left showing a stale channel name with a $0 row beside it.
      for (let i = 0; i < trendChannelSlots; i++) {
        const row = 4 + i;
        const ch = liveChannels[i];
        batchData.push({ range: `'${TREND_SHEET_NAME}'!A${row}`, values: [[ch ? ch.channel : '']] });
        if (ch) {
          const chLit = escapeFormulaString(ch.channel);
          const rowFormulas = monthCols.map(col =>
            `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!S:S,"${chLit}",'Sales Transactions Raw Data'!B:B,TEXT(${col}$3,"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${col}$3),'Sales Transactions Raw Data'!J:J,"Finished Goods")`
          );
          batchData.push({ range: `'${TREND_SHEET_NAME}'!B${row}:K${row}`, values: [rowFormulas] });
        } else {
          batchData.push({ range: `'${TREND_SHEET_NAME}'!B${row}:K${row}`, values: [monthCols.map(() => 0)] });
        }
      }

      // TOTAL REVENUE / COGS / GROSS PROFIT / MARGIN / MoM rows always sit directly below the
      // channel rows — their row numbers shift down by exactly however many extra channel rows
      // were inserted above (0 when a client's channel count fits the template's base 13).
      const trendTotalRow = 17 + extraTrendRows;
      const trendGrossProfitRow1 = trendTotalRow + 1;
      const trendCogsRow = trendTotalRow + 2;
      const trendGrossProfitRow2 = trendTotalRow + 3;
      const trendMarginRow = trendTotalRow + 4;
      const trendMomRow = trendTotalRow + 5;

      // TOTAL REVENUE: summed directly from raw data, independent of the channel breakdown
      // above — so it stays correct even if a channel value is missing/blank, rather than
      // under-counting like SUM(channel rows) would.
      const totalRevenueFormulas = monthCols.map(col =>
        `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!B:B,TEXT(${col}$3,"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${col}$3),'Sales Transactions Raw Data'!J:J,"Finished Goods")`
      );
      batchData.push({ range: `'${TREND_SHEET_NAME}'!B${trendTotalRow}:K${trendTotalRow}`, values: [totalRevenueFormulas] });

      const cogsFormulas = monthCols.map(col =>
        `=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!B:B,TEXT(${col}$3,"mmmm"),'Sales Transactions Raw Data'!A:A,YEAR(${col}$3),'Sales Transactions Raw Data'!J:J,"Finished Goods")`
      );
      batchData.push({ range: `'${TREND_SHEET_NAME}'!B${trendCogsRow}:K${trendCogsRow}`, values: [cogsFormulas] });

      // GROSS PROFIT — the template labels this on two rows; keep both in sync.
      const grossProfitFormulas = monthCols.map(col => `=${col}${trendTotalRow}-${col}${trendCogsRow}`);
      batchData.push({ range: `'${TREND_SHEET_NAME}'!B${trendGrossProfitRow1}:K${trendGrossProfitRow1}`, values: [grossProfitFormulas] });
      batchData.push({ range: `'${TREND_SHEET_NAME}'!B${trendGrossProfitRow2}:K${trendGrossProfitRow2}`, values: [grossProfitFormulas] });

      const marginFormulas = monthCols.map(col => `=IF(${col}${trendTotalRow}=0,"-",${col}${trendGrossProfitRow1}/${col}${trendTotalRow})`);
      batchData.push({ range: `'${TREND_SHEET_NAME}'!B${trendMarginRow}:K${trendMarginRow}`, values: [marginFormulas] });

      // MoM Revenue Growth — first column has no prior month to compare against.
      const momFormulas = monthCols.map((col, idx) => {
        if (idx === 0) return '-';
        const prevCol = monthCols[idx - 1];
        return `=IF(${prevCol}${trendTotalRow}=0,"-",${col}${trendTotalRow}/${prevCol}${trendTotalRow}-1)`;
      });
      batchData.push({ range: `'${TREND_SHEET_NAME}'!B${trendMomRow}:K${trendMomRow}`, values: [momFormulas] });

      // Execute batch update
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: batchData
        }
      });

      console.log(`[DYNAMIC REPORTS] Successfully adapted reporting sheets in ${spreadsheetId}`);
    } catch (err) {
      console.error(`[DYNAMIC REPORTS] Notice: Failed to update dynamic reporting formulas: ${err.message}`);
    }
  }

  /**
   * Reads raw data worksheets from a Google Spreadsheet.
   * Extracts sales, inventory, and purchase records, filtering out trailing empty rows and padding to schema columns.
   * @param {string} spreadsheetId
   * @returns {Promise<{ sales: { headers: string[], rows: any[][] }, inventory: { headers: string[], rows: any[][] }, purchase: { headers: string[], rows: any[][] }, kpiRows: any[][] }>}
   */
  async readSpreadsheetData(spreadsheetId) {
    if (!spreadsheetId) {
      throw new Error('Spreadsheet ID is required to read Google Sheet data.');
    }
    const { sheets } = await this.getGoogleClients();

    const ranges = [
      `'${SALES_SHEET}'!A7:Z`,
      `'${INVENTORY_SHEET}'!A7:K`,
      `'${PURCHASES_SHEET}'!A7:T`,
      `'KPI Dashboard'!A1:F20`
    ];

    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });

    const valueRanges = response.data.valueRanges || [];

    const salesHeaders = ['Month', 'Order date', 'Order #', 'Invoice date', 'Document #', 'SKU', 'Product', 'Brand', 'Category', 'Family', 'Product tags', 'Customer', 'Invoice status', 'Unit', 'Shipment status', 'Customer tags', 'Sales representative', 'Sales Channel', 'Quantity', 'Invoice', 'Sale', 'COGS', 'Profit less journals', 'Journals', 'Profit', 'Profit %'];
    const invHeaders = ['Location', 'SKU', 'Product', 'Unit', 'Quantity on hand', 'Allocated', 'On order', 'In transit', 'Unit cost', 'Stock on hand', 'Available'];
    const poHeaders = ['Year', 'Month', 'Supplier', 'Expiry date', 'PO #', 'Invoice #', 'Brand', 'Category', 'Family', 'SKU', 'Product', 'Unit', 'Location', 'Batch #', 'Status', 'Quantity', 'Main cost', 'Additional cost', 'Journal cost', 'Tax'];

    const cleanAndPadRows = (rawRows, targetLength) => {
      if (!Array.isArray(rawRows)) return [];
      const clean = [];
      for (const row of rawRows) {
        if (!Array.isArray(row) || row.length === 0) continue;
        const hasContent = row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
        if (!hasContent) continue;
        const padded = [...row];
        while (padded.length < targetLength) {
          padded.push('');
        }
        clean.push(padded);
      }
      return clean;
    };

    const salesRows = cleanAndPadRows(valueRanges[0]?.values, salesHeaders.length);
    const invRows = cleanAndPadRows(valueRanges[1]?.values, invHeaders.length);
    const poRows = cleanAndPadRows(valueRanges[2]?.values, poHeaders.length);
    const kpiRows = valueRanges[3]?.values || [];

    return {
      sales: { headers: salesHeaders, rows: salesRows },
      inventory: { headers: invHeaders, rows: invRows },
      purchase: { headers: poHeaders, rows: poRows },
      kpiRows
    };
  }

  /**
   * Reads every tab of a live Google Sheet exactly as it appears in Sheets (tab names,
   * order, and formatted cell values) so an in-app preview can never drift from the
   * real spreadsheet. Unlike readSpreadsheetData (which knows fixed headers for the 3
   * raw-data tabs) this is fully generic and works for any tab in the workbook.
   * @param {string} spreadsheetId
   * @returns {Promise<{ sheets: { name: string, rows: any[][] }[] }>}
   */
  async readWorkbookPreview(spreadsheetId) {
    if (!spreadsheetId) {
      throw new Error('Spreadsheet ID is required to preview Google Sheet data.');
    }
    const { sheets } = await this.getGoogleClients();

    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title,index,gridProperties(rowCount,columnCount)))'
    });

    const sheetProps = (meta.data.sheets || [])
      .map(s => s.properties)
      .sort((a, b) => a.index - b.index);

    if (sheetProps.length === 0) {
      return { sheets: [] };
    }

    const MAX_ROWS = 500;
    const MAX_COLS = 30;
    const colLetter = (n) => {
      let s = '';
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s || 'A';
    };

    const ranges = sheetProps.map(p => {
      const rowCount = Math.min(p.gridProperties?.rowCount || MAX_ROWS, MAX_ROWS);
      const colCount = Math.min(p.gridProperties?.columnCount || MAX_COLS, MAX_COLS);
      return `'${p.title}'!A1:${colLetter(colCount)}${rowCount}`;
    });

    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
      valueRenderOption: 'FORMATTED_VALUE'
    });

    const valueRanges = response.data.valueRanges || [];

    const trimTrailingEmptyRows = (rawRows) => {
      if (!Array.isArray(rawRows)) return [];
      let end = rawRows.length;
      while (end > 0) {
        const row = rawRows[end - 1];
        const hasContent = Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '');
        if (hasContent) break;
        end--;
      }
      return rawRows.slice(0, end);
    };

    const previewSheets = sheetProps.map((p, idx) => ({
      name: p.title,
      rows: trimTrailingEmptyRows(valueRanges[idx]?.values)
    }));

    return { sheets: previewSheets };
  }
}

module.exports = GoogleSheetsAdapter;
