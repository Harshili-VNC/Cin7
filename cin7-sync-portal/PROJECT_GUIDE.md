# VNC Cin7 Sync Portal — Project Guide

**Read this first.** It explains how the whole system fits together, where every
piece of code lives, and how to add new features the right way. Plain language,
no assumptions.

Keep it up to date when something structural changes. This guide replaces
`ARCHITECTURE.md` as the primary onboarding doc — that file is now a short,
older summary and may drift out of date; trust this one.

---

## 1. What this is

A single-service, multi-tenant web application. Each client company ("org")
connects their **Cin7 Core** inventory/ERP account once; the portal pulls their
Sales, Inventory, and Purchase Order data and writes it into a **live Google
Sheet** (cloned from one master financial-reporting template) or, less
completely, into an Excel workbook. A Super Admin console manages every org
from one place, including a full "view as this org/user" impersonation mode.

There is no build step and no framework on the frontend — it's a single static
HTML page with two script/style files, calling a plain Express JSON API.

---

## 2. The big picture — how a request flows

```
  Browser (public/index.html + app.js, no framework, no build step)
        │  fetch('/api/...'), same-origin, cookie-based session
        ▼
  Express app (src/server.js)
        │  security headers → CORS allowlist → body parsing → session
        │  → per-route middleware (auth, role, tenant) → route handler
        ▼
  Routes (src/routes/*.js) → Services (src/services/*.js)
        │                         │
        │                         ├─ cin7Engine.js  ──▶ Cin7 Core REST API
        │                         ├─ googleSheetsAdapter.js ──▶ Google Drive/Sheets API
        │                         ├─ microsoftExcelAdapter.js ──▶ local .xlsx via ExcelJS
        │                         └─ snapshotService.js ──▶ persisted report snapshots
        ▼
  db/index.js (one adapter, picked at boot)
        ├─ SupabaseDatabaseAdapter   (production: Supabase Postgres + supabase-js)
        ├─ PostgresDatabaseAdapter   (self-hosted Postgres, DATABASE_URL)
        └─ MemoryDatabaseAdapter     (no DB configured — JSON file, dev/offline only)
```

Rules that hold today:

1. **The browser only ever calls `/api/*` on this same Express app.** There is
   no separate API origin, no separate frontend build/deploy.
2. **All business logic lives in `src/services/`.** Route files
   (`src/routes/*.js`) parse the request, call a service, shape the response —
   they shouldn't contain Cin7/spreadsheet/database logic themselves.
3. **Every tenant-scoped request resolves `client_id` from the session only**
   (`req.user.client_id`, set by `enforceTenantIsolation` in
   `src/middleware/tenantMiddleware.js`) — never from a client-supplied header,
   query param, or body field. See §9.
4. **There is one database access layer** (`src/db/index.js`) — routes and
   services call `db.query(...)` / `db.getOne(...)`; nothing opens its own
   database connection.

---

## 3. Repository layout

This is **not** a monorepo — `cin7-sync-portal/` is the one real application.
The parent folder (`Cin7/`) also has several older/parallel folders
(`cin7-sheets`, `cin7-sheets-bridge`, `cin7-sync-addin`, `prevcin7--version`)
that are earlier prototypes or a separate script-based integration, plus loose
planning docs (`*.docx`) and zip snapshots at the very top level — **ignore all
of that**; it isn't part of the running app and isn't wired into
`cin7-sync-portal` in any way.

```
Cin7/                          (git root)
├── cin7-sync-portal/          ← the actual application (everything below is here)
│   ├── src/
│   │   ├── server.js          Express app entry point — see §2 for wiring order
│   │   ├── routes/            one file per feature area, thin (HTTP only)
│   │   ├── services/          business logic — the real engine
│   │   ├── middleware/        auth, tenant isolation, rate limiting, validation
│   │   └── db/                schema.sql (reference) + the 3-way adapter (§5)
│   ├── public/                the entire frontend: index.html, app.js, styles.css
│   ├── test/                  manual Node scripts (no test framework — §7)
│   ├── storage/                local per-client file storage: excel_files, google_sheets, snapshots, order_cache, sync_state, current_reports, master
│   ├── .env.example           every environment variable this app reads
│   ├── ARCHITECTURE.md        older, shorter architecture summary (superseded by this file)
│   └── package.json
├── supabase/migrations/       currently empty — see §5.4 caveat
└── scripts/                   two PowerShell ops scripts (zip a release, clean local DB)
```

