const BASE = '/api';

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(data?.error?.message ?? data?.message ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code ?? 'request_failed';
    error.details = data?.error ?? null;
    throw error;
  }

  return data;
}

export const api = {
  health: () => request('/health'),
  config: () => request('/config'),
  me: (token) => request('/auth/me', { token }),
  completeProfile: (token, payload) => request('/auth/profile', { method: 'POST', token, body: payload }),
  bootstrapStatus: () => request('/bootstrap/status'),
  createOwner: (payload) => request('/bootstrap/owner', { method: 'POST', body: payload }),
  diagnostics: (token) => request('/diagnostics', { token }),
  staff: (token) => request('/staff', { token }),
  updateStaff: (token, id, payload) => request(`/staff/${id}`, { method: 'PATCH', token, body: payload }),
  setupSql: async () => {
    const response = await fetch('/api/setup/sql');
    if (!response.ok) throw new Error('تعذر تحميل ملف السياسات.');
    return response.text();
  },
};
