"""
DIAGNOSTIC SCRIPT - run this once with your real Cin7 Core credentials to
see the ACTUAL field names Cin7 returns. This lets us fix any guessed
field names in cin7_client.py with confirmed real ones.

Usage:
    python test_cin7_real.py YOUR_ACCOUNT_ID YOUR_APPLICATION_KEY

This does NOT write anything to your Cin7 account or any Excel file -
it only reads a small sample and prints it to the screen.
"""

import sys
import json

sys.path.insert(0, ".")  # run this from the shared/ folder
from cin7_client import Cin7Client, Cin7Credentials, Cin7ProductType


def main():
    if len(sys.argv) != 3:
        print("Usage: python test_cin7_real.py YOUR_ACCOUNT_ID YOUR_APPLICATION_KEY")
        sys.exit(1)

    account_id = sys.argv[1]
    application_key = sys.argv[2]

    creds = Cin7Credentials(
        product_type=Cin7ProductType.CORE,
        account_id=account_id,
        application_key=application_key,
    )
    client = Cin7Client(creds, client_id_for_logging="diagnostic-test")

    print("=" * 70)
    print("STEP 1: Verifying credentials...")
    print("=" * 70)
    if not client.verify_credentials():
        print("❌ Credentials rejected by Cin7. Double check the Account ID and Application Key.")
        sys.exit(1)
    print("✅ Credentials verified successfully.\n")

    print("=" * 70)
    print("STEP 2: Fetching one page of SaleList (sale-level preview)...")
    print("=" * 70)
    try:
        sale_list_page = client._request("GET", "SaleList", params={"Page": 1, "Limit": 20})
        print(json.dumps(sale_list_page, indent=2)[:3000])
    except Exception as e:
        print(f"❌ SaleList call failed: {e}")
    print()

    print("=" * 70)
    print("STEP 3: Searching for a sale with ACTUAL line items (not voided/empty)...")
    print("=" * 70)
    try:
        sales = sale_list_page.get("SaleList", []) if isinstance(sale_list_page, dict) else []
        found_populated_sale = False
        for sale_summary in sales:
            sale_id = sale_summary.get("SaleID") or sale_summary.get("ID")
            if not sale_id:
                continue
            detail = client._request("GET", "Sale", params={"ID": sale_id})
            order_lines = detail.get("Order", {}).get("Lines", [])
            invoice_lines = []
            for inv in detail.get("Invoices", []):
                invoice_lines.extend(inv.get("Lines", []))
            if order_lines or invoice_lines:
                print(f"Found populated sale! SaleID: {sale_id}, Status: {detail.get('Status')}\n")
                print(f"--- Order.Lines ({len(order_lines)} items) ---")
                print(json.dumps(order_lines[:2], indent=2))
                print(f"\n--- Invoices[].Lines ({len(invoice_lines)} items) ---")
                print(json.dumps(invoice_lines[:2], indent=2))
                print(f"\n--- Top-level Customer field ---")
                print(f"Customer: {detail.get('Customer')}")
                found_populated_sale = True
                break
        if not found_populated_sale:
            print("None of the first page of sales had populated line items.")
            print("Try creating one test sale with a real product line in Cin7's UI, then re-run this script.")
    except Exception as e:
        print(f"❌ Sale line search failed: {e}")
    print()

    print("=" * 70)
    print("STEP 4: Testing ProductAvailability with several URL variants...")
    print("=" * 70)
    variants = [
        ("v2, no params", f"{client.base_url}ProductAvailability", {}),
        ("v2, Page/Limit", f"{client.base_url}ProductAvailability", {"Page": 1, "Limit": 3}),
        ("v2, lowercase page/limit", f"{client.base_url}ProductAvailability", {"page": 1, "limit": 3}),
        ("v1 (no version), Page/Limit",
         "https://inventory.dearsystems.com/externalapi/ProductAvailability", {"Page": 1, "Limit": 3}),
    ]
    for label, url, params in variants:
        try:
            raw_response = client.session.get(url, params=params, timeout=30)
            content_type = raw_response.headers.get("Content-Type", "")
            print(f"[{label}] status={raw_response.status_code} content-type={content_type}")
            if "json" in content_type:
                print(f"  JSON response (first 800 chars): {raw_response.text[:800]}")
            else:
                print(f"  NOT JSON - first 200 chars: {raw_response.text[:200]}")
        except Exception as e:
            print(f"[{label}] request failed: {e}")
        print()

    print("=" * 70)
    print("STEP 5: Fetching one page of Products (for Brand/Category/Family)...")
    print("=" * 70)
    try:
        products_page = client._request("GET", "product", params={"Page": 1, "Limit": 3})
        print(json.dumps(products_page, indent=2)[:3000])
    except Exception as e:
        print(f"❌ Products call failed: {e}")
    print()

    print("=" * 70)
    print("STEP 6: Fetching one page of PurchaseList...")
    print("=" * 70)
    try:
        purchase_list_page = client._request("GET", "PurchaseList", params={"Page": 1, "Limit": 3})
        print(json.dumps(purchase_list_page, indent=2)[:3000])
    except Exception as e:
        print(f"❌ PurchaseList call failed: {e}")
    print()

    print("=" * 70)
    print("STEP 7: Fetching purchase/order detail...")
    print("=" * 70)
    try:
        purchases = purchase_list_page.get("PurchaseList", []) if isinstance(purchase_list_page, dict) else []
        for purchase_summary in purchases[:3]:
            purchase_id = purchase_summary.get("ID")
            print(f"Trying PurchaseID: {purchase_id}")
            raw_response = client._request("GET", "purchase/order", params={"TaskID": purchase_id})
            print(f"  SUCCESS - full response:\n{json.dumps(raw_response, indent=2)[:5000]}")
            break
    except Exception as e:
        print(f"❌ Purchase order search failed: {e}")

    print("\n" + "=" * 70)
    print("DONE. Copy everything above and share it back - this tells us")
    print("the exact field names to use instead of the guessed ones.")
    print("=" * 70)


if __name__ == "__main__":
    main()