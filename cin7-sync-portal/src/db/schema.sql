-- VNC Cin7 Sync Engine Database Schema
-- Production Engine: PostgreSQL compatible

CREATE TABLE IF NOT EXISTS clients (
    id VARCHAR(64) PRIMARY KEY,
    company_name VARCHAR(255) NOT NULL,
    phone_number VARCHAR(50),
    status VARCHAR(50) DEFAULT 'ACTIVE',
    subscription_status VARCHAR(50) DEFAULT 'ACTIVE', -- 'ACTIVE' or 'EXPIRED'
    current_version VARCHAR(50) DEFAULT 'v1.0',
    last_sync_at TIMESTAMP,
    sync_status VARCHAR(50) DEFAULT 'IDLE',
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
    role VARCHAR(50) DEFAULT 'CLIENT',
    auth_provider VARCHAR(50) NOT NULL DEFAULT 'local',
    onboarding_status VARCHAR(50) DEFAULT 'pending',
    onboarding_completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_cin7_client_id ON cin7_connections(client_id);
CREATE INDEX IF NOT EXISTS idx_client_workbooks_client_id ON client_workbooks(client_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_client_id ON sync_runs(client_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_created_at ON sync_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_logs_run_id ON sync_logs(sync_run_id);