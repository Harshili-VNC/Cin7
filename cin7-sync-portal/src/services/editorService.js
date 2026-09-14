const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const clientStorageService = require('./clientStorageService');

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('[editorService] FATAL: SESSION_SECRET environment variable must be set in production.');
}
const SECRET_KEY = process.env.SESSION_SECRET || (() => {
  console.warn('[editorService] WARNING: SESSION_SECRET not set — using insecure default. Set SESSION_SECRET before deploying.');
  return 'vnc_cin7_portal_session_secret_2026_key';
})();
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 Minutes

class EditorService {
  /**
   * Generates a cryptographically signed temporary access token
   */
  generateSessionToken(clientId, userId, versionId = null, isReadOnly = false) {
    const payload = {
      clientId,
      userId,
      versionId: versionId || 'current',
      isReadOnly: !!isReadOnly,
      exp: Date.now() + TOKEN_TTL_MS,
      nonce: crypto.randomBytes(8).toString('hex')
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(payloadB64).digest('base64url');
    return `${payloadB64}.${signature}`;
  }

  /**
   * Validates token signature and expiration
   */
  verifySessionToken(token) {
    if (!token || typeof token !== 'string') {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [payloadB64, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(payloadB64).digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }

    try {
      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);

      if (Date.now() > payload.exp) {
        return null; // Expired token
      }

      return payload;
    } catch (e) {
      return null;
    }
  }

  /**
   * Constructs ONLYOFFICE Docs configuration JSON
   */
  buildOnlyOfficeConfig(clientId, user, client, baseUrl, versionId = null, isReadOnly = false) {
    const token = this.generateSessionToken(clientId, user.id, versionId, isReadOnly);
    const isHistorical = versionId && versionId !== 'current' && versionId !== client.current_version;
    const effectiveReadOnly = isReadOnly || isHistorical;

    const workbookPath = isHistorical
      ? clientStorageService.getClientHistoryWorkbookPath(clientId, versionId)
      : clientStorageService.getClientCurrentWorkbookPath(clientId);

    let docStat = { mtimeMs: Date.now() };
    if (fs.existsSync(workbookPath)) {
      docStat = fs.statSync(workbookPath);
    }

    // Unique document key per file modification / version to ensure ONLYOFFICE cache consistency
    const docKeyRaw = `${clientId}_${versionId || client.current_version || 'v1.0'}_${Math.floor(docStat.mtimeMs)}`;
    const documentKey = crypto.createHash('md5').update(docKeyRaw).digest('hex').substring(0, 20);

    const docTitle = isHistorical
      ? `Controller_Reporting_Model_v5_Cin7_Actuals_${versionId}.xlsx`
      : 'Controller_Reporting_Model_v5_Cin7_Actuals.xlsx';

    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const fileStreamUrl = `${normalizedBaseUrl}/api/editor/files/${token}`;
    const callbackUrl = `${normalizedBaseUrl}/api/editor/callback/${token}`;
    const saveDirectUrl = `${normalizedBaseUrl}/api/editor/save/${token}`;

    const config = {
      documentType: 'cell',
      document: {
        fileType: 'xlsx',
        key: documentKey,
        title: docTitle,
        url: fileStreamUrl,
        permissions: {
          edit: !effectiveReadOnly,
          download: false, // Strictly remove client download options
          print: false,
          copy: true,
          review: false,
          comment: false,
          fillForms: !effectiveReadOnly
        }
      },
      editorConfig: {
        mode: effectiveReadOnly ? 'view' : 'edit',
        lang: 'en',
        callbackUrl: callbackUrl,
        user: {
          id: String(user.id),
          name: user.full_name || user.email || 'VNC User'
        },
        customization: {
          autosave: true,
          forcesave: true,
          compactHeader: true,
          toolbarNoTabs: false,
          help: false,
          about: false,
          feedback: false,
          goback: {
            url: `${normalizedBaseUrl}/#dashboard`
          },
          features: {
            spellcheck: false
          }
        }
      },
      token: token,
      isReadOnly: effectiveReadOnly,
      versionId: versionId || client.current_version || 'v1.0',
      fileName: docTitle,
      companyName: client.company_name,
      fileStreamUrl: fileStreamUrl,
      saveDirectUrl: saveDirectUrl,
      onlyofficeUrl: process.env.ONLYOFFICE_URL || 'http://localhost:8000'
    };

    return config;
  }
}

module.exports = new EditorService();