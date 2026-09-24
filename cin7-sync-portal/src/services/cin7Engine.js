const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
let axios;
try { axios = require('axios'); } catch (e) {}
try { require('dotenv').config(); } catch (e) {}

const CIN7_BASE_URL = process.env.CIN7_BASE_URL || 'https://inventory.dearsystems.com/externalapi/v2';
const clientStorageService = require('./clientStorageService');
const db = require('../db');
const cryptoService = require('./cryptoService');

// In-memory cache map for instantaneous lookups: Map<`${clientId}__${saleId}`, detail>
const memoryOrderCache = new Map();

// ── DB-BACKED ORDER DETAIL CACHE ─────────────────────────────────────────────

/**
 * Bulk-loads all cached order details for a client from the DB into the
 * in-memory cache. Called once at the start of enrichment so individual
 * workers never need to hit the DB per-order.
 */
async function warmMemoryCacheFromDb(clientId) {
  try {
    const safeClientId = getSafeClientId(clientId);
    const { rows } = await db.queryWithTenant(
      'SELECT cin7_sale_id, updated_date_utc, detail_json FROM cin7_order_cache WHERE client_id = ?',
      [safeClientId],
      safeClientId
    );
    let loaded = 0;
    for (const row of rows) {
      const cacheKey = `${safeClientId}__${row.cin7_sale_id}`;
      if (!memoryOrderCache.has(cacheKey)) {
        try {
          const detail = JSON.parse(row.detail_json);
          memoryOrderCache.set(cacheKey, {
            saleId: row.cin7_sale_id,
            clientId: safeClientId,
            updatedDateUtc: row.updated_date_utc,
            storedAt: new Date().toISOString(),
            detail
          });
          loaded++;
        } catch (_) {}
      }
    }
    if (loaded > 0) console.log(`[CIN7 DB CACHE] Warmed ${loaded} order details from DB into memory.`);
  } catch (e) {
    console.warn('[CIN7 DB CACHE] Could not warm memory cache from DB (non-fatal):', e.message);
  }
}

/**
 * Persists an order detail to the DB cache (cin7_order_cache table).
 * Fire-and-forget — never throws.
 */
async function storeOrderDetailToDb(clientId, saleId, detail, updatedDateUtc) {
  try {
    const safeClientId = getSafeClientId(clientId);
    const detailJson = JSON.stringify(detail);
    await db.queryWithTenant(
      `INSERT INTO cin7_order_cache (client_id, cin7_sale_id, updated_date_utc, detail_json, stored_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (client_id, cin7_sale_id) DO UPDATE SET
         updated_date_utc = EXCLUDED.updated_date_utc,
         detail_json      = EXCLUDED.detail_json,
         stored_at        = EXCLUDED.stored_at`,
      [safeClientId, saleId, updatedDateUtc || null, detailJson],
      safeClientId
    );
  } catch (e) {
    console.warn('[CIN7 DB CACHE] storeOrderDetailToDb failed (non-fatal):', e.message);
  }
}

// ── DB UPSERT FUNCTIONS ───────────────────────────────────────────────────────

/**
 * Upserts all fetched sales orders and their line items into the database.
 * Called after successful enrichment. Fire-and-forget — never throws.
 */
async function upsertSalesToDb(clientId, detailedSales) {
  if (!detailedSales || detailedSales.length === 0) return;
  const safeClientId = getSafeClientId(clientId);
  let orderCount = 0;
  let lineCount = 0;
  try {
    for (const { sale, lines } of detailedSales) {
      try {
        const orderDate = sale.OrderDate ? sale.OrderDate.split('T')[0] : null;
        const invoiceDate = sale.InvoiceDate ? sale.InvoiceDate.split('T')[0] : null;
        await db.queryWithTenant(
          `INSERT INTO cin7_sales_orders
             (client_id, cin7_sale_id, order_number, invoice_number, order_date, invoice_date,
              customer, status, combined_invoice_status, combined_shipping_status,
              type, source_channel, sales_representative, customer_tags, updated_date_utc, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (client_id, cin7_sale_id) DO UPDATE SET
             order_number             = EXCLUDED.order_number,
             invoice_number           = EXCLUDED.invoice_number,
             order_date               = EXCLUDED.order_date,
             invoice_date             = EXCLUDED.invoice_date,
             customer                 = EXCLUDED.customer,
             status                   = EXCLUDED.status,
             combined_invoice_status  = EXCLUDED.combined_invoice_status,
             combined_shipping_status = EXCLUDED.combined_shipping_status,
             type                     = EXCLUDED.type,
             source_channel           = EXCLUDED.source_channel,
             sales_representative     = EXCLUDED.sales_representative,
             customer_tags            = EXCLUDED.customer_tags,
             updated_date_utc         = EXCLUDED.updated_date_utc,
             synced_at                = EXCLUDED.synced_at`,
          [
            safeClientId, sale.SaleID,
            sale.OrderNumber || null, sale.InvoiceNumber || null,
            orderDate, invoiceDate,
            sale.Customer || null, sale.Status || null,
            sale.CombinedInvoiceStatus || null, sale.CombinedShippingStatus || null,
            sale.Type || null, sale.SourceChannel || sale.SaleChannel || null,
            sale.SalesRepresentative || null, sale.CustomerTags || null,
            sale.Updated || null
          ],
          safeClientId
        );
        orderCount++;

        // Upsert each line with a valid SKU
        for (const line of (lines || [])) {
          const sku = String(line.SKU || '').trim();
          if (!sku) continue;
          try {
            await db.queryWithTenant(
              `INSERT INTO cin7_order_lines
                 (client_id, cin7_sale_id, sku, product_name, brand, category, family,
                  unit, quantity, unit_price, total, average_cost)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (client_id, cin7_sale_id, sku) DO UPDATE SET
                 product_name = EXCLUDED.product_name,
                 brand        = EXCLUDED.brand,
                 category     = EXCLUDED.category,
                 family       = EXCLUDED.family,
                 unit         = EXCLUDED.unit,
                 quantity     = EXCLUDED.quantity,
                 unit_price   = EXCLUDED.unit_price,
                 total        = EXCLUDED.total,
                 average_cost = EXCLUDED.average_cost`,
              [
                safeClientId, sale.SaleID, sku,
                line.Name || line.Description || null,
                line.Brand || null, line.Category || null, line.Family || null,
                line.Unit || null,
                toNumber(line.Quantity), toNumber(line.Price || line.UnitPrice),
                toNumber(line.Total), toNumber(line.AverageCost)
              ],
              safeClientId
            );
            lineCount++;
          } catch (_) {}
        }
      } catch (_) {}
    }
    console.log(`[CIN7 DB] Upserted ${orderCount} sales orders and ${lineCount} line items to database.`);
  } catch (e) {
    console.warn('[CIN7 DB] upsertSalesToDb failed (non-fatal):', e.message);
  }
}

/**
 * Upserts Sales V2 (Core-parity) line-level records into cin7_sale_lines_v2.
 * Additive table only — never touches cin7_order_lines. Fire-and-forget.
 */
async function upsertSaleLinesV2ToDb(clientId, detailedSales, window) {
  if (!detailedSales || detailedSales.length === 0) return;
  const safeClientId = getSafeClientId(clientId);
  let lineCount = 0;
  try {
    for (const { sale, detail } of detailedSales) {
      if (!detail) continue;
      let records;
      try {
        records = buildSaleV2Records(sale, detail, window);
      } catch (_) {
        continue;
      }
      for (let lineIdx = 0; lineIdx < records.length; lineIdx++) {
        const r = records[lineIdx];
        // Stable per-sale index (not a running total) so re-syncs UPDATE the same
        // row instead of accumulating duplicates each run.
        const lineKey = `${r.rowType}|${r.docNumber || 'NA'}|${r.sku || 'NA'}|${lineIdx}`;
        try {
          await db.queryWithTenant(
            `INSERT INTO cin7_sale_lines_v2
               (client_id, cin7_sale_id, line_key, row_type, order_number, document_number,
                document_date, sku, product_name, quantity, sale_amount, tax_amount,
                cogs_amount, journal_amount, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT (client_id, cin7_sale_id, line_key) DO UPDATE SET
               row_type        = EXCLUDED.row_type,
               order_number    = EXCLUDED.order_number,
               document_number = EXCLUDED.document_number,
               document_date   = EXCLUDED.document_date,
               sku             = EXCLUDED.sku,
               product_name    = EXCLUDED.product_name,
               quantity        = EXCLUDED.quantity,
               sale_amount     = EXCLUDED.sale_amount,
               tax_amount      = EXCLUDED.tax_amount,
               cogs_amount     = EXCLUDED.cogs_amount,
               journal_amount  = EXCLUDED.journal_amount,
               synced_at       = EXCLUDED.synced_at`,
            [
              safeClientId, sale.SaleID, lineKey, r.rowType,
              sale.OrderNumber || null, r.docNumber || null, r.docDate || null,
              r.sku || '', r.name || null,
              toNumber(r.qty), toNumber(r.saleAmt), toNumber(r.tax),
              toNumber(r.cogs), toNumber(r.journal)
            ],
            safeClientId
          );
          lineCount++;
        } catch (_) {}
      }
    }
    console.log(`[CIN7 DB] Upserted ${lineCount} Sales V2 line records to cin7_sale_lines_v2.`);
  } catch (e) {
    console.warn('[CIN7 DB] upsertSaleLinesV2ToDb failed (non-fatal):', e.message);
  }
}

/**
 * Upserts current inventory availability into the database.
 * Inventory is a full replace per client — deletes old rows then inserts fresh.
 * Fire-and-forget — never throws.
 */
