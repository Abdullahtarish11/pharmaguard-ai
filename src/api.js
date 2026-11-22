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
  medicines: (token, query = '') => request(`/medicines${query}`, { token }),
  createMedicine: (token, payload) => request('/medicines', { method: 'POST', token, body: payload }),
  importMedicines: (token, medicines) => request('/medicines/import', { method: 'POST', token, body: { medicines } }),
  updateMedicine: (token, id, payload) => request(`/medicines/${id}`, { method: 'PATCH', token, body: payload }),
  interactions: (token) => request('/interactions', { token }),
  importInteractions: (token, interactions) =>
    request('/interactions/import', { method: 'POST', token, body: { interactions } }),
  batches: (token, query = '') => request(`/batches${query}`, { token }),
  createBatch: (token, payload) => request('/batches', { method: 'POST', token, body: payload }),
  updateBatch: (token, id, payload) => request(`/batches/${id}`, { method: 'PATCH', token, body: payload }),
  batchMovement: (token, id, payload) => request(`/batches/${id}/movements`, { method: 'POST', token, body: payload }),
  movements: (token, query = '') => request(`/movements${query}`, { token }),
  createMovement: (token, payload) => request('/movements', { method: 'POST', token, body: payload }),
  alerts: (token) => request('/alerts', { token }),
  resolveAlert: (token, id) => request(`/alerts/${id}/resolve`, { method: 'PATCH', token }),
  resolveComputedAlert: (token, payload) => request('/alerts/resolve-computed', { method: 'POST', token, body: payload }),
  reportSummary: (token) => request('/reports/summary', { token }),
  saveReport: (token) => request('/reports', { method: 'POST', token }),
  reports: (token) => request('/reports', { token }),
  askAgent: (token, question) => request('/agent/ask', { method: 'POST', token, body: { question } }),
  agentRuns: (token) => request('/agent/runs', { token }),
  agentSweepLatest: (token) => request('/agent/sweep/latest', { token }),
  runAgentSweep: (token) => request('/agent/sweep', { method: 'POST', token }),
  subscribeAgentStream: (token, { onEvent, onStatusChange } = {}) => {
    if (!token) return () => {};
    let closed = false;
    let controller = null;
    let reconnectTimer = null;

    const connect = async () => {
      if (closed) return;
      controller = new AbortController();
      onStatusChange?.('connecting');
      try {
        const response = await fetch(`${BASE}/agent/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }
        onStatusChange?.('connected');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            if (!frame.trim() || frame.startsWith(':')) continue;
            let eventName = 'message';
            const dataLines = [];
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length > 0) {
              const raw = dataLines.join('\n');
              try {
                onEvent?.(eventName, JSON.parse(raw));
              } catch {
                // تجاهل الإطار غير المكتمل
              }
            }
          }
        }
      } catch {
        // إعادة الاتصال تلقائيًا عند انقطاع البث
      }

      if (!closed) {
        onStatusChange?.('reconnecting');
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller?.abort();
    };
  },
};
