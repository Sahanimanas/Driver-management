import React, { useState } from 'react';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty } from '../lib/ui.jsx';
import { date } from '../lib/format.js';

import { ROLES as ROLE_KEYS, ROLE_LABEL, ROLE_DESCRIPTION } from '../lib/roles.js';

const ROLES = ROLE_KEYS.map((k) => [k, ROLE_LABEL[k], ROLE_DESCRIPTION[k]]);

export default function Users() {
  const { user } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.get('/auth/users'), []);

  if (user.role !== 'admin') {
    return <Page title="Users"><div className="banner error"><span>⚠</span>
      <div>User management is limited to Admin / Director.</div></div></Page>;
  }

  async function toggleActive(u) {
    try {
      await api.patch(`/auth/users/${u.id}`, { active: u.active ? 0 : 1 });
      toast.success(`${u.name} ${u.active ? 'deactivated' : 'reactivated'}`);
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  return (
    <Page title="Users & roles" subtitle="Supervisor · Admin / Director · Finance"
      actions={<button className="primary" onClick={() => setCreating(true)}>+ Add user</button>}>
      <ErrorBanner error={error} onRetry={reload} />

      <Card tight>
        {!data ? (error ? null : <Loading what="users" />) : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Added</th>
              <th>Status</th><th className="right">Action</th></tr></thead>
            <tbody>
              {data.length === 0 && <Empty>No users.</Empty>}
              {data.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.name}</b></td>
                  <td className="mono small">{u.email}</td>
                  <td className="mono small">{u.phone || '—'}</td>
                  <td><span className="chip blue">{ROLES.find((r) => r[0] === u.role)?.[1] || u.role}</span></td>
                  <td className="small muted">{date(u.created_at)}</td>
                  <td>{u.active
                    ? <span className="chip green">Active</span>
                    : <span className="chip grey">Inactive</span>}</td>
                  <td className="right nowrap">
                    <button className="sm" onClick={() => setEditing(u)}>Edit</button>{' '}
                    {u.id !== user.id && (
                      <button className="sm" onClick={() => toggleActive(u)}>
                        {u.active ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Roles">
        <table className="tbl">
          <tbody>
            {ROLES.map(([key, label, desc]) => (
              <tr key={key}>
                <td style={{ width: 180 }}><b>{label}</b></td>
                <td className="muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {(creating || editing) && (
        <UserModal
          user={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onDone={() => { setCreating(false); setEditing(null); toast.success('Saved'); reload(); }}
        />
      )}
    </Page>
  );
}

function UserModal({ user, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: user?.name || '', email: user?.email || '', phone: user?.phone || '',
    role: user?.role || 'supervisor', password: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    try {
      if (user) {
        const patch = { name: form.name, phone: form.phone, role: form.role };
        if (form.password) patch.password = form.password;
        await api.patch(`/auth/users/${user.id}`, patch);
      } else {
        await api.post('/auth/users', form);
      }
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add user'} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Save</button>
      </>}>
      <div className="grid c2">
        <Field label="Name"><input value={form.name} onChange={set('name')} /></Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={set('email')} disabled={!!user} />
        </Field>
        <Field label="Phone"><input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Role">
          <select value={form.role} onChange={set('role')}>
            {ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
      </div>
      <Field label={user ? 'New password' : 'Password'} hint="minimum 8 characters">
        <input type="password" value={form.password} onChange={set('password')}
          placeholder={user ? 'leave blank to keep the current password' : ''} />
      </Field>
    </Modal>
  );
}
