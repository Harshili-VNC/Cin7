-- ============================================================================
-- Multi-tenant Cin7 -> Excel Sync Platform - Database Schema
-- Target: PostgreSQL (e.g. Azure Database for PostgreSQL)
--
-- IMPORTANT SECURITY NOTE:
-- Columns marked "-- ENCRYPTED" must be encrypted at the APPLICATION layer
-- (e.g. Python 'cryptography' Fernet, or envelope encryption via Azure Key
-- Vault) BEFORE being written here. This schema stores ciphertext (TEXT),
-- not plaintext secrets. The encryption key itself must live in Key Vault,
-- never in this database and never in application source code.
-- ============================================================================

CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name    TEXT NOT NULL,
    contact_email   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'paused', 'suspended')),

    -- Per-client API key for the Excel button (Office Scripts can't do
    -- OAuth - the key gets hardcoded into each client's own script, so
    -- each client MUST have their own distinct key. Store only a hash;
    -- the plaintext is shown to the client once, at generation time.
    button_api_key_hash   TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cin7_credentials (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    product_type            TEXT NOT NULL CHECK (product_type IN ('core', 'omni')),

    -- Cin7 Core fields (NULL if product_type = 'omni')
    core_account_id         TEXT,  -- ENCRYPTED
    core_application_key    TEXT,  -- ENCRYPTED

    -- Cin7 Omni fields (NULL if product_type = 'core')
    omni_username            TEXT,  -- ENCRYPTED
    omni_connection_key      TEXT,  -- ENCRYPTED

    is_verified              BOOLEAN NOT NULL DEFAULT false,
    last_verified_at         TIMESTAMPTZ,
    last_auth_failure_at     TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (client_id)  -- one active Cin7 connection per client
);

CREATE TABLE microsoft_oauth_tokens (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    tenant_id               TEXT NOT NULL,             -- client's own Microsoft 365 tenant
    sharepoint_site_id      TEXT NOT NULL,
    sharepoint_file_id      TEXT NOT NULL,              -- the specific Excel file to write to

    access_token             TEXT,  -- ENCRYPTED, short-lived (~1hr), refreshed automatically
    refresh_token            TEXT NOT NULL,  -- ENCRYPTED, long-lived
    token_expires_at         TIMESTAMPTZ,

    is_revoked               BOOLEAN NOT NULL DEFAULT false,  -- set true if client revokes consent
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (client_id)
);

CREATE TABLE sync_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id          UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    triggered_by       TEXT NOT NULL CHECK (triggered_by IN ('scheduled', 'manual_button')),
    status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'success', 'failed', 'partial')),
    rows_synced        INTEGER,
    error_message      TEXT,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at        TIMESTAMPTZ
);

-- Speeds up "give me today's jobs for this client" and dashboard queries
CREATE INDEX idx_sync_jobs_client_started ON sync_jobs (client_id, started_at DESC);

-- Speeds up "find all active clients ready for tonight's scheduled run"
CREATE INDEX idx_clients_status ON clients (status) WHERE status = 'active';

-- ============================================================================
-- Notes on design decisions:
--
-- 1. cin7_credentials and microsoft_oauth_tokens are separate tables (not
--    columns on `clients`) because they have very different lifecycles:
--    Cin7 keys rarely change, Microsoft tokens expire hourly. Keeping them
--    apart makes it obvious which system broke when a sync fails.
--
-- 2. sync_jobs is an audit trail, not just a status flag - given "highly
--    sensitive" data was flagged earlier, being able to answer "who ran a
--    sync, when, and did it succeed" for any client, any day, matters.
--
-- 3. ON DELETE CASCADE means removing a client cleans up their credentials
--    and tokens automatically. Confirm this matches your data-retention
--    policy before relying on it - you may prefer a soft-delete / archival
--    approach instead, especially for sync_jobs (audit history).
-- ============================================================================
