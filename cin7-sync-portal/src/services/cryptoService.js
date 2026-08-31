const crypto = require('crypto');
try { require('dotenv').config(); } catch (e) {}

const ALGORITHM = 'aes-256-gcm';
const RAW_KEY = process.env.ENCRYPTION_KEY || 'vnc_secret_encryption_key_32bytes_len_!';

// Ensure key is exactly 32 bytes (256 bits)
const KEY = crypto.createHash('sha256').update(String(RAW_KEY)).digest();

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedPayload) {
  if (!encryptedPayload) return null;
  try {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('❌ Error decrypting payload (Invalid key or corrupted data)');
    return null;
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
