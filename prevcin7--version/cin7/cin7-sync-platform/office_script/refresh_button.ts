/*
 * ============================================================================
 * COMMERCIAL ENTERPRISE REPORTING APPLICATION - CIN7 SYNC ENGINE
 * ============================================================================
 * Design Inspiration: Microsoft Fabric | Power BI | Dynamics 365 | SAP Analytics Cloud
 * Target Platform: Microsoft Excel Office Scripts (TypeScript)
 * 
 * Features:
 * - Branded Enterprise Header & Desktop Navigation Bar
 * - Real-Time Dashboard KPI Cards
 * - Hidden Gridlines & Responsive Canvas Frame
 * - Commercial Data Grid Styling & Number Formatting
 * - Enterprise Status Badges & Freeze Panes
 * - Fully Synchronized Multi-Sheet Timeline Controls
 * - Commercial Audit Log (Sync Log)
 * ============================================================================
 */

// ── DESIGN SYSTEM & COLOR PALETTE TOKENS ───────────────────────────────────
const THEME = {
  fontFamily: "Segoe UI",
  colors: {
    titleBarBg: "#0F172A",       // Deep Slate Navy (Fabric 900)
    titleBarText: "#FFFFFF",     // Pure White
    titleBarSubtext: "#94A3B8",  // Muted Gray
    
    navBarBg: "#1E293B",         // Slate 800
    navTabActiveBg: "#0F6CBD",   // Fabric Accent Blue
    navTabActiveText: "#FFFFFF",
    navTabInactiveBg: "#1E293B",
    navTabInactiveText: "#CBD5E1",
    
    controlBarBg: "#F1F5F9",     // Soft Bar Tint (Slate 100)
    canvasBg: "#F8FAFC",         // Canvas Background (Slate 50)
    cardBg: "#FFFFFF",           // Card Surface
    cardBorder: "#CBD5E1",       // Card Border
    cardTopAccent: "#0F6CBD",    // Accent Line
    
    tableHeaderBg: "#1E293B",    // Grid Header Background
    tableHeaderText: "#FFFFFF",  // Grid Header Text
    tableRowEvenBg: "#FFFFFF",   // Grid Row White
    tableRowOddBg: "#F8FAFC",    // Grid Row Zebra Slate 50
    tableBorder: "#E2E8F0",      // Light Cell Border
    tableText: "#334155",        // Dark Text
    
    textPrimary: "#0F172A",
    textSecondary: "#475569",
    textMuted: "#64748B",
  },
  statusBadges: {
    success: { fill: "#DCFCE7", font: "#15803D", border: "#86EFAC" },
    warning: { fill: "#FEF3C7", font: "#B45309", border: "#FDE68A" },
    error:   { fill: "#FEE2E2", font: "#B91C1C", border: "#FCA5A5" },
    info:    { fill: "#E0F2FE", font: "#0369A1", border: "#BAE6FD" }
  }
};

// ── LOG SHEET SETTINGS ──────────────────────────────────────────────────────
const LOG_SHEET_NAME: string = "Sync Log";
const LOG_MAX_ENTRIES: number = 20;
const LOG_HEADERS: string[] = ["Date & Time", "Status", "Timeline Period", "Rows Synced / Reason", "Run ID"];

// ── CANONICAL SHEET NAMES ───────────────────────────────────────────────────
const SALES_SHEET: string = "Sales Transactions Raw Data";
const INVENTORY_SHEET: string = "Inventory On Hand Raw Data";
const PURCHASES_SHEET: string = "Purchase Transactions Raw data";

interface SyncResponse {
  status: string;
  client_id: string;
  rows_synced?: number;
  reason?: string;
  sales_headers?: string[];
  sales_rows?: (string | number)[][];
  inventory_headers?: string[];
  inventory_rows?: (string | number)[][];
  purchase_headers?: string[];
  purchase_rows?: (string | number)[][];
}

interface KpiCardConfig {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: string;
  statusType?: "success" | "warning" | "error" | "info";
  numberFormat?: string;
}

