"""
Self-service onboarding portal - backend API.
Serves the endpoints the frontend (portal/frontend/index.html) calls.

This is a SEPARATE service from container_app/api_service.py (the sync
API that Excel's button calls) - this one is for client
signup/configuration, typically lower-traffic and can run on a smaller
Container Apps instance or even App Service.

Install: pip install fastapi uvicorn msal
"""

import os
import sys
import logging

import msal
from fastapi import FastAPI, HTTPException, Request, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, field_validator, model_validator

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "shared"))
import db  # noqa: E402
from cin7_client import Cin7Client, Cin7Credentials, Cin7ProductType  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("portal_api")

app = FastAPI(title="Client Onboarding Portal")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CLIENT_ID = os.environ.get("AZURE_APP_CLIENT_ID", "local-test-client-id")
CLIENT_SECRET = os.environ.get("AZURE_APP_CLIENT_SECRET", "local-test-client-secret")
REDIRECT_URI = os.environ.get("REDIRECT_URI", "http://localhost:8000/oauth-callback")
AUTHORITY = "https://login.microsoftonline.com/common"
SCOPES = ["Files.ReadWrite", "Sites.ReadWrite.All"]

# See oauth/oauth_flow.py note: replace with a shared store (DB/Redis) for
# real multi-replica deployments instead of in-memory state.
_pending_oauth_state = {}


# ---------------------------------------------------------------------------
# Step 1: Sign up
# ---------------------------------------------------------------------------
class SignupRequest(BaseModel):
    company_name: str
    contact_email: EmailStr  # rejects anything that isn't a real email shape

    @field_validator("company_name")
    @classmethod
    def company_name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Company name must be at least 2 characters.")
        return v


@app.post("/api/signup")
def signup(req: SignupRequest):
    client_id = db.create_client(req.company_name, req.contact_email)
    logger.info(f"New client signed up: {client_id} ({req.company_name})")
    return {"client_id": client_id}


# ---------------------------------------------------------------------------
# Step 2: Cin7 credentials
# ---------------------------------------------------------------------------
class Cin7CredentialsRequest(BaseModel):
    product_type: str  # "core" or "omni"
    core_account_id: str | None = None
    core_application_key: str | None = None
    omni_username: str | None = None
    omni_connection_key: str | None = None

    @field_validator("product_type")
    @classmethod
    def product_type_must_be_known(cls, v: str) -> str:
        if v not in ("core", "omni"):
            raise ValueError("product_type must be 'core' or 'omni'")
        return v

    @model_validator(mode="after")
    def required_fields_present_for_product_type(self):
        if self.product_type == "core":
            if not self.core_account_id or not self.core_account_id.strip():
                raise ValueError("Account ID is required for Cin7 Core.")
            if not self.core_application_key or not self.core_application_key.strip():
                raise ValueError("Application Key is required for Cin7 Core.")
        elif self.product_type == "omni":
            if not self.omni_username or not self.omni_username.strip():
                raise ValueError("Username is required for Cin7 Omni.")
            if not self.omni_connection_key or not self.omni_connection_key.strip():
                raise ValueError("Connection Key is required for Cin7 Omni.")
        return self


@app.post("/api/clients/{client_id}/cin7-credentials")
def save_cin7_credentials(client_id: str, req: Cin7CredentialsRequest):
    # Save first, then verify - so we always have a record of what was
    # entered even if verification fails (helps debugging a bad key).
    db.save_cin7_credentials(
        client_id,
        req.product_type,
        core_account_id=req.core_account_id,
        core_application_key=req.core_application_key,
        omni_username=req.omni_username,
        omni_connection_key=req.omni_connection_key,
    )

    creds = Cin7Credentials(
        product_type=Cin7ProductType(req.product_type),
        account_id=req.core_account_id,
        application_key=req.core_application_key,
        username=req.omni_username,
        connection_key=req.omni_connection_key,
    )
    is_valid = Cin7Client(creds, client_id_for_logging=client_id).verify_credentials()
    db.mark_cin7_verified(client_id, success=is_valid)

    if not is_valid:
        raise HTTPException(
            status_code=400,
            detail="Cin7 rejected these credentials - double check the Account ID/Key (or username/Connection Key for Omni) and try again.",
        )
    return {"status": "verified"}


# ---------------------------------------------------------------------------
# Step 3: Connect Microsoft 365 (OAuth)
# ---------------------------------------------------------------------------
def _get_msal_app() -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        client_id=CLIENT_ID, client_credential=CLIENT_SECRET, authority=AUTHORITY
    )


