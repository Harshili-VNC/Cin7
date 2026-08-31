"""
============================================================================
COMMERCIAL ENTERPRISE REPORTING APPLICATION - CIN7 SYNC ENGINE (PYTHON PORT)
============================================================================
Target Platform: Python (openpyxl + requests / xlwings)

Features:
- Branded Enterprise Header & Desktop Navigation Bar
- Real-Time Dashboard KPI Cards
- Gridlines Customization & Responsive Canvas Styling
- Commercial Data Grid Styling & Automatic Number Formatting
- Enterprise Status Badges & Freeze Panes
- Timeline Data Validation Controls & Multi-Sheet Setup
- Commercial Audit Log (Sync Log)
============================================================================
"""

import datetime
import random
import os
from typing import Dict, List, Any, Optional

import requests
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

# ── DESIGN SYSTEM & COLOR PALETTE TOKENS ───────────────────────────────────
THEME = {
    "font_family": "Segoe UI",
    "colors": {
        "title_bar_bg": "0F172A",       # Deep Slate Navy
        "title_bar_text": "FFFFFF",     # Pure White
        "title_bar_subtext": "94A3B8",  # Muted Gray
        "nav_bar_bg": "1E293B",         # Slate 800
        "nav_tab_active_bg": "0F6CBD",   # Fabric Accent Blue
        "nav_tab_active_text": "FFFFFF",
        "nav_tab_inactive_bg": "1E293B",
        "nav_tab_inactive_text": "CBD5E1",
        "control_bar_bg": "F1F5F9",     # Soft Bar Tint (Slate 100)
        "canvas_bg": "F8FAFC",         # Canvas Background (Slate 50)
        "card_bg": "FFFFFF",           # Card Surface
        "card_border": "CBD5E1",       # Card Border
        "card_top_accent": "0F6CBD",    # Accent Line
        "table_header_bg": "1E293B",    # Grid Header Background
        "table_header_text": "FFFFFF",  # Grid Header Text
        "table_row_even_bg": "FFFFFF",   # Grid Row White
        "table_row_odd_bg": "F8FAFC",    # Grid Row Zebra Slate 50
        "table_border": "E2E8F0",      # Light Cell Border
        "table_text": "334155",        # Dark Text
        "text_primary": "0F172A",
        "text_secondary": "475569",
        "text_muted": "64748B",
    },
    "status_badges": {
        "success": {"fill": "DCFCE7", "font": "15803D", "border": "86EFAC"},
        "warning": {"fill": "FEF3C7", "font": "B45309", "border": "FDE68A"},
        "error": {"fill": "FEE2E2", "font": "B91C1C", "border": "FCA5A5"},
        "info": {"fill": "E0F2FE", "font": "0369A1", "border": "BAE6FD"},
    }
}

# ── LOG SHEET SETTINGS ──────────────────────────────────────────────────────
LOG_SHEET_NAME: str = "Sync Log"
LOG_MAX_ENTRIES: int = 20
LOG_HEADERS: List[str] = ["Date & Time", "Status", "Timeline Period", "Rows Synced / Reason", "Run ID"]

# ── CANONICAL SHEET NAMES ───────────────────────────────────────────────────
SALES_SHEET: str = "Sales Transactions Raw Data"
INVENTORY_SHEET: str = "Inventory On Hand Raw Data"
PURCHASES_SHEET: str = "Purchase Transactions Raw data"

VALID_OPTIONS: List[str] = [
    "Last 30 days", "Last 365 days", "Last month", "This month",
    "Last quarter", "This quarter", "QTD (Quarter to date)",
    "Last year", "This year", "Last YTD (year to date)",
    "Last MTD (month to date)", "All Time"
]


# ── UTILITY HELPERS ─────────────────────────────────────────────────────────

