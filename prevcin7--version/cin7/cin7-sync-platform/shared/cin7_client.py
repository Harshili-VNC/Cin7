"""
Cin7 API Client
================
Supports both Cin7 Core (API V2) and Cin7 Omni (API v1), since different
clients in the multi-tenant system may be on either product.

IMPORTANT - things this file intentionally does NOT do:
- Does NOT store or decrypt credentials itself. Credentials must be
  fetched (already decrypted) by the caller from your secrets-managed
  database layer, and passed in.
- Does NOT hardcode any real API keys anywhere.

References (verified against Cin7's own documentation):
- Cin7 Core auth headers: api-auth-accountid / api-auth-applicationkey
  https://dearinventory.docs.apiary.io/
- Cin7 Core base URL: https://inventory.dearsystems.com/externalapi/v2/
- Cin7 Omni uses a username + Connection Key (API v1) instead
  https://help.omni.cin7.com/hc/en-us/articles/10015165519503

NOTE: The exact Cin7 Omni request/response shape below is written from
the general API v1 pattern described in Cin7's docs, but I have not
independently verified every Omni endpoint path. Confirm against
https://api.cin7.com/ before relying on it in production.
"""

import os
import time
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import requests

logger = logging.getLogger("cin7_client")


class Cin7ProductType(str, Enum):
    CORE = "core"
    OMNI = "omni"


class Cin7AuthError(Exception):
    """Raised when Cin7 rejects the provided credentials (bad key, revoked, etc.)."""
    pass


class Cin7RateLimitError(Exception):
    """Raised when Cin7 signals we've hit a rate limit (HTTP 429)."""
    pass


@dataclass
class Cin7Credentials:
    """
    Plain-value credential holder. Populate this AFTER decrypting values
    pulled from the cin7_credentials table - never pass encrypted blobs in.
    """
    product_type: Cin7ProductType
    # Core fields:
    account_id: Optional[str] = None
    application_key: Optional[str] = None
    # Omni fields:
    username: Optional[str] = None
    connection_key: Optional[str] = None