| You want to…                             | Go to                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Change a screen or client-side behaviour  | `cin7-sync-portal/public/app.js` (logic) + `index.html` (markup)   |
| Add/adjust an API endpoint                | `cin7-sync-portal/src/routes/<area>Routes.js`                      |
| Change sync/business logic                | `cin7-sync-portal/src/services/<area>.js`                          |
| Change how data reaches Google Sheets     | `src/services/googleSheetsAdapter.js`                              |
| Change how data reaches Excel             | `src/services/microsoftExcelAdapter.js` (see §6.4 — limited today) |
| Change auth / roles / tenant scoping      | `src/middleware/authMiddleware.js`, `tenantMiddleware.js`           |
| Change the database structure             | `src/db/schema.sql` **and** apply it by hand — see §5.3            |
| Add a manual verification script          | `test/*.js` — run directly with `node test/<file>.js`              |

---

## 4. Running it locally

Prerequisites: Node.js, npm. No Docker, no local Postgres required — the app
runs perfectly well against the shared **Supabase dev project**, or with no
database configured at all (falls back to an in-memory/JSON store, §5).

```bash
cd cin7-sync-portal
npm install

cp .env.example .env
# Fill in at minimum: ENCRYPTION_KEY, SESSION_SECRET (see §11 for how to
# generate them), and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_DB_URL
# if you want real persistence instead of the in-memory fallback.

npm run dev      # node --watch src/server.js — restarts on file change
```

Open `http://localhost:2121` (the default in `src/server.js` when `PORT` isn't
set — `.env.example` shows `8080` as a placeholder, but the app's own default,
and what this app actually runs on day to day, is **2121**).

- `npm start` — same thing without `--watch` (what a real deployment runs).
- `npm run init-db` — connects and runs `SELECT 1`; it does **not** apply
  `schema.sql` (see §5.3 — there is no automated migration step today).
- `npm test` — runs `test/test_portal.js` directly with `node`, not a test
  runner; most of `test/*.js` are manual, standalone verification scripts you
  run individually the same way (`node test/test_multi_client_isolation.js`,
  etc.) against a running server. There's no CI wired to run any of them.

---

## 5. The database (`src/db/`)

### 5.1 Three adapters, picked automatically at boot

`src/db/index.js` exports **one** adapter instance, chosen by what's in `.env`,
logged clearly on startup:

