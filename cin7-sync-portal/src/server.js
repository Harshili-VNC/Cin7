const express = require('express');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
require('dotenv').config();

const db = require('./db');
const authRoutes = require('./routes/authRoutes');
const cin7Routes = require('./routes/cin7Routes');
const syncRoutes = require('./routes/syncRoutes');
const editorRoutes = require('./routes/editorRoutes');

const app = express();
const PORT = process.env.PORT || 8080;

// Security & Request Parsing Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// HTTP-Only Secure Session Setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'vnc_cin7_portal_session_secret_2026_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 Hours
  }
}));

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
app.use('/api/cin7', cin7Routes);
app.use('/api/sync', syncRoutes);
app.use('/api/editor', editorRoutes);

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
  app.listen(PORT, () => {
    console.log(`🚀 VNC Cin7 SaaS Reporting Portal Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;