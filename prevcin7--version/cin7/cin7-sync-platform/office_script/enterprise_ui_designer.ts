/**
 * ============================================================================
 * COMMERCIAL ENTERPRISE REPORTING APPLICATION DESIGN SYSTEM & UI ARCHITECT
 * ============================================================================
 * Design Inspiration: Microsoft Fabric | Power BI | Dynamics 365 | SAP Analytics Cloud
 * Target Platform: Microsoft Excel Office Scripts (TypeScript)
 * 
 * Transforms Excel worksheets into commercial desktop-grade business apps with:
 * - Branded Title Bar & Navigation Bar
 * - Dashboard KPI Information Cards
 * - Hidden Gridlines & Soft Container Canvas
 * - Modern Color Palette & Typography Hierarchy
 * - Enterprise Data Grid & Table Styling
 * - Status Pill Badges & Responsive Layout
 * - Freeze Panes & Auto-fitting Column Widths
 * ============================================================================
 */

// ── DESIGN SYSTEM TOKENS & PALETTE (Microsoft Fabric / Power BI Theme) ────────
export const ENTERPRISE_THEME = {
  fontFamily: "Segoe UI",
  
  // Color Palette
  colors: {
    // Header & Navigation
    titleBarBg: "#0F172A",       // Deep Slate Navy (Fabric 900)
    titleBarText: "#FFFFFF",     // Pure White
    titleBarSubtext: "#94A3B8",  // Slate Muted
    
    navBarBg: "#1E293B",         // Dark Slate (Fabric 800)
    navTabActiveBg: "#0F6CBD",   // Fabric Accent Blue
    navTabActiveText: "#FFFFFF",
    navTabInactiveBg: "#1E293B",
    navTabInactiveText: "#CBD5E1",
    
    // Canvas & Containers
    canvasBg: "#F8FAFC",         // Off-White / Soft Slate Tint (Slate 50)
    cardBg: "#FFFFFF",           // Crisp Card Fill
    cardBorder: "#E2E8F0",       // Subtle Slate Border (Slate 200)
    cardTopAccent: "#0F6CBD",    // Fabric Accent
    
    // Data Grid / Tables
    tableHeaderBg: "#1E293B",    // Dark Header Fill
    tableHeaderText: "#FFFFFF",  // Header Text
    tableRowEvenBg: "#FFFFFF",   // Primary Row
    tableRowOddBg: "#F8FAFC",    // Zebra Row Tint
    tableBorder: "#E2E8F0",      // Light Cell Border
    tableText: "#334155",        // Dark Text (Slate 700)
    
    // Text Hierarchy
    textPrimary: "#0F172A",
    textSecondary: "#475569",
    textMuted: "#64748B",
  },

  // Status Badges (Pill style fill + text + border)
  statusBadges: {
    success: {
      fill: "#DCFCE7",
      font: "#15803D",
      border: "#86EFAC",
      labelPrefix: "● "
    },
    warning: {
      fill: "#FEF3C7",
      font: "#B45309",
      border: "#FDE68A",
      labelPrefix: "▲ "
    },
    error: {
      fill: "#FEE2E2",
      font: "#B91C1C",
      border: "#FCA5A5",
      labelPrefix: "✖ "
    },
    info: {
      fill: "#E0F2FE",
      font: "#0369A1",
      border: "#BAE6FD",
      labelPrefix: "ℹ "
    }
  }
};

/** Interface for KPI Card definition */
export interface KpiCardConfig {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: string;
  statusType?: "success" | "warning" | "error" | "info";
  numberFormat?: string;
}

