import React, { useState } from 'react';
import { Page } from '../App.jsx';
import { api } from '../lib/api.js';
import { useAsync, useAuth, useToast, Card, Field, Modal, Loading, ErrorBanner, Empty } from '../lib/ui.jsx';
import { date } from '../lib/format.js';

/**
 * Users, and the roles they are given.
 *
 * A role is a named set of permissions. Supervisor, Admin / Director and
 * Finance are built in and fixed; anything else is made here -- from scratch
 * or by duplicating a built-in one and adjusting it.
 */
export default function Users() {
  const { user, can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('users');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const { data, error, reload } = useAsync(() => api.get('/auth/users'), []);
  const roles = useAsync(() => api.get('/auth/roles'), []);

  if (!can('users.manage')) {
    return <Page title="Users"><div className="banner error"><span>⚠</span>
      <div>Your role does not include managing users.</div></div></Page>;
  }

  async function toggleActive(u) {
    try {
      await api.patch(`/auth/users/${u.id}`, { active: u.active ? 0 : 1 });
      toast.success(`${u.name} ${u.active ? 'deactivated' : 'reactivated'}`);
      reload();
      roles.reload();
    } catch (err) {
      toast.error(err);
    }
  }

  const roleList = roles.data?.roles || [];

  return (
    <Page title="Users & roles" subtitle="Who can sign in, and what each role is allowed to do"
      actions={tab === 'users' && <button className="primary" onClick={() => setCreating(true)}>+ Add user</button>}>
      <div className="tabs">
        <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
        <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>
          Roles {roleList.length > 0 && <span className="muted">({roleList.length})</span>}
        </button>
      </div>

      {tab === 'users' && (
        <>
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
                      <td>
                        <span className="chip blue">{u.role_label || u.role}</span>
                        {u.role_field ? <span className="chip grey" style={{ marginLeft: 4 }}>own drivers</span> : null}
                      </td>
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
        </>
      )}

      {tab === 'roles' && (
        <Roles data={roles.data} error={roles.error} reload={() => { roles.reload(); reload(); }} />
      )}

      {(creating || editing) && (
        <UserModal
          user={editing}
          self={editing?.id === user.id}
          roles={roleList}
          onClose={() => { setCreating(false); setEditing(null); }}
          onDone={() => { setCreating(false); setEditing(null); toast.success('Saved'); reload(); roles.reload(); }}
        />
      )}
    </Page>
  );
}

function UserModal({ user, self, roles, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: user?.name || '', email: user?.email || '', phone: user?.phone || '',
    role: user?.role || 'supervisor', password: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const chosen = roles.find((r) => r.key === form.role);

  async function submit() {
    setBusy(true);
    try {
      if (user) {
        const patch = { name: form.name, phone: form.phone };
        if (!self) patch.role = form.role;
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
        <Field label="Role" hint={self ? 'you cannot change your own role' : undefined}>
          <select value={form.role} onChange={set('role')} disabled={self}>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </Field>
      </div>
      {chosen && (
        <div className="banner" style={{ marginTop: 0 }}>
          <span>ℹ</span>
          <div className="small">
            {chosen.description || `${chosen.permissions.length} permission(s).`}
            {chosen.field && ' Drivers are deployed under this user, and they see only those drivers.'}
          </div>
        </div>
      )}
      <Field label={user ? 'New password' : 'Password'} hint="minimum 8 characters">
        <input type="password" value={form.password} onChange={set('password')}
          placeholder={user ? 'leave blank to keep the current password' : ''} />
      </Field>
    </Modal>
  );
}

// -------------------------------------------------------------------- roles
function Roles({ data, error, reload }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);   // { role?, from? }

  async function remove(r) {
    if (!window.confirm(`Delete the role ${r.label}?`)) return;
    try {
      await api.del(`/auth/roles/${r.key}`);
      toast.success(`${r.label} deleted`);
      reload();
    } catch (err) {
      toast.error(err);
    }
  }

  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (!data) return <Loading what="roles" />;
  const total = data.permissions.length;

  return (
    <>
      <div className="toolbar">
        <div className="muted small" style={{ flex: 1 }}>
          The three built-in roles are fixed. To make a variation of one, duplicate it and adjust
          the copy.
        </div>
        <button className="primary" onClick={() => setEditing({})}>+ New role</button>
      </div>

      <Card tight>
        <table className="tbl">
          <thead>
            <tr><th>Role</th><th>What it can do</th><th className="num">Users</th><th className="right">Action</th></tr>
          </thead>
          <tbody>
            {data.roles.map((r) => (
              <tr key={r.key}>
                <td style={{ width: 220 }}>
                  <b>{r.label}</b>
                  <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                    {r.builtin ? <span className="chip grey">built-in</span> : <span className="chip violet">custom</span>}
                    {r.field && <span className="chip amber">supervises drivers</span>}
                  </div>
                </td>
                <td className="small">
                  {r.description && <div>{r.description}</div>}
                  <div className="muted" style={{ marginTop: 2 }}>
                    {r.permissions.length === total
                      ? 'Every permission'
                      : `${r.permissions.length} of ${total} permissions: `
                        + r.permissions.map((p) => data.permissions.find((x) => x.key === p)?.label || p).join(', ')}
                  </div>
                </td>
                <td className="num">{r.users}</td>
                <td className="right nowrap">
                  {!r.builtin && <><button className="sm" onClick={() => setEditing({ role: r })}>Edit</button>{' '}</>}
                  <button className="sm" onClick={() => setEditing({ from: r })}>Duplicate</button>
                  {!r.builtin && <>{' '}<button className="sm" onClick={() => remove(r)}>Delete</button></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {editing && (
        <RoleModal
          role={editing.role}
          from={editing.from}
          catalogue={data.permissions}
          onClose={() => setEditing(null)}
          onDone={(saved) => { setEditing(null); toast.success(`${saved.label} saved`); reload(); }}
        />
      )}
    </>
  );
}

function RoleModal({ role, from, catalogue, onClose, onDone }) {
  const toast = useToast();
  const base = role || from;
  const [form, setForm] = useState({
    label: role ? role.label : from ? `${from.label} (copy)` : '',
    description: base?.description || '',
    field: Boolean(base?.field),
    permissions: new Set(base?.permissions || []),
  });
  const [busy, setBusy] = useState(false);

  const groups = [];
  catalogue.forEach((p) => {
    let g = groups.find((x) => x.name === p.group);
    if (!g) groups.push(g = { name: p.group, items: [] });
    g.items.push(p);
  });

  const toggle = (key, on) => setForm((f) => {
    const next = new Set(f.permissions);
    if (on) next.add(key); else next.delete(key);
    return { ...f, permissions: next };
  });

  async function submit() {
    setBusy(true);
    try {
      const body = { ...form, permissions: [...form.permissions] };
      const saved = role
        ? await api.patch(`/auth/roles/${role.key}`, body)
        : await api.post('/auth/roles', body);
      onDone(saved);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal wide title={role ? `Edit role — ${role.label}` : 'New role'} onClose={onClose}
      footer={<>
        <span className="muted small" style={{ marginRight: 'auto' }}>
          {form.permissions.size} of {catalogue.length} permissions
        </span>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={submit}
          disabled={busy || form.label.trim().length < 2 || form.permissions.size === 0}>
          {busy ? <span className="spinner" /> : 'Save role'}
        </button>
      </>}>
      <div className="grid c2">
        <Field label="Role name" required>
          <input value={form.label} maxLength={40} autoFocus placeholder="e.g. Site In-charge"
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
        </Field>
        <Field label="Description" hint="optional">
          <input value={form.description} maxLength={200} placeholder="What this role is for"
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
      </div>

      <label className="check" style={{ margin: '4px 0 14px' }}>
        <input type="checkbox" checked={form.field}
          onChange={(e) => setForm((f) => ({ ...f, field: e.target.checked }))} />
        <span>
          <b>Supervises drivers</b>
          <span className="muted small"> — people in this role appear in the deployment form's
            supervisor list, and see only the drivers deployed under them (plus drivers not yet deployed)</span>
        </span>
      </label>

      <div className="perm-grid">
        {groups.map((g) => {
          const all = g.items.every((p) => form.permissions.has(p.key));
          return (
            <div key={g.name} className="perm-group">
              <div className="perm-head">
                <b>{g.name}</b>
                <button className="sm" type="button"
                  onClick={() => g.items.forEach((p) => toggle(p.key, !all))}>{all ? 'None' : 'All'}</button>
              </div>
              {g.items.map((p) => (
                <label key={p.key} className="check perm">
                  <input type="checkbox" checked={form.permissions.has(p.key)}
                    onChange={(e) => toggle(p.key, e.target.checked)} />
                  <span>
                    {p.label}
                    {p.hint && <div className="muted small">{p.hint}</div>}
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