async function main(workbook: ExcelScript.Workbook): Promise<void> {
  const API_BASE_URL: string = "http://localhost:8000";
  const CLIENT_ID: string = "1bde386a-1bcb-4e78-baa8-caa0142892ab";
  const API_KEY: string = "MzybfJtO2UjB9_6DGC8z2p3dAQVgE2tAIK1R7UqmMwM";

  const validOptions: string[] = [
    "Last 30 days", "Last 365 days", "Last month", "This month",
    "Last quarter", "This quarter", "QTD (Quarter to date)",
    "Last year", "This year", "Last YTD (year to date)",
    "Last MTD (month to date)", "All Time"
  ];
  const optionsList: string = validOptions.join(", ");

  // ── 1. Read timeline selection from active sheet (supporting B1 or B3) ────
  const activeSheet: ExcelScript.Worksheet = workbook.getActiveWorksheet();
  let rawVal: string = String(activeSheet.getRange("B3").getValue() || activeSheet.getRange("B1").getValue() || "").trim();
  let timelineValue: string = "Last 30 days";

  for (let i = 0; i < validOptions.length; i++) {
    if (rawVal.toLowerCase() === validOptions[i].toLowerCase()) {
      timelineValue = validOptions[i];
      break;
    }
  }

  // ── 2. Get or create canonical worksheets ──────────────────────────────────
  const salesSheet = getOrCreateSheet(workbook, SALES_SHEET);
  const invSheet = getOrCreateSheet(workbook, INVENTORY_SHEET);
  const poSheet = getOrCreateSheet(workbook, PURCHASES_SHEET);
  const allDataSheets: ExcelScript.Worksheet[] = [salesSheet, invSheet, poSheet];

  // ── 3. Apply Enterprise Application Shell & Timeline Controls to Sheets ────
  const sheets = workbook.getWorksheets();
  for (let i = 0; i < sheets.length; i++) {
    formatWorksheetAsAppContainer(sheets[i]);
  }

  for (let i = 0; i < allDataSheets.length; i++) {
    setupAppShell(workbook, allDataSheets[i], "CIN7 ENTERPRISE ANALYTICS SUITE");
    setupControlRow(allDataSheets[i], optionsList);
    setTimelineAndStatus(allDataSheets[i], timelineValue, `Syncing Cin7 data (${timelineValue})...`, "warning");
    allDataSheets[i].getFreezePanes().freezeRows(3);
  }

  // ── 4. Fetch Data from Sync Engine Backend ────────────────────────────────
  const sinceDate: Date | null = calculateStartDate(timelineValue);
  const queryParam: string = sinceDate
    ? `?updated_since=${encodeURIComponent(sinceDate.toISOString())}`
    : "";

  let runId: string = "";

  try {
    runId = logSyncStart(workbook, timelineValue);

    const response: Response = await fetch(
      `${API_BASE_URL}/sync/${CLIENT_ID}${queryParam}`,
      {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      const err: { detail?: string } = (await response.json()) as { detail?: string };
      const msg: string = `Sync failed: ${err.detail ?? response.statusText}`;
      for (let i = 0; i < allDataSheets.length; i++) {
        setTimelineAndStatus(allDataSheets[i], timelineValue, msg, "error");
      }
      logSyncFinish(workbook, runId, "Failed", err.detail ?? response.statusText ?? "HTTP error");
      return;
    }

    const result: SyncResponse = (await response.json()) as SyncResponse;
    const syncedAt: string = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (result.status === "success") {
      const totalSyncedRows = result.rows_synced ?? 0;
      const successMsg: string = `Status: Synced (${timelineValue}) at ${syncedAt}  |  ${totalSyncedRows} total rows`;

      // ── Write & Format Data into Raw Data Sheets ──────────────────────────

      // 1. Sales Sheet
      if (result.sales_rows && result.sales_rows.length > 0) {
        if (result.sales_headers) {
          writeRows(salesSheet, "A8", [result.sales_headers]);
        }
        writeRows(salesSheet, "A9", result.sales_rows);
        
        const salesRowCount = result.sales_rows.length;
        const salesColCount = (result.sales_headers ? result.sales_headers.length : result.sales_rows[0].length);
        const dataRangeAddr = `A8:${getColumnHeader(salesColCount - 1)}${8 + salesRowCount}`;
        
        formatEnterpriseDataGrid(salesSheet, dataRangeAddr);
        renderSheetKpiCards(salesSheet, [
          { title: "SALES TRANSACTIONS", value: salesRowCount, numberFormat: "#,##0", trend: "● Active Period Rows", statusType: "success" },
          { title: "TIMELINE WINDOW", value: timelineValue, trend: `Synced at ${syncedAt}`, statusType: "info" },
          { title: "SYNC HEALTH", value: "ONLINE 100%", trend: "● Connection Active", statusType: "success" }
        ]);
        setTimelineAndStatus(salesSheet, timelineValue, successMsg, "success");
      }

      // 2. Inventory Sheet
      if (result.inventory_rows && result.inventory_rows.length > 0) {
        tidyGrandTotalRow(invSheet);
        if (result.inventory_headers) {
          writeRows(invSheet, "A8", [result.inventory_headers]);
        }
        writeRows(invSheet, "A9", result.inventory_rows);
        
        const invRowCount = result.inventory_rows.length;
        const invColCount = (result.inventory_headers ? result.inventory_headers.length : result.inventory_rows[0].length);
        const dataRangeAddr = `A8:${getColumnHeader(invColCount - 1)}${8 + invRowCount}`;

        formatEnterpriseDataGrid(invSheet, dataRangeAddr);
        renderSheetKpiCards(invSheet, [
          { title: "INVENTORY ITEMS", value: invRowCount, numberFormat: "#,##0", trend: "● Items On Hand", statusType: "success" },
          { title: "TIMELINE WINDOW", value: timelineValue, trend: `Synced at ${syncedAt}`, statusType: "info" },
          { title: "STOCK MONITOR", value: "OPTIMAL", trend: "● Live Inventory Feed", statusType: "success" }
        ]);
        setTimelineAndStatus(invSheet, timelineValue, successMsg, "success");
      }

      // 3. Purchases Sheet
      if (result.purchase_rows && result.purchase_rows.length > 0) {
        if (result.purchase_headers) {
          writeRows(poSheet, "A8", [result.purchase_headers]);
        }
        writeRows(poSheet, "A9", result.purchase_rows);
        
        const poRowCount = result.purchase_rows.length;
        const poColCount = (result.purchase_headers ? result.purchase_headers.length : result.purchase_rows[0].length);
        const dataRangeAddr = `A8:${getColumnHeader(poColCount - 1)}${8 + poRowCount}`;

        formatEnterpriseDataGrid(poSheet, dataRangeAddr);
        renderSheetKpiCards(poSheet, [
          { title: "PURCHASE ORDERS", value: poRowCount, numberFormat: "#,##0", trend: "● Active Orders", statusType: "success" },
          { title: "TIMELINE WINDOW", value: timelineValue, trend: `Synced at ${syncedAt}`, statusType: "info" },
          { title: "SUPPLY CHAIN", value: "CONNECTED", trend: "● Cin7 Live Feed", statusType: "success" }
        ]);
        setTimelineAndStatus(poSheet, timelineValue, successMsg, "success");
      }

      logSyncFinish(workbook, runId, "Success", `${totalSyncedRows} rows synced`);

    } else {
      const failMsg: string = `Sync failed: ${result.reason ?? "unknown reason"}`;
      for (let i = 0; i < allDataSheets.length; i++) {
        setTimelineAndStatus(allDataSheets[i], timelineValue, failMsg, "error");
      }
      logSyncFinish(workbook, runId, "Failed", result.reason ?? "unknown reason");
    }

  } catch (error) {
    const errMsg: string = "Sync error: server connection unavailable.";
    for (let i = 0; i < allDataSheets.length; i++) {
      setTimelineAndStatus(allDataSheets[i], timelineValue, errMsg, "error");
    }
    logSyncFinish(workbook, runId, "Failed", "Could not reach server");
  }
}

// ── ENTERPRISE UI & LAYOUT ENGINE ──────────────────────────────────────────

/** Sets sheet background to soft enterprise canvas & hides Excel gridlines */
function formatWorksheetAsAppContainer(sheet: ExcelScript.Worksheet): void {
  sheet.setShowGridlines(false);
  const canvas = sheet.getRange("A1:Z100");
  canvas.getFormat().getFont().setName(THEME.fontFamily);
}

/** Builds the top Branded App Shell Title Bar and Navigation Bar */
function setupAppShell(
  workbook: ExcelScript.Workbook,
  sheet: ExcelScript.Worksheet,
  appTitle: string
): void {
  const maxColIndex = 11;
  const maxColLetter = getColumnHeader(maxColIndex);

  // ── ROW 1: BRANDED TITLE BAR ──────────────────────────────────────────────
  const titleRange = sheet.getRange(`A1:${maxColLetter}1`);
  sheet.getRange("A1").setValue(`⚡  ${appTitle}   |   CIN7 SYNC PLATFORM`);
  
  titleRange.getFormat().getFill().setColor(THEME.colors.titleBarBg);
  titleRange.getFormat().getFont().setColor(THEME.colors.titleBarText);
  titleRange.getFormat().getFont().setBold(true);
  titleRange.getFormat().getFont().setSize(11);
  titleRange.getFormat().getFont().setName(THEME.fontFamily);
  titleRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);
  titleRange.getFormat().setRowHeight(32);

  const titleRightCell = sheet.getRange(`${maxColLetter}1`);
  titleRightCell.setValue("[ PROD ENGINE  |  CONNECTED ]");
  titleRightCell.getFormat().getFont().setSize(8.5);
  titleRightCell.getFormat().getFont().setColor(THEME.colors.titleBarSubtext);
  titleRightCell.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.right);

  // ── ROW 2: DESKTOP NAVIGATION TAB BAR ─────────────────────────────────────
  const navRange = sheet.getRange(`A2:${maxColLetter}2`);
  navRange.getFormat().getFill().setColor(THEME.colors.navBarBg);
  navRange.getFormat().setRowHeight(26);

  const sheets = workbook.getWorksheets();
  const currentSheetName = sheet.getName();

  for (let i = 0; i < Math.min(sheets.length, 6); i++) {
    const tabCell = sheet.getRange(`${getColumnHeader(i)}2`);
    const sName = sheets[i].getName();
    const isActive = sName.toLowerCase().trim() === currentSheetName.toLowerCase().trim();

    tabCell.setValue(isActive ? `▶  ${sName.toUpperCase()}` : `   ${sName}   `);
    tabCell.getFormat().getFont().setSize(9);
    tabCell.getFormat().getFont().setName(THEME.fontFamily);
    tabCell.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);
    tabCell.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);

    if (isActive) {
      tabCell.getFormat().getFill().setColor(THEME.colors.navTabActiveBg);
      tabCell.getFormat().getFont().setColor(THEME.colors.navTabActiveText);
      tabCell.getFormat().getFont().setBold(true);
      
      const bottomBorder = tabCell.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeBottom);
      bottomBorder.setColor("#38BDF8");
      bottomBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
      bottomBorder.setWeight(ExcelScript.BorderWeight.medium);
    } else {
      tabCell.getFormat().getFill().setColor(THEME.colors.navTabInactiveBg);
      tabCell.getFormat().getFont().setColor(THEME.colors.navTabInactiveText);
      tabCell.getFormat().getFont().setBold(false);
    }
  }
}

