import { Router } from 'express';
import { q, audit } from '../db.js';
import { signToken, verify, hash, allow, authenticate, ROLES, ROLE_LABEL } from '../auth.js';
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
    res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  }),
);

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user, roles: ROLES, roleLabels: ROLE_LABEL });
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

// ------------------------------------------------------------- user admin
router.get('/users', authenticate, allow('admin'), (req, res) => {
  res.json(q.all('SELECT id, name, email, phone, role, active, created_at FROM users ORDER BY name'));
});

router.post(
  '/users',
  authenticate,
  allow('admin'),
  h(async (req, res) => {
    need(req.body, ['name', 'email', 'password', 'role']);
    if (!ROLES.includes(req.body.role)) throw bad(`role must be one of: ${ROLES.join(', ')}`);
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
    res.status(201).json(q.get('SELECT id, name, email, phone, role, active FROM users WHERE id = ?', id));
  }),
);

router.patch(
  '/users/:id',
  authenticate,
  allow('admin'),
  h(async (req, res) => {
    const user = q.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!user) throw notFound('User not found');
    const { name, phone, role, active, password } = req.body;
    if (role && !ROLES.includes(role)) throw bad(`role must be one of: ${ROLES.join(', ')}`);
    if (user.id === req.user.id && active !== undefined && !bool(active)) {
      throw bad('You cannot deactivate your own account');
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
    res.json(q.get('SELECT id, name, email, phone, role, active FROM users WHERE id = ?', user.id));
  }),
);

export default router;