| Condition                                                       | Adapter                    | Notes                                                             |
| ----------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_DB_URL`) | `SupabaseDatabaseAdapter` | **Production path.** Uses `supabase-js` + a direct `pg` connection. |
| `DATABASE_URL` set, no Supabase vars, `USE_SQLITE_DEV !== 'true'` | `PostgresDatabaseAdapter` | Self-hosted Postgres, same SQL either way.                        |
| Neither                                                            | `MemoryDatabaseAdapter`   | In-process object graph, persisted to `src/db/portal_db_store.json`. Fine for a quick local check, **loses multi-client realism and doesn't survive a fresh clone** — don't use it to verify anything tenant-isolation-related. |

All three adapters expose the same `query(sql, params)` / `getOne(sql, params)`
shape, so route/service code never branches on which one is active.

`SupabaseDatabaseAdapter` also recognizes optional `DATABASE_URL_ADMIN` /
`DATABASE_URL_TENANT` connection strings for a future split between an admin
role and a per-tenant RLS-restricted role — **neither is set today**, so both
fall back to the same shared root credential and **Postgres Row Level Security
provides no real protection right now** (see §5.4 and §9 — tenant isolation is
enforced entirely at the application layer).

### 5.2 Where the table definitions live — and a real caveat

`src/db/schema.sql` lists every table this app is written against: `clients`,
`users`, `plans`, `subscriptions`, `billing_events`, `client_workbooks`,
`cin7_connections`, `sync_runs`, `sync_logs`, `report_snapshots`,
`current_reports`, `client_sync_state`, `client_google_tokens`, `audit_logs`,
`cin7_order_cache`, `cin7_sales_orders`, `cin7_order_lines`, `cin7_inventory`,
`cin7_purchase_orders`.

**Important:** nothing in this repo actually *applies* `schema.sql` to a
database. `npm run init-db` only runs `SELECT 1` to check connectivity (see
§4). The real Supabase database was set up by hand at some point outside this
repo, and it has **at least one table not in `schema.sql`** —
`destination_files` (holds the Google Sheet / Excel file id + URL per client;
referenced throughout `reportRoutes.js`, `googleSheetsAdapter.js`,
`adminRoutes.js`). Treat `schema.sql` as a strong **reference**, not a
guarantee of what's actually live — if you add a column/table, update this
file *and* apply the change to the real database yourself (see §5.3), and if
you find another table missing from it, add it there too.

`supabase/migrations/` (repo root, sibling to `cin7-sync-portal/`) exists but
is currently empty — there is no migration history captured in git today.

### 5.3 How to change the database structure (today's reality, no tooling)

1. Edit `src/db/schema.sql` to describe the new table/column.
2. Apply that SQL yourself against the real database (Supabase SQL editor, or
   `psql` against `SUPABASE_DB_URL` / `DATABASE_URL`). There is no
   `db:generate` / `db:migrate` command — this is a manual step.
3. Update any service that reads the shape (routes rarely touch SQL directly —
   look in `src/services/`).
4. If the table is tenant-scoped, make sure every query that touches it filters
   by `client_id` (see §9) — there is no RLS safety net catching a missed
   filter today.

### 5.4 Encryption at rest

Cin7 credentials and OAuth tokens are encrypted before being written to the
database with AES-256-GCM (`src/services/cryptoService.js`), keyed by the
`ENCRYPTION_KEY` env var. Never log a decrypted credential; never return one in
an API response.

---

## 6. The services layer (`src/services/`) — where the real logic lives

| File                        | Job                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cin7Engine.js`             | Talks to the Cin7 Core REST API: paced/rate-limited requests, retry with backoff, `fetchSales` / `fetchInventory` / `fetchPurchaseOrders`, rolling-window date filtering (`filterSalesByWindow` / `filterPurchaseByWindow` — filters by true Order Date), incremental (`updatedSince`) fetching, row validation. |
| `googleSheetsAdapter.js`    | Clones the master template (`drive.files.copy`) into a brand-new spreadsheet **every sync**, writes the three raw-data sheets, and regenerates the dynamic report formulas (top products, live per-tenant sales-channel taxonomy, KPI Dashboard, Sales Trend Analysis) — see §6.3. |
| `microsoftExcelAdapter.js`  | The Excel destination. **Materially less complete than the Sheets path** — see §6.4.                                                                     |
| `destinationAdapter.js`     | The shared base class both adapters extend.                                                                                                               |
| `snapshotService.js`        | Persists the "current" active report + immutable historical snapshots per sync (`current_reports` / `report_snapshots`), powers the in-app Reports tab (`REPORT_CONFIG` — the authoritative column-index map, independent of what the raw sheet's own header row says — see §6.5), CSV export. |
| `subscriptionService.js`    | Plan/subscription/usage limits, feature gating.                                                                                                           |
| `billingProviderService.js` | Billing provider webhook handling.                                                                                                                        |
| `auditService.js`           | `logAction({ organizationId, userId, action, resource, details })` — the one place cross-tenant/admin actions get written to `audit_logs`. Strips secret-shaped keys from `details` automatically. Reuse this for anything a Super Admin does across tenants — don't write a one-off audit insert. |
| `clientStorageService.js`  | Resolves/validates per-client storage paths (`storage/<clientId>/...`) — always validate a `clientId` through here before touching the filesystem.        |
| `cryptoService.js`          | AES-256-GCM encrypt/decrypt helpers.                                                                                                                       |
| `googleTokenStore.js`       | Persists/refreshes each client's Google OAuth tokens (DB-backed, falls back to the session-carried token for a brand-new user — see §9).                  |
| `microsoftGraphService.js`  | Microsoft Graph API calls backing the Excel/OneDrive path.                                                                                                 |
| `lockService.js`            | Per-client concurrency lock so two syncs for the same org can't run at once.                                                                               |
| `ssrfProtectionService.js`  | Validates outbound URLs before the app fetches them (defence against server-side request forgery).                                                        |
| `editorService.js`          | Backs `editorRoutes.js` (workbook download/edit surface).                                                                                                 |

### 6.1 Routes → services, one file per feature area

| Route file                | Base path            | Covers                                                                                     |
| --------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `authRoutes.js`            | `/api/auth`          | Sign in/up, Google OAuth, `GET /me`, logout, **admin impersonation exit** (§8.3)              |
| `adminRoutes.js`           | `/api/admin`         | Super-Admin-only: dashboard, organizations, users, subscriptions, billing, Cin7/Sheets status, sync monitor, usage, audit log, system health, **impersonation start** (§8.3) |
| `billingRoutes.js`         | `/api/billing`       | Checkout, portal, plan change, cancel                                                       |
| `organizationRoutes.js`    | `/api/organization`  | The logged-in org's own profile                                                              |
| `teamRoutes.js`            | `/api/team`          | Invite/edit/remove teammates within one org                                                  |
| `integrationRoutes.js`     | `/api/integrations`  | Cin7 / Google Sheets connection status + the live workbook preview endpoint (§8.2)           |
| `cin7Routes.js`            | `/api/cin7`          | Cin7 credential test/save                                                                    |
| `syncRoutes.js`            | `/api/sync`          | Triggers a sync run (background), polls status, cancels                                     |
| `editorRoutes.js`          | `/api/editor`, `/api/destination` | Workbook download/edit                                                          |
| `reportRoutes.js`          | `/api/reports`       | Current report, previous snapshots, reconciliation, CSV export                              |
| `settingRoutes.js`         | `/api/settings`, `/api` | Org settings, notifications, security actions, audit logs (client-facing subset)          |

Every route file mounted under `/api/*` sits behind `globalLimiter`
(`rateLimitMiddleware.js`); most also apply `requireAuth` +
`enforceTenantIsolation` (and often a role gate) — see §9.

### 6.2 Recipe — add a new feature area

1. `src/services/<name>.js` — the logic, taking `clientId` explicitly as a
   parameter (never reading it from a global).
2. `src/routes/<name>Routes.js` — thin handlers: `requireAuth`,
   `enforceTenantIsolation` (if tenant-scoped), the right role gate, call the
   service, shape `{ success: true, ... }` / `{ success: false, error, message }`.
3. Mount it in `src/server.js` (`app.use('/api/<name>', <name>Routes)`).
4. Add the matching screen/section to `public/index.html` + wire it up in
   `public/app.js` (§7).
5. If it touches a new table, update `src/db/schema.sql` **and** apply the SQL
   by hand (§5.3).

### 6.3 The Google Sheets destination — what "dynamic" means today

Every sync **clones a brand-new spreadsheet** from the master template (no
long-lived per-client sheet that accumulates structure) and then rewrites:

- the 3 raw-data sheets (Sales / Inventory / Purchase, written positionally —
  see the caveat in §6.5),
- `Product Margin Analysis` / `Sales Dashboard` — top 6 products by revenue,
  computed fresh from that sync's data,
- `COGS & Profitability by Channel`, `Sales Trend Analysis`, and the
  `KPI Dashboard` channel cards — the client's **actual live sales channels**
  (raw Cin7 channel values, ranked by revenue), not a hardcoded list. If a
  client has more channels than the template's built-in slots (12 columns / 13
  rows / 10 KPI rows respectively), the adapter inserts extra columns/rows via
  the Sheets API (`insertDimension`) before writing formulas.