/** Configures Row 3 Control Toolbar (Timeline dropdown & status message) */
function setupControlRow(sheet: ExcelScript.Worksheet, optionsList: string): void {
  sheet.getRange("A3:L3").unmerge();
  
  const controlBarRange = sheet.getRange("A3:L3");
  controlBarRange.getFormat().getFill().setColor(THEME.colors.controlBarBg);
  controlBarRange.getFormat().setRowHeight(26);

  // Label cell A3
  const labelCell = sheet.getRange("A3");
  labelCell.setValue("TIMELINE PERIOD:");
  labelCell.getFormat().getFont().setBold(true);
  labelCell.getFormat().getFont().setSize(8.5);
  labelCell.getFormat().getFont().setColor(THEME.colors.textSecondary);
  labelCell.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);
  labelCell.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.left);

  // Dropdown Cell B3
  const dropdownCell = sheet.getRange("B3");
  dropdownCell.getFormat().getFill().setColor("#FFFFFF");
  dropdownCell.getFormat().getFont().setBold(true);
  dropdownCell.getFormat().getFont().setSize(9);
  dropdownCell.getFormat().getFont().setColor(THEME.colors.textPrimary);
  dropdownCell.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);
  
  setBoxBorder(dropdownCell, THEME.colors.cardBorder);
  
  dropdownCell.getDataValidation().setRule({
    list: { inCellDropDown: true, source: optionsList }
  });

  // Clear dropdown rule on D3 status indicator cell
  const statusCell = sheet.getRange("D3");
  statusCell.getDataValidation().clear();

  // Backward compatibility support for B1 / D1
  sheet.getRange("A1:D1").unmerge();
  sheet.getRange("B1").getDataValidation().setRule({
    list: { inCellDropDown: true, source: optionsList }
  });
}