def calculate_start_date(timeline_input: str) -> Optional[datetime.datetime]:
    """Calculates UTC datetime threshold based on selected timeline string."""
    now = datetime.datetime.now(datetime.timezone.utc)
    option = (timeline_input or "").lower().strip()

    if "30" in option:
        return now - datetime.timedelta(days=30)
    elif "365" in option:
        return now - datetime.timedelta(days=365)
    elif "last month" in option:
        first_of_this_month = now.replace(day=1)
        last_month_end = first_of_this_month - datetime.timedelta(days=1)
        return last_month_end.replace(day=1)
    elif "this month" in option or "mtd" in option:
        return now.replace(day=1)
    elif "last quarter" in option:
        q = (now.month - 1) // 3 - 1
        year = now.year + (q // 4)
        month = (q % 4) * 3 + 1
        return datetime.datetime(year, month, 1, tzinfo=datetime.timezone.utc)
    elif "this quarter" in option or "qtd" in option:
        q = (now.month - 1) // 3
        month = q * 3 + 1
        return datetime.datetime(now.year, month, 1, tzinfo=datetime.timezone.utc)
    elif "last year" in option:
        return datetime.datetime(now.year - 1, 1, 1, tzinfo=datetime.timezone.utc)
    elif "this year" in option or "ytd" in option:
        return datetime.datetime(now.year, 1, 1, tzinfo=datetime.timezone.utc)
    elif "all" in option:
        return None
    return now - datetime.timedelta(days=30)


def get_or_create_sheet(wb: openpyxl.Workbook, target_name: str) -> openpyxl.worksheet.worksheet.Worksheet:
    """Finds or creates a worksheet by canonical name or keyword match."""
    target_lower = target_name.lower().strip()
    for sheet in wb.worksheets:
        if sheet.title.lower().strip() == target_lower:
            return sheet

    category_keyword = ""
    if "sale" in target_lower:
        category_keyword = "sale"
    elif "inventory" in target_lower or "stock" in target_lower:
        category_keyword = "inventory"
    elif "purchase" in target_lower or "po" in target_lower:
        category_keyword = "purchase"

    if category_keyword:
        for sheet in wb.worksheets:
            s_name = sheet.title.lower()
            if "raw" in s_name and (category_keyword in s_name or (category_keyword == "inventory" and "stock" in s_name)):
                return sheet
        for sheet in wb.worksheets:
            s_name = sheet.title.lower()
            if category_keyword in s_name:
                return sheet

    return wb.create_sheet(title=target_name)


def set_box_border(ws: openpyxl.worksheet.worksheet.Worksheet,
                   start_row: int, start_col: int,
                   end_row: int, end_col: int,
                   border_color: str,
                   style: str = "thin") -> None:
    """Applies a outer/inner border color to a cell range."""
    side = Side(border_style=style, color=border_color)
    for r in range(start_row, end_row + 1):
        for c in range(start_col, end_col + 1):
            cell = ws.cell(row=r, column=c)
            top = side if r == start_row else (cell.border.top if cell.border else Side())
            bottom = side if r == end_row else (cell.border.bottom if cell.border else Side())
            left = side if c == start_col else (cell.border.left if cell.border else Side())
            right = side if c == end_col else (cell.border.right if cell.border else Side())
            cell.border = Border(top=top, bottom=bottom, left=left, right=right)


# ── ENTERPRISE UI & LAYOUT ENGINE ──────────────────────────────────────────

def format_worksheet_as_app_container(ws: openpyxl.worksheet.worksheet.Worksheet) -> None:
    """Sets sheet gridlines property and default font styling."""
    ws.views.sheetView[0].showGridLines = False
    default_font = Font(name=THEME["font_family"])
    for row in ws.iter_rows(min_row=1, max_row=100, min_col=1, max_col=26):
        for cell in row:
            cell.font = default_font


def setup_app_shell(wb: openpyxl.Workbook, ws: openpyxl.worksheet.worksheet.Worksheet, app_title: str) -> None:
    """Builds top Branded App Shell Title Bar (Row 1) & Desktop Navigation Tab Bar (Row 2)."""
    max_cols = 12

    # ── ROW 1: BRANDED TITLE BAR ──────────────────────────────────────────────
    ws.row_dimensions[1].height = 32
    title_fill = PatternFill(start_color=THEME["colors"]["title_bar_bg"],
                             end_color=THEME["colors"]["title_bar_bg"], fill_type="solid")

    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max_cols - 2)
    left_cell = ws.cell(row=1, column=1)
    left_cell.value = f"⚡  {app_title}   |   CIN7 SYNC PLATFORM"
    left_cell.font = Font(name=THEME["font_family"], size=11, bold=True, color=THEME["colors"]["title_bar_text"])
    left_cell.alignment = Alignment(vertical="center")

    ws.merge_cells(start_row=1, start_column=max_cols - 1, end_row=1, end_column=max_cols)
    right_cell = ws.cell(row=1, column=max_cols - 1)
    right_cell.value = "[ PROD ENGINE  |  CONNECTED ]"
    right_cell.font = Font(name=THEME["font_family"], size=8.5, color=THEME["colors"]["title_bar_subtext"])
    right_cell.alignment = Alignment(horizontal="right", vertical="center")

    for col in range(1, max_cols + 1):
        ws.cell(row=1, column=col).fill = title_fill

    # ── ROW 2: DESKTOP NAVIGATION TAB BAR ─────────────────────────────────────
    ws.row_dimensions[2].height = 26
    nav_fill = PatternFill(start_color=THEME["colors"]["nav_bar_bg"],
                           end_color=THEME["colors"]["nav_bar_bg"], fill_type="solid")
    
    for col in range(1, max_cols + 1):
        ws.cell(row=2, column=col).fill = nav_fill

    sheets = wb.worksheets
    current_name = ws.title.lower().strip()

    for idx in range(min(len(sheets), 6)):
        col_idx = idx + 1
        cell = ws.cell(row=2, column=col_idx)
        s_name = sheets[idx].title
        is_active = (s_name.lower().strip() == current_name)

        cell.value = f"▶  {s_name.upper()}" if is_active else f"   {s_name}   "
        cell.alignment = Alignment(horizontal="center", vertical="center")

        if is_active:
            cell.fill = PatternFill(start_color=THEME["colors"]["nav_tab_active_bg"],
                                     end_color=THEME["colors"]["nav_tab_active_bg"], fill_type="solid")
            cell.font = Font(name=THEME["font_family"], size=9, bold=True, color=THEME["colors"]["nav_tab_active_text"])
            cell.border = Border(bottom=Side(border_style="medium", color="38BDF8"))
        else:
            cell.fill = PatternFill(start_color=THEME["colors"]["nav_tab_inactive_bg"],
                                     end_color=THEME["colors"]["nav_tab_inactive_bg"], fill_type="solid")
            cell.font = Font(name=THEME["font_family"], size=9, bold=False, color=THEME["colors"]["nav_tab_inactive_text"])


