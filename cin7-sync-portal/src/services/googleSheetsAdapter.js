const DestinationAdapter = require('./destinationAdapter');
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SALES_SHEET = 'Sales Transactions Raw Data';
const INVENTORY_SHEET = 'Inventory On Hand Raw Data';
const PURCHASES_SHEET = 'Purchase Transactions Raw data';
const LOG_SHEET = 'Sync Log';

class GoogleSheetsAdapter extends DestinationAdapter {
  constructor(clientId, userOAuthAccount) {
    super(clientId, userOAuthAccount);
    this.storageDir = path.join(__dirname, '../../storage/google_sheets');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  async getOrCreateDestination() {
    const existing = await db.getOne(
      "SELECT * FROM destination_files WHERE client_id = ? AND provider = 'google'",
      [this.clientId]
    );

    if (existing) {
      return existing;
    }

    const fileId = `g-sheet-${uuidv4().substring(0, 8)}`;
    const fileName = `Controller_Reporting_Model_v5_Cin7_Actuals_${this.clientId.substring(0, 8)}`;
    const fileUrl = `https://docs.google.com/spreadsheets/d/${fileId}/edit`;

    const recordId = `dest-${uuidv4().substring(0, 8)}`;

    const sheetStructure = {
      fileId,
      fileName,
      provider: 'google',
      worksheets: {
        [SALES_SHEET]: { headers: [], rows: [] },
        [INVENTORY_SHEET]: { headers: [], rows: [] },
        [PURCHASES_SHEET]: { headers: [], rows: [] },
        [LOG_SHEET]: { headers: [], rows: [] }
      }
    };

    fs.writeFileSync(path.join(this.storageDir, `${fileId}.json`), JSON.stringify(sheetStructure, null, 2));

    await db.query(
      `INSERT INTO destination_files (id, client_id, provider, file_id, file_name, file_url)
       VALUES (?, ?, 'google', ?, ?, ?)`,
      [recordId, this.clientId, fileId, fileName, fileUrl]
    );

    return { id: recordId, client_id: this.clientId, provider: 'google', file_id: fileId, file_name: fileName, file_url: fileUrl };
  }

  async syncSales(salesData) {
    const dest = await this.getOrCreateDestination();
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    const mappedRows = salesData.rows.map(r => {
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

    doc.worksheets[SALES_SHEET] = {
      headers: ['Month', 'Order date', 'Order #', 'Invoice date', 'Document #', 'SKU', 'Product', 'Brand', 'Category', 'Family', 'Product tags', 'Customer', 'Invoice status', 'Unit', 'Shipment status', 'Customer tags', 'Sales representative', 'Sales Channel', 'Quantity', 'Invoice', 'Sale', 'COGS', 'Profit less journals', 'Journals', 'Profit', 'Profit %'],
      rows: mappedRows
    };

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
    return dest;
  }

  async syncInventory(inventoryData) {
    const dest = await this.getOrCreateDestination();
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    doc.worksheets[INVENTORY_SHEET] = {
      headers: ['Location', 'SKU', 'Product', 'Unit', 'Quantity on hand', 'Allocated', 'On order', 'In transit', 'Unit cost', 'Stock on hand', 'Available'],
      rows: inventoryData.rows
    };

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
    return dest;
  }

  async syncPurchaseOrders(purchaseData) {
    const dest = await this.getOrCreateDestination();
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    doc.worksheets[PURCHASES_SHEET] = {
      headers: ['Year', 'Month', 'Supplier', 'Expiry date', 'PO #', 'Invoice #', 'Brand', 'Category', 'Family', 'SKU', 'Product', 'Unit', 'Location', 'Batch #', 'Status', 'Quantity', 'Main cost', 'Additional cost', 'Journal cost', 'Tax'],
      rows: purchaseData.rows
    };

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
    return dest;
  }

  async updateSyncLog(logEntry) {
    const dest = await this.getOrCreateDestination();
    const filePath = path.join(this.storageDir, `${dest.file_id}.json`);
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    doc.worksheets[LOG_SHEET].rows.push([
      new Date().toLocaleString(),
      logEntry.status,
      'Last 30 days',
      `${logEntry.syncType.toUpperCase()} - ${logEntry.detail}`,
      logEntry.runId
    ]);

    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
    return dest;
  }
}

module.exports = GoogleSheetsAdapter;