/** Entry Point: Formats the active sheet or entire workbook into an Enterprise App */
export async function main(workbook: ExcelScript.Workbook): Promise<void> {
  const activeSheet = workbook.getActiveWorksheet();
  
  // 1. Apply global container formatting to all worksheets
  const sheets = workbook.getWorksheets();
  for (let i = 0; i < sheets.length; i++) {
    formatWorksheetAsAppContainer(sheets[i]);
  }

  // 2. Build App Title Bar & Nav Tabs on active sheet
  setupAppShell(workbook, activeSheet, "CIN7 ENTERPRISE ANALYTICS SUITE");

  // 3. Format any existing tables/used ranges into enterprise data grids
  const usedRange = activeSheet.getUsedRange();
  if (usedRange) {
    const lastRow = usedRange.getRowCount();
    const lastCol = usedRange.getColumnCount();

    // If table starts around row 5-8, format data table
    if (lastRow > 6) {
      const dataRangeAddress = `A6:${getColumnHeader(lastCol - 1)}${lastRow}`;
      formatEnterpriseDataGrid(activeSheet, dataRangeAddress);
    }
  }

  // 4. Freeze panes below top navigation bar
  activeSheet.getFreezePanes().freezeRows(3);
}

/**
 * Transforms a worksheet into an enterprise app canvas:
 * Hides gridlines, sets background color for canvas area, standardizes font family.
 */
export function formatWorksheetAsAppContainer(sheet: ExcelScript.Worksheet): void {
  // Hide gridlines for a clean desktop app look
  sheet.setShowGridlines(false);
  
  // Set default container range font & sizing
  const fullCanvas = sheet.getRange("A1:Z100");
  fullCanvas.getFormat().getFont().setName(ENTERPRISE_THEME.fontFamily);
}

/**
 * Builds the top Enterprise App Shell:
 * Row 1: Branded Title Bar with System Badges
 * Row 2: Interactive Sheet Navigation Bar
 * Row 3: Workspace Spacer Row
 */
export function setupAppShell(
  workbook: ExcelScript.Workbook,
  sheet: ExcelScript.Worksheet,
  appTitle: string = "ENTERPRISE REPORTING ENGINE"
): void {
  const maxColIndex = 11; // Columns A to L (0 to 11)
  const maxColLetter = getColumnHeader(maxColIndex);

  // ── ROW 1: BRANDED TITLE BAR ──────────────────────────────────────────────
  const titleRange = sheet.getRange(`A1:${maxColLetter}1`);
  sheet.getRange("A1").setValue(`⚡  ${appTitle}   |   CIN7 SYNC PLATFORM`);
  
  titleRange.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.titleBarBg);
  titleRange.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.titleBarText);
  titleRange.getFormat().getFont().setBold(true);
  titleRange.getFormat().getFont().setSize(12);
  titleRange.getFormat().getFont().setName(ENTERPRISE_THEME.fontFamily);
  titleRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);
  titleRange.getFormat().setRowHeight(32);

  // Right-aligned status badge in title bar (Col K:L or Col L)
  const titleRightCell = sheet.getRange(`${maxColLetter}1`);
  titleRightCell.setValue("[ SYSTEM STATUS: ONLINE ]");
  titleRightCell.getFormat().getFont().setSize(9);
  titleRightCell.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.titleBarSubtext);
  titleRightCell.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.right);

  // ── ROW 2: DESKTOP NAVIGATION TAB BAR ─────────────────────────────────────
  const navRange = sheet.getRange(`A2:${maxColLetter}2`);
  navRange.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.navBarBg);
  navRange.getFormat().setRowHeight(26);

  const sheets = workbook.getWorksheets();
  const currentSheetName = sheet.getName();

  // Draw sheet tabs across columns A2, B2, C2, etc.
  for (let i = 0; i < Math.min(sheets.length, 6); i++) {
    const tabCell = sheet.getRange(`${getColumnHeader(i)}2`);
    const sName = sheets[i].getName();
    const isActive = sName.toLowerCase().trim() === currentSheetName.toLowerCase().trim();

    tabCell.setValue(isActive ? `▶  ${sName.toUpperCase()}` : `   ${sName}   `);
    tabCell.getFormat().getFont().setSize(9.5);
    tabCell.getFormat().getFont().setName(ENTERPRISE_THEME.fontFamily);
    tabCell.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);
    tabCell.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);

    if (isActive) {
      tabCell.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.navTabActiveBg);
      tabCell.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.navTabActiveText);
      tabCell.getFormat().getFont().setBold(true);
      // Bottom accent border for active tab
      const bottomBorder = tabCell.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeBottom);
      bottomBorder.setColor("#38BDF8");
      bottomBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
      bottomBorder.setWeight(ExcelScript.BorderWeight.medium);
    } else {
      tabCell.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.navTabInactiveBg);
      tabCell.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.navTabInactiveText);
      tabCell.getFormat().getFont().setBold(false);
    }
  }

  // ── ROW 3: CANVAS SEPARATOR / CONTROL BAR SPACER ─────────────────────────
  const spacerRange = sheet.getRange(`A3:${maxColLetter}3`);
  spacerRange.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.canvasBg);
  spacerRange.getFormat().setRowHeight(10);
}