/** Updates Timeline value and renders status text with an enterprise badge style */
function setTimelineAndStatus(
  sheet: ExcelScript.Worksheet,
  timelineValue: string,
  statusMessage: string,
  statusType: "success" | "warning" | "error" | "info" = "info"
): void {
  // Sync both B3 and B1 for backwards compatibility
  sheet.getRange("B3").setValue(timelineValue);
  sheet.getRange("B1").setValue(timelineValue);

  const statusCell = sheet.getRange("D3");
  statusCell.setValue(statusMessage);
  statusCell.getFormat().getFont().setBold(true);
  statusCell.getFormat().getFont().setSize(9);
  statusCell.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

  const badgeStyle = THEME.statusBadges[statusType];
  statusCell.getFormat().getFill().setColor(badgeStyle.fill);
  statusCell.getFormat().getFont().setColor(badgeStyle.font);
  setBoxBorder(statusCell, badgeStyle.border);

  // Also write D1 for backwards compatibility
  sheet.getRange("D1").setValue(statusMessage);
}

/** Renders Dashboard KPI Cards in Rows 4-6 */
function renderSheetKpiCards(sheet: ExcelScript.Worksheet, cards: KpiCardConfig[]): void {
  const startRow = 4;
  const cardWidthCols = 3;

  // Clear card spacer row 7
  sheet.getRange("A7:L7").getFormat().getFill().setColor(THEME.colors.canvasBg);
  sheet.getRange("A7:L7").getFormat().setRowHeight(10);

  cards.forEach((card, index) => {
    const startColIdx = index * cardWidthCols;
    const endColIdx = startColIdx + cardWidthCols - 1;
    
    const startCol = getColumnHeader(startColIdx);
    const endCol = getColumnHeader(endColIdx);

    const cardHeaderRange = sheet.getRange(`${startCol}${startRow}:${endCol}${startRow}`);
    const cardValueRange = sheet.getRange(`${startCol}${startRow + 1}:${endCol}${startRow + 1}`);
    const cardFooterRange = sheet.getRange(`${startCol}${startRow + 2}:${endCol}${startRow + 2}`);
    const cardFullRange = sheet.getRange(`${startCol}${startRow}:${endCol}${startRow + 2}`);

    cardFullRange.getFormat().getFill().setColor(THEME.colors.cardBg);
    setBoxBorder(cardFullRange, THEME.colors.cardBorder);

    const topBorder = cardHeaderRange.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeTop);
    topBorder.setColor(THEME.colors.cardTopAccent);
    topBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
    topBorder.setWeight(ExcelScript.BorderWeight.medium);

    // Title
    sheet.getRange(`${startCol}${startRow}`).setValue(card.title.toUpperCase());
    cardHeaderRange.getFormat().getFont().setSize(8);
    cardHeaderRange.getFormat().getFont().setBold(true);
    cardHeaderRange.getFormat().getFont().setColor(THEME.colors.textMuted);
    cardHeaderRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.bottom);

    // Metric Value
    const valCell = sheet.getRange(`${startCol}${startRow + 1}`);
    valCell.setValue(card.value);
    if (card.numberFormat) {
      valCell.setNumberFormat(card.numberFormat);
    }
    cardValueRange.getFormat().getFont().setSize(15);
    cardValueRange.getFormat().getFont().setBold(true);
    cardValueRange.getFormat().getFont().setColor(THEME.colors.textPrimary);
    cardValueRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

    // Footer
    if (card.trend || card.subtitle) {
      const footerCell = sheet.getRange(`${startCol}${startRow + 2}`);
      footerCell.setValue(card.trend || card.subtitle || "");
      cardFooterRange.getFormat().getFont().setSize(8);
      cardFooterRange.getFormat().getFont().setColor(
        card.statusType === "success" ? "#16A34A" :
        card.statusType === "warning" ? "#D97706" :
        card.statusType === "error" ? "#DC2626" : THEME.colors.textMuted
      );
      cardFooterRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.top);
    }
  });

  sheet.getRange(`A${startRow}:Z${startRow}`).getFormat().setRowHeight(18);
  sheet.getRange(`A${startRow + 1}:Z${startRow + 1}`).getFormat().setRowHeight(26);
  sheet.getRange(`A${startRow + 2}:Z${startRow + 2}`).getFormat().setRowHeight(18);
}

