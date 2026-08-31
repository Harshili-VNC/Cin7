# VNC Cin7 Sync Engine — Portal Architecture Documentation

## Overview
The **VNC Cin7 Sync Portal** is a multi-tenant SaaS application that enables clients to connect their Cin7 Core ERP account once and synchronize Sales, Inventory On Hand, and Purchase Orders directly into Microsoft Excel Online or Google Sheets directly from any modern web browser.

---

## High-Level Architecture Diagram

```
                       ┌─────────────────────────┐
                       │   Client Web Browser    │
                       │ (VNC Enterprise Portal) │
                       └────────────┬────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │   Node.js / Express     │
                       │    REST API Server      │
                       └─────┬─────────────┬─────┘
                             │             │
           ┌─────────────────┴─┐         ┌─┴───────────────────┐
           ▼                   ▼         ▼                     ▼
┌────────────────────┐   ┌───────────┐ ┌──────────┐ ┌────────────────────┐
│ Multi-Tenant DB    │   │  AES-256  │ │  Cin7    │ │ Destination        │
│ (PostgreSQL/SQLite)│   │  Crypto   │ │  Engine  │ │ Adapters           │
└────────────────────┘   └───────────┘ └────┬─────┘ └──────────┬─────────┘
                                            │                  │
                                            ▼                  ▼
                                    ┌──────────────┐  ┌──────────────────┐
                                    │  Cin7 ERP    │  │ Microsoft Graph  │
                                    │  REST Gateway│  │ Google Sheets    │
                                    └──────────────┘  └──────────────────┘
```

---

## Security Architecture

1. **AES-256-GCM Encryption at Rest**:
   - All Cin7 API credentials and OAuth tokens are encrypted before being written to the database using AES-256-GCM authenticated encryption.
   - The master key is supplied via `ENCRYPTION_KEY`.
   - Credentials are never logged to console/files or exposed to frontend API payloads.

2. **Strict Multi-Tenant Scoping**:
   - `client_id` is resolved strictly from the authenticated server-side session (`req.user.client_id`).
   - Client-supplied tenant IDs are rejected.
   - Database queries mandate `WHERE client_id = ?` scoping.

3. **HTTP-Only Secure Cookie Sessions**:
   - Session identifiers are stored in HTTP-Only cookies with `SameSite=Strict` protection.

---

## Destination Adapter Architecture

The application uses an extensible **Destination Adapter Pattern**:

- `DestinationAdapter` (Abstract Base Interface)
  - `MicrosoftExcelAdapter`: Connects via Microsoft Graph API / ExcelJS to construct and format canonical sheets (`Sales Transactions Raw Data`, `Inventory On Hand Raw Data`, `Purchase Transactions Raw Data`, `Sync Log`).
  - `GoogleSheetsAdapter`: Connects via Google Drive API & Sheets API to maintain mirrored canonical spreadsheets.
  - Storage files are indexed by client ID in `destination_files`, preventing duplicate spreadsheet creation on repeated syncs.

---

## Database Schema Model

- `clients`: Primary tenant organization.
- `users`: User identity bound to tenant (`client_id`) and role (`CLIENT` or `ADMIN`).
- `oauth_accounts`: Microsoft / Google OAuth token metadata.
- `cin7_connections`: AES-256-GCM encrypted API credentials.
- `destination_files`: Tracked Excel / Google Sheets URLs and file IDs.
- `sync_runs`: Audit records of every sync execution, record count, duration, and status.
- `sync_logs`: Detailed execution trace logs per run.
