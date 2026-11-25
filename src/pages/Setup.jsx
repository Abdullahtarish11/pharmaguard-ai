import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const REASONS = {
  owner_exists: 'يوجد مالك للصيدلية بالفعل، لذلك مسار التهيئة مغلق نهائيًا.',
  bootstrap_token_missing:
    'لم يُضبط OWNER_BOOTSTRAP_TOKEN على السيرفر، لذلك التهيئة معطّلة حتى تضيفه في متغيرات البيئة.',
  not_configured: 'لم تُضف مفاتيح Supabase بعد، لذلك لا يمكن التحقق من حالة المالك.',
};

export default function Setup() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    bootstrapToken: '',
    fullName: '',
    email: '',
    password: '',
    pharmacyName: '',
  });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.bootstrapStatus();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  function update(field) {
    return (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createOwner({
        bootstrapToken: form.bootstrapToken,
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        pharmacyName: form.pharmacyName.trim(),
      });
      setCreated(result);
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const ownerExists = status?.ownerExists === true;
  const canBootstrap = status?.canBootstrap === true;
  const reason = status?.reason ? REASONS[status.reason] ?? null : null;

  return (
    <div className="grid">
      <div className="card form-card-narrow">
        <h1 className="section-title">تهيئة أول مالك للصيدلية</h1>

        {status && (
          <div className={ownerExists ? 'alert alert-warn' : 'alert'}>
            <strong>الحالة: </strong>
            {ownerExists ? 'مالك موجود' : canBootstrap ? 'جاهز للتهيئة' : 'غير جاهز'}
            {reason && <div className="small">{reason}</div>}
            {status.detail && (
              <div className="small" dir="ltr">
                {status.detail}
              </div>
            )}
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {created && (
          <div className="alert alert-success">
            تم إنشاء حساب المالك {created.owner?.email}. <Link to="/login">سجّل الدخول الآن</Link>.
            <div className="small">الصيدلية: {created.pharmacy?.name}</div>
          </div>
        )}

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="bootstrapToken">رمز التهيئة السري</label>
            <input
              id="bootstrapToken"
              className="input"
              type="password"
              dir="ltr"
              autoComplete="off"
              value={form.bootstrapToken}
              onChange={update('bootstrapToken')}
              required
              disabled={busy || ownerExists}
            />
          </div>
          <div className="field">
            <label htmlFor="fullName">اسم المالك الكامل</label>
            <input
              id="fullName"
              className="input"
              value={form.fullName}
              onChange={update('fullName')}
              required
              minLength={2}
              disabled={busy || ownerExists}
            />
          </div>
          <div className="field">
            <label htmlFor="ownerEmail">البريد الإلكتروني للمالك</label>
            <input
              id="ownerEmail"
              className="input"
              type="email"
              dir="ltr"
              autoComplete="email"
              value={form.email}
              onChange={update('email')}
              required
              disabled={busy || ownerExists}
            />
          </div>
          <div className="field">
            <label htmlFor="ownerPassword">كلمة المرور</label>
            <input
              id="ownerPassword"
              className="input"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              minLength={8}
              value={form.password}
              onChange={update('password')}
              required
              disabled={busy || ownerExists}
            />
          </div>
          <div className="field">
            <label htmlFor="pharmacyName">اسم الصيدلية</label>
            <input
              id="pharmacyName"
              className="input"
              value={form.pharmacyName}
              onChange={update('pharmacyName')}
              required
              minLength={2}
              disabled={busy || ownerExists}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || ownerExists || !canBootstrap}>
            {busy ? 'جارٍ الإنشاء…' : 'إنشاء حساب المالك'}
          </button>
        </form>
      </div>
    </div>
  );
}
