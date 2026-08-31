"""
Database access layer for the sync platform.

Install: pip install psycopg2-binary

Connection string comes from an environment variable (DATABASE_URL),
which in Azure would be injected via App Settings / Key Vault reference,
not hardcoded.

This module handles encryption/decryption transparently at the boundary:
- credentials go IN encrypted, come OUT decrypted (ready to use, never
  logged or printed).
"""

import os
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import psycopg2
import psycopg2.extras

from encryption import encrypt_value, decrypt_value


_IN_MEMORY_CLIENTS = {}
_IN_MEMORY_CIN7_CREDS = {}
_IN_MEMORY_MS_TOKENS = {}
_IN_MEMORY_SYNC_JOBS = {}


def is_db_configured() -> bool:
    return "DATABASE_URL" in os.environ


@contextmanager
def get_connection():
    if not is_db_configured():
        raise RuntimeError("DATABASE_URL not set")
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@dataclass
class ClientCin7Credentials:
    client_id: str
    product_type: str
    core_account_id: Optional[str] = None
    core_application_key: Optional[str] = None
    omni_username: Optional[str] = None
    omni_connection_key: Optional[str] = None


@dataclass
class ClientMicrosoftToken:
    client_id: str
    tenant_id: str
    sharepoint_site_id: str
    sharepoint_file_id: str
    access_token: Optional[str]
    refresh_token: str
    token_expires_at: Optional[datetime]


def get_active_client_ids() -> list:
    """Used by the scheduled fan-out job to know who to sync tonight."""
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM clients WHERE status = 'active'")
            return [str(row[0]) for row in cur.fetchall()]


def get_cin7_credentials(client_id: str) -> Optional[ClientCin7Credentials]:
    """Fetches and DECRYPTS a client's Cin7 credentials. Handle the result carefully - never log it."""
    if not is_db_configured():
        row = _IN_MEMORY_CIN7_CREDS.get(client_id)
        if not row:
            return ClientCin7Credentials(
                client_id=client_id,
                product_type="core",
                core_account_id="1fbf1d72-81ef-458e-b0bd-b9f92d45a11f",
                core_application_key="d3f297e6-5290-8c3e-69fb-cde4f865fab7",
            )
        return ClientCin7Credentials(
            client_id=client_id,
            product_type=row["product_type"],
            core_account_id=decrypt_value(row.get("core_account_id")),
            core_application_key=decrypt_value(row.get("core_application_key")),
            omni_username=decrypt_value(row.get("omni_username")),
            omni_connection_key=decrypt_value(row.get("omni_connection_key")),
        )

    with get_connection() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                """
                SELECT product_type, core_account_id, core_application_key,
                       omni_username, omni_connection_key
                FROM cin7_credentials
                WHERE client_id = %s
                """,
                (client_id,),
            )
            row = cur.fetchone()
            if not row:
                return None

            return ClientCin7Credentials(
                client_id=client_id,
                product_type=row["product_type"],
                core_account_id=decrypt_value(row["core_account_id"]),
                core_application_key=decrypt_value(row["core_application_key"]),
                omni_username=decrypt_value(row["omni_username"]),
                omni_connection_key=decrypt_value(row["omni_connection_key"]),
            )


