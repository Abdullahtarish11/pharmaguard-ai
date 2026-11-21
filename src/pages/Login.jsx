import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context.jsx';
import { roleLabel } from '../labels.js';

export default function Login() {
  const { supabase, config, session, passwordRecovery, clearPasswordRecovery } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const ready = Boolean(supabase);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setNotice(null);
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

  async function handleResetRequest(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/login`,
      });
      if (resetError) throw new Error(resetError.message);
      setNotice('أُرسل رابط استعادة كلمة المرور إلى بريدك الإلكتروني (إن كان الحساب مسجّلًا).');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordUpdate(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw new Error(updateError.message);
      clearPasswordRecovery();
      setNewPassword('');
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
        <h1 className="section-title">
          {passwordRecovery ? 'تعيين كلمة مرور جديدة' : forgotMode ? 'استعادة كلمة المرور' : 'تسجيل الدخول'}
        </h1>
        <p className="muted small">
          الدخول يتم عبر Supabase Auth في مشروعك، والجلسة تحمل هويتك إلى سياسات RLS.
        </p>

        {!ready && (
          <div className="alert alert-warn">
            لم تُضف مفاتيح Supabase بعد. أضف <span dir="ltr">SUPABASE_URL</span> و{' '}
            <span dir="ltr">SUPABASE_ANON_KEY</span> في Settings → Environment variables ثم أعد تحميل الصفحة.
          </div>
        )}
        {session && !passwordRecovery && (
          <div className="alert alert-success">
            أنت مسجّل الدخول بالفعل. <Link to="/app">انتقل إلى لوحة التحكم</Link>.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        {passwordRecovery ? (
          <form className="form" onSubmit={handlePasswordUpdate}>
            <div className="field">
              <label htmlFor="new-password">كلمة المرور الجديدة</label>
              <input
                id="new-password"
                className="input"
                type="password"
                dir="ltr"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
                disabled={!ready || busy}
              />
              <span className="hint">8 أحرف على الأقل.</span>
            </div>
            <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
              {busy ? 'جارٍ الحفظ…' : 'تحديث كلمة المرور'}
            </button>
          </form>
        ) : forgotMode ? (
          <form className="form" onSubmit={handleResetRequest}>
            <div className="field">
              <label htmlFor="reset-email">البريد الإلكتروني</label>
              <input
                id="reset-email"
                className="input"
                type="email"
                dir="ltr"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={!ready || busy}
              />
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
                {busy ? 'جارٍ الإرسال…' : 'إرسال رابط الاستعادة'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  setForgotMode(false);
                  setError(null);
                  setNotice(null);
                }}
              >
                رجوع لتسجيل الدخول
              </button>
            </div>
          </form>
        ) : (
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
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
                {busy ? 'جارٍ الدخول…' : 'دخول'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                disabled={!ready || busy}
                onClick={() => {
                  setForgotMode(true);
                  setError(null);
                  setNotice(null);
                }}
              >
                نسيت كلمة المرور؟
              </button>
            </div>
          </form>
        )}
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
            الأدوار المتاحة للتسجيل: {config.selfRegisterRoles.map((r) => roleLabel(r)).join(' • ')}
          </p>
        )}
      </div>
    </div>
  );
}