/** Formats a range address as a commercial Enterprise Data Grid */
function formatEnterpriseDataGrid(sheet: ExcelScript.Worksheet, rangeAddress: string): void {
  const gridRange = sheet.getRange(rangeAddress);
  const rowCount = gridRange.getRowCount();
  const colCount = gridRange.getColumnCount();

  if (rowCount === 0 || colCount === 0) return;

  // ── Header Row ────────────────────────────────────────────────────────────
  const headerRange = gridRange.getResizedRange(-(rowCount - 1), 0);
  headerRange.getFormat().getFill().setColor(THEME.colors.tableHeaderBg);
  headerRange.getFormat().getFont().setColor(THEME.colors.tableHeaderText);
  headerRange.getFormat().getFont().setBold(true);
  headerRange.getFormat().getFont().setSize(9.5);
  headerRange.getFormat().getFont().setName(THEME.fontFamily);
  headerRange.getFormat().setRowHeight(26);
  headerRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

  const headerBottomBorder = headerRange.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeBottom);
  headerBottomBorder.setColor("#0EA5E9");
  headerBottomBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
  headerBottomBorder.setWeight(ExcelScript.BorderWeight.medium);

  // ── Data Rows & Zebra Striping ────────────────────────────────────────────
  if (rowCount > 1) {
    const dataRange = gridRange.getOffsetRange(1, 0).getResizedRange(-1, 0);
    dataRange.getFormat().getFont().setName(THEME.fontFamily);
    dataRange.getFormat().getFont().setSize(9.5);
    dataRange.getFormat().getFont().setColor(THEME.colors.tableText);
    dataRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

    for (let r = 1; r < rowCount; r++) {
      const rowRange = gridRange.getCell(r, 0).getResizedRange(0, colCount - 1);
      rowRange.getFormat().setRowHeight(22);

      if (r % 2 === 1) {
        rowRange.getFormat().getFill().setColor(THEME.colors.tableRowOddBg);
      } else {
        rowRange.getFormat().getFill().setColor(THEME.colors.tableRowEvenBg);
      }

      const bBorder = rowRange.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeBottom);
      bBorder.setColor(THEME.colors.tableBorder);
      bBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
      bBorder.setWeight(ExcelScript.BorderWeight.thin);
    }
  }

  // ── Autofit & Safety Column Widths ────────────────────────────────────────
  gridRange.getFormat().autofitColumns();
  for (let c = 0; c < colCount; c++) {
    const colRange = gridRange.getCell(0, c).getEntireColumn();
    const currentWidth = colRange.getFormat().getColumnWidth();
    colRange.getFormat().setColumnWidth(Math.max(currentWidth + 18, 110));
  }

  // ── Auto Format Data Types & Alignment ─────────────────────────────────────
  autoFormatColumns(gridRange);
}

