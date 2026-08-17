const TOKEN_KEY = 'qdm.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, { body, form, raw } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  if (res.status === 401 && !path.startsWith('/auth/login')) {
    setToken(null);
    window.dispatchEvent(new CustomEvent('qdm:signed-out'));
  }
  if (raw) {
    if (!res.ok) throw new ApiError('Download failed', res.status);
    return res;
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.details);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, body) => request('POST', p, { body }),
  patch: (p, body) => request('PATCH', p, { body }),
  put: (p, body) => request('PUT', p, { body }),
  del: (p) => request('DELETE', p),
  upload: (p, form, method = 'POST') => request(method, p, { form }),

  /** Trigger a browser download of a generated file (register, sheet, export). */
  async download(path, filename) {
    const res = await request('GET', path, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return res;
  },
};

/** URL for an attachment — the token rides in the query so <img> works. */
export const fileUrl = (id, { download = false } = {}) =>
  id ? `/api/files/${id}?t=${encodeURIComponent(getToken() || '')}${download ? '&download=1' : ''}` : null;