- `Weekly Order Tracker` / monthly activity summary — regenerated from the
  sync's own reference date, never a hardcoded year.

The Excel destination (§6.4) does **not** get any of this — it only writes raw
rows.

### 6.4 The Excel destination — known limitation

`microsoftExcelAdapter.js` writes the three raw-data sheets via direct OpenXML
injection (`updateSheetXmlPreserveAllRows`), preserving the template's existing
rows. **`syncPurchaseOrders` does not use the real synced purchase-order data
at all** — it always rebuilds a synthetic row (`'PO-101'`, `'Global Supplier'`,
`'VNC Brand'`, …) from a handful of fields, discarding everything else. Sales
and Inventory do pass real rows through correctly (they have a
`row.length >= N` guard that returns real data unmodified). Treat the Excel
destination as noticeably behind the Google Sheets one; check with whoever
asks for Excel-path work whether this is still expected before building on it
further.

### 6.5 A known display quirk in the raw Sales sheet's header row

The **printed header row** (`SALES_HEADERS` in `cin7Engine.js`, duplicated in
the adapters) is one column out of step with the data actually written beneath
it in the exported spreadsheet (e.g. the column labeled "Quantity" sits above a
duplicated sales-channel value, not a number). This is **display-label-only** —
every piece of code that actually *uses* column positions (`validateSalesData`,
`REPORT_CONFIG` in `snapshotService.js`, `updateClonedReportFormulas`) agrees on
the real positions and is internally consistent; only the header text written
into the live sheet is mislabeled. Fixing the labels is a deliberately
un-touched, separate piece of work (it needs a product decision about a couple
of ambiguous columns) — don't assume the header row is correct if you're
reading it to find a column.

