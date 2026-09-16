const db = require('../db');
const cryptoService = require('./cryptoService');

/**
 * Persists Google OAuth tokens (encrypted) per client/tenant in the database,
 * replacing the local token.json file which lived on Render's ephemeral disk
 * and was wiped on every redeploy, forcing repeated "Authorize Google"
 * re-prompts even when the underlying refresh token was still valid.
 */

async function getClientGoogleTokens(clientId) {
  if (!clientId) return null;
  try {
    const row = await db.getOne(
      'SELECT encrypted_tokens FROM client_google_tokens WHERE client_id = ?',
      [clientId]
    );
    if (!row) return null;
    const decrypted = cryptoService.decrypt(row.encrypted_tokens);
    return decrypted ? JSON.parse(decrypted) : null;
  } catch (e) {
    console.warn('[GOOGLE TOKEN STORE] Read error:', e.message);
    return null;
  }
}

async function saveClientGoogleTokens(clientId, tokens) {
  if (!clientId || !tokens) return;
  try {
    const encrypted = cryptoService.encrypt(JSON.stringify(tokens));
    await db.query(
      `INSERT INTO client_google_tokens (client_id, encrypted_tokens, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET
         encrypted_tokens = EXCLUDED.encrypted_tokens,
         updated_at = EXCLUDED.updated_at`,
      [clientId, encrypted, new Date().toISOString()]
    );
    console.log(`[GOOGLE TOKEN STORE] Saved Google tokens for client '${clientId}'`);
  } catch (e) {
    console.warn('[GOOGLE TOKEN STORE] Save error:', e.message);
  }
}

/**
 * Merges a partial token refresh (e.g. a new access_token without a
 * refresh_token, which Google omits on refresh) on top of whatever is
 * already stored, so the refresh_token is never accidentally dropped.
 */
async function mergeAndSaveClientGoogleTokens(clientId, refreshedTokens) {
  if (!clientId || !refreshedTokens) return;
  const current = (await getClientGoogleTokens(clientId)) || {};
  await saveClientGoogleTokens(clientId, { ...current, ...refreshedTokens });
}

module.exports = { getClientGoogleTokens, saveClientGoogleTokens, mergeAndSaveClientGoogleTokens };
