"""
Timer-triggered Azure Function - runs once at your chosen start time
(e.g. 7pm) and fans out every active client into a queue. It does NOT
do the actual syncing itself - that's QueueSyncWorker's job. This keeps
the fan-out fast and simple, regardless of how many clients you have.

Configure the schedule in function.json (NCRONTAB format), e.g.:
  "0 0 19 * * *"   -> runs daily at 19:00 (7pm)

Requires an Azure Storage Queue (or Service Bus queue) named 'client-sync-queue'
bound in function.json as an output binding.
"""

import logging
import json
import sys
import os
from typing import List

import azure.functions as func

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
import db  # noqa: E402


def main(timer: func.TimerRequest, msg: func.Out[List[str]]) -> None:
    logging.info("TimerFanOut triggered - queuing all active clients for sync")

    client_ids = db.get_active_client_ids()
    logging.info(f"Found {len(client_ids)} active clients to sync")

    # Each queue message = one client's sync job. The queue naturally
    # spreads processing over time rather than hitting everyone at once -
    # see QueueSyncWorker's host.json batchSize settings to control how
    # spread-out (or parallel) this actually is.
    messages = [json.dumps({"client_id": cid, "triggered_by": "scheduled"}) for cid in client_ids]

    # func.Out[List[str]] lets us set every message for this invocation
    # in one call - Azure Functions handles enqueueing them all.
    msg.set(messages)

    logging.info(f"TimerFanOut complete - queued {len(messages)} clients")
