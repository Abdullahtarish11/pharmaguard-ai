import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context.jsx';

export default function Login() {
  const { supabase, config } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const ready = Boolean(supabase);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) throw new Error(signInError.message);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-2">
      <div className="card">
        <h1 className="section-title">تسجيل الدخول</h1>
        <p className="muted small">
          الدخول يتم عبر Supabase Auth في مشروعك، والجلسة تحمل هويتك إلى سياسات RLS.
        </p>

        {!ready && (
          <div className="alert alert-warn">
            لم تُضف مفاتيح Supabase بعد. أضف <span dir="ltr">SUPABASE_URL</span> و{' '}
            <span dir="ltr">SUPABASE_ANON_KEY</span> في Settings → Environment variables ثم أعد تحميل الصفحة.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">البريد الإلكتروني</label>
            <input
              id="email"
              className="input"
              type="email"
              dir="ltr"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={!ready}
            />
          </div>
          <div className="field">
            <label htmlFor="password">كلمة المرور</label>
            <input
              id="password"
              className="input"
              type="password"
              dir="ltr"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={!ready}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
            {busy ? 'جارٍ الدخول…' : 'دخول'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2 className="section-title">لا تملك حسابًا؟</h2>
        <p className="muted small">
          حسابات الموظفين تُنشأ بالتسجيل الذاتي بدور صيدلي أو مسؤول مخزون فقط. أول حساب مالك للصيدلية يُنشأ عبر
          مسار تهيئة محمي برمز سري.
        </p>
        <div className="btn-row">
          <Link className="btn btn-soft" to="/register">
            تسجيل موظف
          </Link>
          <Link className="btn btn-ghost" to="/setup">
            تهيئة المالك
          </Link>
        </div>
        {config?.selfRegisterRoles && (
          <p className="hint" style={{ marginTop: '1rem' }}>
            الأدوار المتاحة للتسجيل: {config.selfRegisterRoles.join(' , ')}
          </p>
        )}
      </div>
    </div>
  );
}