---

## 7. The frontend (`public/`)

No framework, no bundler, no npm build step. Three files:

| File          | Contains                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `index.html`  | Every screen as a `<section>` inside one `#app` div, toggled by `.hidden` — auth, onboarding, dashboard, reports, settings, the Admin Portal, support/legal pages, and every modal. |
| `app.js`      | All client-side logic: a single `state` object, `navigateTo(viewId)` (shows/hides the right `<section>`, toggles nav buttons), one `load*`/`handle*` function per screen, plain `fetch()` calls to `/api/...`. |
| `styles.css`  | One stylesheet. Brand tokens as CSS variables at the top: `--vnc-main` (#004682), `--vnc-blue` (#2f8fed), `--vnc-dark` (#312f77), `--vnc-yellow` (#f19031), `--vnc-purple` (#7a4eab) — **use these, don't hardcode hex.** |

### 7.1 Client vs Admin chrome — two separate top bars

The client-facing screens (Dashboard/Reports/Settings) share one global navbar
(`#navbar`, blue gradient). The Admin Portal has its **own**, separate topbar
(`.admin-topbar`, dark navy→purple gradient) with its own identity/sign-out —
`navigateTo()` explicitly hides `#navbar` whenever `viewId === 'admin'` and
restores it otherwise. Don't reuse the client navbar's markup/ids for anything
admin-only, and vice versa — they're deliberately kept as two separate systems
so a Super Admin's screen never reads as "half client app, half admin app."

### 7.2 Adding a new screen

1. Add a `<section id="<name>-view" class="view-container hidden">` in
   `index.html`.
2. Add a case for it in `app.js`'s `navigateTo()` (the `views` array + any
   `if (viewId === '<name>') load<Name>Data();`).
3. Write `load<Name>Data()` — `fetch('/api/...')`, render into the DOM. Always
   `escapeHtml(...)` any server-supplied string before it goes into
   `innerHTML` — this codebase treats that as non-negotiable (SEC-09 XSS
   hardening; see the comment at the top of `app.js`).
4. Bump the `?v=` query string on `app.js`/`styles.css`'s `<script>`/`<link>`
   tags in `index.html` when you change either file, so browsers don't serve a
   stale cached copy.

---

## 8. The Admin Portal

A Super Admin (`platformRole === 'SUPER_ADMIN'`) lands here automatically on
login (`checkAuthStatus()` in `app.js`). Tabs: Dashboard, Organizations, Users,
Subscriptions, Billing, Cin7 Connections, Google Sheets, Sync Monitoring,
Platform Usage, Audit Logs, System Health.

### 8.1 "Inspect 360°" — read-only

Clicking an organization opens a curated, read-only summary modal
(`viewAdminOrg360` → `GET /api/admin/organizations/:id`) — users, subscription,
integration status (masked, no secrets), recent syncs. This is **not** the same
data path as the real client dashboard.

