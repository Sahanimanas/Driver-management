import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, forbidden } from './util.js';
import { PERMISSIONS, PERMISSION_KEYS } from './roles.js';

/**
 * Access is by permission (roles.js). A role is a named set of permissions;
 * Admin / Director holds every one of them. Route guards therefore read
 * allow('advances.pay'), not allow('finance'), so a role Admin creates works
 * everywhere the built-in ones do.
 */

/** Roles used before the consolidation, still accepted on the way in. */
export const LEGACY_ROLE = {
  senior_manager: 'admin',
  director: 'admin',
  accounts: 'finance',
};

export const normaliseRole = (role) => LEGACY_ROLE[role] || role;

export const hash = (pw) => bcrypt.hashSync(pw, 10);
export const verify = (pw, h) => bcrypt.compareSync(pw, h);

const PERMISSION_LABEL = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.label]));

export const parsePermissions = (json) => {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list.filter((p) => PERMISSION_KEYS.includes(p)) : [];
  } catch {
    return [];
  }
};

/**
 * The signed-in user as every route sees it: who they are, what they may do,
 * and whether they are in a field role (and so see only their own drivers).
 */
export function loadUser(id) {
  const row = q.get(
    `SELECT u.id, u.name, u.email, u.role, u.active,
            r.label AS role_label, r.permissions AS role_permissions, r.field AS role_field
       FROM users u LEFT JOIN roles r ON r.key = u.role
      WHERE u.id = ?`,
    id,
  );
  if (!row) return null;
  const admin = row.role === 'admin';
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    roleLabel: row.role_label || row.role,
    permissions: admin ? PERMISSION_KEYS : parsePermissions(row.role_permissions),
    field: !admin && Boolean(row.role_field),
  };
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name }, config.jwtSecret, {
    expiresIn: config.tokenTtl,
  });
}

function readToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // Files are loaded by <img src>/<a href>, which cannot set headers.
  if (typeof req.query?.t === 'string' && req.query.t) return req.query.t;
  return null;
}

export function authenticate(req, _res, next) {
  const token = readToken(req);
  if (!token) return next(new HttpError(401, 'Authentication required'));
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(new HttpError(401, 'Session expired, please sign in again'));
  }
  const user = loadUser(payload.sub);
  if (!user || !user.active) return next(new HttpError(401, 'Account is inactive'));
  req.user = user;
  return next();
}

/** True when the user holds any of the permissions. Admin holds them all. */
export const can = (user, ...perms) =>
  Boolean(user && (user.role === 'admin' || perms.some((p) => user.permissions?.includes(p))));

/** Route guard: allow(...permissions) — any one of them is enough. */
export function allow(...perms) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (can(req.user, ...perms)) return next();
    return next(forbidden(
      `Your role does not allow this. It needs the permission: ${perms.map((p) => PERMISSION_LABEL[p] || p).join(' or ')}`,
    ));
  };
}

/** Role keys (other than admin) that carry a permission — e.g. who holds a petty cash float. */
export function rolesWith(perm) {
  return q.all("SELECT key, permissions FROM roles WHERE key <> 'admin'")
    .filter((r) => parsePermissions(r.permissions).includes(perm))
    .map((r) => r.key);
}

/** Role keys that are field roles: drivers are deployed under people in them. */
export const fieldRoles = () => q.all("SELECT key FROM roles WHERE field = 1 AND key <> 'admin'").map((r) => r.key);
