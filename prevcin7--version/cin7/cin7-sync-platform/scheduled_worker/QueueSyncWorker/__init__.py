"""
Queue-triggered Azure Function - processes ONE client's sync per message.
This is what actually calls Cin7 and writes to SharePoint, via the shared
sync_logic module (the same code path the manual button API uses).

Because each invocation only handles one client, a failure for one client
(bad credentials, Cin7 timeout, etc.) never affects the other 199+ -
Azure Functions retries/dead-letters failed messages independently.
"""

import logging
import json
import sys
import os

import azure.functions as func

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
import sync_logic  # noqa: E402


def main(msg: func.QueueMessage) -> None:
    body = json.loads(msg.get_body().decode("utf-8"))
    client_id = body["client_id"]
    triggered_by = body.get("triggered_by", "scheduled")

    logging.info(f"QueueSyncWorker processing client={client_id}")

    result = sync_logic.sync_client(client_id, triggered_by)

    if result["status"] != "success":
        # Logging (not raising) so Azure doesn't endlessly retry a client
        # whose credentials are simply wrong - that needs a human/client
        # to fix, not a retry. sync_jobs table already has the failure
        # logged with details for your dashboard/alerting to pick up.
        logging.warning(f"Sync failed for client={client_id}: {result}")
    else:
        logging.info(f"Sync succeeded for client={client_id}: {result['rows_synced']} rows")
