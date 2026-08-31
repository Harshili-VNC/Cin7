"""
Core sync logic - the ONE function both the scheduled job and the manual
button ultimately call. Keeping this in one place means there's no risk
of the scheduled and manual paths drifting apart or behaving differently.

Column mappings below are confirmed against the actual uploaded template
(Controller_Reporting_Model_v5_Cin7_Actuals.xlsx):
- "Sales Transactions Raw Data": headers at row 6, data starts row 7
- "Inventory On Hand Raw Data": headers at row 3, data starts row 4
- "Purchase Transactions Raw data": headers at row 6, data starts row 7

All 3 sheets say "DO NOT EDIT... paste new data here" in the template's
own Cover sheet instructions - every other sheet (KPI Dashboard, Sales
Trend Analysis, etc.) is formula-driven off these 3, so we only ever
write into these 3 sheets, never touch the calculated ones.
"""

import logging
from typing import Optional

import db
from cin7_client import Cin7Client, Cin7Credentials, Cin7ProductType, Cin7AuthError, Cin7RateLimitError
from ms_graph import get_valid_access_token, write_rows_to_range, clear_range, force_recalculate, GraphAuthError

logger = logging.getLogger("sync_logic")

# Exact sheet names from the uploaded template - must match exactly,
# including capitalization and the lowercase "data" in the third one.
SHEET_SALES = "Sales Transactions Raw Data"
SHEET_INVENTORY = "Inventory On Hand Raw Data"
SHEET_PURCHASES = "Purchase Transactions Raw data"

# Where each sheet's data actually starts.
# Sales and Purchases reserve rows 1-5 for the "Report period / From / To /
# Currency" block that the Office Script writes before the headers.
# Inventory's real headers/data sit higher up (row 3/4) in the actual
# template - do not move this to match Sales/Purchase, that was tried
# once and caused a duplicate header block to appear at row 6/7 instead.
SALES_START_CELL = "A7"
SALES_CLEAR_RANGE = "A7:Z10000"
INVENTORY_START_CELL = "A4"
INVENTORY_CLEAR_RANGE = "A4:K10000"
PURCHASES_START_CELL = "A7"
PURCHASES_CLEAR_RANGE = "A7:T10000"

# CONFIRMED against the client's real exported template - exact names/order.
SALES_HEADERS = [
    "Year", "Month", "Order date", "Order #", "Invoice date", "Document #", "SKU",
    "Product", "Brand", "Category", "Family", "Product tags", "Customer",
    "Invoice status", "Unit", "Shipment status", "Customer tags",
    "Sales representative", "Sales Channel", "Quantity", "Invoice", "Sale",
    "COGS", "Profit less journals", "Journals", "Profit"
]

INVENTORY_HEADERS = [
    "Location", "SKU", "Product", "Unit", "Quantity on hand", "Allocated",
    "On order", "In transit", "Unit cost", "Stock on hand", "Available"
]

PURCHASE_HEADERS = [
    "Year", "Month", "Supplier", "Expiry date", "PO #", "Invoice #", "Brand",
    "Category", "Family", "SKU", "Product", "Unit", "Location", "Batch #",
    "Status", "Quantity", "Main cost", "Additional cost", "Journal cost", "Tax"
]


