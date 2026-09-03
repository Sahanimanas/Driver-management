import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, forbidden } from './util.js';

/**
 * Three roles, as agreed for this build:
 *   supervisor  -- the field role: registration, screening, deployment,
 *                  attendance, and raising advance / expense requests.
 *   admin       -- Admin / Director: approves every advance and expense,
 *                  owns the salary master, branding and user management.
 *   finance     -- pays out: advance runs, expense settlements, payroll,
 *                  bank sheets, bank reconciliation, Tally linkage, petty cash.
 */
export const ROLES = ['supervisor', 'admin', 'finance'];

export const ROLE_LABEL = {
  supervisor: 'Supervisor',
  admin: 'Admin / Director',
  finance: 'Finance',
};

export const ROLE_DESCRIPTION = {
  supervisor:
    'Registers drivers, records screening, deploys, marks attendance, raises advance '
    + 'and expense requests and settles petty cash.',
  admin:
    'Approves advances and expenses, maintains the salary master and branding, '
    + 'manages users, and can do everything the other roles can.',
  finance:
    'Advance payment runs, expense settlement, payroll and the wage register, bank '
    + 'upload sheets, bank reconciliation, Tally linkage and the petty cash float.',
};

/** Roles used before the consolidation, still accepted on the way in. */
export const LEGACY_ROLE = {
  senior_manager: 'admin',
  director: 'admin',
  accounts: 'finance',
};

export const normaliseRole = (role) => LEGACY_ROLE[role] || role;

export const hash = (pw) => bcrypt.hashSync(pw, 10);
export const verify = (pw, h) => bcrypt.compareSync(pw, h);

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
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = q.get('SELECT id, name, email, role, active FROM users WHERE id = ?', payload.sub);
    if (!user || !user.active) return next(new HttpError(401, 'Account is inactive'));
    req.user = user;
    return next();
  } catch {
    return next(new HttpError(401, 'Session expired, please sign in again'));
  }
}

/** Route guard: allow(...roles). Admin always passes. */
export function allow(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return next(forbidden(`This action is limited to: ${roles.map((r) => ROLE_LABEL[r]).join(', ')}`));
  };
}

export const is = (user, ...roles) => user?.role === 'admin' || roles.includes(user?.role);