/**
 * Creates Dashboard-Style KPI Information Cards in a specified row range.
 * Each card features a top accent border, metric label, large bold value, and trend/status badge.
 */
export function renderKpiCards(
  sheet: ExcelScript.Worksheet,
  cards: KpiCardConfig[],
  startRow: number = 4
): void {
  const cardWidthCols = 3; // Each card spans 3 columns (e.g. A-C, D-F, G-I)
  
  cards.forEach((card, index) => {
    const startColIdx = index * cardWidthCols;
    const endColIdx = startColIdx + cardWidthCols - 1;
    
    const startCol = getColumnHeader(startColIdx);
    const endCol = getColumnHeader(endColIdx);

    const cardHeaderRange = sheet.getRange(`${startCol}${startRow}:${endCol}${startRow}`);
    const cardValueRange = sheet.getRange(`${startCol}${startRow + 1}:${endCol}${startRow + 1}`);
    const cardFooterRange = sheet.getRange(`${startCol}${startRow + 2}:${endCol}${startRow + 2}`);
    const cardFullRange = sheet.getRange(`${startCol}${startRow}:${endCol}${startRow + 2}`);

    // Card background & borders
    cardFullRange.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.cardBg);
    
    // Set subtle card outer border
    setBoxBorder(cardFullRange, ENTERPRISE_THEME.colors.cardBorder);

    // Top card accent border line
    const topBorder = cardHeaderRange.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeTop);
    topBorder.setColor(ENTERPRISE_THEME.colors.cardTopAccent);
    topBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
    topBorder.setWeight(ExcelScript.BorderWeight.medium);

    // Header (Title)
    sheet.getRange(`${startCol}${startRow}`).setValue(card.title.toUpperCase());
    cardHeaderRange.getFormat().getFont().setSize(8.5);
    cardHeaderRange.getFormat().getFont().setBold(true);
    cardHeaderRange.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.textMuted);
    cardHeaderRange.getFormat().setRowHeight(18);
    cardHeaderRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.bottom);

    // Value (Metric)
    const valCell = sheet.getRange(`${startCol}${startRow + 1}`);
    valCell.setValue(card.value);
    if (card.numberFormat) {
      valCell.setNumberFormat(card.numberFormat);
    }
    cardValueRange.getFormat().getFont().setSize(16);
    cardValueRange.getFormat().getFont().setBold(true);
    cardValueRange.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.textPrimary);
    cardValueRange.getFormat().setRowHeight(28);
    cardValueRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

    // Footer / Trend / Status
    if (card.trend || card.subtitle) {
      const footerCell = sheet.getRange(`${startCol}${startRow + 2}`);
      footerCell.setValue(card.trend || card.subtitle || "");
      cardFooterRange.getFormat().getFont().setSize(8.5);
      cardFooterRange.getFormat().getFont().setColor(
        card.statusType === "success" ? "#16A34A" :
        card.statusType === "warning" ? "#D97706" :
        card.statusType === "error" ? "#DC2626" : ENTERPRISE_THEME.colors.textMuted
      );
      cardFooterRange.getFormat().setRowHeight(18);
      cardFooterRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.top);
    }
  });

  // Set card row heights cleanly
  sheet.getRange(`A${startRow}:Z${startRow}`).getFormat().setRowHeight(20);
  sheet.getRange(`A${startRow + 1}:Z${startRow + 1}`).getFormat().setRowHeight(30);
  sheet.getRange(`A${startRow + 2}:Z${startRow + 2}`).getFormat().setRowHeight(20);
}

/**
 * Formats a given range address into a commercial Enterprise Data Grid.
 * Features: Deep header fill, crisp white header text, zebra row striping,
 * auto cell alignment, cell borders, and automatic column widths.
 */
