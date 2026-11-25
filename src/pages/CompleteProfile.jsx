import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { SELF_REGISTER_ROLES, roleLabel } from '../labels.js';

export default function CompleteProfile() {
  const { session, refreshMe } = useApp();
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState(SELF_REGISTER_ROLES[0].value);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.completeProfile(session.access_token, { fullName: fullName.trim(), role });
      await refreshMe();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-card-narrow">
      <h1 className="section-title">أكمل ملفك الشخصي</h1>
      {error && <div className="alert alert-error">{error}</div>}
      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="fullName">الاسم الكامل</label>
          <input
            id="fullName"
            className="input"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            required
            minLength={2}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="role">الدور</label>
          <select
            id="role"
            className="select"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            disabled={busy}
          >
            {SELF_REGISTER_ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {roleLabel(option.value)} — {option.hint}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ الملف'}
        </button>
      </form>
    </div>
  );
}