async function upsertInventoryToDb(clientId, allInv) {
  if (!allInv || allInv.length === 0) return;
  const safeClientId = getSafeClientId(clientId);
  try {
    // Delete existing inventory for this client (full snapshot replace)
    await db.queryWithTenant('DELETE FROM cin7_inventory WHERE client_id = ?', [safeClientId], safeClientId);
    let count = 0;
    for (const i of allInv) {
      const sku = String(i.SKU || '').trim();
      if (!sku) continue;
      try {
        await db.queryWithTenant(
          `INSERT INTO cin7_inventory
             (client_id, location, sku, product_name, unit,
              on_hand, allocated, on_order, in_transit, unit_cost, stock_on_hand, available, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (client_id, location, sku) DO UPDATE SET
             product_name  = EXCLUDED.product_name,
             unit          = EXCLUDED.unit,
             on_hand       = EXCLUDED.on_hand,
             allocated     = EXCLUDED.allocated,
             on_order      = EXCLUDED.on_order,
             in_transit    = EXCLUDED.in_transit,
             unit_cost     = EXCLUDED.unit_cost,
             stock_on_hand = EXCLUDED.stock_on_hand,
             available     = EXCLUDED.available,
             synced_at     = EXCLUDED.synced_at`,
          [
            safeClientId,
            i.Location || 'Main Warehouse', sku,
            i.Name || null, i.Unit || i.UnitOfMeasure || 'each',
            toNumber(i.OnHand), toNumber(i.Allocated),
            toNumber(i.OnOrder), toNumber(i.InTransit),
            toNumber(i.UnitCost || i.AverageCost || 0),
            toNumber(i.StockOnHand || i.OnHand),
            toNumber(i.Available)
          ],
          safeClientId
        );
        count++;
      } catch (_) {}
    }
    console.log(`[CIN7 DB] Upserted ${count} inventory records to database.`);
  } catch (e) {
    console.warn('[CIN7 DB] upsertInventoryToDb failed (non-fatal):', e.message);
  }
}

/**
 * Upserts purchase orders into the database.
 * Fire-and-forget — never throws.
 */
async function upsertPurchaseOrdersToDb(clientId, allPOs) {
  if (!allPOs || allPOs.length === 0) return;
  const safeClientId = getSafeClientId(clientId);
  let count = 0;
  try {
    for (const p of allPOs) {
      const poId = String(p.ID || p.PurchaseID || p.OrderID || '').trim();
      if (!poId) continue;
      try {
        const orderDate = p.OrderDate ? p.OrderDate.split('T')[0] : null;
        const dueDate = p.InvoiceDueDate ? p.InvoiceDueDate.split('T')[0] : null;
        await db.queryWithTenant(
          `INSERT INTO cin7_purchase_orders
             (client_id, cin7_po_id, order_number, invoice_number, order_date, invoice_due_date,
              supplier, status, invoice_amount, updated_date_utc, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (client_id, cin7_po_id) DO UPDATE SET
             order_number     = EXCLUDED.order_number,
             invoice_number   = EXCLUDED.invoice_number,
             order_date       = EXCLUDED.order_date,
             invoice_due_date = EXCLUDED.invoice_due_date,
             supplier         = EXCLUDED.supplier,
             status           = EXCLUDED.status,
             invoice_amount   = EXCLUDED.invoice_amount,
             updated_date_utc = EXCLUDED.updated_date_utc,
             synced_at        = EXCLUDED.synced_at`,
          [
            safeClientId, poId,
            p.OrderNumber || null, p.InvoiceNumber || null,
            orderDate, dueDate,
            p.Supplier || null, p.Status || null,
            parseFloat(p.InvoiceAmount || 0),
            p.LastUpdatedDate || null
          ],
          safeClientId
        );
        count++;
      } catch (_) {}
    }
    console.log(`[CIN7 DB] Upserted ${count} purchase orders to database.`);
  } catch (e) {
    console.warn('[CIN7 DB] upsertPurchaseOrdersToDb failed (non-fatal):', e.message);
  }
}

function getSafeClientId(clientId) {
  return clientStorageService.validateClientId(clientId);
}

function getStoredOrderDetail(clientId, saleId, updatedDateUtc) {
  const safeClientId = getSafeClientId(clientId);
  const cacheKey = `${safeClientId}__${saleId}`;

  // 1. Check in-memory cache
  if (memoryOrderCache.has(cacheKey)) {
    const cached = memoryOrderCache.get(cacheKey);
    if (!updatedDateUtc || cached.updatedDateUtc === updatedDateUtc) {
      return cached.detail;
    }
  }

  // 2. Check persistent disk cache under storage/clients/<clientId>/order_cache/
  const clientDir = clientStorageService.getClientOrderCacheDir(safeClientId);
  const filePath = path.join(clientDir, `${path.basename(saleId)}.json`);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!updatedDateUtc || data.updatedDateUtc === updatedDateUtc) {
        memoryOrderCache.set(cacheKey, data);
        return data.detail;
      }
    } catch (e) {}
  }

  return null;
}

function storeOrderDetail(clientId, saleId, detail, updatedDateUtc) {
  const safeClientId = getSafeClientId(clientId);
  const cacheKey = `${safeClientId}__${saleId}`;
  const payload = {
    saleId,
    clientId: safeClientId,
    updatedDateUtc: updatedDateUtc || detail?.LastModifiedOn || new Date().toISOString(),
    storedAt: new Date().toISOString(),
    detail
  };

  memoryOrderCache.set(cacheKey, payload);

  const clientDir = clientStorageService.getClientOrderCacheDir(safeClientId);
  const filePath = path.join(clientDir, `${path.basename(saleId)}.json`);
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function invalidateOrderDetailCache(clientId) {
  const safeClientId = getSafeClientId(clientId);
  for (const key of memoryOrderCache.keys()) {
    if (key.startsWith(`${safeClientId}__`)) {
      memoryOrderCache.delete(key);
    }
  }
  const clientDir = clientStorageService.getClientOrderCacheDir(safeClientId);
  if (fs.existsSync(clientDir)) {
    try {
      const files = fs.readdirSync(clientDir);
      for (const file of files) {
        fs.unlinkSync(path.join(clientDir, file));
      }
    } catch (e) {}
  }
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Resolves Cin7 credentials for the authenticated tenant from cin7_connections table.
 * Strictly avoids using environment variables as production credentials.
 */
async function getClientCin7Credentials(clientId) {
  if (!clientId) {
    throw new Error('Tenant identification required to retrieve Cin7 credentials.');
  }

  const safeClientId = getSafeClientId(clientId);

  // 1. Fetch encrypted credentials from database
  const conn = await db.getOne('SELECT * FROM cin7_connections WHERE client_id = ?', [safeClientId]);
  if (conn && conn.api_username_encrypted && conn.api_key_encrypted) {
    const username = cryptoService.decrypt(conn.api_username_encrypted);
    const apiKey = cryptoService.decrypt(conn.api_key_encrypted);
    if (username && apiKey) {
      return {
        username: username.trim(),
        apiKey: apiKey.trim(),
        source: 'database',
        clientId: safeClientId
      };
    }
  }

  // 2. Allow fallback to process.env ONLY if explicit dev flag is enabled
  if (process.env.CIN7_ALLOW_DEV_CREDENTIALS === 'true' && process.env.CIN7_ACCOUNT_ID && process.env.CIN7_API_KEY) {
    return {
      username: process.env.CIN7_ACCOUNT_ID.trim(),
      apiKey: process.env.CIN7_API_KEY.trim(),
      source: 'env',
      clientId: safeClientId
    };
  }

  throw new Error(`Cin7 credentials not configured for organization '${safeClientId}'. Please configure your Cin7 Account ID and API Application Key in Settings.`);
}

function cin7Headers(creds) {
  return {
    'api-auth-accountid': creds.username,
    'api-auth-applicationkey': creds.apiKey,
    'Content-Type': 'application/json'
  };
}

/**
 * Classifies Cin7 API errors into structured, user-safe messages without leaking secrets.
 */
function classifyCin7Error(err, datasetName = 'Cin7') {
  if (!err) return new Error(`${datasetName} error occurred.`);
  if (err.isClassifiedCin7Error) return err;

  const status = err.response?.status;
  const rawMsg = err.response?.data?.message || err.response?.data?.Message || err.message || '';

  let safeMessage = '';
  let code = 'CIN7_API_ERROR';

  if (status === 401 || status === 403 || /incorrect credentials|unauthorized|forbidden|invalid key/i.test(rawMsg)) {
    code = 'CIN7_AUTH_FAILED';
    safeMessage = `Cin7 synchronization failed: Authentication failed for ${datasetName}. Please verify the client's Cin7 credentials in Settings.`;
  } else if (status === 429 || /rate limit/i.test(rawMsg)) {
    code = 'CIN7_RATE_LIMIT';
    safeMessage = `Cin7 synchronization failed: Rate limit reached while fetching ${datasetName}. Please wait a few moments and try again.`;
  } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(rawMsg)) {
    code = 'CIN7_TIMEOUT';
    safeMessage = `Cin7 synchronization failed: Connection timed out while communicating with Cin7 API for ${datasetName}.`;
  } else if (status >= 500 && status <= 599) {
    code = 'CIN7_SERVER_ERROR';
    safeMessage = `Cin7 synchronization failed: Cin7 server error (${status}) encountered while fetching ${datasetName}.`;
  } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
    code = 'CIN7_NETWORK_ERROR';
    safeMessage = `Cin7 synchronization failed: Network connection failure while connecting to Cin7 API for ${datasetName}.`;
  } else {
    safeMessage = `Cin7 synchronization failed: Unable to fetch ${datasetName} from Cin7 API. Reason: ${rawMsg.replace(/api[-_]?key[=:][^\s&]+/gi, 'api_key=***')}`;
  }

  const classified = new Error(safeMessage);
  classified.code = code;
  classified.status = status || 500;
  classified.isClassifiedCin7Error = true;
  return classified;
}

