import React, { useState } from 'react';
import { useAuth, useBranding, useToast, Field } from '../lib/ui.jsx';

const DEMO = [
  ['supervisor@quantum.test', 'Supervisor', 'Ramesh Yadav'],
  ['director@quantum.test', 'Admin / Director', 'Vikram Singh'],
  ['finance@quantum.test', 'Finance', 'Priya Nair'],
];

export default function Login() {
  const { signIn } = useAuth();
  const brand = useBranding();
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
        {brand.logoUrl && <img className="brand-logo" src={brand.logoUrl} alt="" />}
        <h1>{brand.appName}</h1>
        <p className="muted" style={{ marginTop: 0 }}>{brand.tagline}</p>

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