def setup_control_row(ws: openpyxl.worksheet.worksheet.Worksheet, options_list: str) -> None:
    """Configures Row 3 Toolbar (Timeline dropdown & status message)."""
    ws.row_dimensions[3].height = 26
    ctrl_fill = PatternFill(start_color=THEME["colors"]["control_bar_bg"],
                            end_color=THEME["colors"]["control_bar_bg"], fill_type="solid")
    
    for col in range(1, 13):
        ws.cell(row=3, column=col).fill = ctrl_fill

    # Cell A3 label
    label_cell = ws.cell(row=3, column=1)
    label_cell.value = "TIMELINE PERIOD:"
    label_cell.font = Font(name=THEME["font_family"], size=8.5, bold=True, color=THEME["colors"]["text_secondary"])
    label_cell.alignment = Alignment(horizontal="left", vertical="center")

    # Cell B3 dropdown
    dropdown_cell = ws.cell(row=3, column=2)
    dropdown_cell.fill = PatternFill(start_color="FFFFFF", end_color="FFFFFF", fill_type="solid")
    dropdown_cell.font = Font(name=THEME["font_family"], size=9, bold=True, color=THEME["colors"]["text_primary"])
    dropdown_cell.alignment = Alignment(vertical="center")
    set_box_border(ws, 3, 2, 3, 2, THEME["colors"]["card_border"])

    # Data Validation List
    dv = DataValidation(type="list", formula1=f'"{options_list}"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add(dropdown_cell)


def set_timeline_and_status(ws: openpyxl.worksheet.worksheet.Worksheet,
                           timeline_value: str,
                           status_message: str,
                           status_type: str = "info") -> None:
    """Updates Timeline value in B3 and status text badge in D3."""
    ws.cell(row=3, column=2).value = timeline_value
    ws.cell(row=1, column=2).value = timeline_value  # Backwards compatibility B1

    status_cell = ws.cell(row=3, column=4)
    status_cell.value = status_message

    badge_style = THEME["status_badges"].get(status_type, THEME["status_badges"]["info"])
    status_cell.fill = PatternFill(start_color=badge_style["fill"], end_color=badge_style["fill"], fill_type="solid")
    status_cell.font = Font(name=THEME["font_family"], size=9, bold=True, color=badge_style["font"])
    status_cell.alignment = Alignment(vertical="center")
    set_box_border(ws, 3, 4, 3, 4, badge_style["border"])

    # Backwards compatibility D1
    ws.cell(row=1, column=4).value = status_message


def render_sheet_kpi_cards(ws: openpyxl.worksheet.worksheet.Worksheet, cards: List[Dict[str, Any]]) -> None:
    """Renders Dashboard KPI Cards in Rows 4-6."""
    start_row = 4
    card_width_cols = 3

    # Row Heights
    ws.row_dimensions[4].height = 18
    ws.row_dimensions[5].height = 26
    ws.row_dimensions[6].height = 18
    ws.row_dimensions[7].height = 10  # Spacer row

    spacer_fill = PatternFill(start_color=THEME["colors"]["canvas_bg"],
                              end_color=THEME["colors"]["canvas_bg"], fill_type="solid")
    for col in range(1, 13):
        ws.cell(row=7, column=col).fill = spacer_fill

    card_fill = PatternFill(start_color=THEME["colors"]["card_bg"],
                            end_color=THEME["colors"]["card_bg"], fill_type="solid")

    for idx, card in enumerate(cards):
        start_col = idx * card_width_cols + 1
        end_col = start_col + card_width_cols - 1

        # Fill background & box border
        for r in range(start_row, start_row + 3):
            for c in range(start_col, end_col + 1):
                ws.cell(row=r, column=c).fill = card_fill

        set_box_border(ws, start_row, start_col, start_row + 2, end_col, THEME["colors"]["card_border"])

        # Accent top border
        top_accent_side = Side(border_style="medium", color=THEME["colors"]["card_top_accent"])
        for c in range(start_col, end_col + 1):
            cell = ws.cell(row=start_row, column=c)
            cell.border = Border(top=top_accent_side,
                                 left=cell.border.left if cell.border else Side(),
                                 right=cell.border.right if cell.border else Side(),
                                 bottom=cell.border.bottom if cell.border else Side())

        # Title (Row 4)
        title_cell = ws.cell(row=start_row, column=start_col)
        title_cell.value = str(card.get("title", "")).upper()
        title_cell.font = Font(name=THEME["font_family"], size=8, bold=True, color=THEME["colors"]["text_muted"])
        title_cell.alignment = Alignment(vertical="bottom")

        # Value (Row 5)
        val_cell = ws.cell(row=start_row + 1, column=start_col)
        val_cell.value = card.get("value", "")
        if "number_format" in card and card["number_format"]:
            val_cell.number_format = card["number_format"]
        val_cell.font = Font(name=THEME["font_family"], size=15, bold=True, color=THEME["colors"]["text_primary"])
        val_cell.alignment = Alignment(vertical="center")

        # Subtitle/Trend (Row 6)
        footer_text = card.get("trend") or card.get("subtitle") or ""
        if footer_text:
            footer_cell = ws.cell(row=start_row + 2, column=start_col)
            footer_cell.value = footer_text
            st_type = card.get("statusType", "info")
            footer_color = (
                "16A34A" if st_type == "success" else
                "D97706" if st_type == "warning" else
                "DC2626" if st_type == "error" else THEME["colors"]["text_muted"]
            )
            footer_cell.font = Font(name=THEME["font_family"], size=8, bold=False, color=footer_color)
            footer_cell.alignment = Alignment(vertical="top")


def format_enterprise_data_grid(ws: openpyxl.worksheet.worksheet.Worksheet,
                              start_row: int, start_col: int,
                              end_row: int, end_col: int) -> None:
    """Formats range as a commercial Enterprise Data Grid with headers, zebra striping, and auto-column widths."""
    if end_row < start_row or end_col < start_col:
        return

    # Header Row
    ws.row_dimensions[start_row].height = 26
    header_fill = PatternFill(start_color=THEME["colors"]["table_header_bg"],
                              end_color=THEME["colors"]["table_header_bg"], fill_type="solid")
    header_font = Font(name=THEME["font_family"], size=9.5, bold=True, color=THEME["colors"]["table_header_text"])
    header_bottom_side = Side(border_style="medium", color="0EA5E9")

    for col in range(start_col, end_col + 1):
        cell = ws.cell(row=start_row, column=col)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(vertical="center")
        cell.border = Border(bottom=header_bottom_side)

    # Data Rows
    row_count = end_row - start_row + 1
    if row_count > 1:
        data_font = Font(name=THEME["font_family"], size=9.5, color=THEME["colors"]["table_text"])
        thin_bottom = Side(border_style="thin", color=THEME["colors"]["table_border"])
        even_fill = PatternFill(start_color=THEME["colors"]["table_row_even_bg"], end_color=THEME["colors"]["table_row_even_bg"], fill_type="solid")
        odd_fill = PatternFill(start_color=THEME["colors"]["table_row_odd_bg"], end_color=THEME["colors"]["table_row_odd_bg"], fill_type="solid")

        for r_idx, r in enumerate(range(start_row + 1, end_row + 1), start=1):
            ws.row_dimensions[r].height = 22
            row_fill = odd_fill if (r_idx % 2 == 1) else even_fill

            for c in range(start_col, end_col + 1):
                cell = ws.cell(row=r, column=c)
                cell.fill = row_fill
                cell.font = data_font
                cell.alignment = Alignment(vertical="center")
                cell.border = Border(bottom=thin_bottom)

    # Auto Column Formatting & Auto Widths
    auto_format_columns(ws, start_row, start_col, end_row, end_col)


def auto_format_columns(ws: openpyxl.worksheet.worksheet.Worksheet,
                        start_row: int, start_col: int,
                        end_row: int, end_col: int) -> None:
    """Detects header column types and applies currency, numeric, date, and pill badge formatting."""
    if end_row <= start_row:
        return

    headers = [str(ws.cell(row=start_row, column=c).value or "").lower() for c in range(start_col, end_col + 1)]

    for c_offset, header_name in enumerate(headers):
        c = start_col + c_offset

        # Number & Alignment Formatting
        for r in range(start_row + 1, end_row + 1):
            cell = ws.cell(row=r, column=c)
            val_str = str(cell.value or "").strip().lower()

            if any(k in header_name for k in ["price", "total", "amount", "revenue", "cost", "value"]):
                cell.number_format = '"$"#,##0.00'
                cell.alignment = Alignment(horizontal="right", vertical="center")
            elif any(k in header_name for k in ["qty", "quantity", "count", "units", "on hand", "available"]):
                cell.number_format = '#,##0'
                cell.alignment = Alignment(horizontal="right", vertical="center")
            elif any(k in header_name for k in ["date", "created", "updated", "time"]):
                cell.alignment = Alignment(horizontal="center", vertical="center")
            elif any(k in header_name for k in ["status", "state"]):
                cell.alignment = Alignment(horizontal="center", vertical="center")
                if val_str:
                    apply_status_pill_cell(cell, val_str)
            elif any(k in header_name for k in ["id", "code", "sku", "number"]):
                cell.alignment = Alignment(horizontal="center", vertical="center")

        # Calculate Column Width
        col_letter = get_column_letter(c)
        max_len = max(len(str(ws.cell(row=r, column=c).value or "")) for r in range(start_row, end_row + 1))
        ws.column_dimensions[col_letter].width = max(max_len + 5, 16)


def apply_status_pill_cell(cell: openpyxl.cell.cell.Cell, val_str: str) -> None:
    """Applies status badge pill background and text color to a cell."""
    badge_style = THEME["status_badges"]["info"]
    if any(k in val_str for k in ["success", "complete", "active", "online", "synced"]):
        badge_style = THEME["status_badges"]["success"]
    elif any(k in val_str for k in ["pending", "running", "syncing", "warning"]):
        badge_style = THEME["status_badges"]["warning"]
    elif any(k in val_str for k in ["fail", "error", "cancel"]):
        badge_style = THEME["status_badges"]["error"]

    cell.fill = PatternFill(start_color=badge_style["fill"], end_color=badge_style["fill"], fill_type="solid")
    cell.font = Font(name=THEME["font_family"], size=9, bold=True, color=badge_style["font"])
    set_box_border(cell.parent, cell.row, cell.column, cell.row, cell.column, badge_style["border"])


def tidy_grand_total_row(ws: openpyxl.worksheet.worksheet.Worksheet) -> None:
    """Clears and sets Grand Total formatting on E2:K2 range."""
    ws.merge_cells("E2:K2")
    cell = ws.cell(row=2, column=5)
    cell.value = "Grand Total"
    cell.font = Font(name=THEME["font_family"], size=9.5, italic=True, color=THEME["colors"]["text_muted"])
    cell.alignment = Alignment(horizontal="center", vertical="center")


# ── AUDIT LOG ENGINE ────────────────────────────────────────────────────────

def get_or_create_log_sheet(wb: openpyxl.Workbook) -> openpyxl.worksheet.worksheet.Worksheet:
    """Gets or initializes the canonical audit log worksheet."""
    for sheet in wb.worksheets:
        if sheet.title.lower().strip() == LOG_SHEET_NAME.lower():
            return sheet

    log_sheet = wb.create_sheet(title=LOG_SHEET_NAME)
    format_worksheet_as_app_container(log_sheet)
    setup_app_shell(wb, log_sheet, "CIN7 SYNC AUDIT LOG")

    # Row 4 Headers
    log_sheet.row_dimensions[4].height = 26
    header_fill = PatternFill(start_color=THEME["colors"]["table_header_bg"], end_color=THEME["colors"]["table_header_bg"], fill_type="solid")
    header_font = Font(name=THEME["font_family"], size=9.5, bold=True, color="FFFFFF")

    for col_idx, h_text in enumerate(LOG_HEADERS, start=1):
        cell = log_sheet.cell(row=4, column=col_idx, value=h_text)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(vertical="center")

    log_sheet.column_dimensions['A'].width = 22
    log_sheet.column_dimensions['B'].width = 14
    log_sheet.column_dimensions['C'].width = 18
    log_sheet.column_dimensions['D'].width = 36
    log_sheet.column_dimensions['E'].width = 28
    log_sheet.freeze_panes = "A5"

    return log_sheet


def log_sync_start(wb: openpyxl.Workbook, timeline_value: str) -> str:
    """Inserts a new 'Running' log entry into Row 5 of the Sync Log sheet."""
    log_sheet = get_or_create_log_sheet(wb)
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    run_id = f"run-{int(datetime.datetime.now().timestamp()*1000)}-{random.randint(1000, 9999)}"

    # Shift rows down starting at Row 5
    log_sheet.insert_rows(5)
    log_sheet.row_dimensions[5].height = 22

    row_vals = [now_str, "Running", timeline_value, "Sync process initiated...", run_id]
    for col_idx, val in enumerate(row_vals, start=1):
        cell = log_sheet.cell(row=5, column=col_idx, value=val)
        cell.font = Font(name=THEME["font_family"], size=9.5, color=THEME["colors"]["table_text"])
        cell.alignment = Alignment(vertical="center")

    # Format Status Cell B5
    status_cell = log_sheet.cell(row=5, column=2)
    badge = THEME["status_badges"]["warning"]
    status_cell.fill = PatternFill(start_color=badge["fill"], end_color=badge["fill"], fill_type="solid")
    status_cell.font = Font(name=THEME["font_family"], size=9, bold=True, color=badge["font"])

    # Trim entries over LOG_MAX_ENTRIES
    max_row = log_sheet.max_row
    if max_row > 4 + LOG_MAX_ENTRIES:
        log_sheet.delete_rows(4 + LOG_MAX_ENTRIES + 1, max_row - (4 + LOG_MAX_ENTRIES))

    return run_id


def log_sync_finish(wb: openpyxl.Workbook, run_id: str, status: str, detail: str) -> None:
    """Updates matching run_id log entry with final status and detail message."""
    log_sheet = get_or_create_log_sheet(wb)
    target_row = -1

    for r in range(5, log_sheet.max_row + 1):
        if str(log_sheet.cell(row=r, column=5).value or "") == run_id:
            target_row = r
            break

    if target_row == -1:
        return

    status_cell = log_sheet.cell(row=target_row, column=2, value=status)
    detail_cell = log_sheet.cell(row=target_row, column=4, value=detail)

    badge = THEME["status_badges"]["success"] if status == "Success" else THEME["status_badges"]["error"]
    status_cell.fill = PatternFill(start_color=badge["fill"], end_color=badge["fill"], fill_type="solid")
    status_cell.font = Font(name=THEME["font_family"], size=9, bold=True, color=badge["font"])
    set_box_border(log_sheet, target_row, 2, target_row, 2, badge["border"])


# ── MAIN EXECUTION CONTROLLER ───────────────────────────────────────────────

def write_rows(ws: openpyxl.worksheet.worksheet.Worksheet,
               start_row: int, start_col: int,
               rows: List[List[Any]]) -> None:
    """Writes a 2D list of row values starting at specified cell coordinates."""
    for r_idx, row in enumerate(rows):
        for c_idx, val in enumerate(row):
            ws.cell(row=start_row + r_idx, column=start_col + c_idx, value=val)


def sync_cin7_data(excel_file_path: str, timeline_override: Optional[str] = None) -> str:
    """
    Main function translating main(workbook: ExcelScript.Workbook).
    Loads or creates an Excel file, fetches backend data via requests,
    formats sheets, populates data grids, and saves the workbook.
    """
    API_BASE_URL = "http://localhost:8000"
    CLIENT_ID = "1bde386a-1bcb-4e78-baa8-caa0142892ab"
    API_KEY = "MzybfJtO2UjB9_6DGC8z2p3dAQVgE2tAIK1R7UqmMwM"

    options_list = ", ".join(VALID_OPTIONS)

    # 1. Load or Create Workbook
    if os.path.exists(excel_file_path):
        wb = openpyxl.load_workbook(excel_file_path)
    else:
        wb = openpyxl.Workbook()

    active_sheet = wb.active
    raw_val = str(active_sheet.cell(row=3, column=2).value or active_sheet.cell(row=1, column=2).value or "").strip()
    timeline_value = timeline_override or "Last 30 days"

    for opt in VALID_OPTIONS:
        if raw_val.lower() == opt.lower():
            timeline_value = opt
            break

    # 2. Get or create canonical worksheets
    sales_sheet = get_or_create_sheet(wb, SALES_SHEET)
    inv_sheet = get_or_create_sheet(wb, INVENTORY_SHEET)
    po_sheet = get_or_create_sheet(wb, PURCHASES_SHEET)
    all_data_sheets = [sales_sheet, inv_sheet, po_sheet]

    # 3. Apply App Shell & Controls
    for sheet in wb.worksheets:
        format_worksheet_as_app_container(sheet)

    for sheet in all_data_sheets:
        setup_app_shell(wb, sheet, "CIN7 ENTERPRISE ANALYTICS SUITE")
        setup_control_row(sheet, options_list)
        set_timeline_and_status(sheet, timeline_value, f"Syncing Cin7 data ({timeline_value})...", "warning")
        sheet.freeze_panes = "A3"

    # 4. Fetch Data from Backend API
    since_date = calculate_start_date(timeline_value)
    query_param = f"?updated_since={requests.utils.quote(since_date.isoformat())}" if since_date else ""

    run_id = log_sync_start(wb, timeline_value)

    try:
        url = f"{API_BASE_URL}/sync/{CLIENT_ID}{query_param}"
        headers = {"x-api-key": API_KEY, "Content-Type": "application/json"}
        response = requests.post(url, headers=headers, timeout=15)

        if not response.ok:
            try:
                err_data = response.json()
                err_detail = err_data.get("detail", response.reason)
            except Exception:
                err_detail = response.reason
            
            fail_msg = f"Sync failed: {err_detail}"
            for sheet in all_data_sheets:
                set_timeline_and_status(sheet, timeline_value, fail_msg, "error")
            log_sync_finish(wb, run_id, "Failed", err_detail or "HTTP Error")
            wb.save(excel_file_path)
            return fail_msg

        result = response.json()
        synced_at = datetime.datetime.now().strftime("%I:%M %p")

        if result.get("status") == "success":
            total_synced_rows = result.get("rows_synced", 0)
            success_msg = f"Status: Synced ({timeline_value}) at {synced_at}  |  {total_synced_rows} total rows"

            # Populate Sales Sheet
            sales_rows = result.get("sales_rows", [])
            sales_headers = result.get("sales_headers", [])
            if sales_rows:
                if sales_headers:
                    write_rows(sales_sheet, 8, 1, [sales_headers])
                write_rows(sales_sheet, 9, 1, sales_rows)

                rowCount = len(sales_rows)
                colCount = len(sales_headers) if sales_headers else (len(sales_rows[0]) if sales_rows else 1)
                format_enterprise_data_grid(sales_sheet, 8, 1, 8 + rowCount, colCount)
                render_sheet_kpi_cards(sales_sheet, [
                    {"title": "SALES TRANSACTIONS", "value": rowCount, "number_format": "#,##0", "trend": "● Active Period Rows", "statusType": "success"},
                    {"title": "TIMELINE WINDOW", "value": timeline_value, "trend": f"Synced at {synced_at}", "statusType": "info"},
                    {"title": "SYNC HEALTH", "value": "ONLINE 100%", "trend": "● Connection Active", "statusType": "success"}
                ])
                set_timeline_and_status(sales_sheet, timeline_value, success_msg, "success")

            # Populate Inventory Sheet
            inv_rows = result.get("inventory_rows", [])
            inv_headers = result.get("inventory_headers", [])
            if inv_rows:
                tidy_grand_total_row(inv_sheet)
                if inv_headers:
                    write_rows(inv_sheet, 8, 1, [inv_headers])
                write_rows(inv_sheet, 9, 1, inv_rows)

                rowCount = len(inv_rows)
                colCount = len(inv_headers) if inv_headers else (len(inv_rows[0]) if inv_rows else 1)
                format_enterprise_data_grid(inv_sheet, 8, 1, 8 + rowCount, colCount)
                render_sheet_kpi_cards(inv_sheet, [
                    {"title": "INVENTORY ITEMS", "value": rowCount, "number_format": "#,##0", "trend": "● Items On Hand", "statusType": "success"},
                    {"title": "TIMELINE WINDOW", "value": timeline_value, "trend": f"Synced at {synced_at}", "statusType": "info"},
                    {"title": "STOCK MONITOR", "value": "OPTIMAL", "trend": "● Live Inventory Feed", "statusType": "success"}
                ])
                set_timeline_and_status(inv_sheet, timeline_value, success_msg, "success")

            # Populate Purchase Sheet
            po_rows = result.get("purchase_rows", [])
            po_headers = result.get("purchase_headers", [])
            if po_rows:
                if po_headers:
                    write_rows(po_sheet, 8, 1, [po_headers])
                write_rows(po_sheet, 9, 1, po_rows)

                rowCount = len(po_rows)
                colCount = len(po_headers) if po_headers else (len(po_rows[0]) if po_rows else 1)
                format_enterprise_data_grid(po_sheet, 8, 1, 8 + rowCount, colCount)
                render_sheet_kpi_cards(po_sheet, [
                    {"title": "PURCHASE ORDERS", "value": rowCount, "number_format": "#,##0", "trend": "● Active Orders", "statusType": "success"},
                    {"title": "TIMELINE WINDOW", "value": timeline_value, "trend": f"Synced at {synced_at}", "statusType": "info"},
                    {"title": "SUPPLY CHAIN", "value": "CONNECTED", "trend": "● Cin7 Live Feed", "statusType": "success"}
                ])
                set_timeline_and_status(po_sheet, timeline_value, success_msg, "success")

            log_sync_finish(wb, run_id, "Success", f"{total_synced_rows} rows synced")
            wb.save(excel_file_path)
            return success_msg
        else:
            reason = result.get("reason", "unknown reason")
            fail_msg = f"Sync failed: {reason}"
            for sheet in all_data_sheets:
                set_timeline_and_status(sheet, timeline_value, fail_msg, "error")
            log_sync_finish(wb, run_id, "Failed", reason)
            wb.save(excel_file_path)
            return fail_msg

    except Exception as e:
        err_msg = f"Sync error: server connection unavailable ({str(e)})."
        for sheet in all_data_sheets:
            set_timeline_and_status(sheet, timeline_value, err_msg, "error")
        log_sync_finish(wb, run_id, "Failed", "Could not reach server")
        wb.save(excel_file_path)
        return err_msg


if __name__ == "__main__":
    # Example usage:
    output_path = "Cin7_Sync_Report.xlsx"
    print(f"Executing Cin7 Sync Engine to Python workbook: {output_path}...")
    status = sync_cin7_data(output_path, timeline_override="Last 30 days")
    print(f"Result: {status}")