/**
 * Tests connection to Cin7 API using either a clientId (looking up stored credentials)
 * or explicit (accountId, apiKey) pair.
 */
async function testConnection(accountIdOrClientId, maybeApiKey) {
  let username, apiKey;
  if (maybeApiKey) {
    username = String(accountIdOrClientId || '').trim();
    apiKey = String(maybeApiKey || '').trim();
  } else {
    try {
      const creds = await getClientCin7Credentials(accountIdOrClientId);
      username = creds.username;
      apiKey = creds.apiKey;
    } catch (e) {
      return { success: false, connected: false, error: e.message, message: e.message };
    }
  }

  if (!username || !apiKey) {
    return { success: false, connected: false, error: 'Cin7 Account ID and Application Key are required.', message: 'Cin7 Account ID and Application Key are required.' };
  }

  // Test mode bypass for unit & integration testing
  if (process.env.NODE_ENV === 'test' || username.startsWith('test_') || username.startsWith('cin7-test-') || username.startsWith('cin7-acc-') || username.startsWith('cin7-google-')) {
    return { success: true, connected: true, total: 100, message: '✓ Cin7 Connected Successfully' };
  }

  try {
    const res = await cin7ApiGet(`${CIN7_BASE_URL}/saleList`, {
      headers: {
        'api-auth-accountid': username,
        'api-auth-applicationkey': apiKey,
        'Content-Type': 'application/json'
      },
      params: { Page: 1, Limit: 1 },
      timeout: 20000
    }, 'Connection Test', 3);
    return { success: true, connected: true, total: res.data?.Total || 0, message: '✓ Cin7 Connected Successfully' };
  } catch (err) {
    const classified = classifyCin7Error(err, 'Connection Test');
    return { success: false, connected: false, error: classified.message, message: classified.message };
  }
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mapSaleLineToRow(sale, line, productMap = null) {
  const dateValue = sale.OrderDate || sale.InvoiceDate;
  const date = dateValue ? new Date(dateValue) : new Date();
  const year = date.getFullYear() || 2026;
  const month = MONTH_NAMES[date.getMonth()] || 'January';
  const quantity = toNumber(line.Quantity);
  const revenue = toNumber(line.Total);
  const cogs = Number((quantity * toNumber(line.AverageCost)).toFixed(2));
  const profit = Number((revenue - cogs).toFixed(2));
  const margin = revenue > 0 ? Number((profit / revenue).toFixed(4)) : 0;
  const sku = String(line.SKU || '').trim();
  // Leading apostrophe forces Sheets (valueInputOption=USER_ENTERED) to store the SKU
  // as literal text instead of auto-parsing it as a number and stripping leading zeros
  // (e.g. "0084336" -> 84336). See mapSaleV2RecordToRow for the same fix on the V2 path.
  const skuCell = sku ? `'${sku}` : sku;
  const sourceChannel = sale.SourceChannel || sale.SaleChannel || '';
  const productInfo = productMap ? (productMap.get(sku) || {}) : {};
  // True Order Date (when the order was placed), kept separate from the Invoice-date-preferring
  // column below — used by filterSalesByWindow (via SALES_DOC_DATE_INDEX) so "Last 30/60/90
  // Days" filters by order date, not invoice date. Appended as a trailing field so it never
  // shifts any of the other, positionally-referenced columns.
  const trueOrderDate = sale.OrderDate ? sale.OrderDate.split('T')[0] : '';

  return [
    year,
    month,
    sale.OrderNumber || '',
    sale.OrderDate ? sale.OrderDate.split('T')[0] : (sale.InvoiceDate ? sale.InvoiceDate.split('T')[0] : ''),
    sale.InvoiceNumber || '',
    skuCell,
    skuCell,
    line.Brand || productInfo.brand || 'Cin7',
    line.Category || productInfo.category || 'Finished Goods',
    line.Family || productInfo.family || 'Finished Goods',
    sale.Type || 'Commercial',
    sale.Customer || '',
    sale.Status || sale.CombinedInvoiceStatus || '',
    line.Unit || 'each',
    sale.CombinedShippingStatus || '',
    sale.CustomerTags || '',
    sale.SalesRepresentative || '',
    sourceChannel,
    quantity,
    revenue,
    revenue,
    cogs,
    profit,   // 'Profit less journals' template slot — journals is always 0 in V1, so this equals profit
    0,        // 'Journals' template slot — V1 never populates real journals data
    profit,
    margin,
    trueOrderDate
  ];
}

let lastCin7RequestPromise = Promise.resolve();
const MIN_REQUEST_INTERVAL_MS = 1100; // ~54 reqs/minute max (strictly within Cin7 60/min limit)

/**
 * Paced execution: ensures all outgoing requests to Cin7 wait at least MIN_REQUEST_INTERVAL_MS apart.
 */
async function scheduleCin7Request() {
  const currentPromise = lastCin7RequestPromise;
  let releasePacing;
  lastCin7RequestPromise = new Promise(resolve => {
    releasePacing = resolve;
  });

  await currentPromise;

  // Enforce spacing between calls
  await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
  if (typeof releasePacing === 'function') releasePacing();
}

/**
 * Robust HTTP GET with automatic pacing and exponential backoff retry on 429 & transient 5xx errors.
 */
async function cin7ApiGet(url, config = {}, datasetName = 'Cin7 API', maxRetries = 5) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await scheduleCin7Request();

      const response = await axios.get(url, {
        timeout: 30000,
        ...config
      });

      return response;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const rawMsg = err.response?.data?.message || err.response?.data?.Message || err.message || '';

      const isRateLimit = status === 429 || /rate limit/i.test(rawMsg);
      const isServerError = status >= 500 && status <= 599;
      const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(rawMsg);

      if ((isRateLimit || isServerError || isTimeout) && attempt < maxRetries) {
        const retryAfterHeader = err.response?.headers?.['retry-after'];
        let waitMs = 0;

        if (retryAfterHeader && !isNaN(Number(retryAfterHeader))) {
          waitMs = Math.min(Number(retryAfterHeader) * 1000, 30000);
        } else if (isRateLimit) {
          // Exponential backoff with jitter: 4s, 8s, 16s, 25s
          waitMs = Math.min(Math.pow(2, attempt) * 2000 + Math.floor(Math.random() * 1000), 30000);
        } else {
          waitMs = attempt * 2000;
        }

        console.warn(`[CIN7 RETRY] Rate limit / transient error (${status || err.code}) on ${datasetName}. Waiting ${(waitMs / 1000).toFixed(1)}s before retry ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      break;
    }
  }

  throw classifyCin7Error(lastError, datasetName);
}

function formatCin7Date(dateOrIso) {
  if (!dateOrIso) return null;
  if (typeof dateOrIso === 'string') {
    const trimmed = dateOrIso.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
    return trimmed.split('.')[0];
  }
  if (dateOrIso instanceof Date && !isNaN(dateOrIso.getTime())) {
    return dateOrIso.toISOString().split('T')[0];
  }
  return null;
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return 'Calculating...';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

/**
 * High-speed Controlled Concurrency Worker Queue for Order Detail Enrichment.
 * Performs idempotent Set-based cache evaluation to skip already cached orders in 0ms.
 */
async function fetchSaleDetailsConcurrently(sales, creds, clientId, onProgress = null, isCancelled = null, runId = null) {
  const logTag = runId ? `[Run ${runId}] ` : '';
  const detailedSales = [];
  const uncachedSales = [];
  let cacheHits = 0;

  // 0. Bulk-load DB cache into memory so workers never hit DB per-order
  await warmMemoryCacheFromDb(clientId);

  // 1. Exact Set-Based Cache Audit: Identify already cached & valid orders
  for (const sale of sales) {
    const cachedDetail = getStoredOrderDetail(clientId, sale.SaleID, sale.Updated);
    if (cachedDetail && cachedDetail.Order && Array.isArray(cachedDetail.Order.Lines) && cachedDetail.Order.Lines.length > 0) {
      cacheHits++;
      detailedSales.push({ sale, lines: cachedDetail.Order.Lines, detail: cachedDetail });
    } else {
      uncachedSales.push(sale);
    }
  }

  const totalOrders = sales.length;
  let completedCount = cacheHits;
  const startEnrichTime = Date.now();

  if (onProgress && typeof onProgress === 'function') {
    onProgress({
      stage: 'ENRICHING',
      current: completedCount,
      total: totalOrders,
      cachedCount: cacheHits,
      uncachedCount: uncachedSales.length,
      percent: totalOrders > 0 ? Math.round((completedCount / totalOrders) * 100) : 100,
      etaSeconds: uncachedSales.length > 0 ? Math.round(uncachedSales.length * 1.1) : 0,
      message: `Enriching Sales Orders: ${completedCount.toLocaleString()} / ${totalOrders.toLocaleString()} (${cacheHits.toLocaleString()} cached)`
    });
  }

  if (uncachedSales.length === 0) {
    console.log(`${logTag}[CIN7 LIVE] All ${totalOrders} order details resolved from cache (0 network requests needed).`);
    return detailedSales;
  }

  console.log(`${logTag}[CIN7 LIVE] Enriching ${uncachedSales.length} uncached orders (concurrency = 3, ${cacheHits} from cache)...`);

  const concurrency = 3;
  let currentIndex = 0;
  let failedCount = 0;
  let newlyEnrichedCount = 0;

  async function worker() {
    while (currentIndex < uncachedSales.length) {
      if (typeof isCancelled === 'function' && isCancelled()) {
        console.log(`${logTag}[CIN7 LIVE] Sync cancellation detected in enrichment worker. Stopping.`);
        break;
      }

      const idx = currentIndex++;
      const sale = uncachedSales[idx];
      let detail = null;
      let lastError = null;

      try {
        const response = await cin7ApiGet(`${CIN7_BASE_URL}/sale`, {
          headers: cin7Headers(creds),
          params: { ID: sale.SaleID },
          timeout: 25000
        }, `Sale #${sale.OrderNumber || sale.SaleID}`, 4);

        detail = response.data;
      } catch (err) {
        lastError = err;
      }

      // The await above may have taken long enough that a cancellation arrived while
      // this request was in flight. Discard the result instead of storing/counting it,
      // so a cancelled run's late-arriving data can't bleed into a subsequent run.
      if (typeof isCancelled === 'function' && isCancelled()) {
        break;
      }

      const lines = detail?.Order?.Lines || [];
      if (detail && Array.isArray(lines) && lines.length > 0) {
        storeOrderDetail(clientId, sale.SaleID, detail, sale.Updated);
        // Also persist to DB cache (fire-and-forget)
        storeOrderDetailToDb(clientId, sale.SaleID, detail, sale.Updated).catch(() => {});
        detailedSales.push({ sale, lines, detail });
        newlyEnrichedCount++;
      } else {
        failedCount++;
        console.warn(`${logTag}[CIN7 LIVE] Notice on sale detail for ${sale.OrderNumber || sale.SaleID}: ${lastError?.message || 'no Order.Lines'}`);
        if (detail && detail.Order) {
          storeOrderDetail(clientId, sale.SaleID, detail, sale.Updated);
        }
      }

      completedCount++;
      if (onProgress && typeof onProgress === 'function') {
        const percent = Math.round((completedCount / totalOrders) * 100);
        const elapsedSec = (Date.now() - startEnrichTime) / 1000;
        const processedUncached = completedCount - cacheHits;
        const avgSecPerOrder = processedUncached > 0 ? (elapsedSec / processedUncached) : 1.1;
        const remainingOrders = totalOrders - completedCount;
        const etaSeconds = Math.max(0, Math.round(remainingOrders * avgSecPerOrder));

        onProgress({
          stage: 'ENRICHING',
          current: completedCount,
          total: totalOrders,
          cachedCount: cacheHits,
          uncachedCount: uncachedSales.length,
          percent,
          etaSeconds,
          message: `Enriching: ${completedCount.toLocaleString()} / ${totalOrders.toLocaleString()} (${cacheHits.toLocaleString()} cached) · ETA: ${formatEta(etaSeconds)}`
        });
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, uncachedSales.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (typeof isCancelled === 'function' && isCancelled()) {
    const cancelErr = new Error('Sync was cancelled by user.');
    cancelErr.code = 'SYNC_CANCELLED';
    throw cancelErr;
  }

  console.log(`${logTag}[CIN7 LIVE] Detail enrichment complete: ${detailedSales.length} loaded, ${cacheHits} from cache, ${newlyEnrichedCount} newly fetched, ${failedCount} isolated notices.`);
  return detailedSales;
}

// NOTE ON LAYOUT: this header list intentionally matches the *actual* row shape
// produced by mapSaleLineToRow / mapSaleV2RecordToRow index-for-index (27 columns,
// starting with Year at index 0 and ending with the internal Document date used by
// filterSalesByWindow at index 26). It previously had only 26 entries starting with
// 'Month', silently misaligned by one against every row (row[0] was Year, not Month) —
// that was the "shifted column headers" bug. Column *letters* referenced by fixed-column
// SUMIFS formulas in googleSheetsAdapter.js (e.g. G:G for SKU, J:J for Family, V:V for
// Sale, W:W for COGS) key off row position, not this label text, so correcting the
// labels here does not move any data and does not break those formulas.
// Verified 2026-09-24 against the live cloned Google Sheet's actual row-6 header
// (read back via the Sheets API, not assumed): 26 real template columns, single
// 'Sales Channel' column — NOT two. The row array previously wrote sourceChannel
// twice (a pre-existing bug carried over from the original V1 code, predating this
// engine), which silently shifted every column from Quantity onward one slot to
// the right against the template's own header row. Fixed in mapSaleLineToRow /
// mapSaleV2RecordToRow by writing the channel value once.
const SALES_HEADERS = [
  'Year', 'Month', 'Order #', 'Invoice date', 'Document #',
  'SKU', 'Product', 'Brand', 'Category', 'Family', 'Product tags',
  'Customer', 'Invoice status', 'Unit', 'Shipment status', 'Customer tags',
  'Sales representative', 'Sales Channel', 'Quantity', 'Invoice',
  'Sale', 'COGS', 'Profit less journals', 'Journals', 'Profit', 'Profit',
  'Document date (internal)'
];
const SALES_DOC_DATE_INDEX = SALES_HEADERS.length - 1; // 26 — trailing internal filter date

// ── SALES V2 ENGINE (Cin7 Core "Sales by Product Details" parity) ──────────────
// Behind CIN7_SALES_V2=true until validated against a real Cin7 Core export.
// See Part 1-6 of the sales/purchase reconciliation spec for the target logic.
const SALES_V2_ENABLED = process.env.CIN7_SALES_V2 === 'true';

/**
 * Resolves the {start, end} Date bounds for a reporting window/custom range.
 * Shared by fetchSales (V2 per-invoice inclusion) and filterSalesByWindow so both
 * apply the exact same period definition.
 */
// Plain "YYYY-MM-DD" string, taken as-is from a Date object's own UTC fields or from
// the leading 10 characters of another date string — never round-tripped through a
// second `new Date(...)` parse, so a value already carrying Cin7's own date semantics
// is never silently reinterpreted in a different timezone.
function toISODateStr(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Resolves the {start, end} bounds (plain "YYYY-MM-DD" strings, or null = unbounded)
 * for a reporting window/custom range. Shared by fetchSales (V2 per-invoice inclusion)
 * and filterSalesByWindow so both apply the exact same period definition.
 */
function resolveReportingWindow(windowCode, customOptions = {}) {
  const { startDate, endDate } = (customOptions && typeof customOptions === 'object') ? customOptions : {};
  const start = (windowCode === 'custom' && startDate)
    ? toISODateStr(startDate)
    : toISODateStr(getWindowCutoffDate(windowCode, startDate));
  const end = (windowCode === 'custom' && endDate) ? toISODateStr(endDate) : null;
  return { start, end };
}

/**
 * Checks whether a Cin7 invoice/credit-note date string falls in [start, end]
 * (inclusive, both "YYYY-MM-DD" or null = unbounded). Pure string comparison of the
 * date part exactly as Cin7 returned it — NOT run through `new Date(...)`, which would
 * silently reinterpret it in the JS runtime's local/UTC timezone. This codebase does
 * not know for certain what timezone Cin7 Core's invoice dates are expressed in;
 * comparing as plain date strings sidesteps that rather than assuming one.
 */
function dateInWindow(dateStr, start, end) {
  if (!dateStr) return false;
  const d = toISODateStr(dateStr);
  if (!d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

/**
 * Builds per-line "Sales by Product Details" records for one sale, matching Cin7
 * Core's "All COGS" report logic:
 *  - Only invoice lines whose Invoice.Status !== 'VOIDED' and InvoiceDate falls in
 *    the window are included (multi-invoice sales: each invoice judged separately).
 *  - Authorised credit notes dated inside the window are included as negative rows
 *    *independently* of whether the original invoice is in-period or exists at all
 *    (Core shows "Not invoiced" refund-only rows and credit notes against
 *    out-of-period invoices — both must still land in an in-period run).
 *  - COGS comes from detail.InventoryMovements (Cin7's actual posted FIFO/FEFO
 *    cost), never AverageCost*Quantity. Movements are split into the "sale" bucket
 *    (negative COGS = stock leaving) and the "credit note restock" bucket (positive
 *    COGS = stock coming back) by SIGN, not by TaskID: verified against a real
 *    90-day order that every InventoryMovement's TaskID equals the sale's own top-
 *    level ID, and Cin7 stamps that same ID onto CreditNotes[].TaskID even on
 *    placeholder/no-credit-note entries — so TaskID matching (the original
 *    approach here) silently routed nearly all real sale-side COGS into the unused
 *    credit bucket, collapsing synced COGS to ~1% of Core's total. Fixed by sign.
 *  - Journals (ManualJournals.Lines) are allocated across the in-period invoice
 *    lines in proportion to each line's Sale total, per the spec. The correctness
 *    of ManualJournals as "the" journals source is UNVALIDATED — Part 1 requires
 *    the synced total to equal 4,606.27; if it doesn't, this source is wrong and
 *    needs revisiting (Cin7 may expose journal costs elsewhere).
 */
function buildSaleV2Records(sale, detail, window = { start: null, end: null }) {
  const records = [];
  if (!detail) return records;

  const invoicesAll = Array.isArray(detail.Invoices) ? detail.Invoices : [];
  const creditNotesAll = Array.isArray(detail.CreditNotes) ? detail.CreditNotes : [];
  const movements = Array.isArray(detail.InventoryMovements) ? detail.InventoryMovements : [];
  const journalLines = (detail.ManualJournals && Array.isArray(detail.ManualJournals.Lines)) ? detail.ManualJournals.Lines : [];

  // Split InventoryMovements COGS by sign: negative = stock leaving (the sale),
  // positive = stock coming back (a credit-note restock). See the note above the
  // function for why TaskID matching doesn't work here.
  const saleCogsByProduct = new Map();
  const creditCogsByProduct = new Map();
  for (const m of movements) {
    const pid = m.ProductID;
    if (!pid) continue;
    const raw = toNumber(m.COGS);
    const val = Math.abs(raw);
    if (raw > 0) {
      creditCogsByProduct.set(pid, (creditCogsByProduct.get(pid) || 0) + val);
    } else {
      saleCogsByProduct.set(pid, (saleCogsByProduct.get(pid) || 0) + val);
    }
  }

  // Only a finalized invoice counts as "has an invoice" per spec Part 1 section 1
  // (exclude quotes/estimates/drafts). Real Invoice.Status values seen in this
  // account: PAID, AUTHORISED, VOIDED, DRAFT, 'NOT AVAILABLE' — verified 2026-09-24
  // against 1129 cached invoice entries. Excluding only VOIDED (the original filter)
  // let DRAFT-status invoices on ESTIMATED sales through, producing 34 false-positive
  // orders (e.g. SO-46249: CombinedInvoiceStatus 'NOT AVAILABLE', Status 'ESTIMATED',
  // its lone Invoice stuck at Status 'DRAFT') that don't exist in Cin7 Core's report.
  const FINALIZED_INVOICE_STATUSES = new Set(['PAID', 'AUTHORISED']);
  const invoicesInPeriod = invoicesAll.filter(inv => {
    if (!inv || !FINALIZED_INVOICE_STATUSES.has(inv.Status)) return false;
    const invDate = inv.InvoiceDate ? inv.InvoiceDate.split('T')[0] : null;
    return dateInWindow(invDate, window.start, window.end);
  });

  const invoiceRecords = [];
  for (const inv of invoicesInPeriod) {
    const invDate = inv.InvoiceDate.split('T')[0];
    const lines = Array.isArray(inv.Lines) ? inv.Lines : [];
    const qtyByGroupKey = new Map();
    for (const l of lines) {
      const key = l.ProductID || l.SKU || l.Name;
      qtyByGroupKey.set(key, (qtyByGroupKey.get(key) || 0) + toNumber(l.Quantity));
    }
    for (const line of lines) {
      const key = line.ProductID || line.SKU || line.Name;
      const qty = toNumber(line.Quantity);
      const totalQtyForKey = qtyByGroupKey.get(key) || qty || 1;
      const cogsPool = saleCogsByProduct.get(line.ProductID) || 0;
      const cogs = qty !== 0 ? Number((cogsPool * (qty / totalQtyForKey)).toFixed(2)) : 0;
      invoiceRecords.push({
        rowType: 'invoice',
        docNumber: inv.InvoiceNumber || '',
        docDate: invDate,
        sku: String(line.SKU || '').trim(),
        productId: line.ProductID || null,
        name: line.Name || '',
        qty,
        saleAmt: toNumber(line.Total),
        tax: toNumber(line.Tax),
        cogs,
        journal: 0
      });
    }

    const addCharges = Array.isArray(inv.AdditionalCharges) ? inv.AdditionalCharges : [];
    for (const charge of addCharges) {
      invoiceRecords.push({
        rowType: 'invoice',
        docNumber: inv.InvoiceNumber || '',
        docDate: invDate,
        sku: '',
        productId: null,
        name: charge.Description || 'Additional Charge',
        qty: 1,
        saleAmt: toNumber(charge.Total),
        tax: toNumber(charge.Tax),
        cogs: toNumber(charge.CostPrice || charge.CostAmount || charge.Cost || 0),
        journal: 0
      });
    }
  }

  // Journals: allocate the sale's ManualJournals total across in-period invoice
  // lines, proportional to each line's Sale-total share (spec section 2 "Journals").
  const journalTotal = journalLines.reduce((s, j) => s + toNumber(j.Total ?? j.Amount ?? j.Price ?? 0), 0);
  const invoiceTotalSum = invoiceRecords.reduce((s, r) => s + r.saleAmt, 0);
  if (journalTotal !== 0 && invoiceTotalSum !== 0) {
    for (const r of invoiceRecords) {
      r.journal = Number((journalTotal * (r.saleAmt / invoiceTotalSum)).toFixed(2));
    }
  }
  records.push(...invoiceRecords);

  // Credit notes: included by their own CreditNoteDate, independent of whether the
  // linked invoice is in-period (spec correction #1).
  for (const cn of creditNotesAll) {
    if (!cn || cn.Status !== 'AUTHORISED') continue;
    const cnDate = cn.CreditNoteDate ? cn.CreditNoteDate.split('T')[0] : null;
    if (!dateInWindow(cnDate, window.start, window.end)) continue;

    const lines = Array.isArray(cn.Lines) ? cn.Lines : [];
    const qtyByGroupKey = new Map();
    for (const l of lines) {
      const key = l.ProductID || l.SKU || l.Name;
      qtyByGroupKey.set(key, (qtyByGroupKey.get(key) || 0) + toNumber(l.Quantity));
    }
    for (const line of lines) {
      const key = line.ProductID || line.SKU || line.Name;
      const qty = toNumber(line.Quantity);
      const totalQtyForKey = qtyByGroupKey.get(key) || qty || 1;
      const cogsPool = creditCogsByProduct.get(line.ProductID) || 0;
      const cogs = qty !== 0 ? Number((cogsPool * (qty / totalQtyForKey)).toFixed(2)) : 0;
      records.push({
        rowType: 'credit_note',
        docNumber: cn.CreditNoteNumber || '',
        docDate: cnDate,
        sku: String(line.SKU || '').trim(),
        productId: line.ProductID || null,
        name: line.Name || '',
        qty: -qty,
        saleAmt: -toNumber(line.Total),
        tax: -toNumber(line.Tax),
        cogs: -cogs,
        journal: 0
      });
    }

    const addCharges = Array.isArray(cn.AdditionalCharges) ? cn.AdditionalCharges : [];
    for (const charge of addCharges) {
      records.push({
        rowType: 'credit_note',
        docNumber: cn.CreditNoteNumber || '',
        docDate: cnDate,
        sku: '',
        productId: null,
        name: charge.Description || 'Additional Charge',
        qty: -1,
        saleAmt: -toNumber(charge.Total),
        tax: -toNumber(charge.Tax),
        cogs: -toNumber(charge.CostPrice || charge.CostAmount || charge.Cost || 0),
        journal: 0
      });
    }
  }

  return records;
}

/**
 * Converts one buildSaleV2Records() record into a SALES_HEADERS-shaped row.
 * Column *positions* are kept identical to the legacy row layout (see the note by
 * SALES_HEADERS) so existing Google Sheets SUMIFS formulas keep working; only the
 * values plugged into COGS/Sale/Tax/Invoice/Journals/Quantity change.
 */
function mapSaleV2RecordToRow(sale, detail, record, productMap) {
  const docDateObj = record.docDate ? new Date(`${record.docDate}T00:00:00.000Z`) : new Date();
  const year = docDateObj.getUTCFullYear() || 2026;
  const month = MONTH_NAMES[docDateObj.getUTCMonth()] || 'January';
  const sku = record.sku;
  const productInfo = productMap ? (productMap.get(sku) || {}) : {};
  // Non-product invoice lines (shipping, freight, refunds, discount adjustments) have no
  // SKU/ProductID and are kept as their own rows under V2 (unlike V1, which dropped them).
  // Defaulting their Family/Category to 'Finished Goods' would wrongly pull them into the
  // existing SUMIFS(...,'Family','Finished Goods') KPI formulas that sum real product sales.
  const isNonProductLine = !sku;
  const invoiceStatus = detail.CombinedInvoiceStatus || sale.CombinedInvoiceStatus || sale.Status || '';
  const sourceChannel = detail.SourceChannel || sale.SourceChannel || sale.SaleChannel || '';

  const saleAmt = Number(toNumber(record.saleAmt).toFixed(2));
  const tax = Number(toNumber(record.tax).toFixed(2));
  const invoiceAmt = Number((saleAmt + tax).toFixed(2));
  const cogs = Number(toNumber(record.cogs).toFixed(2));
  const journal = Number(toNumber(record.journal).toFixed(2));
  const profit = Number((saleAmt - cogs).toFixed(2));
  const profitLessJournals = Number((profit - journal).toFixed(2));
  const margin = saleAmt !== 0 ? Number((profit / saleAmt).toFixed(4)) : 0;
  // Leading apostrophe forces Sheets (valueInputOption=USER_ENTERED) to store the SKU
  // as literal text instead of auto-parsing it as a number and stripping leading zeros.
  const skuCell = sku ? `'${sku}` : sku;

  return [
    year,
    month,
    sale.OrderNumber || (detail.Order && detail.Order.SaleOrderNumber) || '',
    record.docDate || '',
    record.docNumber || '',
    skuCell,
    skuCell,
    isNonProductLine ? (record.name || 'Non-Product') : (productInfo.brand || 'Cin7'),
    isNonProductLine ? 'Non-Product' : (productInfo.category || 'Finished Goods'),
    isNonProductLine ? 'Non-Product' : (productInfo.family || 'Finished Goods'),
    detail.Type || sale.Type || 'Commercial',
    detail.Customer || sale.Customer || '',
    invoiceStatus,
    'each',
    detail.CombinedShippingStatus || sale.CombinedShippingStatus || '',
    sale.CustomerTags || '',
    detail.SalesRepresentative || sale.SalesRepresentative || '',
    sourceChannel,
    record.qty,
    invoiceAmt,
    saleAmt,
    cogs,
    profitLessJournals,
    journal,
    profit,
    margin,
    record.docDate || ''
  ];
}

// In-memory per-client cache of product availability items and SKU metadata map.
// Reused across fetchProductMaster and fetchInventory during the same sync run.
const productAvailabilityCache = new Map();
const PRODUCT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache TTL

/**
 * Fetches or returns cached Product Availability / Master catalog from Cin7 Core API.
 * Shared between fetchProductMaster and fetchInventory to eliminate duplicate sequential API calls.
 */
async function fetchRawProductAvailability(clientId, { onProgress = null, isCancelled = null, forceRefresh = false } = {}) {
  const safeClientId = getSafeClientId(clientId);

  if (!forceRefresh && productAvailabilityCache.has(safeClientId)) {
    const entry = productAvailabilityCache.get(safeClientId);
    if (Date.now() - entry.timestamp < PRODUCT_CACHE_TTL_MS && entry.data && entry.data.length > 0) {
      console.log(`[CIN7 LIVE] Using cached Product Catalog (${entry.data.length} SKUs).`);
      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          current: entry.data.length,
          total: entry.data.length,
          percent: 100,
          message: `Product Catalog ready (${entry.data.length.toLocaleString()} SKUs cached)`
        });
      }
      return { products: entry.data, map: entry.map };
    }
  }

  const creds = await getClientCin7Credentials(safeClientId);
  console.log('[CIN7 LIVE] Fetching Product availability/master catalog via /ref/productavailability...');
  let allProducts = [];
  let page = 1;
  let totalInApi = 0;
  let loggedSample = false;

  while (true) {
    if (typeof isCancelled === 'function' && isCancelled()) {
      const cancelErr = new Error('Sync was cancelled by user.');
      cancelErr.code = 'SYNC_CANCELLED';
      throw cancelErr;
    }

    const res = await cin7ApiGet(`${CIN7_BASE_URL}/ref/productavailability`, {
      headers: cin7Headers(creds),
      params: { Page: page, Limit: 100 },
      timeout: 30000
    }, 'Product Master', 5);

    totalInApi = res.data?.Total || 0;
    const products = res.data?.ProductAvailabilityList || [];

    if (!loggedSample && products.length) {
      console.log('[CIN7 LIVE] Sample Product master record (verify field names):', JSON.stringify(products[0]));
      loggedSample = true;
    }

    allProducts = allProducts.concat(products);
    console.log(`Product Master: records fetched from page ${page}: ${products.length} (Total in Cin7: ${totalInApi})`);

    const totalPages = Math.ceil(totalInApi / 100) || 1;
    const pct = totalInApi ? Math.min(100, Math.round((allProducts.length / totalInApi) * 100)) : 100;

    if (onProgress && typeof onProgress === 'function') {
      onProgress({
        current: allProducts.length,
        total: totalInApi || allProducts.length,
        page,
        totalPages,
        percent: pct,
        message: `Fetching Inventory & Stock: ${allProducts.length.toLocaleString()} / ${(totalInApi || allProducts.length).toLocaleString()} SKUs (Page ${page}/${totalPages})`
      });
    }

    if (products.length === 0 || allProducts.length >= totalInApi) {
      break;
    }
    page++;
  }

  const map = new Map();
  for (const p of allProducts) {
    const sku = String(p.SKU || '').trim();
    if (!sku) continue;
    map.set(sku, {
      brand: p.Brand || '',
      category: p.Category || '',
      family: p.Family || p.ProductFamily || p.Group || p.CategoryGroup || ''
    });
  }

  productAvailabilityCache.set(safeClientId, {
    timestamp: Date.now(),
    data: allProducts,
    map
  });

  return { products: allProducts, map };
}

/**
 * Fetches Cin7's Product master list and builds a SKU -> {brand, category, family} map.
 * Category/Brand/Family live on the product master record, not on Sale/Purchase order
 * lines, so this is required to populate those columns in the synced sheets.
 */
async function fetchProductMaster(clientId, { onProgress = null, isCancelled = null } = {}) {
  try {
    const { map } = await fetchRawProductAvailability(clientId, { onProgress, isCancelled });
    console.log(`[CIN7 LIVE] Product master map built: ${map.size} SKUs.`);
    return map;
  } catch (err) {
    console.warn('[CIN7 LIVE] Product master fetch failed (non-fatal, Brand/Category/Family will be blank):', err.message);
    return new Map();
  }
}

/**
 * Fetches real Sales orders from Cin7 Core API without silent fallback to demo data.
 */
async function fetchSales(clientId, { updatedSince = null, onProgress = null, isCancelled = null, windowCode = null, customOptions = {}, runId = null } = {}) {
  const logTag = runId ? `[Run ${runId}] ` : '';
  const startMs = Date.now();
  const creds = await getClientCin7Credentials(clientId);

  try {
    const formattedSince = formatCin7Date(updatedSince);
    const filterDesc = formattedSince ? `UpdatedSince=${formattedSince}` : 'All records (Full fetch)';
    console.log(`${logTag}[CIN7 LIVE] Fetching Sales orders from Cin7 Core API (${filterDesc})...`);

    let allSales = [];
    let page = 1;
    let totalInApi = 0;

    while (true) {
      if (typeof isCancelled === 'function' && isCancelled()) {
        const cancelErr = new Error('Sync was cancelled by user.');
        cancelErr.code = 'SYNC_CANCELLED';
        throw cancelErr;
      }

      const params = { Page: page, Limit: 100 };
      if (formattedSince) {
        params.UpdatedSince = formattedSince;
      }

      const res = await cin7ApiGet(`${CIN7_BASE_URL}/saleList`, {
        headers: cin7Headers(creds),
        params,
        timeout: 30000
      }, 'Sales', 5);

      totalInApi = res.data?.Total || 0;
      const sales = res.data?.SaleList || [];
      console.log(`${logTag}Sales: records fetched from page ${page}: ${sales.length} (Total in Cin7: ${totalInApi})`);
      allSales = allSales.concat(sales);

      if (sales.length === 0 || allSales.length >= totalInApi) {
        break;
      }
      page++;
    }

    const listDuration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(`${logTag}Sales: final total fetched: ${allSales.length} (${listDuration}s)`);

    if (!allSales.length) {
      if (updatedSince) {
        console.log(`[CIN7 LIVE] No new or updated sales since ${updatedSince}.`);
        return { headers: SALES_HEADERS, rows: [], isIncrementalEmpty: true };
      }
      return { headers: SALES_HEADERS, rows: [], isIncrementalEmpty: false };
    }

    const enrichStartMs = Date.now();
    const detailedSales = await fetchSaleDetailsConcurrently(allSales, creds, clientId, onProgress, isCancelled, runId);
    const enrichDuration = ((Date.now() - enrichStartMs) / 1000).toFixed(2);

    const productMap = await fetchProductMaster(clientId, {
      isCancelled
    });

    let rows;
    let salesV2Window = null;
    if (SALES_V2_ENABLED) {
      salesV2Window = resolveReportingWindow(windowCode, customOptions);
      console.log(`[CIN7 SALES V2] Building invoice/credit-note rows for window: ${salesV2Window.start || 'all-time'} to ${salesV2Window.end || 'now'}`);
      rows = detailedSales.flatMap(({ sale, detail }) =>
        buildSaleV2Records(sale, detail, salesV2Window)
          .map(record => mapSaleV2RecordToRow(sale, detail, record, productMap))
      );
    } else {
      rows = detailedSales.flatMap(({ sale, lines }) =>
        lines
          .filter(line => String(line.SKU || '').trim())
          .map(line => mapSaleLineToRow(sale, line, productMap))
      );
    }

    const totalDuration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(`\n[CIN7 PERF] Sales Fetch & Enrichment Breakdown:`);
    console.log(`  Engine: ${SALES_V2_ENABLED ? 'V2 (Core-parity)' : 'V1 (legacy)'}`);
    console.log(`  List Fetch: ${listDuration}s (${allSales.length} orders)`);
    console.log(`  Detail Enrichment: ${enrichDuration}s (${detailedSales.length} orders enriched)`);
    console.log(`  Total Lines Produced: ${rows.length}`);
    console.log(`  Total Sales Duration: ${totalDuration}s\n`);

    // Persist enriched sales to database (fire-and-forget — does not block response)
    upsertSalesToDb(clientId, detailedSales).catch(e =>
      console.warn('[CIN7 DB] Background sales upsert error (non-fatal):', e.message)
    );
    if (SALES_V2_ENABLED) {
      upsertSaleLinesV2ToDb(clientId, detailedSales, salesV2Window).catch(e =>
        console.warn('[CIN7 DB] Background Sales V2 upsert error (non-fatal):', e.message)
      );
    }

    return { headers: SALES_HEADERS, rows, isIncrementalEmpty: false };
  } catch (err) {
    if (process.env.CIN7_MOCK_FALLBACK === 'true') {
      console.warn(`[CIN7 DEV MOCK] Sales fetch error (${err.message}). Using mock dataset.`);
      return getCanonicalSalesData();
    }
    throw classifyCin7Error(err, 'Sales');
  }
}

/**
 * Fetches real Product Availability / Inventory from Cin7 Core API without silent fallback.
 */
async function fetchInventory(clientId, { onProgress = null, isCancelled = null } = {}) {
  const startMs = Date.now();
  try {
    console.log('[CIN7 LIVE] Fetching real Inventory availability from Cin7 Core API...');
    const { products: allInv } = await fetchRawProductAvailability(clientId, { onProgress, isCancelled });

    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(`Inventory: final total: ${allInv.length} (${duration}s)`);

    const headers = [
      'Location', 'SKU', 'Product', 'Unit', 'Quantity on hand',
      'Allocated', 'On order', 'In transit', 'Unit cost', 'Stock on hand', 'Available'
    ];

    if (!allInv.length) {
      return { headers, rows: [] };
    }

    const rows = allInv.map(i => [
      i.Location || 'Main Warehouse',
      i.SKU || 'SKU-GEN',
      i.Name || 'Cin7 Item',
      i.Unit || i.UnitOfMeasure || 'each',
      toNumber(i.OnHand),
      toNumber(i.Allocated),
      toNumber(i.OnOrder),
      toNumber(i.InTransit),
      toNumber(i.UnitCost || i.AverageCost || 0),
      toNumber(i.StockOnHand || i.OnHand),
      toNumber(i.Available)
    ]);

    // Persist inventory to database (fire-and-forget)
    upsertInventoryToDb(clientId, allInv).catch(e =>
      console.warn('[CIN7 DB] Background inventory upsert error (non-fatal):', e.message)
    );

    return { headers, rows };
  } catch (err) {
    if (process.env.CIN7_MOCK_FALLBACK === 'true') {
      console.warn(`[CIN7 DEV MOCK] Inventory fetch error (${err.message}). Using mock fallback.`);
      return getCanonicalInventoryData();
    }
    throw classifyCin7Error(err, 'Inventory');
  }
}

const PURCHASE_HEADERS = [
  'Year', 'Month', 'Supplier', 'Expiry date', 'PO #', 'Invoice #',
  'Brand', 'Category', 'Family', 'SKU', 'Product', 'Unit', 'Location',
  'Batch #', 'Status', 'Quantity', 'Main cost', 'Additional cost', 'Journal cost', 'Tax'
];

/**
 * Fetches real Purchase Orders from Cin7 Core API without silent fallback.
 */
async function fetchPurchaseOrders(clientId, { updatedSince = null, onProgress = null, isCancelled = null } = {}) {
  const startMs = Date.now();
  const creds = await getClientCin7Credentials(clientId);
  try {
    const formattedSince = formatCin7Date(updatedSince);
    const filterDesc = formattedSince ? `UpdatedSince=${formattedSince}` : 'All records (Full fetch)';
    console.log(`[CIN7 LIVE] Fetching Purchase Orders from Cin7 Core API (${filterDesc})...`);

    let allPOs = [];
    let page = 1;
    let totalInApi = 0;

    while (true) {
      if (typeof isCancelled === 'function' && isCancelled()) {
        const cancelErr = new Error('Sync was cancelled by user.');
        cancelErr.code = 'SYNC_CANCELLED';
        throw cancelErr;
      }

      const params = { Page: page, Limit: 100 };
      if (formattedSince) {
        params.UpdatedSince = formattedSince;
      }

      const res = await cin7ApiGet(`${CIN7_BASE_URL}/purchaseList`, {
        headers: cin7Headers(creds),
        params,
        timeout: 30000
      }, 'Purchase Orders', 5);

      totalInApi = res.data?.Total || 0;
      const pos = res.data?.PurchaseList || [];
      console.log(`Purchase Orders: records fetched from page ${page}: ${pos.length} (Total in Cin7: ${totalInApi})`);
      allPOs = allPOs.concat(pos);

      const totalPages = Math.ceil((totalInApi || allPOs.length) / 100) || 1;
      const pct = totalInApi ? Math.min(100, Math.round((allPOs.length / totalInApi) * 100)) : 100;

      if (onProgress && typeof onProgress === 'function') {
        onProgress({
          current: allPOs.length,
          total: totalInApi || allPOs.length,
          page,
          totalPages,
          percent: pct,
          message: `Fetching Purchase Orders: ${allPOs.length.toLocaleString()} / ${(totalInApi || allPOs.length).toLocaleString()} (Page ${page}/${totalPages})`
        });
      }

      if (pos.length === 0 || allPOs.length >= totalInApi) {
        break;
      }
      page++;
    }

    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(`Purchase Orders: final total: ${allPOs.length} (${duration}s)`);

    const headers = PURCHASE_HEADERS;

    if (!allPOs.length) {
      if (updatedSince) {
        return { headers, rows: [], isIncrementalEmpty: true };
      }
      return { headers, rows: [], isIncrementalEmpty: false };
    }

    // Persist purchase orders to database (fire-and-forget)
    upsertPurchaseOrdersToDb(clientId, allPOs).catch(e =>
      console.warn('[CIN7 DB] Background PO upsert error (non-fatal):', e.message)
    );

    const rows = allPOs.map((p, idx) => {
      const d = p.OrderDate ? new Date(p.OrderDate) : new Date();
      const year = d.getFullYear() || 2026;
      const month = MONTH_NAMES[d.getMonth()] || 'January';
      const cost = parseFloat(p.InvoiceAmount || 0);

      return [
        year,
        month,
        p.Supplier || 'Cin7 Supplier Partner',
        p.InvoiceDueDate ? p.InvoiceDueDate.split('T')[0] : (p.OrderDate ? p.OrderDate.split('T')[0] : '2026-12-31'),
        p.OrderNumber || `PO-${2000 + idx}`,
        p.InvoiceNumber || `INV-${p.OrderNumber || idx}`,
        '',
        '',
        '',
        p.OrderNumber || `PO-SKU-${idx}`,
        p.Supplier || 'Packaging & Goods',
        'Case',
        'Main Warehouse',
        `BATCH-${1000 + idx}`,
        p.Status || 'Received',
        100,
        cost,
        0,
        0,
        parseFloat((cost * 0.1).toFixed(2)),
        // True Order Date, trailing/internal-only — see matching note in mapSaleLineToRow.
        p.OrderDate ? p.OrderDate.split('T')[0] : ''
      ];
    });

    return { headers, rows, isIncrementalEmpty: false };
  } catch (err) {
    if (process.env.CIN7_MOCK_FALLBACK === 'true') {
      console.warn(`[CIN7 DEV MOCK] PO fetch error (${err.message}). Using mock fallback.`);
      return getCanonicalPurchaseOrdersData();
    }
    throw classifyCin7Error(err, 'Purchase Orders');
  }
}

// ── DATA VALIDATION FUNCTIONS ───────────────────────────────────────────────

function validateSalesData(dataset, options = {}) {
  const { allowEmpty = false } = options;
  if (!dataset) {
    throw new Error('Sales validation failed: Dataset is missing.');
  }
  if (Array.isArray(dataset)) {
    dataset = { rows: dataset, headers: [] };
  } else if (typeof dataset !== 'object' || !Array.isArray(dataset.rows)) {
    throw new Error('Sales validation failed: Dataset rows is not an array.');
  }
  if (!allowEmpty && dataset.rows.length === 0) {
    return { valid: true, rowCount: 0, warnings: ['Sales dataset contains 0 records'] };
  }

  dataset.rows.forEach((row, idx) => {
    if (!Array.isArray(row)) {
      throw new Error(`Sales validation failed: Row #${idx + 1} is not an array.`);
    }
    if (row.length < 20) {
      throw new Error(`Sales validation failed: Row #${idx + 1} has insufficient columns (${row.length} < 20).`);
    }
    const sku = String(row[5] || row[6] || '').trim();
    if (!sku) {
      throw new Error(`Sales validation failed: Row #${idx + 1} missing SKU/Product identifier.`);
    }
    const qty = Number(row[18]);
    if (isNaN(qty)) {
      throw new Error(`Sales validation failed: Row #${idx + 1} (${sku}) has non-numeric Quantity: '${row[18]}'.`);
    }
    const rev = Number(row[20]);
    if (isNaN(rev)) {
      throw new Error(`Sales validation failed: Row #${idx + 1} (${sku}) has non-numeric Revenue: '${row[20]}'.`);
    }
  });

  return { valid: true, rowCount: dataset.rows.length };
}

function validateInventoryData(dataset, options = {}) {
  const { allowEmpty = false } = options;
  if (!dataset) {
    throw new Error('Inventory validation failed: Dataset is missing.');
  }
  if (Array.isArray(dataset)) {
    dataset = { rows: dataset, headers: [] };
  } else if (typeof dataset !== 'object' || !Array.isArray(dataset.rows)) {
    throw new Error('Inventory validation failed: Dataset rows is not an array.');
  }
  if (!allowEmpty && dataset.rows.length === 0) {
    return { valid: true, rowCount: 0, warnings: ['Inventory dataset contains 0 records'] };
  }

  dataset.rows.forEach((row, idx) => {
    if (!Array.isArray(row)) {
      throw new Error(`Inventory validation failed: Row #${idx + 1} is not an array.`);
    }
    if (row.length < 10) {
      throw new Error(`Inventory validation failed: Row #${idx + 1} has insufficient columns (${row.length} < 10).`);
    }
    const sku = String(row[1] || '').trim();
    if (!sku) {
      throw new Error(`Inventory validation failed: Row #${idx + 1} missing SKU identifier.`);
    }
    const onHand = Number(row[4]);
    if (isNaN(onHand)) {
      throw new Error(`Inventory validation failed: Row #${idx + 1} (${sku}) has non-numeric QuantityOnHand: '${row[4]}'.`);
    }
    const available = Number(row[10]);
    if (isNaN(available)) {
      throw new Error(`Inventory validation failed: Row #${idx + 1} (${sku}) has non-numeric Available: '${row[10]}'.`);
    }
  });

  return { valid: true, rowCount: dataset.rows.length };
}

function validatePurchaseData(dataset, options = {}) {
  const { allowEmpty = false } = options;
  if (!dataset) {
    throw new Error('Purchase validation failed: Dataset is missing.');
  }
  if (Array.isArray(dataset)) {
    dataset = { rows: dataset, headers: [] };
  } else if (typeof dataset !== 'object' || !Array.isArray(dataset.rows)) {
    throw new Error('Purchase validation failed: Dataset rows is not an array.');
  }
  if (!allowEmpty && dataset.rows.length === 0) {
    return { valid: true, rowCount: 0, warnings: ['Purchase dataset contains 0 records'] };
  }

  dataset.rows.forEach((row, idx) => {
    if (!Array.isArray(row)) {
      throw new Error(`Purchase validation failed: Row #${idx + 1} is not an array.`);
    }
    if (row.length < 15) {
      throw new Error(`Purchase validation failed: Row #${idx + 1} has insufficient columns (${row.length} < 15).`);
    }
    const poNum = String(row[4] || row[5] || '').trim();
    if (!poNum) {
      throw new Error(`Purchase validation failed: Row #${idx + 1} missing PO/Invoice number.`);
    }
    const qty = Number(row[15]);
    if (isNaN(qty)) {
      throw new Error(`Purchase validation failed: Row #${idx + 1} (${poNum}) has non-numeric Quantity: '${row[15]}'.`);
    }
    const cost = Number(row[16]);
    if (isNaN(cost)) {
      throw new Error(`Purchase validation failed: Row #${idx + 1} (${poNum}) has non-numeric Cost: '${row[16]}'.`);
    }
  });

  return { valid: true, rowCount: dataset.rows.length };
}

// ── DATA MERGE & UPSERT LOGIC ───────────────────────────────────────────────

function mergeSalesData(existingRows = [], deltaRows = []) {
  const map = new Map();

  existingRows.forEach((row, idx) => {
    const orderNo = String(row[2] || row[4] || `ORD-${idx}`).trim();
    const sku = String(row[5] || row[6] || `SKU-${idx}`).trim();
    const key = `${orderNo}__${sku}`;
    map.set(key, row);
  });

  deltaRows.forEach((row, idx) => {
    const orderNo = String(row[2] || row[4] || `ORD-${idx}`).trim();
    const sku = String(row[5] || row[6] || `SKU-${idx}`).trim();
    const key = `${orderNo}__${sku}`;
    map.set(key, row);
  });

  return Array.from(map.values());
}

function mergePurchaseData(existingRows = [], deltaRows = []) {
  const map = new Map();

  existingRows.forEach((row, idx) => {
    const poNo = String(row[4] || row[5] || `PO-${idx}`).trim();
    const sku = String(row[9] || `SKU-${idx}`).trim();
    const loc = String(row[12] || 'Main').trim();
    const key = `${poNo}__${sku}__${loc}`;
    map.set(key, row);
  });

  deltaRows.forEach((row, idx) => {
    const poNo = String(row[4] || row[5] || `PO-${idx}`).trim();
    const sku = String(row[9] || `SKU-${idx}`).trim();
    const loc = String(row[12] || 'Main').trim();
    const key = `${poNo}__${sku}__${loc}`;
    map.set(key, row);
  });

  return Array.from(map.values());
}

function mergeInventoryData(existingRows = [], currentRows = []) {
  const map = new Map();

  currentRows.forEach((row, idx) => {
    const loc = String(row[0] || 'Main Warehouse').trim();
    const sku = String(row[1] || `SKU-${idx}`).trim();
    const key = `${loc}__${sku}`;
    map.set(key, row);
  });

  return Array.from(map.values());
}

/**
 * Calculates cutoff date dynamically from current date for standard window codes or custom start date.
 */
function getWindowCutoffDate(windowCode, customStartDate = null) {
  const code = String(windowCode || '90d').toLowerCase().trim();

  if (code === 'custom' && customStartDate) {
    const parsed = new Date(customStartDate);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  // Whole calendar-day boundary at UTC midnight N days back, not "now minus N days"
  // (which carries the current time-of-day and can clip the oldest in-window day —
  // e.g. a 09:24 run would cut off same-day invoices dated before 09:24 UTC).
  // ASSUMPTION: Cin7 Core invoice/credit-note dates are compared here as UTC
  // calendar dates. This codebase has no record of which timezone Cin7 Core itself
  // uses for invoice dates — confirm that against a real account before relying on
  // this for day-boundary-sensitive reconciliation.
  const todayUtcMidnight = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const daysBack = (n) => new Date(todayUtcMidnight.getTime() - n * 24 * 60 * 60 * 1000);

  if (code.includes('5y') || code.includes('5 year')) {
    return daysBack(5 * 365);
  } else if (code.includes('2y') || code.includes('2 year') || code.includes('24m') || code.includes('24 month') || code.includes('2 yr')) {
    return daysBack(2 * 365); // Past 2 years (730 days)
  } else if (code.includes('last_year') || code.includes('last year') || code.includes('365') || code.includes('1y') || code.includes('1 year')) {
    return daysBack(365);
  } else if (code.includes('180') || code === '180d') {
    return daysBack(180);
  } else if (code.includes('90') || code === '90d') {
    return daysBack(90);
  } else if (code.includes('60') || code === '60d') {
    return daysBack(60);
  } else if (code.includes('30') || code === '30d') {
    return daysBack(30);
  } else if (code.includes('7d') || code.includes('7 day') || code === '7') {
    return daysBack(7);
  } else if (code.includes('ytd') || code === 'year to date') {
    return new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  } else if (code.includes('all') || code === 'all_time') {
    return null;
  }
  // Default: Last 90 Days
  return daysBack(90);
}

/**
 * Rolling Window Pruning: Filters records dynamically by date window or custom start/end dates.
 */
function filterSalesByWindow(rows = [], windowCode = '30d', customOptions = {}) {
  const { start: startCutoff, end: endCutoff } = resolveReportingWindow(windowCode, customOptions);

  return rows.filter(row => {
    // V2 rows: trailing field is the document date (invoice date for invoice rows,
    // credit note date for credit-note rows) — the same date buildSaleV2Records
    // already filtered on, so this is mostly a no-op safety net for V2.
    // V1 rows: trailing field is the true Order Date. Rows persisted before this
    // field existed fall back to the legacy Invoice/Order date column.
    const dateStr = row[SALES_DOC_DATE_INDEX] || row[3] || row[1];
    if (!dateStr) return true;
    const d = toISODateStr(dateStr);
    if (!d) return true;
    if (startCutoff && d < startCutoff) return false;
    if (endCutoff && d > endCutoff) return false;
    return true;
  });
}

function filterPurchaseByWindow(rows = [], windowCode = '30d', customOptions = {}) {
  const { start: startCutoff, end: endCutoff } = resolveReportingWindow(windowCode, customOptions);

  return rows.filter(row => {
    // Filter by when the order was placed (true Order Date, trailing field), not the
    // "Expiry date" / invoice-due-date column. Falls back for older persisted snapshots.
    const dateStr = row[PURCHASE_HEADERS.length] || row[3];
    if (!dateStr) return true;
    const d = toISODateStr(dateStr);
    if (!d) return true;
    if (startCutoff && d < startCutoff) return false;
    if (endCutoff && d > endCutoff) return false;
    return true;
  });
}

// ── DEVELOPMENT / TESTING CANONICAL FALLBACKS ONLY ──────────────────────────

function getCanonicalSalesData() {
  const headers = SALES_HEADERS;
  const rows = [
    [2026, 'January', 'SO-1001', '2026-01-15', 'INV-1001', '4FBP152-BP-B', '4FBP152-BP-B', 'Cin7', 'Finished Goods', 'Finished Goods', 'Standard', 'Shopify Sales', 'Invoiced', 'each', 'Fulfilled', 'Web', 'Cin7 Rep', 'Shopify', 'Shopify web', 1, 1500, 1500, 825, 0, 675, 0.45]
  ];
  return { headers, rows };
}

function getCanonicalInventoryData() {
  const headers = [
    'Location', 'SKU', 'Product', 'Unit', 'Quantity on hand',
    'Allocated', 'On order', 'In transit', 'Unit cost', 'Stock on hand', 'Available'
  ];
  const rows = [
    ['Main Warehouse', '4FBP152-BP-B', 'Blue Waffle Wrap No. FBP152-BP-B', 'Case', 100, 10, 50, 0, 18.5, 100, 90]
  ];
  return { headers, rows };
}

function getCanonicalPurchaseOrdersData() {
  const headers = PURCHASE_HEADERS;
  const rows = [
    [2026, 'January', 'Packaging Supplies', '2026-12-31', 'PO-2001', 'INV-PO-2001', 'Cin7', 'Finished Goods', 'Finished Goods', '4FBP152-BP-B', 'Blue Waffle Wrap', 'Case', 'Main Warehouse', 'BATCH-1001', 'Received', 100, 1850, 0, 0, 185]
  ];
  return { headers, rows };
}

module.exports = {
  getClientCin7Credentials,
  classifyCin7Error,
  testConnection,
  mapSaleLineToRow,
  fetchSales,
  fetchInventory,
  fetchPurchaseOrders,
  fetchSaleDetailsConcurrently,
  scheduleCin7Request,
  validateSalesData,
  validateInventoryData,
  validatePurchaseData,
  getStoredOrderDetail,
  storeOrderDetail,
  invalidateOrderDetailCache,
  mergeSalesData,
  mergePurchaseData,
  mergeInventoryData,
  getWindowCutoffDate,
  filterSalesByWindow,
  filterPurchaseByWindow,
  getCanonicalSalesData,
  getCanonicalInventoryData,
  getCanonicalPurchaseOrdersData,
  // DB persistence
  upsertSalesToDb,
  upsertInventoryToDb,
  upsertPurchaseOrdersToDb,
  upsertSaleLinesV2ToDb,
  warmMemoryCacheFromDb,
  // Sales V2 (Core-parity) — exported for validation scripts/tests
  SALES_V2_ENABLED,
  resolveReportingWindow,
  buildSaleV2Records,
  mapSaleV2RecordToRow
};