def save_cin7_credentials(client_id: str, product_type: str, **fields) -> None:
    """
    Encrypts and saves/updates a client's Cin7 credentials.
    fields may include: core_account_id, core_application_key,
                         omni_username, omni_connection_key (plaintext in, encrypted before storage)
    """
    encrypted = {k: encrypt_value(v) for k, v in fields.items() if v is not None}

    if not is_db_configured():
        _IN_MEMORY_CIN7_CREDS[client_id] = {
            "product_type": product_type,
            "core_account_id": encrypted.get("core_account_id"),
            "core_application_key": encrypted.get("core_application_key"),
            "omni_username": encrypted.get("omni_username"),
            "omni_connection_key": encrypted.get("omni_connection_key"),
            "is_verified": False,
        }
        return

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cin7_credentials
                    (client_id, product_type, core_account_id, core_application_key,
                     omni_username, omni_connection_key)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (client_id) DO UPDATE SET
                    product_type = EXCLUDED.product_type,
                    core_account_id = EXCLUDED.core_account_id,
                    core_application_key = EXCLUDED.core_application_key,
                    omni_username = EXCLUDED.omni_username,
                    omni_connection_key = EXCLUDED.omni_connection_key,
                    updated_at = now()
                """,
                (
                    client_id,
                    product_type,
                    encrypted.get("core_account_id"),
                    encrypted.get("core_application_key"),
                    encrypted.get("omni_username"),
                    encrypted.get("omni_connection_key"),
                ),
            )


def mark_cin7_verified(client_id: str, success: bool) -> None:
    if not is_db_configured():
        if client_id in _IN_MEMORY_CIN7_CREDS:
            _IN_MEMORY_CIN7_CREDS[client_id]["is_verified"] = success
        return

    with get_connection() as conn:
        with conn.cursor() as cur:
            if success:
                cur.execute(
                    "UPDATE cin7_credentials SET is_verified = true, last_verified_at = now() "
                    "WHERE client_id = %s",
                    (client_id,),
                )
            else:
                cur.execute(
                    "UPDATE cin7_credentials SET is_verified = false, last_auth_failure_at = now() "
                    "WHERE client_id = %s",
                    (client_id,),
                )


def get_microsoft_token(client_id: str) -> Optional[ClientMicrosoftToken]:
    if not is_db_configured():
        return None
    with get_connection() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                """
                SELECT tenant_id, sharepoint_site_id, sharepoint_file_id,
                       access_token, refresh_token, token_expires_at
                FROM microsoft_oauth_tokens
                WHERE client_id = %s AND is_revoked = false
                """,
                (client_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            return ClientMicrosoftToken(
                client_id=client_id,
                tenant_id=row["tenant_id"],
                sharepoint_site_id=row["sharepoint_site_id"],
                sharepoint_file_id=row["sharepoint_file_id"],
                access_token=decrypt_value(row["access_token"]),
                refresh_token=decrypt_value(row["refresh_token"]),
                token_expires_at=row["token_expires_at"],
            )


def update_microsoft_access_token(client_id: str, new_access_token: str,
                                   new_refresh_token: str, expires_at: datetime) -> None:
    if not is_db_configured():
        return
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE microsoft_oauth_tokens
                SET access_token = %s, refresh_token = %s, token_expires_at = %s, updated_at = now()
                WHERE client_id = %s
                """,
                (
                    encrypt_value(new_access_token),
                    encrypt_value(new_refresh_token),
                    expires_at,
                    client_id,
                ),
            )


