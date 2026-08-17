import React, { useState } from 'react';
import { useAuth, useToast, Field } from '../lib/ui.jsx';

const DEMO = [
  ['supervisor@quantum.test', 'Supervisor', 'Ramesh Yadav'],
  ['manager@quantum.test', 'Senior Manager', 'Anil Mehta'],
  ['director@quantum.test', 'Director', 'Vikram Singh'],
  ['accounts@quantum.test', 'Accounts', 'Priya Nair'],
  ['admin@quantum.test', 'Administrator', 'Admin'],
];

export default function Login() {
  const { signIn } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e, asEmail, asPassword) {
    e?.preventDefault();
    setBusy(true);
    try {
      await signIn(asEmail ?? email, asPassword ?? password);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>Quantum</h1>
        <p className="muted" style={{ marginTop: 0 }}>Driver Attendance &amp; Management</p>

        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <button className="primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
          {busy ? <span className="spinner" /> : 'Sign in'}
        </button>

        <div className="demo">
          Demo accounts — password <span className="mono">Quantum@123</span>
          {DEMO.map(([mail, role, name]) => (
            <button key={mail} type="button" onClick={(e) => submit(e, mail, 'Quantum@123')} disabled={busy}>
              <span>{role}</span>
              <span className="muted">{name}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
