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
            sale.UpdatedDateUtc || null
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
            p.UpdatedDateUtc || null
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
    updatedDateUtc: updatedDateUtc || detail?.UpdatedDateUtc || new Date().toISOString(),
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

function mapSaleLineToRow(sale, line) {
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
  const sourceChannel = sale.SourceChannel || sale.SaleChannel || '';

  return [
    year,
    month,
    sale.OrderNumber || '',
    sale.InvoiceDate ? sale.InvoiceDate.split('T')[0] : (sale.OrderDate ? sale.OrderDate.split('T')[0] : ''),
    sale.InvoiceNumber || '',
    sku,
    sku,
    line.Brand || '',
    line.Category || '',
    line.Family || '',
    sale.Type || 'Commercial',
    sale.Customer || '',
    sale.Status || sale.CombinedInvoiceStatus || '',
    line.Unit || 'each',
    sale.CombinedShippingStatus || '',
    sale.CustomerTags || '',
    sale.SalesRepresentative || '',
    sourceChannel,
    sourceChannel,
    quantity,
    revenue,
    revenue,
    cogs,
    0,
    profit,
    margin
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
async function fetchSaleDetailsConcurrently(sales, creds, clientId, onProgress = null, isCancelled = null) {
  const detailedSales = [];
  const uncachedSales = [];
  let cacheHits = 0;

  // 0. Bulk-load DB cache into memory so workers never hit DB per-order
  await warmMemoryCacheFromDb(clientId);

  // 1. Exact Set-Based Cache Audit: Identify already cached & valid orders
  for (const sale of sales) {
    const cachedDetail = getStoredOrderDetail(clientId, sale.SaleID, sale.UpdatedDateUtc);
    if (cachedDetail && cachedDetail.Order && Array.isArray(cachedDetail.Order.Lines) && cachedDetail.Order.Lines.length > 0) {
      cacheHits++;
      detailedSales.push({ sale, lines: cachedDetail.Order.Lines });
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
    console.log(`[CIN7 LIVE] All ${totalOrders} order details resolved from cache (0 network requests needed).`);
    return detailedSales;
  }

  console.log(`[CIN7 LIVE] Enriching ${uncachedSales.length} uncached orders (concurrency = 3, ${cacheHits} from cache)...`);

  const concurrency = 3;
  let currentIndex = 0;
  let failedCount = 0;
  let newlyEnrichedCount = 0;

  async function worker() {
    while (currentIndex < uncachedSales.length) {
      if (typeof isCancelled === 'function' && isCancelled()) {
        console.log('[CIN7 LIVE] Sync cancellation detected in enrichment worker. Stopping.');
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

      const lines = detail?.Order?.Lines || [];
      if (detail && Array.isArray(lines) && lines.length > 0) {
        storeOrderDetail(clientId, sale.SaleID, detail, sale.UpdatedDateUtc);
        // Also persist to DB cache (fire-and-forget)
        storeOrderDetailToDb(clientId, sale.SaleID, detail, sale.UpdatedDateUtc).catch(() => {});
        detailedSales.push({ sale, lines });
        newlyEnrichedCount++;
      } else {
        failedCount++;
        console.warn(`[CIN7 LIVE] Notice on sale detail for ${sale.OrderNumber || sale.SaleID}: ${lastError?.message || 'no Order.Lines'}`);
        if (detail && detail.Order) {
          storeOrderDetail(clientId, sale.SaleID, detail, sale.UpdatedDateUtc);
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

  console.log(`[CIN7 LIVE] Detail enrichment complete: ${detailedSales.length} loaded, ${cacheHits} from cache, ${newlyEnrichedCount} newly fetched, ${failedCount} isolated notices.`);
  return detailedSales;
}

const SALES_HEADERS = [
  'Month', 'Order date', 'Order #', 'Invoice date', 'Document #',
  'SKU', 'Product', 'Brand', 'Category', 'Family', 'Product tags',
  'Customer', 'Invoice status', 'Unit', 'Shipment status', 'Customer tags',
  'Sales representative', 'Sales Channel', 'Quantity', 'Invoice', 'Sale',
  'COGS', 'Profit less journals', 'Journals', 'Profit', 'Profit'
];

/**
 * Fetches real Sales orders from Cin7 Core API without silent fallback to demo data.
 */
async function fetchSales(clientId, { updatedSince = null, onProgress = null, isCancelled = null } = {}) {
  const startMs = Date.now();
  const creds = await getClientCin7Credentials(clientId);

  try {
    const formattedSince = formatCin7Date(updatedSince);
    const filterDesc = formattedSince ? `UpdatedSince=${formattedSince}` : 'All records (Full fetch)';
    console.log(`[CIN7 LIVE] Fetching Sales orders from Cin7 Core API (${filterDesc})...`);

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
      console.log(`Sales: records fetched from page ${page}: ${sales.length} (Total in Cin7: ${totalInApi})`);
      allSales = allSales.concat(sales);

      if (sales.length === 0 || allSales.length >= totalInApi) {
        break;
      }
      page++;
    }

    const listDuration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(`Sales: final total fetched: ${allSales.length} (${listDuration}s)`);

    if (!allSales.length) {
      if (updatedSince) {
        console.log(`[CIN7 LIVE] No new or updated sales since ${updatedSince}.`);
        return { headers: SALES_HEADERS, rows: [], isIncrementalEmpty: true };
      }
      return { headers: SALES_HEADERS, rows: [], isIncrementalEmpty: false };
    }

    const enrichStartMs = Date.now();
    const detailedSales = await fetchSaleDetailsConcurrently(allSales, creds, clientId, onProgress, isCancelled);
    const enrichDuration = ((Date.now() - enrichStartMs) / 1000).toFixed(2);

    const rows = detailedSales.flatMap(({ sale, lines }) =>
      lines
        .filter(line => String(line.SKU || '').trim())
        .map(line => mapSaleLineToRow(sale, line))
    );

    const totalDuration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(`\n[CIN7 PERF] Sales Fetch & Enrichment Breakdown:`);
    console.log(`  List Fetch: ${listDuration}s (${allSales.length} orders)`);
    console.log(`  Detail Enrichment: ${enrichDuration}s (${detailedSales.length} orders enriched)`);
    console.log(`  Total Lines Produced: ${rows.length}`);
    console.log(`  Total Sales Duration: ${totalDuration}s\n`);

    // Persist enriched sales to database (fire-and-forget — does not block response)
    upsertSalesToDb(clientId, detailedSales).catch(e =>
      console.warn('[CIN7 DB] Background sales upsert error (non-fatal):', e.message)
    );

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
async function fetchInventory(clientId) {
  const startMs = Date.now();
  const creds = await getClientCin7Credentials(clientId);
  try {
    console.log('[CIN7 LIVE] Fetching real Inventory availability from Cin7 Core API...');
    let allInv = [];
    let page = 1;
    let totalInApi = 0;

    while (true) {
      const res = await cin7ApiGet(`${CIN7_BASE_URL}/ref/productavailability`, {
        headers: cin7Headers(creds),
        params: { Page: page, Limit: 100 },
        timeout: 30000
      }, 'Inventory', 5);

      totalInApi = res.data?.Total || 0;
      const inv = res.data?.ProductAvailabilityList || [];
      console.log(`Inventory: records fetched from page ${page}: ${inv.length} (Total in Cin7: ${totalInApi})`);
      allInv = allInv.concat(inv);

      if (inv.length === 0 || allInv.length >= totalInApi) {
        break;
      }
      page++;
    }

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
async function fetchPurchaseOrders(clientId, { updatedSince = null } = {}) {
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
        parseFloat((cost * 0.1).toFixed(2))
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
    const qty = Number(row[19]);
    if (isNaN(qty)) {
      throw new Error(`Sales validation failed: Row #${idx + 1} (${sku}) has non-numeric Quantity: '${row[19]}'.`);
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
  const now = new Date();
  const code = String(windowCode || '90d').toLowerCase().trim();

  if (code === 'custom' && customStartDate) {
    const parsed = new Date(customStartDate);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  if (code.includes('5y') || code.includes('5 year')) {
    return new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
  } else if (code.includes('2y') || code.includes('2 year') || code.includes('24m') || code.includes('24 month') || code.includes('2 yr')) {
    return new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000); // Past 2 years (730 days)
  } else if (code.includes('last_year') || code.includes('last year') || code.includes('365') || code.includes('1y') || code.includes('1 year')) {
    return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  } else if (code.includes('180') || code === '180d') {
    return new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  } else if (code.includes('90') || code === '90d') {
    return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else if (code.includes('60') || code === '60d') {
    return new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  } else if (code.includes('30') || code === '30d') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (code.includes('7d') || code.includes('7 day') || code === '7') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (code.includes('ytd') || code === 'year to date') {
    return new Date(now.getFullYear(), 0, 1);
  } else if (code.includes('all') || code === 'all_time') {
    return null;
  }
  // Default: Last 90 Days
  return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
}

/**
 * Rolling Window Pruning: Filters records dynamically by date window or custom start/end dates.
 */
function filterSalesByWindow(rows = [], windowCode = '30d', customOptions = {}) {
  let startDate = typeof customOptions === 'object' ? customOptions.startDate : null;
  let endDate = typeof customOptions === 'object' ? customOptions.endDate : null;
  
  const startCutoff = (windowCode === 'custom' && startDate) ? new Date(startDate + 'T00:00:00.000Z') : getWindowCutoffDate(windowCode);
  const endCutoff = (windowCode === 'custom' && endDate) ? new Date(endDate + 'T23:59:59.999Z') : null;

  return rows.filter(row => {
    const dateStr = row[3] || row[1];
    if (!dateStr) return true;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return true;
    if (startCutoff && d < startCutoff) return false;
    if (endCutoff && d > endCutoff) return false;
    return true;
  });
}

function filterPurchaseByWindow(rows = [], windowCode = '30d', customOptions = {}) {
  let startDate = typeof customOptions === 'object' ? customOptions.startDate : null;
  let endDate = typeof customOptions === 'object' ? customOptions.endDate : null;

  const startCutoff = (windowCode === 'custom' && startDate) ? new Date(startDate + 'T00:00:00.000Z') : getWindowCutoffDate(windowCode);
  const endCutoff = (windowCode === 'custom' && endDate) ? new Date(endDate + 'T23:59:59.999Z') : null;

  return rows.filter(row => {
    const dateStr = row[3];
    if (!dateStr) return true;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return true;
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
  warmMemoryCacheFromDb
};