export function formatEnterpriseDataGrid(
  sheet: ExcelScript.Worksheet,
  rangeAddress: string,
  options?: {
    headerBg?: string;
    headerText?: string;
    zebra?: boolean;
    autoFit?: boolean;
  }
): void {
  const gridRange = sheet.getRange(rangeAddress);
  const rowCount = gridRange.getRowCount();
  const colCount = gridRange.getColumnCount();

  if (rowCount === 0 || colCount === 0) return;

  const headerBg = options?.headerBg || ENTERPRISE_THEME.colors.tableHeaderBg;
  const headerText = options?.headerText || ENTERPRISE_THEME.colors.tableHeaderText;
  const isZebra = options?.zebra !== false;

  // ── 1. HEADER ROW STYLING ──────────────────────────────────────────────────
  const headerRange = gridRange.getResizedRange(-(rowCount - 1), 0);
  headerRange.getFormat().getFill().setColor(headerBg);
  headerRange.getFormat().getFont().setColor(headerText);
  headerRange.getFormat().getFont().setBold(true);
  headerRange.getFormat().getFont().setSize(9.5);
  headerRange.getFormat().getFont().setName(ENTERPRISE_THEME.fontFamily);
  headerRange.getFormat().setRowHeight(26);
  headerRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

  // Bottom accent line under header
  const headerBottomBorder = headerRange.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeBottom);
  headerBottomBorder.setColor("#0EA5E9");
  headerBottomBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
  headerBottomBorder.setWeight(ExcelScript.BorderWeight.medium);

  // ── 2. DATA ROWS STYLING & ZEBRA STRIPING ─────────────────────────────────
  if (rowCount > 1) {
    const dataRange = gridRange.getOffsetRange(1, 0).getResizedRange(-1, 0);
    dataRange.getFormat().getFont().setName(ENTERPRISE_THEME.fontFamily);
    dataRange.getFormat().getFont().setSize(9.5);
    dataRange.getFormat().getFont().setColor(ENTERPRISE_THEME.colors.tableText);
    dataRange.getFormat().setVerticalAlignment(ExcelScript.VerticalAlignment.center);

    // Apply Zebra striping row by row for precise container control
    for (let r = 1; r < rowCount; r++) {
      const rowRange = gridRange.getCell(r, 0).getResizedRange(0, colCount - 1);
      rowRange.getFormat().setRowHeight(22);

      if (isZebra && r % 2 === 1) {
        rowRange.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.tableRowOddBg);
      } else {
        rowRange.getFormat().getFill().setColor(ENTERPRISE_THEME.colors.tableRowEvenBg);
      }

      // Thin bottom border between rows
      const bBorder = rowRange.getFormat().getRangeBorder(ExcelScript.BorderIndex.edgeBottom);
      bBorder.setColor(ENTERPRISE_THEME.colors.tableBorder);
      bBorder.setStyle(ExcelScript.BorderLineStyle.continuous);
      bBorder.setWeight(ExcelScript.BorderWeight.thin);
    }
  }

  // ── 3. AUTO FIT & COLUMN WIDTH PADDING ────────────────────────────────────
  if (options?.autoFit !== false) {
    gridRange.getFormat().autofitColumns();
    
    // Add safety width padding so text/numbers never show ###
    for (let c = 0; c < colCount; c++) {
      const colRange = gridRange.getCell(0, c).getEntireColumn();
      const currentWidth = colRange.getFormat().getColumnWidth();
      const newWidth = Math.max(currentWidth + 18, 110);
      colRange.getFormat().setColumnWidth(newWidth);
    }
  }

  // ── 4. DYNAMIC COLUMN NUMBER FORMATTING & ALIGNMENT DETECTOR ───────────────
  autoFormatColumnDataTypes(sheet, gridRange);
}

/**
 * Intelligently detects data types (Dates, Currency, Quantity/Numbers, IDs, Status)
 * across columns and applies enterprise number formatting and alignments.
 */