def sync_client(client_id: str, triggered_by: str = "scheduled", updated_since: Optional[str] = None) -> dict:
    """
    Runs one full sync for one client: pulls all 3 Cin7 data sets, writes
    each into its matching sheet in their SharePoint Excel file, forces
    a recalculation, logs the result.

    updated_since: optional ISO 8601 date string (e.g. "2026-05-01T00:00:00")
    letting the client choose a reporting period from the Excel side,
    instead of always pulling all-time data. Passed through to Cin7's
    SaleList/PurchaseList UpdatedSince filter.
    """
    job_id = db.start_sync_job(client_id, triggered_by)
    logger.info(f"Starting sync job={job_id} client={client_id} trigger={triggered_by} period={updated_since}")

    try:
        cin7_creds_record = db.get_cin7_credentials(client_id)
        if not cin7_creds_record:
            raise ValueError(f"No Cin7 credentials on file for client={client_id}")

        cin7_creds = Cin7Credentials(
            product_type=Cin7ProductType(cin7_creds_record.product_type),
            account_id=cin7_creds_record.core_account_id,
            application_key=cin7_creds_record.core_application_key,
            username=cin7_creds_record.omni_username,
            connection_key=cin7_creds_record.omni_connection_key,
        )
        cin7_client = Cin7Client(cin7_creds, client_id_for_logging=client_id)

        token_record = db.get_microsoft_token(client_id)
        access_token = None
        if token_record:
            access_token = get_valid_access_token(client_id, token_record, db.update_microsoft_access_token)
        else:
            logger.info(f"Local test mode (no MS Graph token on file) for client={client_id}. Fetching Cin7 data directly...")

        total_rows = 0

        # Fetch the product catalog ONCE and reuse for both sales and purchases
        products_lookup = cin7_client.get_products_lookup()

        # --- 1. Sales Transactions ---
        sales_data = cin7_client.get_sales_transactions(updated_since=updated_since)
        _enrich_with_product_lookup(sales_data, products_lookup)
        sales_rows = _sales_dicts_to_rows(sales_data)
        if token_record and access_token:
            clear_range(access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id,
                        SHEET_SALES, SALES_CLEAR_RANGE)
            if sales_rows:
                total_rows += write_rows_to_range(
                    access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id,
                    SHEET_SALES, SALES_START_CELL, sales_rows,
                )
        else:
            total_rows += len(sales_rows)

        # --- 2. Inventory On Hand ---
        inventory_data = cin7_client.get_inventory_on_hand()
        inventory_rows = _inventory_dicts_to_rows(inventory_data)
        if token_record and access_token:
            clear_range(access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id,
                        SHEET_INVENTORY, INVENTORY_CLEAR_RANGE)
            if inventory_rows:
                total_rows += write_rows_to_range(
                    access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id,
                    SHEET_INVENTORY, INVENTORY_START_CELL, inventory_rows,
                )
        else:
            total_rows += len(inventory_rows)

        # --- 3. Purchase Transactions ---
        purchase_data = cin7_client.get_purchase_transactions(updated_since=updated_since)
        _enrich_with_product_lookup(purchase_data, products_lookup)
        purchase_rows = _purchase_dicts_to_rows(purchase_data)
        if token_record and access_token:
            clear_range(access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id,
                        SHEET_PURCHASES, PURCHASES_CLEAR_RANGE)
            if purchase_rows:
                total_rows += write_rows_to_range(
                    access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id,
                    SHEET_PURCHASES, PURCHASES_START_CELL, purchase_rows,
                )
        else:
            total_rows += len(purchase_rows)

        # --- 4. Force Excel to recalculate ---
        if token_record and access_token:
            force_recalculate(access_token, token_record.sharepoint_site_id, token_record.sharepoint_file_id)

        db.finish_sync_job(job_id, status="success", rows_synced=total_rows)
        logger.info(f"Finished sync job={job_id} client={client_id} rows={total_rows}")
        return {
            "status": "success",
            "client_id": client_id,
            "rows_synced": total_rows,
            "sales_headers": SALES_HEADERS,
            "sales_rows": sales_rows,
            "inventory_headers": INVENTORY_HEADERS,
            "inventory_rows": inventory_rows,
            "purchase_headers": PURCHASE_HEADERS,
            "purchase_rows": purchase_rows,
        }

    except Cin7AuthError as e:
        db.mark_cin7_verified(client_id, success=False)
        db.finish_sync_job(job_id, status="failed", error_message=str(e))
        logger.warning(f"Cin7 auth failed for client={client_id}: {e}")
        return {"status": "failed", "client_id": client_id, "reason": "cin7_auth_error"}

    except GraphAuthError as e:
        db.finish_sync_job(job_id, status="failed", error_message=str(e))
        logger.warning(f"Microsoft auth failed for client={client_id}: {e}")
        return {"status": "failed", "client_id": client_id, "reason": "microsoft_auth_error"}

    except Cin7RateLimitError as e:
        db.finish_sync_job(job_id, status="failed", error_message=str(e))
        logger.warning(f"Cin7 rate limited for client={client_id}: {e}")
        return {"status": "failed", "client_id": client_id, "reason": "cin7_rate_limited"}

    except Exception as e:
        # Catch-all so ONE broken client can never crash a batch of 200+
        db.finish_sync_job(job_id, status="failed", error_message=str(e))
        logger.error(f"Unexpected error syncing client={client_id}: {e}")
        return {"status": "failed", "client_id": client_id, "reason": "unexpected_error"}


