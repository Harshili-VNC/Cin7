const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
require('dotenv').config();

// Persistent session store — uses the same Supabase / Postgres connection
let pgSession;
try { pgSession = require('connect-pg-simple')(session); } catch (e) {
  console.warn('[server] connect-pg-simple not installed — falling back to MemoryStore (not suitable for production). Run: npm install connect-pg-simple');
}

const db = require('./db');
const { globalLimiter } = require('./middleware/rateLimitMiddleware');
const authRoutes = require('./routes/authRoutes');
const cin7Routes = require('./routes/cin7Routes');
const syncRoutes = require('./routes/syncRoutes');
const editorRoutes = require('./routes/editorRoutes');
const reportRoutes = require('./routes/reportRoutes');
const organizationRoutes = require('./routes/organizationRoutes');
const teamRoutes = require('./routes/teamRoutes');
const integrationRoutes = require('./routes/integrationRoutes');
const settingRoutes = require('./routes/settingRoutes');
const billingRoutes = require('./routes/billingRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 2121;

// ── PRODUCTION FAIL-FAST SECURITY VALIDATION ──────────────────────────────────
const DEFAULT_DEV_SESSION_SECRET = 'vnc_cin7_portal_session_secret_2026_key';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_DEV_SESSION_SECRET;

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === DEFAULT_DEV_SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    console.error('❌ [FATAL SECURITY ERROR] Insecure or missing SESSION_SECRET in production.');
    throw new Error('FATAL: SESSION_SECRET must be configured with at least 32 characters in production.');
  }
}

// ── SECURITY HEADERS MIDDLEWARE ───────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://inventory.dearsystems.com https://inventory.cin7.com https://accounts.google.com; frame-src 'self' https://accounts.google.com http://localhost:* http://127.0.0.1:*;"
  );

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── RESTRICTIVE CORS ALLOWLIST ────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim().toLowerCase())
  .filter(Boolean);

const defaultAllowedOrigins = [
  'http://localhost:2029',
  'http://127.0.0.1:2029',
  'http://localhost:2121',
  'http://127.0.0.1:2121',
  'http://localhost:2005',
  'http://127.0.0.1:2005',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

if (process.env.APP_URL) {
  try {
    const appUrlOrigin = new URL(process.env.APP_URL).origin.toLowerCase();
    if (!defaultAllowedOrigins.includes(appUrlOrigin)) {
      defaultAllowedOrigins.push(appUrlOrigin);
    }
  } catch (_) {}
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server) where origin is undefined
    if (!origin) return callback(null, true);

    const cleanOrigin = origin.toLowerCase();
    const isAllowed = allowedOrigins.includes(cleanOrigin) ||
      defaultAllowedOrigins.includes(cleanOrigin) ||
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/.test(cleanOrigin) ||
      /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/.test(cleanOrigin);

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('CORS_NOT_ALLOWED: Request origin not authorized.'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'stripe-signature', 'x-billing-signature', 'x-skip-rate-limit']
}));

// Request Body Parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ── HARDENED SESSION CONFIGURATION ───────────────────────────────────────────
const sessionDbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
const sessionStore = (pgSession && sessionDbUrl)
  ? new pgSession({
      conString: sessionDbUrl,
      tableName: 'user_sessions',
      createTableIfMissing: true,
      ssl: process.env.SUPABASE_DB_URL ? { rejectUnauthorized: false } : false
    })
  : undefined; // Falls back to MemoryStore when pg not configured

if (!sessionStore) {
  console.warn('[server] WARNING: Using in-memory session store — sessions will be lost on restart. Set SUPABASE_DB_URL or DATABASE_URL and install connect-pg-simple for production.');
}

app.use(session({
  store: sessionStore,
  name: '__vnc_portal_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 Hours
  }
}));

// Mount Global Rate Limiter on API surface
app.use('/api', globalLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'VNC Cin7 Sync SaaS Reporting Portal',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/cin7', cin7Routes);
app.use('/api/sync', syncRoutes);
app.use('/api/editor', editorRoutes);
app.use('/api/destination', editorRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api', settingRoutes);

// 404 handler for undefined API routes (prevents fallback to SPA index.html for API requests)
app.all('/api/*', (req, res) => {
  res.status(404).json({
    error: 'API_ENDPOINT_NOT_FOUND',
    message: 'The requested API endpoint does not exist or has been removed.'
  });
});

// Serve Static Frontend Single Page Application
app.use(express.static(path.join(__dirname, '../public')));

// SPA Catch-all Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global Error Handler (Sanitizes technical details)
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(500).json({ error: 'An unexpected internal error occurred. Please try again later.' });
});

// Start Server
if (require.main === module) {
  const os = require('os');
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 VNC Cin7 SaaS Reporting Portal Server running:`);
    console.log(`  > Local:   http://localhost:${PORT}`);
    
    // Find network IP
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  > Network: http://${net.address}:${PORT}`);
        }
      }
    }
    console.log('');
    // Auto-heal orphaned sync runs from prior unexpected server shutdowns
    try {
      db.query("UPDATE sync_runs SET status = 'INTERRUPTED', completed_at = CURRENT_TIMESTAMP WHERE status = 'RUNNING'").catch(() => {});
    } catch (_) {}
  });

  // Graceful shutdown — allows in-flight requests to complete and closes the DB pool cleanly
  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('[server] HTTP server closed.');
      process.exit(0);
    });
    // Force exit after 10 seconds if something hangs
    setTimeout(() => {
      console.error('[server] Forced exit after shutdown timeout.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = app;