### 8.2 The live workbook preview

`GET /api/integrations/google-sheets/preview` reads every tab of the client's
actual synced Google Sheet, live, via the Sheets API — not a cache. The in-app
preview modal currently shows only the `KPI Dashboard` tab (deliberately
narrowed from all 14-17 sheets).

### 8.3 "View as" — full impersonation

From either the Organizations or Users admin tab, "View as" starts a real
impersonation session:

- `POST /api/admin/organizations/:id/impersonate` — impersonates that org's own
  ADMIN-role user (full org-admin access: trigger syncs, edit Cin7/Sheets
  credentials, change settings).
- `POST /api/admin/users/:id/impersonate` — impersonates that *exact* person;
  their real role applies (a Viewer stays read-only, even to a Super Admin).
- `POST /api/auth/impersonate/exit` — restores the real admin's session.

Mechanically: `req.session.user` is swapped to the target's own real identity
(their real `client_id`/`role`, `platform_role` forced to `USER` so no
Super-Admin privilege ever leaks into the impersonated context), while
`req.session.impersonatorAdmin` stashes the real admin's identity for the exit
call to restore. This reuses every existing client route/guard unmodified —
nothing in `tenantMiddleware.js` or `authMiddleware.js` needed to change. Start
and end are both audit-logged via `auditService.logAction()`. A persistent
yellow banner (`#impersonation-banner`, injected by `renderImpersonationBanner()`
in `app.js`) shows on every page while active, with an exit button. Blocked
from impersonating another Super Admin, and from starting a second
impersonation without exiting the first.

---

## 9. Auth & tenant isolation, end to end

1. **Sign-in**: email/password or Google OAuth (`authRoutes.js`). On success,
   `req.session.user` is set to a consistent shape: `{ id, client_id, email,
full_name, role, platform_role, ... }` (see `sessionUserFromGoogleProfile`
   for the canonical shape to copy if you ever need to build this object by
   hand, e.g. for impersonation).
2. **Every request**: `requireAuth` (`authMiddleware.js`) copies
   `req.session.user` onto `req.user` (401 if absent).
3. **Role gates**: `requireRole([...])` / `requireAdmin` / `requireCanSync` /
   `requireCanManageSettings` / `requireSuperAdmin` check `req.user.role` and/or
   `req.user.platform_role` — a `platform_role`/`role` of `SUPER_ADMIN` always
   passes every gate.
4. **Tenant scoping**: `enforceTenantIsolation` (`tenantMiddleware.js`)
   derives `req.tenantId` **strictly** from `req.user.client_id` — it explicitly
   rejects any client-supplied override (header, query, body). Every
   tenant-scoped route must use `req.tenantId` for its `WHERE client_id = ?`,
   never trust a `clientId` from the request.
5. **Roles, in increasing privilege**: `VIEWER` (read-only) → `MANAGER` (can
   sync) → `ADMIN` (can manage settings/credentials/team) — all scoped to one
   org — and separately, `platform_role = SUPER_ADMIN`, which is
   platform-wide and bypasses every org-role check.
6. **Session store**: `connect-pg-simple` against the same Postgres connection
   when available; falls back to Express's in-memory session store (with a
   loud startup warning) otherwise — fine for local dev, **not** for anything
   that needs to survive a restart or run more than one instance.

There is currently **no database-level RLS enforcing any of this** (§5.1) —
the guards above are the entire enforcement layer. Be exact about them; there
is no safety net catching a missing tenant filter.

---

## 10. Security posture (as implemented, not aspirational)

