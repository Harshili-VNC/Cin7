const crypto = require('crypto');
try { require('dotenv').config(); } catch (e) {}

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_DEV_KEY = 'vnc_secret_encryption_key_32bytes_len_!';
const RAW_KEY = process.env.ENCRYPTION_KEY || DEFAULT_DEV_KEY;
const KDF_SALT = process.env.ENCRYPTION_SALT || 'vnc_cin7_saas_kdf_salt_v1';

// Fail-fast security check in production
if (process.env.NODE_ENV === 'production') {
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === DEFAULT_DEV_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    console.error('❌ [FATAL SECURITY ERROR] Insecure or missing ENCRYPTION_KEY in production.');
    throw new Error('FATAL: ENCRYPTION_KEY must be configured with at least 32 characters in production.');
  }
}

// Derive primary 256-bit key using cryptographically secure PBKDF2 with salt (P1-012 fix)
const PRIMARY_KEY = crypto.pbkdf2Sync(String(RAW_KEY), KDF_SALT, 100000, 32, 'sha256');
// Legacy key fallback for backward compatibility
const LEGACY_KEY = crypto.createHash('sha256').update(String(RAW_KEY)).digest();

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, PRIMARY_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptWithKey(encryptedPayload, key) {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) return null;
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function decrypt(encryptedPayload) {
  if (!encryptedPayload) return null;
  try {
    // 1. Try decrypting with primary PBKDF2 salted key
    return decryptWithKey(encryptedPayload, PRIMARY_KEY);
  } catch (err) {
    try {
      // 2. Fallback to legacy key for backward compatibility
      return decryptWithKey(encryptedPayload, LEGACY_KEY);
    } catch (fallbackErr) {
      console.error('❌ Error decrypting payload (Invalid key or corrupted data)');
      return null;
    }
  }
}

/**
 * Hashes password using cryptographically secure PBKDF2-HMAC-SHA512
 */
function hashPassword(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verifies password against stored salt + hash in constant-time
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 2) return false;
    const salt = parts[0];
    const originalHash = parts[1];
    const hashToTest = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(hashToTest, 'hex'));
  } catch (err) {
    return false;
  }
}

module.exports = {
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword
};