/** Detects dates, prices, quantities, IDs and applies enterprise formatting */
function autoFormatColumns(gridRange: ExcelScript.Range): void {
  const rowCount = gridRange.getRowCount();
  const colCount = gridRange.getColumnCount();
  if (rowCount < 2) return;

  const headerValues = gridRange.getResizedRange(-(rowCount - 1), 0).getValues()[0] as string[];

  for (let c = 0; c < colCount; c++) {
    const headerName = String(headerValues[c] || "").toLowerCase();
    const dataColRange = gridRange.getCell(1, c).getResizedRange(rowCount - 2, 0);

    if (
      headerName.includes("price") || headerName.includes("total") ||
      headerName.includes("amount") || headerName.includes("revenue") ||
      headerName.includes("cost") || headerName.includes("value")
    ) {
      dataColRange.setNumberFormat("$#,##0.00");
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.right);
    } else if (
      headerName.includes("qty") || headerName.includes("quantity") ||
      headerName.includes("count") || headerName.includes("units") ||
      headerName.includes("on hand") || headerName.includes("available")
    ) {
      dataColRange.setNumberFormat("#,##0");
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.right);
    } else if (
      headerName.includes("date") || headerName.includes("created") ||
      headerName.includes("updated") || headerName.includes("time")
    ) {
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
    } else if (headerName.includes("status") || headerName.includes("state")) {
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
      applyStatusPills(dataColRange);
    } else if (
      headerName.includes("id") || headerName.includes("code") ||
      headerName.includes("sku") || headerName.includes("number")
    ) {
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
    }
  }
}

/** Applies pill badges to status cells */
function applyStatusPills(range: ExcelScript.Range): void {
  const rowCount = range.getRowCount();
  const colCount = range.getColumnCount();
  const values = range.getValues();

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const cell = range.getCell(r, c);
      const valStr = String(values[r][c] || "").trim().toLowerCase();

      if (!valStr) continue;

      let badgeStyle = THEME.statusBadges.info;
      if (valStr.includes("success") || valStr.includes("complete") || valStr.includes("active") || valStr.includes("online") || valStr.includes("synced")) {
        badgeStyle = THEME.statusBadges.success;
      } else if (valStr.includes("pending") || valStr.includes("running") || valStr.includes("syncing") || valStr.includes("warning")) {
        badgeStyle = THEME.statusBadges.warning;
      } else if (valStr.includes("fail") || valStr.includes("error") || valStr.includes("cancel")) {
        badgeStyle = THEME.statusBadges.error;
      }

      cell.getFormat().getFill().setColor(badgeStyle.fill);
      cell.getFormat().getFont().setColor(badgeStyle.font);
      cell.getFormat().getFont().setBold(true);
      cell.getFormat().getFont().setSize(9);
      setBoxBorder(cell, badgeStyle.border);
    }
  }
}

