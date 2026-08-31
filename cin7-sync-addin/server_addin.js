const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const publicPath = path.join(__dirname, 'src/taskpane');

app.use(express.static(publicPath));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.get('/taskpane.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'taskpane.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'taskpane.html'));
});

const PORT = 3000;

// Self-signed HTTPS fallback or HTTP server
try {
  const pem = require('office-addin-dev-certs');
  pem.getHttpsServerOptions().then(options => {
    https.createServer(options, app).listen(PORT, () => {
      console.log(`✅ HTTPS Add-in Taskpane Server running at https://localhost:${PORT}/taskpane.html`);
    });
  }).catch(() => {
    http.createServer(app).listen(PORT, () => {
      console.log(`✅ HTTP Add-in Taskpane Server running at http://localhost:${PORT}/taskpane.html`);
    });
  });
} catch (err) {
  http.createServer(app).listen(PORT, () => {
    console.log(`✅ HTTP Add-in Taskpane Server running at http://localhost:${PORT}/taskpane.html`);
  });
}