- **Headers**: CSP, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options:
nosniff`, HSTS when behind TLS — all set unconditionally in `server.js`.
- **CORS**: explicit allowlist (`ALLOWED_ORIGINS` + a hardcoded localhost dev
  list + private-IP regexes for LAN testing) — never a wildcard, since cookies
  are involved (`credentials: true`).
- **Sessions**: httpOnly, `SameSite=Lax`, `secure` in production, named
  `__vnc_portal_sid` — the browser JS never holds a token.
- **Secrets at rest**: AES-256-GCM via `cryptoService.js` for Cin7 credentials
  and OAuth tokens (§5.4).
- **Rate limiting**: `globalLimiter` on all of `/api/*`
  (`rateLimitMiddleware.js`).
- **XSS**: `escapeHtml()` before any server string reaches `innerHTML` (§7.2).
- **Fail-fast in production**: `server.js` refuses to boot in
  `NODE_ENV=production` if `SESSION_SECRET` is missing, is the dev sentinel
  value, or is under 32 characters.
- **`cin7-sheets/token.json` is a known, live exposure** — a real Google OAuth
  token committed in plaintext to git history despite being listed in
  `.gitignore` (it was tracked before that rule existed). If you're touching
  anything Google-OAuth-related, don't assume that credential is still valid
  or safe to reference — check with the project owner before relying on it.

---

## 11. Environment variables (`.env`)

See `.env.example` for the full, current list with comments. Summary:

| Var                                              | Required when                              |
| -------------------------------------------------- | --------------------------------------------- |
| `PORT`                                            | optional, defaults to `2121`                 |
| `NODE_ENV`                                        | set to `production` for the fail-fast checks |
| `APP_URL`, `ALLOWED_ORIGINS`                      | production CORS                              |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | to use the real (production-shaped) database — omit all three to run against the in-memory fallback |
| `ENCRYPTION_KEY`                                  | **always** — 32-byte hex, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SESSION_SECRET`                                  | **always** in production; auto-generated (ephemeral) if omitted in dev  |
| `MICROSOFT_CLIENT_ID/SECRET`, `MICROSOFT_REDIRECT_URI` | the Excel/OneDrive destination path       |
| `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_REDIRECT_URI`  | Google sign-in and the Sheets destination    |
| `CIN7_BASE_URL`                                   | defaults to `https://inventory.cin7.com/api/v1` |

---

## 12. Deployment

**There is no CI and no infrastructure-as-code file in this repo today** — no
`.github/workflows/`, no `render.yaml`, no `Procfile`. Whatever hosting is in
use today is configured directly on the hosting platform's dashboard (start
command `npm start`, working directory `cin7-sync-portal/`), not tracked here.
If you set one up, this section should be the first thing updated to describe
it — don't let a second document (or nothing at all) become the real source of
truth for how a deploy happens.

Branching today is simple: everything lives on `main`, pushed directly (see
recent commit history) — there is no `testing`/`production` split and no PR-gate
automation. If that changes, document the real workflow here rather than
assuming a process this repo doesn't actually enforce.

---

## 13. Background work

There is no scheduler and no queue. A sync is **always** started by a user
action (`POST /api/sync/...`), runs in the background within the same Node
process, and is tracked via `sync_runs` (status polled by the frontend). If
recurring/scheduled syncs are ever needed, there's nothing today to build on
top of — it would be new infrastructure, not an existing hook.

---

## 14. Known gaps worth knowing about before you build on them

These are real, verified during recent work on this codebase — not
speculation:

- **Schema drift** (§5.2): `schema.sql` is missing at least `destination_files`,
  which exists in the real database. Don't assume the file is complete.
- **No RLS** (§5.1, §9): tenant isolation is 100% application-layer. A route
  that forgets to call `enforceTenantIsolation`, or a service that forgets to
  filter by `client_id`, has nothing else stopping it.
- **Excel purchase-order sync ignores real data** (§6.4).
- **Sales sheet header row is mislabeled** relative to the data under it
  (§6.5) — the underlying data and every real consumer of it are correct; only
  the printed labels in the exported sheet are off.
- **`cin7-sheets/token.json`** has a real OAuth token exposed in git history
  (§10).
- A stray/unlinked `public/admin.js` file (referencing element IDs that don't
  exist in the current markup, never `<script src>`-included) was found and
  removed during the Admin Portal redesign — if you see a similarly
  disconnected file again, it's likely leftover scratch work, not live code;
  verify it's actually referenced from `index.html` before trusting it.
- `styles.css` has a pre-existing dangling CSS block (declarations with no
  selector, around the `.select-dropdown` rules) — browsers tolerate it
  silently, but it means that rule isn't styling what it looks like it should.