def _enrich_with_product_lookup(transaction_rows: list, products_lookup: dict) -> None:
    """Mutates transaction_rows in place, filling in Brand/Category/Family by SKU match."""
    for row in transaction_rows:
        sku = row.get("sku", "")
        match = products_lookup.get(sku)
        if match:
            row["brand"] = match["brand"]
            row["category"] = match["category"]
            row["family"] = match["family"]


def _sales_dicts_to_rows(sales: list) -> list:
    """
    Maps to 'Sales Transactions Raw Data' columns exactly, in order (CONFIRMED
    against the client's real exported template):
    Year, Month, Order date, Order #, Invoice date, Document #, SKU,
    Product, Brand, Category, Family, Product tags, Customer,
    Invoice status, Unit, Shipment status, Customer tags,
    Sales representative, Sales Channel, Quantity, Invoice, Sale, COGS,
    Profit less journals, Journals, Profit
    """
    rows = []
    for s in sales:
        order_date = s.get("order_date", "")
        year = order_date[0:4] if isinstance(order_date, str) and len(order_date) >= 4 else ""
        month = order_date[5:7] if isinstance(order_date, str) and len(order_date) >= 7 else ""
        profit = s.get("profit", 0)
        rows.append([
            year, month, order_date, s.get("order_number", ""), s.get("invoice_date", ""),
            s.get("document_number", ""), s.get("sku", ""), s.get("product", ""),
            s.get("brand", ""), s.get("category", ""), s.get("family", ""), "",  # Product tags - not sourced yet
            s.get("customer", ""), s.get("invoice_status", ""), "",  # Unit - not sourced yet
            s.get("shipment_status", ""), "",  # Customer tags - not sourced yet
            s.get("sales_rep", ""), s.get("sales_channel", ""), s.get("quantity", 0),
            s.get("invoice", 0), s.get("sale", 0), s.get("cogs", 0), profit, 0, profit,  # Journals defaulted to 0
        ])
    return rows


def _inventory_dicts_to_rows(inventory: list) -> list:
    """
    Maps to 'Inventory On Hand Raw Data' columns exactly, in order:
    Location, SKU, Product, Unit, Quantity on hand, Allocated, On order,
    In transit, Unit cost, Stock on hand, Available
    """
    rows = []
    for i in inventory:
        rows.append([
            i.get("location", ""), i.get("sku", ""), i.get("product", ""), i.get("unit", ""),
            i.get("quantity_on_hand", 0), i.get("allocated", 0), i.get("on_order", 0),
            i.get("in_transit", 0), i.get("unit_cost", 0), i.get("stock_on_hand", 0),
            i.get("available", 0),
        ])
    return rows


def _purchase_dicts_to_rows(purchases: list) -> list:
    """
    Maps to 'Purchase Transactions Raw data' columns exactly, in order:
    Year, Month, Supplier, Expiry date, PO #, Invoice #, Brand, Category,
    Family, SKU, Product, Unit, Location, Batch #, Status, Quantity,
    Main cost, Additional cost, Journal cost, Tax
    """
    rows = []
    for p in purchases:
        rows.append([
            "", "",  # Year/Month - not sourced from purchase line yet, needs a date field mapped
            p.get("supplier", ""), "",  # Expiry date - not sourced yet
            p.get("po_number", ""), p.get("invoice_number", ""), p.get("brand", ""),
            p.get("category", ""), p.get("family", ""), p.get("sku", ""), p.get("product", ""),
            p.get("unit", ""), p.get("location", ""), p.get("batch_number", ""), p.get("status", ""),
            p.get("quantity", 0), p.get("main_cost", 0), p.get("additional_cost", 0),
            p.get("journal_cost", 0), p.get("tax", 0),
        ])
    return rows