@app.get("/api/clients/{client_id}/connect-microsoft")
def connect_microsoft(client_id: str):
    if CLIENT_ID == "local-test-client-id":
        # Local test mode: auto-simulate Microsoft connection completion
        return RedirectResponse(f"/?client_id={client_id}&microsoft=connected")
    msal_app = _get_msal_app()
    state = client_id
    _pending_oauth_state[state] = client_id
    auth_url = msal_app.get_authorization_request_url(
        scopes=SCOPES, redirect_uri=REDIRECT_URI, state=state
    )
    return RedirectResponse(auth_url)


@app.get("/oauth-callback")
def oauth_callback(request: Request):
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    error = request.query_params.get("error")

    if error:
        raise HTTPException(status_code=400, detail=f"Microsoft consent failed: {error}")

    client_id = _pending_oauth_state.pop(state, None)
    if not client_id:
        raise HTTPException(status_code=400, detail="Unknown or expired OAuth state")

    msal_app = _get_msal_app()
    result = msal_app.acquire_token_by_authorization_code(
        code=code, scopes=SCOPES, redirect_uri=REDIRECT_URI
    )
    if "error" in result:
        raise HTTPException(status_code=400, detail=result.get("error_description"))

    # NOTE: site/file selection is still a manual follow-up step - see
    # earlier flag in oauth/oauth_flow.py. Redirect to a portal page that
    # lets the client pick their SharePoint file next.
    return RedirectResponse(f"/?client_id={client_id}&microsoft=connected")


# ---------------------------------------------------------------------------
# Step 4: Generate the Excel button's API key (shown ONCE)
# ---------------------------------------------------------------------------
@app.post("/api/clients/{client_id}/generate-button-key")
def generate_button_key(client_id: str):
    plaintext_key = db.generate_and_store_button_api_key(client_id)
    return {
        "api_key": plaintext_key,
        "warning": "This key is shown only once. Paste it into your Office Script now - it cannot be retrieved again, only regenerated.",
    }


@app.get("/api/clients/{client_id}/script")
def get_custom_script(client_id: str, api_key: str = Query(...)):
    script_path = os.path.join(os.path.dirname(__file__), "..", "office_script", "refresh_button.ts")
    if not os.path.exists(script_path):
        raise HTTPException(status_code=444, detail="Template script not found")
    
    with open(script_path, "r", encoding="utf-8") as f:
        script_code = f.read()

    # Replace CLIENT_ID and API_KEY constants with client's real values
    import re
    script_code = re.sub(r'const CLIENT_ID:\s*string\s*=\s*".*?";', f'const CLIENT_ID: string = "{client_id}";', script_code)
    script_code = re.sub(r'const API_KEY:\s*string\s*=\s*".*?";', f'const API_KEY: string = "{api_key}";', script_code)

    from fastapi.responses import Response
    return Response(content=script_code, media_type="text/plain")


# ---------------------------------------------------------------------------
# Step 5: Status dashboard
# ---------------------------------------------------------------------------
@app.get("/api/clients/{client_id}/status")
def get_status(client_id: str):
    status = db.get_client_status(client_id)
    if not status:
        raise HTTPException(status_code=404, detail="Client not found")
    return status


# ---------------------------------------------------------------------------
# Excel Button Sync Endpoint
# ---------------------------------------------------------------------------
class SyncResponse(BaseModel):
    status: str
    client_id: str
    rows_synced: int | None = None
    reason: str | None = None
    sales_headers: list | None = None
    sales_rows: list | None = None
    inventory_headers: list | None = None
    inventory_rows: list | None = None
    purchase_headers: list | None = None
    purchase_rows: list | None = None


def _verify_api_key(client_id: str, x_api_key: str | None) -> None:
    if not db.is_db_configured():
        return
    if not x_api_key or not db.verify_button_api_key(client_id, x_api_key):
        raise HTTPException(status_code=401, detail="Invalid or missing API key for this client")


@app.post("/sync/{client_id}", response_model=SyncResponse)
def trigger_sync(client_id: str, updated_since: str | None = Query(default=None), x_api_key: str = Header(default=None)):
    _verify_api_key(client_id, x_api_key)
    logger.info(f"Manual sync triggered via button for client={client_id} period={updated_since}")
    import sync_logic
    result = sync_logic.sync_client(client_id, triggered_by="manual_button", updated_since=updated_since)

    if result["status"] != "success":
        return SyncResponse(
            status=result["status"],
            client_id=client_id,
            reason=result.get("reason"),
        )

    return SyncResponse(
        status="success",
        client_id=client_id,
        rows_synced=result["rows_synced"],
        sales_headers=result.get("sales_headers"),
        sales_rows=result.get("sales_rows"),
        inventory_headers=result.get("inventory_headers"),
        inventory_rows=result.get("inventory_rows"),
        purchase_headers=result.get("purchase_headers"),
        purchase_rows=result.get("purchase_rows"),
    )


# Serve the frontend
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "frontend"), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