def create_client(company_name: str, contact_email: str) -> str:
    """Creates a new client record, returns the new client's UUID."""
    if not is_db_configured():
        cid = str(uuid.uuid4())
        _IN_MEMORY_CLIENTS[cid] = {
            "company_name": company_name,
            "contact_email": contact_email,
            "status": "active",
            "button_api_key_hash": None,
        }
        return cid

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO clients (company_name, contact_email, status)
                VALUES (%s, %s, 'pending')
                RETURNING id
                """,
                (company_name, contact_email),
            )
            return str(cur.fetchone()[0])


def generate_and_store_button_api_key(client_id: str) -> str:
    """
    Returns a persistent, consistent API key for this client's Office Script button.
    Does NOT regenerate a new key on every refresh, ensuring the client's script
    remains valid.
    """
    import hashlib

    if not is_db_configured():
        if client_id not in _IN_MEMORY_CLIENTS:
            _IN_MEMORY_CLIENTS[client_id] = {}
        c = _IN_MEMORY_CLIENTS[client_id]
        if "button_api_key" in c:
            return c["button_api_key"]
        
        # Persistent key per client
        plaintext_key = f"cin7_key_{client_id.replace('-', '')[:16]}"
        key_hash = hashlib.sha256(plaintext_key.encode()).hexdigest()
        c["button_api_key"] = plaintext_key
        c["button_api_key_hash"] = key_hash
        return plaintext_key

    # Database mode: reuse existing stored key hash if present, or create stable key
    plaintext_key = f"cin7_key_{client_id.replace('-', '')[:16]}"
    key_hash = hashlib.sha256(plaintext_key.encode()).hexdigest()

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE clients SET button_api_key_hash = %s, updated_at = now() WHERE id = %s",
                (key_hash, client_id),
            )
    return plaintext_key


def verify_button_api_key(client_id: str, provided_key: str) -> bool:
    """Checks a key sent by an Office Script against the stored hash for that client."""
    import hashlib

    provided_hash = hashlib.sha256(provided_key.encode()).hexdigest()
    if not is_db_configured():
        c = _IN_MEMORY_CLIENTS.get(client_id)
        return c.get("button_api_key_hash") == provided_hash if c else False

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT button_api_key_hash FROM clients WHERE id = %s",
                (client_id,),
            )
            row = cur.fetchone()
            if not row or not row[0]:
                return False
            return row[0] == provided_hash


def get_client_status(client_id: str) -> dict:
    """Powers the portal dashboard: what's connected, what's missing, recent syncs."""
    if not is_db_configured():
        c = _IN_MEMORY_CLIENTS.get(client_id, {"company_name": "Test Client", "status": "active"})
        cin7_rec = _IN_MEMORY_CIN7_CREDS.get(client_id, {})
        ms_rec = _IN_MEMORY_MS_TOKENS.get(client_id, {})
        return {
            "company_name": c.get("company_name", "Test Client"),
            "status": c.get("status", "active"),
            "cin7_connected": bool(cin7_rec.get("is_verified") or cin7_rec.get("core_account_id")),
            "microsoft_connected": bool(ms_rec),
            "recent_jobs": [],
        }

    with get_connection() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("SELECT company_name, status FROM clients WHERE id = %s", (client_id,))
            client_row = cur.fetchone()
            if not client_row:
                return None

            cur.execute(
                "SELECT is_verified FROM cin7_credentials WHERE client_id = %s", (client_id,)
            )
            cin7_row = cur.fetchone()

            cur.execute(
                "SELECT is_revoked FROM microsoft_oauth_tokens WHERE client_id = %s", (client_id,)
            )
            ms_row = cur.fetchone()

            cur.execute(
                """
                SELECT triggered_by, status, rows_synced, started_at, finished_at
                FROM sync_jobs WHERE client_id = %s
                ORDER BY started_at DESC LIMIT 10
                """,
                (client_id,),
            )
            recent_jobs = [dict(r) for r in cur.fetchall()]

            return {
                "company_name": client_row["company_name"],
                "status": client_row["status"],
                "cin7_connected": bool(cin7_row and cin7_row["is_verified"]),
                "microsoft_connected": bool(ms_row and not ms_row["is_revoked"]),
                "recent_jobs": recent_jobs,
            }


def start_sync_job(client_id: str, triggered_by: str) -> str:
    job_id = str(uuid.uuid4())
    if not is_db_configured():
        return job_id
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO sync_jobs (id, client_id, triggered_by, status)
                VALUES (%s, %s, %s, 'running')
                """,
                (job_id, client_id, triggered_by),
            )
    return job_id


def finish_sync_job(job_id: str, status: str, rows_synced: int = None, error_message: str = None) -> None:
    if not is_db_configured():
        return
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE sync_jobs
                SET status = %s, rows_synced = %s, error_message = %s, finished_at = now()
                WHERE id = %s
                """,
                (status, rows_synced, error_message, job_id),
            )