// ── DATA FETCH & DATE LOGIC ────────────────────────────────────────────────

function calculateStartDate(timelineInput: string): Date | null {
  const now: Date = new Date();
  const option: string = (timelineInput || "").toLowerCase().trim();

  if (option.includes("30")) {
    return new Date(now.setDate(now.getDate() - 30));
  } else if (option.includes("365")) {
    return new Date(now.setDate(now.getDate() - 365));
  } else if (option.includes("last month")) {
    return new Date(now.getFullYear(), now.getMonth() - 1, 1);
  } else if (option.includes("this month") || option.includes("mtd")) {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (option.includes("last quarter")) {
    const q: number = Math.floor(now.getMonth() / 3) - 1;
    return new Date(now.getFullYear(), q * 3, 1);
  } else if (option.includes("this quarter") || option.includes("qtd")) {
    const q: number = Math.floor(now.getMonth() / 3);
    return new Date(now.getFullYear(), q * 3, 1);
  } else if (option.includes("last year")) {
    return new Date(now.getFullYear() - 1, 0, 1);
  } else if (option.includes("this year") || option.includes("ytd")) {
    return new Date(now.getFullYear(), 0, 1);
  } else if (option.includes("all")) {
    return null;
  }
  return new Date(now.setDate(now.getDate() - 30));
}

function getOrCreateSheet(workbook: ExcelScript.Workbook, targetName: string): ExcelScript.Worksheet {
  const sheets: ExcelScript.Worksheet[] = workbook.getWorksheets();
  const lowerTarget: string = targetName.toLowerCase().trim();

  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase().trim() === lowerTarget) {
      return sheets[i];
    }
  }

  let categoryKeyword: string = "";
  if (lowerTarget.includes("sale")) categoryKeyword = "sale";
  else if (lowerTarget.includes("inventory") || lowerTarget.includes("stock")) categoryKeyword = "inventory";
  else if (lowerTarget.includes("purchase") || lowerTarget.includes("po")) categoryKeyword = "purchase";

  if (categoryKeyword) {
    for (let i = 0; i < sheets.length; i++) {
      const sName: string = sheets[i].getName().toLowerCase();
      if (sName.includes("raw") && (sName.includes(categoryKeyword) || (categoryKeyword === "inventory" && sName.includes("stock")))) {
        return sheets[i];
      }
    }
    for (let i = 0; i < sheets.length; i++) {
      const sName: string = sheets[i].getName().toLowerCase();
      if (sName.includes(categoryKeyword)) {
        return sheets[i];
      }
    }
  }

  return workbook.addWorksheet(targetName);
}

function writeRows(
  sheet: ExcelScript.Worksheet,
  startCell: string,
  rows: (string | number)[][]
): void {
  const sanitized = rows.map(row =>
    row.map(cell => (cell === null || cell === undefined) ? "" : cell)
  );
  const numRows: number = sanitized.length;
  const numCols: number = sanitized[0].length;
  sheet.getRange(startCell).getResizedRange(numRows - 1, numCols - 1).setValues(sanitized);
}

function tidyGrandTotalRow(sheet: ExcelScript.Worksheet): void {
  const grandTotalRange: ExcelScript.Range = sheet.getRange("E2:K2");
  grandTotalRange.unmerge();
  grandTotalRange.clear(ExcelScript.ClearApplyTo.contents);
  grandTotalRange.merge();
  grandTotalRange.setValues([["Grand Total", "", "", "", "", "", ""]]);
  grandTotalRange.getFormat().getFont().setItalic(true);
  grandTotalRange.getFormat().getFont().setSize(9.5);
  grandTotalRange.getFormat().getFont().setColor(THEME.colors.textMuted);
  grandTotalRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
}

// ── ENTERPRISE SYNC AUDIT LOG ──────────────────────────────────────────────

