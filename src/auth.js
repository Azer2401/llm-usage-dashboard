'use strict';

const jwt = require('jsonwebtoken');
const { aitmPool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwt';

// ─── HR/HM role check ────────────────────────────────────────────────────────
const MONITORED_ROLES = ['HUMAN RESOURCES', 'HIRING MANAGER'];

function isMonitoredRole(role) {
  return MONITORED_ROLES.includes(role);
}

// ─── Middleware: Require valid JWT ────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', code: 'NO_TOKEN' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // payload: { sub, email, name, role, type, iat, exp }
    req.user = {
      id:    payload.sub,
      email: payload.email,
      name:  payload.name,
      role:  payload.role,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_TOKEN', detail: err.message });
  }
}

// ─── Middleware: Require HR or Hiring Manager role ────────────────────────────
function requireHRorHM(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isMonitoredRole(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden', code: 'INSUFFICIENT_ROLE' });
  }
  next();
}

// ─── Middleware: Require HUMAN RESOURCES role (admin-level for this dashboard) ─
// In this system, HR acts as the admin who manages plans/assignments/mappings
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'HUMAN RESOURCES') {
    return res.status(403).json({ error: 'Forbidden', code: 'ADMIN_REQUIRED' });
  }
  next();
}

// ─── Middleware: Require specific LLM permission ──────────────────────────────
// Checks against role_permissions + permissions tables in AITM DB
function requirePermission(permissionName) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const { rows } = await aitmPool.query(`
        SELECT rp.id
        FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        JOIN user_roles ur ON ur.id = rp.user_role_id
        JOIN employees e ON e.user_role_id = ur.id
        WHERE e.user_id = $1
          AND p.permission_name = $2
        LIMIT 1
      `, [req.user.id, permissionName]);

      if (rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden', code: 'PERMISSION_DENIED', required: permissionName });
      }
      next();
    } catch (err) {
      console.error('[Auth] Permission check error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ─── Internal Service Key Auth ────────────────────────────────────────────────
// Used by N8N / GoClaw internal API calls
function requireInternalKey(req, res, next) {
  const serviceHeader = req.headers['x-internal-service'];
  const keyHeader     = req.headers['x-internal-key'];

  if (!serviceHeader || !keyHeader) {
    return res.status(401).json({ error: 'Unauthorized', code: 'MISSING_INTERNAL_CREDENTIALS' });
  }

  // Validate against env-configured keys
  const serviceKeyMap = {
    n8n:     process.env.INTERNAL_KEY_N8N,
    goclaw:  process.env.INTERNAL_KEY_GOCLAW,
    backend: process.env.INTERNAL_KEY_BACKEND,
  };

  const expectedKey = serviceKeyMap[serviceHeader.toLowerCase()];
  if (!expectedKey || expectedKey !== keyHeader) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_INTERNAL_KEY' });
  }

  req.internalService = serviceHeader.toUpperCase(); // N8N | GOCLAW | BACKEND
  next();
}

module.exports = {
  requireAuth,
  requireHRorHM,
  requireAdmin,
  requirePermission,
  requireInternalKey,
  isMonitoredRole,
  MONITORED_ROLES,
};
