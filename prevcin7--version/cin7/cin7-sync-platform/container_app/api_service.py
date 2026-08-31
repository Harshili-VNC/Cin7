"""
API service for the on-demand "click to refresh" button.
Excel's Office Script calls this endpoint (via Power Automate) when a
user clicks the button in their spreadsheet.

Install: pip install fastapi uvicorn

Runs the SAME sync_logic.sync_client() function as the scheduled queue
worker - no duplicated logic between the two trigger paths.
"""

import logging
import os
import sys

from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.append(os.path.join(os.path.dirname(__file__), "shared"))
import sync_logic  # noqa: E402
import db  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("api_service")

app = FastAPI(title="Cin7 Sync API")

# Excel Online (Office Scripts) needs CORS allowed to call this API directly
# from the browser. Restrict this to Microsoft's actual Excel Online origin
# in production rather than "*" - adjust once confirmed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://excel.officeapps.live.com"],
    allow_methods=["POST"],
    allow_headers=["*"],
)


class SyncResponse(BaseModel):
    status: str
    client_id: str
    rows_synced: int | None = None
    reason: str | None = None


def _verify_api_key(client_id: str, x_api_key: str | None) -> None:
    """
    Each client has their OWN API key (see db.generate_and_store_button_api_key),
    hardcoded into their own Office Script. This means a leaked key only
    exposes that one client, not the whole platform - important given
    Office Scripts have no secure credential storage of their own.
    """
    if not x_api_key or not db.verify_button_api_key(client_id, x_api_key):
        raise HTTPException(status_code=401, detail="Invalid or missing API key for this client")


@app.post("/sync/{client_id}", response_model=SyncResponse)
def trigger_sync(client_id: str, x_api_key: str = Header(default=None)):
    _verify_api_key(client_id, x_api_key)

    logger.info(f"Manual sync triggered via button for client={client_id}")
    result = sync_logic.sync_client(client_id, triggered_by="manual_button")

    if result["status"] != "success":
        # Return 200 with failure details rather than 500 - this was a
        # legitimate request that failed for a known business reason
        # (bad credentials, rate limit, etc.), not a server crash.
        return SyncResponse(
            status=result["status"],
            client_id=client_id,
            reason=result.get("reason"),
        )

    return SyncResponse(
        status="success",
        client_id=client_id,
        rows_synced=result["rows_synced"],
    )


@app.get("/health")
def health_check():
    """Container Apps uses this to confirm the service is alive."""
    return {"status": "ok"}
