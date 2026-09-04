const db = require('../db');
const { v4: uuidv4 } = require('uuid');

/**
 * Enterprise Audit Logger
 * Records significant organization-level actions for compliance and tracking.
 * Strictly NEVER logs credentials, passwords, or API keys.
 */
async function logAction({ organizationId, userId, action, resource, result = 'SUCCESS', details = {} }) {
  if (!organizationId || !action || !resource) {
    return;
  }

  // Sanitize details: strip any potential secret fields
  const safeDetails = { ...details };
  const sensitiveKeys = ['password', 'apiKey', 'api_key', 'token', 'access_token', 'refresh_token', 'clientSecret', 'client_secret'];
  sensitiveKeys.forEach(k => delete safeDetails[k]);

  const auditId = `audit-${uuidv4().substring(0, 8)}`;
  try {
    await db.query(
      `INSERT INTO audit_logs (id, organization_id, user_id, action, resource, result, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        auditId,
        organizationId,
        userId || 'system',
        action,
        resource,
        result,
        JSON.stringify(safeDetails)
      ]
    );
  } catch (err) {
    console.error('[AUDIT LOG ERROR]', err.message);
  }
}

module.exports = {
  logAction
};