class Cin7Client:
    CORE_BASE_URL = "https://inventory.dearsystems.com/externalapi/v2/"
    OMNI_BASE_URL = "https://api.cin7.com/api/v1/"

    MAX_RETRIES = 5
    RETRY_BACKOFF_SECONDS = 3  # doubles each retry: 3s, 6s, 12s, 24s

    def __init__(self, credentials: Cin7Credentials, client_id_for_logging: str = ""):
        self.credentials = credentials
        self.client_id_for_logging = client_id_for_logging  # your internal client UUID, for audit logs only

        # TESTING ONLY - set CIN7_MOCK_MODE=true to skip real Cin7 API calls
        # entirely and return fake sample data instead. This lets you test
        # the portal/database/onboarding flow before you have a real Cin7
        # trial account. NEVER enable this anywhere near real client data -
        # "verified" will report true without checking anything real.
        self.mock_mode = os.environ.get("CIN7_MOCK_MODE", "false").lower() == "true"
        if self.mock_mode:
            logger.warning(
                f"CIN7_MOCK_MODE is ON for client={client_id_for_logging} - "
                f"no real Cin7 API calls will be made. Fake data will be returned. "
                f"Do not use this setting with real client credentials."
            )
            return  # skip building a real session entirely

        if credentials.product_type == Cin7ProductType.CORE:
            if not credentials.account_id or not credentials.application_key:
                raise ValueError("Core credentials require account_id and application_key")
            self.base_url = self.CORE_BASE_URL
            self.session = requests.Session()
            self.session.headers.update({
                "api-auth-accountid": credentials.account_id,
                "api-auth-applicationkey": credentials.application_key,
                "Content-Type": "application/json",
            })
        elif credentials.product_type == Cin7ProductType.OMNI:
            if not credentials.username or not credentials.connection_key:
                raise ValueError("Omni credentials require username and connection_key")
            self.base_url = self.OMNI_BASE_URL
            self.session = requests.Session()
            self.session.auth = (credentials.username, credentials.connection_key)
        else:
            raise ValueError(f"Unknown Cin7 product type: {credentials.product_type}")

    def _request(self, method: str, endpoint: str, params: Optional[dict] = None,
                 json_body: Optional[dict] = None) -> dict:
        """
        Internal request wrapper with retry + rate-limit handling.
        Cin7's own docs recommend queuing/retrying rather than assuming
        the API is always available - this implements that.
        """
        url = f"{self.base_url}{endpoint}"
        last_error = None

        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                response = self.session.request(method, url, params=params, json=json_body, timeout=30)

                if response.status_code == 401 or response.status_code == 403:
                    # Bad or revoked credentials - do NOT retry, this needs human/client attention
                    raise Cin7AuthError(
                        f"Cin7 auth failed for client={self.client_id_for_logging} "
                        f"(status {response.status_code}). Credentials may be invalid or revoked."
                    )

                if response.status_code == 429:
                    # Rate limited - back off and retry
                    wait_time = self.RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
                    logger.warning(
                        f"Rate limited by Cin7 for client={self.client_id_for_logging}, "
                        f"waiting {wait_time}s (attempt {attempt}/{self.MAX_RETRIES})"
                    )
                    time.sleep(wait_time)
                    continue

                response.raise_for_status()
                return response.json()

            except requests.exceptions.RequestException as e:
                last_error = e
                wait_time = self.RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
                logger.warning(
                    f"Request failed for client={self.client_id_for_logging}, "
                    f"attempt {attempt}/{self.MAX_RETRIES}: {e}. Retrying in {wait_time}s."
                )
                time.sleep(wait_time)

        raise Cin7RateLimitError(
            f"Cin7 request failed after {self.MAX_RETRIES} attempts for "
            f"client={self.client_id_for_logging}: {last_error}"
        )

    def verify_credentials(self) -> bool:
        """
        Lightweight check to confirm credentials are valid, without pulling
        real business data. Use this when a client first enters their key
        in the self-service portal, before saving it as 'verified'.
        """
        if self.mock_mode:
            return True  # always "succeeds" in mock mode - see warning logged in __init__

        try:
            if self.credentials.product_type == Cin7ProductType.CORE:
                self._request("GET", "SaleList", params={"Page": 1, "Limit": 1})
            else:
                self._request("GET", "Me")
            return True
        except (Cin7AuthError, Exception):
            return False

    def get_products_lookup(self) -> dict:
        """
        Fetches the full product catalog ONCE and returns a dict keyed by
        SKU, containing Brand/Category/Family - fields that do NOT exist
        on individual sale/purchase line items (confirmed via live test:
        line items only return SKU, Name, ProductID, Quantity, Price,
        AverageCost). Call this once per sync and reuse the result across
        every sale/purchase line, rather than one API call per line.
        """
        if self.mock_mode:
            return {"MOCK-SKU-001": {"brand": "MockBrand", "category": "Finished Goods", "family": "Variety"}}

        lookup = {}
        page = 1
        while True:
            resp = self._request("GET", "product", params={"Page": page, "Limit": 100})
            products = resp.get("Products", []) if isinstance(resp, dict) else []
            if not products:
                break
            for p in products:
                sku = p.get("SKU")
                if sku:
                    lookup[sku] = {
                        "brand": p.get("Brand", ""),
                        "category": p.get("Category", ""),
                        "family": p.get("ProductFamily", ""),
                    }
            page += 1
            if page > 200:
                break
        return lookup

    def get_sales_transactions(self, updated_since: Optional[str] = None) -> list:
        """
        Returns per-sale summary rows from SaleList ONLY.

        PERFORMANCE: Previously made 1 + N API calls (SaleList + one Sale
        detail per record). Now makes only ceil(total/100) calls total,
        which eliminates Cin7 rate-limit backoffs almost entirely.

        Trade-off: line-item SKU/Quantity detail is not available from
        SaleList alone - each row represents one invoice-level summary.
        If per-line-item breakdown is required, the old per-sale detail
        approach must be restored (accepting the slowness).
        """
        if self.mock_mode:
            return self._mock_sales_transactions()

        all_rows = []
        page = 1
        while True:
            params = {"Page": page, "Limit": 100} if self.credentials.product_type == Cin7ProductType.CORE \
                      else {"page": page, "limit": 100}
            if updated_since:
                params["UpdatedSince"] = updated_since

            sale_list_page = self._request("GET", "SaleList", params=params)
            sales = sale_list_page.get("SaleList", []) if isinstance(sale_list_page, dict) else []
            if not sales:
                break

            for sale_summary in sales:
                all_rows.extend(self._flatten_sale_summary_to_rows(sale_summary))

            page += 1
            if page > 200:
                logger.warning(f"Hit page safety cap for client={self.client_id_for_logging}")
                break
            # Small pause between pages to stay under Cin7 rate limits
            time.sleep(0.5)

        return all_rows

    def _flatten_sale_summary_to_rows(self, sale_summary: dict) -> list:
        """
        Converts one SaleList summary row into a single Excel row.
        Uses only fields available on SaleList (no per-sale detail call).
        This is the fast path - one page of SaleList = one API call for
        up to 100 sales instead of 101 calls.
        """
        total = sale_summary.get("Total", 0) or 0
        subtotal = sale_summary.get("SubTotal", 0) or total
        tax = sale_summary.get("TaxTotal", 0) or 0
        order_date = sale_summary.get("OrderDate", "")
        month = order_date[5:7] if isinstance(order_date, str) and len(order_date) >= 7 else ""
        return [{
            "order_date": order_date,
            "order_number": sale_summary.get("OrderNumber", ""),
            "invoice_date": sale_summary.get("InvoiceDate", ""),
            "document_number": sale_summary.get("InvoiceNumber", ""),
            "customer": sale_summary.get("Customer", ""),
            "invoice_status": sale_summary.get("CombinedInvoiceStatus", ""),
            "shipment_status": sale_summary.get("CombinedShippingStatus", ""),
            "sales_rep": sale_summary.get("SalesRepresentative", ""),
            "sales_channel": sale_summary.get("SourceChannel", ""),
            # Line-item fields not available at summary level
            "sku": "",
            "product": "",
            "brand": "",
            "category": "",
            "family": "",
            "quantity": sale_summary.get("Qty", 0) or 0,
            "invoice": total,
            "sale": subtotal,
            "cogs": 0,
            "profit": subtotal - tax,
        }]

    def get_inventory_on_hand(self) -> list:
        """
        Matches the template's 'Inventory On Hand Raw Data' sheet, sourced
        from Cin7's real, documented ProductAvailability endpoint.
        Field names below still need confirmation against a live account.
        """
        if self.mock_mode:
            return self._mock_inventory()

        all_rows = []
        page = 1
        while True:
            if self.credentials.product_type == Cin7ProductType.CORE:
                url = "https://inventory.dearsystems.com/externalapi/ProductAvailability"
                resp_raw = self.session.get(url, params={"Page": page, "Limit": 100}, timeout=30)
                resp_raw.raise_for_status()
                resp = resp_raw.json()
                items = resp.get("ProductAvailability", []) if isinstance(resp, dict) else []
            else:
                resp = self._request("GET", "ProductAvailability", params={"page": page, "limit": 100})
                items = resp.get("ProductAvailabilityList", []) if isinstance(resp, dict) else []
            if not items:
                break
            for item in items:
                all_rows.append({
                    "location": item.get("Location", ""),
                    "sku": item.get("SKU", ""),
                    "product": item.get("Name", ""),
                    "unit": item.get("Unit", ""),
                    "quantity_on_hand": item.get("OnHand", 0),
                    "allocated": item.get("Allocated", 0),
                    "on_order": item.get("OnOrder", 0),
                    "in_transit": item.get("InTransit", 0),
                    "unit_cost": item.get("AverageCost", 0),
                    "stock_on_hand": item.get("StockOnHand", 0),
                    "available": item.get("Available", 0),
                })
            page += 1
            if page > 200:
                break
        return all_rows

    def get_purchase_transactions(self, updated_since: Optional[str] = None) -> list:
        """
        Matches the template's 'Purchase Transactions Raw data' sheet.

        PERFORMANCE: Uses PurchaseList summary data only - no per-purchase
        detail calls. Reduces API calls from N+1 to ceil(total/100).
        """
        if self.mock_mode:
            return self._mock_purchases()

        all_rows = []
        page = 1
        while True:
            params = {"Page": page, "Limit": 100} if self.credentials.product_type == Cin7ProductType.CORE \
                      else {"page": page, "limit": 100}
            if updated_since:
                params["UpdatedSince"] = updated_since

            purchase_list_page = self._request("GET", "PurchaseList", params=params)
            purchases = purchase_list_page.get("PurchaseList", []) if isinstance(purchase_list_page, dict) else []
            if not purchases:
                break

            for purchase_summary in purchases:
                all_rows.extend(self._flatten_purchase_summary_to_rows(purchase_summary))

            page += 1
            if page > 200:
                break
            # Small pause between pages to stay under Cin7 rate limits
            time.sleep(0.5)

        return all_rows

    def _flatten_purchase_summary_to_rows(self, purchase_summary: dict) -> list:
        """
        Converts one PurchaseList summary into a single Excel row.
        Uses only PurchaseList fields - no per-purchase detail call needed.
        """
        order_date = purchase_summary.get("OrderDate", "")
        year = order_date[:4] if isinstance(order_date, str) and len(order_date) >= 4 else ""
        month = order_date[5:7] if isinstance(order_date, str) and len(order_date) >= 7 else ""
        return [{
            "year": year,
            "month": month,
            "supplier": purchase_summary.get("Supplier", ""),
            "expiry_date": "",
            "po_number": purchase_summary.get("OrderNumber", ""),
            "invoice_number": purchase_summary.get("InvoiceNumber", ""),
            "brand": "",
            "category": "",
            "family": "",
            "sku": "",
            "product": "",
            "unit": "",
            "location": purchase_summary.get("Location", ""),
            "batch_number": "",
            "status": purchase_summary.get("Status", ""),
            "quantity": purchase_summary.get("Qty", 0) or 0,
            "main_cost": purchase_summary.get("Total", 0) or 0,
            "additional_cost": 0,
            "journal_cost": 0,
            "tax": purchase_summary.get("TaxTotal", 0) or 0,
        }]

    # -------------------------------------------------------------------
    # Mock data generators - used only when CIN7_MOCK_MODE=true
    # -------------------------------------------------------------------
    def _mock_sales_transactions(self) -> list:
        return [
            {"order_date": "2026-07-01", "order_number": "SO-MOCK-001", "invoice_date": "2026-07-02",
             "document_number": "INV-MOCK-001", "customer": "Mock Customer A", "invoice_status": "Invoiced",
             "shipment_status": "Shipped", "sales_rep": "Mock Rep", "sales_channel": "Shopify web",
             "sku": "MOCK-SKU-001", "product": "Mock Product 12pk", "brand": "MockBrand",
             "category": "Finished Goods", "family": "Variety", "quantity": 5, "invoice": 249.95,
             "sale": 249.95, "cogs": 115.20, "profit": 134.75},
        ]

    def _mock_inventory(self) -> list:
        return [
            {"location": "Mock Warehouse", "sku": "MOCK-SKU-001", "product": "Mock Product 12pk",
             "unit": "each", "quantity_on_hand": 240, "allocated": 20, "on_order": 100,
             "in_transit": 0, "unit_cost": 23.04, "stock_on_hand": 240, "available": 220},
        ]

    def _mock_purchases(self) -> list:
        return [
            {"supplier": "Mock Supplier Co", "po_number": "PO-MOCK-001", "invoice_number": "INV-SUP-001",
             "status": "Received", "sku": "MOCK-SKU-001", "product": "Mock Product 12pk",
             "brand": "MockBrand", "category": "Finished Goods", "family": "Variety", "unit": "each",
             "location": "Mock Warehouse", "batch_number": "B-001", "quantity": 500,
             "main_cost": 4600.00, "additional_cost": 120.00, "journal_cost": 0, "tax": 0},
        ]


# ---------------------------------------------------------------------------
# Example usage (not executed on import) - shows the intended calling pattern
# from the scheduler/api service, AFTER credentials have been decrypted.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # This block is illustrative only - replace with real decrypted values
    # pulled from your secrets-managed database layer.
    example_creds = Cin7Credentials(
        product_type=Cin7ProductType.CORE,
        account_id="REPLACE_WITH_DECRYPTED_VALUE",
        application_key="REPLACE_WITH_DECRYPTED_VALUE",
    )
    client = Cin7Client(example_creds, client_id_for_logging="example-client-uuid")

    if client.verify_credentials():
        sales = client.get_sales_transactions()
        inventory = client.get_inventory_on_hand()
        purchases = client.get_purchase_transactions()
        print(f"{len(sales)} sale lines, {len(inventory)} inventory rows, {len(purchases)} purchase lines")
    else:
        print("Credentials invalid - flag this client for re-authentication")