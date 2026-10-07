import { Router } from 'express';
import { q, audit } from '../db.js';
import { signToken, verify, hash, allow, authenticate, loadUser, parsePermissions } from '../auth.js';
import { PERMISSIONS, PERMISSION_KEYS, BUILTIN_KEYS } from '../roles.js';
import { h, need, bad, notFound, HttpError, bool } from '../util.js';

const router = Router();

router.post(
  '/login',
  h(async (req, res) => {
    need(req.body, ['email', 'password']);
    const user = q.get('SELECT * FROM users WHERE lower(email) = lower(?)', String(req.body.email).trim());
    if (!user || !verify(req.body.password, user.password_hash)) {
      throw new HttpError(401, 'Invalid email or password');
    }
    if (!user.active) throw new HttpError(403, 'This account has been deactivated');
    audit(user.id, 'user', user.id, 'login');
    res.json({ token: signToken(user), user: loadUser(user.id) });
  }),
);

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post(
  '/change-password',
  authenticate,
  h(async (req, res) => {
    need(req.body, ['currentPassword', 'newPassword']);
    if (String(req.body.newPassword).length < 8) throw bad('New password must be at least 8 characters');
    const user = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verify(req.body.currentPassword, user.password_hash)) throw bad('Current password is incorrect');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hash(req.body.newPassword), user.id);
    audit(user.id, 'user', user.id, 'password_changed');
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ roles
const roleRow = (r) => ({
  key: r.key,
  label: r.label,
  description: r.description,
  permissions: r.key === 'admin' ? PERMISSION_KEYS : parsePermissions(r.permissions),
  field: Boolean(r.field),
  builtin: Boolean(r.builtin),
  users: Number(r.users || 0),
});

const ROLES_SQL = `
  SELECT r.*, (SELECT count(*) FROM users u WHERE u.role = r.key AND u.active = 1) AS users
    FROM roles r
   ORDER BY r.builtin DESC, CASE r.key WHEN 'supervisor' THEN 1 WHEN 'admin' THEN 2 WHEN 'finance' THEN 3 END, r.label`;

/** Every role and the permission catalogue the role editor is built from. */
router.get('/roles', authenticate, (_req, res) => {
  res.json({ roles: q.all(ROLES_SQL).map(roleRow), permissions: PERMISSIONS });
});

function readRole(body, existingKey = null) {
  const label = String(body.label || '').trim().replace(/\s+/g, ' ');
  if (label.length < 2 || label.length > 40) throw bad('A role name is 2 to 40 characters');
  const clash = q.get('SELECT key FROM roles WHERE label = ? COLLATE NOCASE AND key <> ?', label, existingKey || '');
  if (clash) throw bad(`There is already a role called ${label}`);
  const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
  const unknown = permissions.filter((p) => !PERMISSION_KEYS.includes(p));
  if (unknown.length) throw bad(`Unknown permission: ${unknown.join(', ')}`);
  if (!permissions.length) throw bad('Give the role at least one permission');
  return {
    label,
    description: String(body.description || '').trim() || null,
    permissions: PERMISSION_KEYS.filter((p) => permissions.includes(p)),
    field: bool(body.field) ? 1 : 0,
  };
}

function newRoleKey(label) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'role';
  let key = base;
  for (let n = 2; q.get('SELECT 1 FROM roles WHERE key = ?', key) || BUILTIN_KEYS.includes(key); n += 1) {
    key = `${base}_${n}`;
  }
  return key;
}

router.post(
  '/roles',
  authenticate,
  allow('users.manage'),
  h(async (req, res) => {
    const role = readRole(req.body);
    const key = newRoleKey(role.label);
    q.run(
      'INSERT INTO roles(key, label, description, permissions, field, builtin) VALUES (?,?,?,?,?,0)',
      key, role.label, role.description, JSON.stringify(role.permissions), role.field,
    );
    audit(req.user.id, 'role', key, 'created', role);
    res.status(201).json(roleRow(q.get('SELECT * FROM roles WHERE key = ?', key)));
  }),
);