function getOrCreateLogSheet(workbook: ExcelScript.Workbook): ExcelScript.Worksheet {
  const sheets: ExcelScript.Worksheet[] = workbook.getWorksheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase().trim() === LOG_SHEET_NAME.toLowerCase()) {
      const existingSheet: ExcelScript.Worksheet = sheets[i];
      existingSheet.getRange("E:E").setColumnHidden(true);
      return existingSheet;
    }
  }

  const logSheet: ExcelScript.Worksheet = workbook.addWorksheet(LOG_SHEET_NAME);
  formatWorksheetAsAppContainer(logSheet);
  setupAppShell(workbook, logSheet, "CIN7 SYNC AUDIT LOG");

  const headerRange: ExcelScript.Range = logSheet.getRange("A4:E4");
  headerRange.setValues([LOG_HEADERS]);
  headerRange.getFormat().getFont().setBold(true);
  headerRange.getFormat().getFont().setColor("#FFFFFF");
  headerRange.getFormat().getFill().setColor(THEME.colors.tableHeaderBg);
  headerRange.getFormat().setRowHeight(26);

  logSheet.getRange("A:A").getFormat().setColumnWidth(160);
  logSheet.getRange("B:B").getFormat().setColumnWidth(110);
  logSheet.getRange("C:C").getFormat().setColumnWidth(140);
  logSheet.getRange("D:D").getFormat().setColumnWidth(280);
  logSheet.getRange("E:E").setColumnHidden(true);
  logSheet.getFreezePanes().freezeRows(4);

  return logSheet;
}

function logSyncStart(workbook: ExcelScript.Workbook, timelineValue: string): string {
  const logSheet: ExcelScript.Worksheet = getOrCreateLogSheet(workbook);
  const now: string = new Date().toLocaleString();
  const runId: string = `run-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const newRowRange: ExcelScript.Range = logSheet.getRange("A5:E5");
  newRowRange.insert(ExcelScript.InsertShiftDirection.down);
  newRowRange.setValues([[now, "Running", timelineValue, "Sync process initiated...", runId]]);
  newRowRange.getFormat().setRowHeight(22);

  const statusCell: ExcelScript.Range = logSheet.getRange("B5");
  statusCell.getFormat().getFill().setColor(THEME.statusBadges.warning.fill);
  statusCell.getFormat().getFont().setColor(THEME.statusBadges.warning.font);
  statusCell.getFormat().getFont().setBold(true);
  setBoxBorder(statusCell, THEME.statusBadges.warning.border);

  const usedRange: ExcelScript.Range = logSheet.getUsedRange();
  if (usedRange) {
    const lastRow: number = usedRange.getRowCount();
    const maxDataRow: number = 4 + LOG_MAX_ENTRIES;
    if (lastRow > maxDataRow) {
      logSheet.getRange(`A${maxDataRow + 1}:E${lastRow}`).delete(ExcelScript.DeleteShiftDirection.up);
    }
  }

  return runId;
}

function logSyncFinish(workbook: ExcelScript.Workbook, runId: string, status: string, detail: string): void {
  const logSheet: ExcelScript.Worksheet = getOrCreateLogSheet(workbook);
  const usedRange: ExcelScript.Range = logSheet.getUsedRange();
  if (!usedRange) return;

  const rowCount: number = usedRange.getRowCount();
  const idValues: string[][] = logSheet.getRange(`E1:E${rowCount}`).getValues() as string[][];

  let targetRow: number = -1;
  for (let i = 4; i < idValues.length; i++) {
    if (idValues[i][0] === runId) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) return;

  const statusCell: ExcelScript.Range = logSheet.getRange(`B${targetRow}`);
  const detailCell: ExcelScript.Range = logSheet.getRange(`D${targetRow}`);
  statusCell.setValue(status);
  detailCell.setValue(detail);

  const isSuccess = status === "Success";
  const badgeStyle = isSuccess ? THEME.statusBadges.success : THEME.statusBadges.error;

  statusCell.getFormat().getFill().setColor(badgeStyle.fill);
  statusCell.getFormat().getFont().setColor(badgeStyle.font);
  statusCell.getFormat().getFont().setBold(true);
  setBoxBorder(statusCell, badgeStyle.border);
}

// ── UTILITY HELPERS ─────────────────────────────────────────────────────────

function setBoxBorder(range: ExcelScript.Range, borderColor: string): void {
  const edges = [
    ExcelScript.BorderIndex.edgeTop,
    ExcelScript.BorderIndex.edgeBottom,
    ExcelScript.BorderIndex.edgeLeft,
    ExcelScript.BorderIndex.edgeRight
  ];
  edges.forEach((edge) => {
    const border = range.getFormat().getRangeBorder(edge);
    border.setColor(borderColor);
    border.setStyle(ExcelScript.BorderLineStyle.continuous);
    border.setWeight(ExcelScript.BorderWeight.thin);
  });
}

function getColumnHeader(columnIndex: number): string {
  let temp = "";
  let letter = "";
  while (columnIndex >= 0) {
    temp = columnIndex % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    columnIndex = (columnIndex - temp) / 26 - 1;
  }
  return letter;
}