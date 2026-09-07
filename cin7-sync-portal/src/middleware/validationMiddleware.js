/**
 * Central Input Validation Middleware & Sanitization Utilities
 * Enforces strict input bounds, type constraints, format rules, and payload sanitization
 * across authentication, tenant operations, reports, and integrations.
 */

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const UUID_OR_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const REPORT_TYPE_REGEX = /^(sales|inventory|purchase|purchase_orders|financial|all)$/i;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim();
  if (clean.length < 3 || clean.length > 254) return false;
  return EMAIL_REGEX.test(clean);
}

function validatePassword(password, minLength = 6) {
  if (!password || typeof password !== 'string') return false;
  return password.length >= minLength && password.length <= 128;
}

function validateId(id) {
  if (!id || typeof id !== 'string') return false;
  return UUID_OR_ID_REGEX.test(id.trim());
}

function sanitizePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page || 1, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || query.limit || 25, 10) || 25));
  const offset = (page - 1) * pageSize;
  return { page, pageSize, limit: pageSize, offset };
}

function sanitizeSearch(searchStr, maxLength = 100) {
  if (!searchStr || typeof searchStr !== 'string') return '';
  return searchStr.trim().slice(0, maxLength);
}

/**
 * Express middleware to validate login payload
 */
function validateLoginInput(req, res, next) {
  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ success: false, message: 'Valid email address is required.' });
  }
  if (!validateEmail(email)) {
    return res.status(400).json({ success: false, message: 'Invalid email format.' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, message: 'Password is required.' });
  }
  req.body.email = email.toLowerCase().trim();
  next();
}

/**
 * Express middleware to validate registration payload
 */
function validateRegisterInput(req, res, next) {
  const { email, password, companyName, fullName } = req.body || {};

  if (!email || !validateEmail(email)) {
    return res.status(400).json({ success: false, message: 'Valid business email is required.' });
  }
  if (!password || !validatePassword(password, 6)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
  }
  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    return res.status(400).json({ success: false, message: 'Company name is required.' });
  }

  req.body.email = email.toLowerCase().trim();
  req.body.companyName = companyName.trim().slice(0, 150);
  if (fullName && typeof fullName === 'string') {
    req.body.fullName = fullName.trim().slice(0, 100);
  }
  next();
}

/**
 * Express middleware to sanitize pagination parameters
 */
function validatePaginationMiddleware(req, res, next) {
  const { page, pageSize, limit, offset } = sanitizePagination(req.query);
  req.pagination = { page, pageSize, limit, offset };
  next();
}

module.exports = {
  validateEmail,
  validatePassword,
  validateId,
  sanitizePagination,
  sanitizeSearch,
  validateLoginInput,
  validateRegisterInput,
  validatePaginationMiddleware,
  REPORT_TYPE_REGEX
};
