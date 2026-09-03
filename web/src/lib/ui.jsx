import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './api.js';

// ------------------------------------------------------------------- auth
const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onSignedOut = () => setUser(null);
    window.addEventListener('qdm:signed-out', onSignedOut);
    return () => window.removeEventListener('qdm:signed-out', onSignedOut);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api.get('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const value = useMemo(
    () => ({
      user,
      ready,
      async signIn(email, password) {
        const r = await api.post('/auth/login', { email, password });
        setToken(r.token);
        setUser(r.user);
        return r.user;
      },
      signOut() {
        setToken(null);
        setUser(null);
      },
      /** Admin passes every role check. */
      can: (...roles) => Boolean(user && (user.role === 'admin' || roles.includes(user.role))),
    }),
    [user, ready],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);

// --------------------------------------------------------------- branding
/**
 * The trading name and logo are client-supplied and editable in Settings, so
 * they are fetched rather than hard-coded. The endpoint is public because the
 * sign-in screen has to render before anyone has a session.
 */
const BrandCtx = createContext(null);

const FALLBACK_BRAND = { appName: 'Quantum', tagline: 'Driver Attendance & Management', logoUrl: null };

export function BrandingProvider({ children }) {
  const [brand, setBrand] = useState(FALLBACK_BRAND);

  const load = useCallback(() => {
    api.get('/branding')
      .then((b) => setBrand({ ...FALLBACK_BRAND, ...b }))
      .catch(() => setBrand(FALLBACK_BRAND));
  }, []);

  useEffect(() => {
    load();
    const onChanged = () => load();
    window.addEventListener('qdm:branding-changed', onChanged);
    return () => window.removeEventListener('qdm:branding-changed', onChanged);
  }, [load]);

  useEffect(() => {
    document.title = `${brand.appName} — ${brand.tagline}`;
  }, [brand]);

  return <BrandCtx.Provider value={brand}>{children}</BrandCtx.Provider>;
}

export const useBranding = () => useContext(BrandCtx) || FALLBACK_BRAND;

/** Settings calls this after saving so every screen picks the change up. */
export const brandingChanged = () => window.dispatchEvent(new CustomEvent('qdm:branding-changed'));

// ----------------------------------------------------------------- toasts
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const push = useCallback((message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((cur) => [...cur, { id, message, kind }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const value = useMemo(
    () => ({
      info: (m) => push(m, 'info'),
      success: (m) => push(m, 'success'),
      error: (m) => push(typeof m === 'string' ? m : m?.message || 'Something went wrong', 'error'),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- helpers
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve(fn())
      .then((data) => alive && setState({ loading: false, data, error: null }))
      .catch((error) => alive && setState({ loading: false, data: null, error }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}

// ------------------------------------------------------------- components
export function Modal({ title, children, onClose, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <header>
          <h3>{title}</h3>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/**
 * A labelled input.
 *
 * `required` marks the field with an asterisk, matching the starred fields of
 * the scope document. `error` puts the field in an error state and prints the
 * reason underneath — shown only once the field has been touched, so a form
 * does not open covered in red.
 */
export function Field({ label, hint, error, required, children }) {
  return (
    <label className={`field${error ? ' invalid' : ''}`}>
      <span>
        {label}{required && <b className="req" title="Mandatory">*</b>}
        {hint && <span className="hint">{hint}</span>}
      </span>
      {children}
      {error && <span className="err">{error}</span>}
    </label>
  );
}

export function Card({ title, actions, children, tight }) {
  return (
    <div className="card">
      {(title || actions) && (
        <header>
          <h3>{title}</h3>
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={`body${tight ? ' tight' : ''}`}>{children}</div>
    </div>
  );
}

export function Stat({ label, value, foot, tone }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export function Loading({ what = 'data' }) {
  return <div className="loading"><span className="spinner" /> Loading {what}…</div>;
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="banner error">
      <span>⚠</span>
      <div style={{ flex: 1 }}>{error.message}</div>
      {onRetry && <button className="sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ children }) {
  return <tr><td className="empty" colSpan={99}>{children}</td></tr>;
}

export function Avatar({ src, name, large }) {
  const initials = (name || '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  if (src) return <img className={`avatar${large ? ' lg' : ''}`} src={src} alt={name} />;
  return <span className={`avatar${large ? ' lg' : ''}`}>{initials}</span>;
}
