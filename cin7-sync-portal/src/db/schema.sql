-- VNC Cin7 Sync Engine Database Schema
-- Production Engine: PostgreSQL compatible

CREATE TABLE IF NOT EXISTS clients (
    id VARCHAR(64) PRIMARY KEY,
    company_name VARCHAR(255) NOT NULL,
    phone_number VARCHAR(50),
    timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
    status VARCHAR(50) DEFAULT 'ACTIVE',
    subscription_status VARCHAR(50) DEFAULT 'ACTIVE', -- 'ACTIVE' or 'EXPIRED'
    current_version VARCHAR(50) DEFAULT 'v1.0',
    last_sync_at TIMESTAMP,
    sync_status VARCHAR(50) DEFAULT 'IDLE',
    sync_schedule_json TEXT DEFAULT '{"daily_sync":true,"schedule_time":"02:00","timezone":"Asia/Kolkata","incremental_sync":true}',
    notifications_config_json TEXT DEFAULT '{"email_daily_summary":true,"email_sync_completed":true,"email_sync_failed":true,"email_critical_errors":true,"email_weekly_reports":false,"slack_status":"Not Connected","teams_status":"Not Connected"}',
    onboarding_status VARCHAR(50) DEFAULT 'pending',
    onboarding_completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(50),
    password_hash TEXT,
    role VARCHAR(50) DEFAULT 'ADMIN', -- 'ADMIN', 'MANAGER', 'VIEWER'
    platform_role VARCHAR(50) DEFAULT 'USER', -- 'USER', 'SUPER_ADMIN'
    status VARCHAR(50) DEFAULT 'ACTIVE', -- 'ACTIVE', 'DISABLED'
    auth_provider VARCHAR(50) NOT NULL DEFAULT 'local',
    onboarding_status VARCHAR(50) DEFAULT 'pending',
    onboarding_completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) UNIQUE NOT NULL, -- 'STARTER', 'PROFESSIONAL', 'ENTERPRISE'
    description TEXT,
    price DECIMAL(10, 2) DEFAULT 0.00,
    currency VARCHAR(10) DEFAULT 'USD',
    billing_interval VARCHAR(20) DEFAULT 'monthly', -- 'monthly', 'annual'
    is_active BOOLEAN DEFAULT TRUE,
    features_json TEXT NOT NULL DEFAULT '{}',
    limits_json TEXT NOT NULL DEFAULT '{}',
    external_price_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    plan_id VARCHAR(64) NOT NULL REFERENCES plans(id),
    billing_provider VARCHAR(50) DEFAULT 'neutral',
    external_customer_id VARCHAR(255),
    external_subscription_id VARCHAR(255),
    external_price_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'
    current_period_start TIMESTAMP,
    current_period_end TIMESTAMP,
    trial_start TIMESTAMP,
    trial_end TIMESTAMP,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    canceled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_events (
    id VARCHAR(64) PRIMARY KEY,
    billing_provider VARCHAR(50) DEFAULT 'neutral',
    external_event_id VARCHAR(255) UNIQUE,
    event_type VARCHAR(100) NOT NULL,
    organization_id VARCHAR(64) REFERENCES clients(id) ON DELETE CASCADE,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'PROCESSED',
    payload_hash VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_workbooks (
    id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(64) UNIQUE NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    workbook_path TEXT NOT NULL,
    current_version VARCHAR(50) DEFAULT 'v1.0',
    file_name VARCHAR(255) DEFAULT 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cin7_connections (
    id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(64) UNIQUE NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    api_username_encrypted TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'DISCONNECTED',
    last_tested_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    user_id VARCHAR(64),
    run_id VARCHAR(64) NOT NULL,
    sync_type VARCHAR(50) NOT NULL, -- 'sales', 'inventory', 'purchase_orders', 'all'
    status VARCHAR(50) NOT NULL, -- 'RUNNING', 'COMPLETED', 'FAILED'
    records_processed INT DEFAULT 0,
    duration_ms INT DEFAULT 0,
    error_message TEXT,
    destination_provider VARCHAR(50) DEFAULT 'server-xlsx',
    destination_file_id VARCHAR(255),
    destination_drive_id VARCHAR(255),
    destination_file_name VARCHAR(255),
    excel_version_id VARCHAR(50),
    excel_version_timestamp TIMESTAMP,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_logs (
    id VARCHAR(64) PRIMARY KEY,
    sync_run_id VARCHAR(64) NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
    client_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    log_level VARCHAR(20) DEFAULT 'INFO',
    message TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_snapshots (
    id VARCHAR(64) PRIMARY KEY,
    client_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    report_type VARCHAR(50) NOT NULL,
    report_name VARCHAR(255) NOT NULL,
    period_label VARCHAR(100),
    record_count INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'SUCCESS',
    sync_run_id VARCHAR(64),
    file_path TEXT,
    data_json TEXT,
    totals_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS data_json TEXT;

-- Active/current report state per client+type, replacing per-client disk JSON
-- files so it survives redeploys on hosts with ephemeral filesystems (Render).
CREATE TABLE IF NOT EXISTS current_reports (
    client_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    report_type VARCHAR(50) NOT NULL,
    latest_snapshot_id VARCHAR(64),
    data_json TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, report_type)
);

-- Incremental-sync safety state per client+type (replaces per-client disk
-- sync-state JSON file). Tracks the last successful sync boundary so the
-- next sync knows whether an incremental (UpdatedSince) fetch is safe.
CREATE TABLE IF NOT EXISTS client_sync_state (
    client_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    report_type VARCHAR(50) NOT NULL,
    report_window VARCHAR(20),
    last_successful_sync TIMESTAMP,
    last_sync_run_id VARCHAR(64),
    record_count INT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, report_type)
);

-- Google OAuth tokens (encrypted) per client/tenant, replacing the local
-- token.json file which lived on Render's ephemeral disk and was wiped on
-- every redeploy, forcing repeated "Authorize Google" re-prompts.
CREATE TABLE IF NOT EXISTS client_google_tokens (
    client_id VARCHAR(64) PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    encrypted_tokens TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    organization_id VARCHAR(64) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    user_id VARCHAR(64),
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(100) NOT NULL,
    result VARCHAR(50) NOT NULL DEFAULT 'SUCCESS', -- 'SUCCESS', 'FAILURE'
    details_json TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_platform_role ON users(platform_role);
CREATE INDEX IF NOT EXISTS idx_plans_code ON plans(code);
CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_billing_events_event_id ON billing_events(external_event_id);
CREATE INDEX IF NOT EXISTS idx_cin7_client_id ON cin7_connections(client_id);
CREATE INDEX IF NOT EXISTS idx_client_workbooks_client_id ON client_workbooks(client_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_client_id ON sync_runs(client_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_created_at ON sync_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_logs_run_id ON sync_logs(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_client_id ON report_snapshots(client_id);
CREATE INDEX IF NOT EXISTS idx_report_snapshots_created_at ON report_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_current_reports_client_id ON current_reports(client_id);
CREATE INDEX IF NOT EXISTS idx_client_sync_state_client_id ON client_sync_state(client_id);
CREATE INDEX IF NOT EXISTS idx_client_google_tokens_client_id ON client_google_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- ── CIN7 LIVE DATA STORE ─────────────────────────────────────────────────────
-- Persists all Cin7 API data in the database so synced data survives server
-- restarts, spreadsheet deletion, and enables fast incremental re-syncs.

-- Order detail cache: replaces per-client disk JSON files.
-- Keyed by (client_id, cin7_sale_id); updated_date_utc used for staleness check.
CREATE TABLE IF NOT EXISTS cin7_order_cache (
    client_id         VARCHAR(64)  NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    cin7_sale_id      VARCHAR(255) NOT NULL,
    updated_date_utc  TEXT,
    detail_json       TEXT         NOT NULL,
    stored_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, cin7_sale_id)
);

-- Sales order headers (one row per Cin7 sale)
CREATE TABLE IF NOT EXISTS cin7_sales_orders (
    client_id                 VARCHAR(64)  NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    cin7_sale_id              VARCHAR(255) NOT NULL,
    order_number              VARCHAR(255),
    invoice_number            VARCHAR(255),
    order_date                DATE,
    invoice_date              DATE,
    customer                  VARCHAR(255),
    status                    VARCHAR(100),
    combined_invoice_status   VARCHAR(100),
    combined_shipping_status  VARCHAR(100),
    type                      VARCHAR(100),
    source_channel            VARCHAR(255),
    sales_representative      VARCHAR(255),
    customer_tags             TEXT,
    updated_date_utc          TEXT,
    synced_at                 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, cin7_sale_id)
);

-- Sales order line items (one row per SKU per sale)
CREATE TABLE IF NOT EXISTS cin7_order_lines (
    client_id     VARCHAR(64)    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    cin7_sale_id  VARCHAR(255)   NOT NULL,
    sku           VARCHAR(255)   NOT NULL DEFAULT '',
    product_name  VARCHAR(255),
    brand         VARCHAR(255),
    category      VARCHAR(255),
    family        VARCHAR(255),
    unit          VARCHAR(100),
    quantity      DECIMAL(15,4)  DEFAULT 0,
    unit_price    DECIMAL(15,4)  DEFAULT 0,
    total         DECIMAL(15,4)  DEFAULT 0,
    average_cost  DECIMAL(15,4)  DEFAULT 0,
    PRIMARY KEY (client_id, cin7_sale_id, sku)
);

-- Inventory: current availability snapshot (fully replaced on each sync)
CREATE TABLE IF NOT EXISTS cin7_inventory (
    client_id     VARCHAR(64)    NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    location      VARCHAR(255)   NOT NULL DEFAULT 'Main Warehouse',
    sku           VARCHAR(255)   NOT NULL,
    product_name  VARCHAR(255),
    unit          VARCHAR(100),
    on_hand       DECIMAL(15,4)  DEFAULT 0,
    allocated     DECIMAL(15,4)  DEFAULT 0,
    on_order      DECIMAL(15,4)  DEFAULT 0,
    in_transit    DECIMAL(15,4)  DEFAULT 0,
    unit_cost     DECIMAL(15,4)  DEFAULT 0,
    stock_on_hand DECIMAL(15,4)  DEFAULT 0,
    available     DECIMAL(15,4)  DEFAULT 0,
    synced_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, location, sku)
);

-- Purchase order headers (one row per Cin7 PO)
CREATE TABLE IF NOT EXISTS cin7_purchase_orders (
    client_id        VARCHAR(64)   NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    cin7_po_id       VARCHAR(255)  NOT NULL,
    order_number     VARCHAR(255),
    invoice_number   VARCHAR(255),
    order_date       DATE,
    invoice_due_date DATE,
    supplier         VARCHAR(255),
    status           VARCHAR(100),
    invoice_amount   DECIMAL(15,4) DEFAULT 0,
    updated_date_utc TEXT,
    synced_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, cin7_po_id)
);

CREATE INDEX IF NOT EXISTS idx_cin7_order_cache_client ON cin7_order_cache(client_id);
CREATE INDEX IF NOT EXISTS idx_cin7_sales_orders_client ON cin7_sales_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_cin7_order_lines_client_sale ON cin7_order_lines(client_id, cin7_sale_id);
CREATE INDEX IF NOT EXISTS idx_cin7_inventory_client ON cin7_inventory(client_id);
CREATE INDEX IF NOT EXISTS idx_cin7_purchase_orders_client ON cin7_purchase_orders(client_id);

-- ── ROW LEVEL SECURITY (RLS) ──────────────────────────────────────────────────
-- Defense-in-depth tenant isolation. The app layer enforces client_id filtering;
-- RLS provides a database-level guarantee even if a query bug slips through.
-- All policies read current_setting('app.current_client_id', true) which the
-- application sets per-transaction via SET LOCAL before running tenant queries.
-- The Supabase service-role key bypasses RLS entirely (Supabase default).

DO $$ BEGIN
  ALTER TABLE clients                ENABLE ROW LEVEL SECURITY;
  ALTER TABLE users                  ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cin7_connections       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE client_workbooks       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sync_runs              ENABLE ROW LEVEL SECURITY;
  ALTER TABLE sync_logs              ENABLE ROW LEVEL SECURITY;
  ALTER TABLE report_snapshots       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE current_reports        ENABLE ROW LEVEL SECURITY;
  ALTER TABLE client_sync_state      ENABLE ROW LEVEL SECURITY;
  ALTER TABLE client_google_tokens   ENABLE ROW LEVEL SECURITY;
  ALTER TABLE audit_logs             ENABLE ROW LEVEL SECURITY;
  ALTER TABLE subscriptions          ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cin7_order_cache       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cin7_sales_orders      ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cin7_order_lines       ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cin7_inventory         ENABLE ROW LEVEL SECURITY;
  ALTER TABLE cin7_purchase_orders   ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RLS enable: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS clients_tenant ON clients;
  CREATE POLICY clients_tenant ON clients USING (id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'clients RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS users_tenant ON users;
  CREATE POLICY users_tenant ON users USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'users RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS cin7_connections_tenant ON cin7_connections;
  CREATE POLICY cin7_connections_tenant ON cin7_connections USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cin7_connections RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS client_workbooks_tenant ON client_workbooks;
  CREATE POLICY client_workbooks_tenant ON client_workbooks USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'client_workbooks RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS sync_runs_tenant ON sync_runs;
  CREATE POLICY sync_runs_tenant ON sync_runs USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'sync_runs RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS sync_logs_tenant ON sync_logs;
  CREATE POLICY sync_logs_tenant ON sync_logs USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'sync_logs RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS report_snapshots_tenant ON report_snapshots;
  CREATE POLICY report_snapshots_tenant ON report_snapshots USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'report_snapshots RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS current_reports_tenant ON current_reports;
  CREATE POLICY current_reports_tenant ON current_reports USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'current_reports RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS client_sync_state_tenant ON client_sync_state;
  CREATE POLICY client_sync_state_tenant ON client_sync_state USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'client_sync_state RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS client_google_tokens_tenant ON client_google_tokens;
  CREATE POLICY client_google_tokens_tenant ON client_google_tokens USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'client_google_tokens RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS audit_logs_tenant ON audit_logs;
  CREATE POLICY audit_logs_tenant ON audit_logs USING (organization_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'audit_logs RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS subscriptions_tenant ON subscriptions;
  CREATE POLICY subscriptions_tenant ON subscriptions USING (organization_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'subscriptions RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS cin7_order_cache_tenant ON cin7_order_cache;
  CREATE POLICY cin7_order_cache_tenant ON cin7_order_cache USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cin7_order_cache RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS cin7_sales_orders_tenant ON cin7_sales_orders;
  CREATE POLICY cin7_sales_orders_tenant ON cin7_sales_orders USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cin7_sales_orders RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS cin7_order_lines_tenant ON cin7_order_lines;
  CREATE POLICY cin7_order_lines_tenant ON cin7_order_lines USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cin7_order_lines RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS cin7_inventory_tenant ON cin7_inventory;
  CREATE POLICY cin7_inventory_tenant ON cin7_inventory USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cin7_inventory RLS: %', SQLERRM; END $$;

DO $$ BEGIN DROP POLICY IF EXISTS cin7_purchase_orders_tenant ON cin7_purchase_orders;
  CREATE POLICY cin7_purchase_orders_tenant ON cin7_purchase_orders USING (client_id = current_setting('app.current_client_id', true));
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cin7_purchase_orders RLS: %', SQLERRM; END $$;