router.patch(
  '/roles/:key',
  authenticate,
  allow('users.manage'),
  h(async (req, res) => {
    const existing = q.get('SELECT * FROM roles WHERE key = ?', req.params.key);
    if (!existing) throw notFound('Role not found');
    if (existing.builtin) {
      throw bad('The built-in roles are fixed. Duplicate one to make a role of your own.');
    }
    const role = readRole(req.body, existing.key);
    q.run(
      'UPDATE roles SET label = ?, description = ?, permissions = ?, field = ? WHERE key = ?',
      role.label, role.description, JSON.stringify(role.permissions), role.field, existing.key,
    );
    audit(req.user.id, 'role', existing.key, 'updated', role);
    res.json(roleRow(q.get('SELECT * FROM roles WHERE key = ?', existing.key)));
  }),
);

router.delete(
  '/roles/:key',
  authenticate,
  allow('users.manage'),
  h(async (req, res) => {
    const existing = q.get('SELECT * FROM roles WHERE key = ?', req.params.key);
    if (!existing) throw notFound('Role not found');
    if (existing.builtin) throw bad('A built-in role cannot be deleted');
    const users = Number(q.scalar('SELECT count(*) FROM users WHERE role = ?', existing.key));
    if (users) {
      throw bad(`${users} user(s) still have the role ${existing.label}. Move them to another role first.`);
    }
    q.run('DELETE FROM roles WHERE key = ?', existing.key);
    audit(req.user.id, 'role', existing.key, 'deleted', { label: existing.label });
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------- user admin
const USER_SQL = `
  SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.created_at,
         r.label AS role_label, r.field AS role_field
    FROM users u LEFT JOIN roles r ON r.key = u.role`;

const checkRole = (role) => {
  if (!q.get('SELECT 1 FROM roles WHERE key = ?', role)) throw bad('Choose one of the roles on the list');
};

router.get('/users', authenticate, allow('users.manage'), (req, res) => {
  res.json(q.all(`${USER_SQL} ORDER BY u.name`));
});

router.post(
  '/users',
  authenticate,
  allow('users.manage'),
  h(async (req, res) => {
    need(req.body, ['name', 'email', 'password', 'role']);
    checkRole(req.body.role);
    if (String(req.body.password).length < 8) throw bad('Password must be at least 8 characters');
    const exists = q.get('SELECT id FROM users WHERE lower(email) = lower(?)', req.body.email);
    if (exists) throw bad('A user with this email already exists');
    const id = q.insert(
      'INSERT INTO users(name, email, phone, password_hash, role) VALUES (?,?,?,?,?)',
      req.body.name.trim(),
      String(req.body.email).trim().toLowerCase(),
      req.body.phone || null,
      hash(req.body.password),
      req.body.role,
    );
    audit(req.user.id, 'user', id, 'created', { role: req.body.role });
    res.status(201).json(q.get(`${USER_SQL} WHERE u.id = ?`, id));
  }),
);

router.patch(
  '/users/:id',
  authenticate,
  allow('users.manage'),
  h(async (req, res) => {
    const user = q.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!user) throw notFound('User not found');
    const { name, phone, role, active, password } = req.body;
    if (role) checkRole(role);
    if (user.id === req.user.id && active !== undefined && !bool(active)) {
      throw bad('You cannot deactivate your own account');
    }
    if (user.id === req.user.id && role && role !== user.role) {
      throw bad('You cannot change your own role — ask another administrator');
    }
    q.run(
      `UPDATE users SET name = ?, phone = ?, role = ?, active = ? WHERE id = ?`,
      name ?? user.name,
      phone ?? user.phone,
      role ?? user.role,
      active === undefined ? user.active : bool(active),
      user.id,
    );
    if (password) {
      if (String(password).length < 8) throw bad('Password must be at least 8 characters');
      q.run('UPDATE users SET password_hash = ? WHERE id = ?', hash(password), user.id);
    }
    audit(req.user.id, 'user', user.id, 'updated');
    res.json(q.get(`${USER_SQL} WHERE u.id = ?`, user.id));
  }),
);

export default router;
