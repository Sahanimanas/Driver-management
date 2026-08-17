import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, forbidden } from './util.js';

export const ROLES = ['admin', 'supervisor', 'senior_manager', 'director', 'accounts'];

export const ROLE_LABEL = {
  admin: 'Administrator',
  supervisor: 'Supervisor',
  senior_manager: 'Senior Manager',
  director: 'Director',
  accounts: 'Accounts',
};

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