export function autoFormatColumnDataTypes(
  sheet: ExcelScript.Worksheet,
  gridRange: ExcelScript.Range
): void {
  const rowCount = gridRange.getRowCount();
  const colCount = gridRange.getColumnCount();
  if (rowCount < 2) return;

  const headerValues = gridRange.getResizedRange(-(rowCount - 1), 0).getValues()[0] as string[];

  for (let c = 0; c < colCount; c++) {
    const headerName = String(headerValues[c] || "").toLowerCase();
    const dataColRange = gridRange.getCell(1, c).getResizedRange(rowCount - 2, 0);

    if (
      headerName.includes("price") ||
      headerName.includes("total") ||
      headerName.includes("amount") ||
      headerName.includes("revenue") ||
      headerName.includes("cost") ||
      headerName.includes("value") ||
      headerName.includes("margin")
    ) {
      // Currency column: Right-aligned, $#,##0.00
      dataColRange.setNumberFormat("$#,##0.00");
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.right);
    } else if (
      headerName.includes("qty") ||
      headerName.includes("quantity") ||
      headerName.includes("count") ||
      headerName.includes("units") ||
      headerName.includes("on hand") ||
      headerName.includes("available")
    ) {
      // Numeric quantity: Right-aligned, #,##0
      dataColRange.setNumberFormat("#,##0");
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.right);
    } else if (
      headerName.includes("date") ||
      headerName.includes("created") ||
      headerName.includes("updated") ||
      headerName.includes("time")
    ) {
      // Date column: Center-aligned, yyyy-mm-dd
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
    } else if (
      headerName.includes("status") ||
      headerName.includes("state") ||
      headerName.includes("condition")
    ) {
      // Status column: Center-aligned + apply Pill Badges
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
      applyStatusBadgesToRange(sheet, dataColRange);
    } else if (
      headerName.includes("id") ||
      headerName.includes("code") ||
      headerName.includes("sku") ||
      headerName.includes("number") ||
      headerName.includes("reference")
    ) {
      // Key/ID column: Center or Left-aligned text
      dataColRange.getFormat().setHorizontalAlignment(ExcelScript.HorizontalAlignment.center);
    }
  }
}

/**
 * Transforms string status values in a range into styled enterprise status pill badges.
 * Supports: Success / Completed / Active / Online, Pending / Syncing / Warning, Failed / Error, Info.
 */
export function applyStatusBadgesToRange(
  sheet: ExcelScript.Worksheet,
  range: ExcelScript.Range
): void {
  const rowCount = range.getRowCount();
  const colCount = range.getColumnCount();
  const values = range.getValues();

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const cell = range.getCell(r, c);
      const valStr = String(values[r][c] || "").trim();
      const valLower = valStr.toLowerCase();

      if (!valStr) continue;

      let badgeStyle = ENTERPRISE_THEME.statusBadges.info;

      if (
        valLower.includes("success") ||
        valLower.includes("complete") ||
        valLower.includes("active") ||
        valLower.includes("online") ||
        valLower.includes("synced") ||
        valLower.includes("passed") ||
        valLower.includes("ok")
      ) {
        badgeStyle = ENTERPRISE_THEME.statusBadges.success;
      } else if (
        valLower.includes("pending") ||
        valLower.includes("running") ||
        valLower.includes("syncing") ||
        valLower.includes("progress") ||
        valLower.includes("warning") ||
        valLower.includes("hold")
      ) {
        badgeStyle = ENTERPRISE_THEME.statusBadges.warning;
      } else if (
        valLower.includes("fail") ||
        valLower.includes("error") ||
        valLower.includes("cancel") ||
        valLower.includes("offline") ||
        valLower.includes("alert")
      ) {
        badgeStyle = ENTERPRISE_THEME.statusBadges.error;
      }

      // Apply pill fill, font color, and thin border
      cell.getFormat().getFill().setColor(badgeStyle.fill);
      cell.getFormat().getFont().setColor(badgeStyle.font);
      cell.getFormat().getFont().setBold(true);
      cell.getFormat().getFont().setSize(9);

      setBoxBorder(cell, badgeStyle.border);
    }
  }
}

/** Helper to draw clean outer box border on a range */
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

/** Helper to convert 0-indexed column number to Excel column letter (0 -> A, 1 -> B, 25 -> Z, 26 -> AA) */
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
