# VNC Cin7 Sync Engine — Browser-Based SaaS Portal

## Quick Start & Local Execution Guide

### 1. Install Dependencies
```bash
cd cin7-sync-portal
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Ensure `ENCRYPTION_KEY` and `SESSION_SECRET` are set.

### 3. Run Automated Integration Test Suite
```bash
npm test
```

### 4. Start Local Development Server
```bash
npm run dev
```

Open your browser to:
`http://localhost:8080`

---

## Features
- **Browser-Based SaaS Experience**: No Excel Add-in installation required.
- **Microsoft & Google Single Sign-On**: Authenticate using Microsoft or Google accounts.
- **First-Time Cin7 Setup Modal**: Live "Test Connection" validation with server-side AES-256-GCM encrypted credential storage.
- **Multi-Tenant Data Isolation**: Complete separation of Client A and Client B credentials, spreadsheets, and audit logs.
- **Cin7 Core Integration Engine**:
  - Handles `/Sales`, `/Stock`, and `/PurchaseOrders` endpoints.
  - Rate limiting throttling queue (60 req/min).
  - 250 batch pagination.
  - Exponential backoff retry handler for HTTP 429 / 5xx errors.
  - Incremental `updated_since` data filtering.
- **Destination Adapters**:
  - `MicrosoftExcelAdapter` → Microsoft Excel Online (OneDrive)
  - `GoogleSheetsAdapter` → Google Sheets
  - Formats data into 4 canonical sheets with zebra striping, currency formatting, KPI cards, and status badges.
  - Avoids duplicate file creation on repeated syncs.
- **Sync Audit History Page**: Complete log of runs with duration, record counts, and run IDs.
- **Connection Settings Page**: Status badges and reconnect options for Cin7 and destination platforms.
