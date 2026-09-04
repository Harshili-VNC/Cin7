/**
 * Google OAuth Desktop Authorization Script
 * Prompts user to authorize Google Sheets & Drive APIs via browser,
 * receives the authorization code, and saves token.json in cin7-sheets/
 */
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

// Paths
const CREDENTIALS_PATH = path.resolve(__dirname, '../../cin7-sheets/oauth-credentials.json');
const TOKEN_PATH = path.resolve(__dirname, '../../cin7-sheets/token.json');

async function authorize() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`❌ Credentials file not found at: ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const config = credentials.installed || credentials.web || credentials;
  const { client_id, client_secret } = config;

  return new Promise((resolve, reject) => {
    let resolved = false;

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = req.url || '';
        if (reqUrl.includes('favicon.ico')) {
          res.writeHead(204);
          return res.end();
        }

        if (reqUrl.includes('code=') && !resolved) {
          resolved = true;
          const parsedUrl = new URL(req.url, `http://localhost:${server.address().port}`);
          const code = parsedUrl.searchParams.get('code');

          console.log('\n[OAuth] Code received. Exchanging authorization code for tokens...');
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);

          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log(`[OAuth] ✅ Saved token.json to: ${TOKEN_PATH}\n`);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family:sans-serif; text-align:center; padding-top:50px;">
                <h2 style="color:green;">✅ Authentication Successful!</h2>
                <p>Google OAuth tokens have been generated and saved to <code>cin7-sheets/token.json</code>.</p>
                <p>You can close this browser tab and return to the terminal.</p>
              </body>
            </html>
          `);

          server.close();
          resolve(tokens);
        } else if (!resolved) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Waiting for Google authorization...');
        }
      } catch (err) {
        console.error('[OAuth] Token exchange error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Authentication Error: ' + err.message);
        }
        server.close();
        reject(err);
      }
    });

    server.listen(0, () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}`;

      oauth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirectUri
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES
      });

      console.log('\n======================================================');
      console.log('       GOOGLE OAUTH AUTHORIZATION SETUP');
      console.log('======================================================\n');
      console.log('1. Open this URL in your web browser:\n');
      console.log(`🔗 ${authUrl}\n`);
      console.log('2. Log in and grant permissions for Google Sheets & Google Drive.');
      console.log('3. Waiting for authorization callback on localhost...\n');

      // Attempt to auto-open browser on Windows
      const startCmd = process.platform === 'win32' ? `start "" "${authUrl}"` : (process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`);
      exec(startCmd, (err) => {
        if (err) {
          // If auto-open fails, user can click the printed URL
        }
      });
    });
  });
}

if (require.main === module) {
  authorize().then(() => {
    console.log('🎉 OAuth Authorization Completed Successfully.');
    process.exit(0);
  }).catch((err) => {
    console.error('❌ Authorization Failed:', err.message);
    process.exit(1);
  });
}

module.exports = authorize;
