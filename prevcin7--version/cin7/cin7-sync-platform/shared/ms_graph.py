"""
Microsoft Graph API helper: refreshing OAuth tokens and writing data into
a client's SharePoint-hosted Excel file.

Install: pip install msal requests

References:
- MSAL (Microsoft Authentication Library) is Microsoft's official library
  for handling OAuth token acquisition/refresh - using it instead of
  hand-rolling the OAuth HTTP calls reduces the chance of subtle auth bugs.
  https://learn.microsoft.com/en-us/entra/msal/
- Graph API Excel operations (adding rows to a table):
  https://learn.microsoft.com/en-us/graph/api/table-post-rows

IMPORTANT - things you must fill in before this works:
- AZURE_APP_CLIENT_ID / AZURE_APP_CLIENT_SECRET: from YOUR single
  multi-tenant Azure app registration (one app for the whole platform,
  not per-client - see the OAuth consent flow discussed earlier).
- Each client's tenant_id, sharepoint_site_id, sharepoint_file_id, and
  refresh_token come from the database (already wired up in db.py).
"""

import os
import logging
from datetime import datetime, timedelta, timezone

import msal
import requests

logger = logging.getLogger("ms_graph")

GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
SCOPES = ["https://graph.microsoft.com/.default"]


class GraphAuthError(Exception):
    """Raised when a client's Microsoft consent appears to have been revoked."""
    pass


def _get_msal_app(tenant_id: str) -> msal.ConfidentialClientApplication:
    client_id = os.environ["AZURE_APP_CLIENT_ID"]
    client_secret = os.environ["AZURE_APP_CLIENT_SECRET"]
    authority = f"https://login.microsoftonline.com/{tenant_id}"
    return msal.ConfidentialClientApplication(
        client_id=client_id,
        client_credential=client_secret,
        authority=authority,
    )


def refresh_access_token(tenant_id: str, refresh_token: str) -> dict:
    """
    Exchanges a stored refresh token for a new access token.
    Returns dict with: access_token, refresh_token, expires_at (datetime)

    Raises GraphAuthError if the refresh token is no longer valid - this
    typically means the client revoked your app's access in their
    Microsoft 365 admin settings, and they'll need to re-consent via the
    OAuth flow before syncing can resume for them.
    """
    app = _get_msal_app(tenant_id)
    result = app.acquire_token_by_refresh_token(refresh_token, scopes=SCOPES)

    if "error" in result:
        raise GraphAuthError(
            f"Failed to refresh Microsoft token for tenant={tenant_id}: "
            f"{result.get('error_description', result.get('error'))}"
        )

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=result.get("expires_in", 3600))
    return {
        "access_token": result["access_token"],
        # Not all responses include a new refresh_token - reuse the old one if absent
        "refresh_token": result.get("refresh_token", refresh_token),
        "expires_at": expires_at,
    }


def get_valid_access_token(client_id: str, token_record, refresh_and_save_fn) -> str:
    """
    Returns a usable access token, refreshing first if expired.
    `token_record` is a db.ClientMicrosoftToken instance.
    `refresh_and_save_fn` is a callback (client_id, new_access, new_refresh, expires_at)
    used to persist the refreshed token - wire this to db.update_microsoft_access_token.
    """
    now = datetime.now(timezone.utc)
    if token_record.token_expires_at and token_record.token_expires_at > now:
        return token_record.access_token

    refreshed = refresh_access_token(token_record.tenant_id, token_record.refresh_token)
    refresh_and_save_fn(
        client_id,
        refreshed["access_token"],
        refreshed["refresh_token"],
        refreshed["expires_at"],
    )
    return refreshed["access_token"]


def write_rows_to_range(access_token: str, site_id: str, file_id: str,
                          sheet_name: str, start_cell: str, rows: list) -> int:
    """
    Writes rows into a plain cell range (NOT an Excel Table) starting at
    `start_cell`, e.g. start_cell="A7" for the Sales Transactions sheet
    where data begins at row 7 (headers are in row 6, with report
    metadata above that).

    This matches how the real Cin7 Controller Reporting template is
    built - it uses raw ranges below a fixed header row, not a defined
    Table object, so Graph's table-row-add API (used in an earlier
    draft of this file) doesn't apply here.

    `rows` should be a list of lists matching the sheet's exact column
    order, e.g. for Sales Transactions Raw Data:
    [Year, Month, Order date, Order #, Invoice date, Document #, SKU,
     Product, Brand, Category, Family, Product tags, Customer,
     Invoice status, Unit, Shipment status, Customer tags,
     Sales representative, Sales Channel, Quantity, Invoice, Sale,
     COGS, Profit less journals, Journals, Profit]
    """
    if not rows:
        return 0

    num_rows = len(rows)
    num_cols = len(rows[0])
    end_col_letter = _column_number_to_letter(_column_letter_to_number(start_cell[0]) + num_cols - 1)
    start_row = int(''.join(filter(str.isdigit, start_cell)))
    end_row = start_row + num_rows - 1
    start_col_letters = ''.join(filter(str.isalpha, start_cell))
    range_address = f"{start_col_letters}{start_row}:{end_col_letter}{end_row}"

    url = (f"{GRAPH_BASE_URL}/sites/{site_id}/drive/items/{file_id}/workbook/"
           f"worksheets('{sheet_name}')/range(address='{range_address}')")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    response = requests.patch(url, headers=headers, json={"values": rows}, timeout=60)

    if response.status_code == 401:
        raise GraphAuthError("Access token rejected - may need a fresh refresh or client re-consent.")

    response.raise_for_status()
    return num_rows


def clear_range(access_token: str, site_id: str, file_id: str,
                 sheet_name: str, range_address: str) -> None:
    """
    Clears existing data rows before writing fresh data, so re-running the
    sync REPLACES old rows rather than appending duplicates below them -
    matching the template's own documented refresh instructions ("replace
    all rows, keep headers"). Pass a generously large range (e.g.
    "A7:Z10000") to cover more rows than you expect to ever need.
    """
    url = (f"{GRAPH_BASE_URL}/sites/{site_id}/drive/items/{file_id}/workbook/"
           f"worksheets('{sheet_name}')/range(address='{range_address}')/clear")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    response = requests.post(url, headers=headers, json={"applyTo": "Contents"}, timeout=60)
    response.raise_for_status()


def force_recalculate(access_token: str, site_id: str, file_id: str) -> None:
    """
    Forces Excel Online to fully recalculate every formula in the workbook
    immediately - without this, formula-driven sheets (KPI Dashboard, Sales
    Trend Analysis, etc.) would show stale cached values until someone
    next opens the file in Excel. Call this AFTER all raw-data writes are
    done for a given sync.
    """
    url = f"{GRAPH_BASE_URL}/sites/{site_id}/drive/items/{file_id}/workbook/application/calculate"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    response = requests.post(url, headers=headers, json={"calculationType": "Full"}, timeout=60)
    response.raise_for_status()


def _column_letter_to_number(letter: str) -> int:
    result = 0
    for char in letter.upper():
        if char.isalpha():
            result = result * 26 + (ord(char) - ord('A') + 1)
    return result


def _column_number_to_letter(n: int) -> str:
    result = ""
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        result = chr(65 + remainder) + result
    return result