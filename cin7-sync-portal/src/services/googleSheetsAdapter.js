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

class GoogleSheetsAdapter extends DestinationAdapter {
  constructor(clientId, userOAuthAccount) {
    super(clientId, userOAuthAccount);
    this.clientId = clientStorageService.validateClientId(clientId || 'client-vnc-master');
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

    // 4. Granting Access: Anyone with link + explicit user email
    try {
      console.log(`[GOOGLE SHEETS] Granting anyone-with-link access to ${fileId}`);
      await drive.permissions.create({
        fileId: fileId,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        }
      });
      console.log(`[GOOGLE SHEETS] Anyone-with-link access granted successfully`);
    } catch (anyoneErr) {
      console.warn(`[GOOGLE SHEETS] Anyone permission notice: ${anyoneErr.message}`);
    }

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
   */
  async updateClonedReportFormulas(spreadsheetId, salesData, invData) {
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

      const batchData = [];

      // A. "COGS & Profitability by Channel"
      const channelCols = [
        { col: 'B', channel: 'amazon' },
        { col: 'C', channel: 'amazon-us' },
        { col: 'D', channel: 'Shopify web' },
        { col: 'E', channel: 'Shopify POS' },
        { col: 'F', channel: 'Shopify admin' },
        { col: 'G', channel: 'subscription_contract' },
        { col: 'H', channel: 'subscription_contract_checkout_one' },
        { col: 'I', channel: '296827748353' },
        { col: 'J', channel: 'faire' },
        { col: 'K', channel: 'tiktok' },
        { col: 'L', channel: 'Shopify' },
        { col: 'M', channel: 'API' }
      ];

      topProducts.forEach((p, i) => {
        const rowNum = 5 + i; // Revenue rows 5 to 10
        const cogsRowNum = 14 + i; // COGS rows 14 to 19

        // Col A product labels
        batchData.push({ range: `'COGS & Profitability by Channel'!A${rowNum}`, values: [[p.sku]] });
        batchData.push({ range: `'COGS & Profitability by Channel'!A${cogsRowNum}`, values: [[p.sku]] });

        // Channel formulas
        channelCols.forEach(({ col, channel }) => {
          const revForm = `=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!S:S,"*${channel}*",'Sales Transactions Raw Data'!J:J,"Finished Goods")`;
          const cogsForm = `=SUMIFS('Sales Transactions Raw Data'!W:W,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!S:S,"*${channel}*",'Sales Transactions Raw Data'!J:J,"Finished Goods")`;
          batchData.push({ range: `'COGS & Profitability by Channel'!${col}${rowNum}`, values: [[revForm]] });
          batchData.push({ range: `'COGS & Profitability by Channel'!${col}${cogsRowNum}`, values: [[cogsForm]] });
        });
      });

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

      // F. "Sales Dashboard" Chart Data 3 (Top Products)
      topProducts.forEach((p, i) => {
        const rowNum = 26 + i;
        batchData.push({ range: `'Sales Dashboard'!A${rowNum}`, values: [[p.name || p.sku]] });
        batchData.push({
          range: `'Sales Dashboard'!B${rowNum}`,
          values: [[`=SUMIFS('Sales Transactions Raw Data'!V:V,'Sales Transactions Raw Data'!G:G,"${p.sku}",'Sales Transactions Raw Data'!J:J,"Finished Goods")`]]
        });
      });

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
}

module.exports = GoogleSheetsAdapter;
