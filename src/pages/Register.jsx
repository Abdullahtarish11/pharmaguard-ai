import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { SELF_REGISTER_ROLES } from '../labels.js';

export default function Register() {
  const { supabase, session, refreshMe } = useApp();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(SELF_REGISTER_ROLES[0].value);
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
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: { data: { full_name: fullName.trim() } },
      });
      if (signUpError) throw new Error(signUpError.message);

      const token = data?.session?.access_token;
      if (!token) {
        setNotice(
          'تم إنشاء الحساب. مشروعك يطلب تأكيد البريد الإلكتروني: افتح رسالة التأكيد ثم سجّل الدخول لإكمال الملف الشخصي واختيار الدور.',
        );
        return;
      }

      await api.completeProfile(token, { fullName: fullName.trim(), role });
      await refreshMe();
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
        <h1 className="section-title">إنشاء حساب موظف</h1>
        <p className="muted small">
          التسجيل الذاتي متاح لدورين فقط: صيدلي أو مسؤول مخزون. دور مالك الصيدلية غير موجود في هذا النموذج ولا
          يمكن اختياره أو إرساله.
        </p>

        {!ready && (
          <div className="alert alert-warn">
            أضف <span dir="ltr">SUPABASE_URL</span> و <span dir="ltr">SUPABASE_ANON_KEY</span> في Settings →
            Environment variables ثم أعد تحميل الصفحة.
          </div>
        )}
        {session && (
          <div className="alert">
            أنت مسجّل الدخول بالفعل. <Link to="/app">اذهب إلى لوحة التحكم</Link>.
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

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
              disabled={!ready || busy}
            />
          </div>
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
              disabled={!ready || busy}
            />
          </div>
          <div className="field">
            <label htmlFor="password">كلمة المرور</label>
            <input
              id="password"
              className="input"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={!ready || busy}
            />
            <span className="hint">8 أحرف على الأقل.</span>
          </div>
          <div className="field">
            <label htmlFor="role">الدور الوظيفي</label>
            <select
              id="role"
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              disabled={!ready || busy}
            >
              {SELF_REGISTER_ROLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.hint}
                </option>
              ))}
            </select>
            <span className="hint">لن يمنحك التسجيل أي صلاحية على صيدلية قبل أن يربطك المالك بها.</span>
          </div>
          <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
            {busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2 className="section-title">هل أنت مالك الصيدلية؟</h2>
        <p className="muted small">
          حساب المالك يُنشأ مرة واحدة فقط عبر مسار تهيئة محمي برمز سري على السيرفر، ولا يمكن إنشاؤه من نموذج
          التسجيل العام. بعد وجود مالك واحد يُغلق المسار تلقائيًا.
        </p>
        <div className="btn-row">
          <Link className="btn btn-ghost" to="/setup">
            فتح صفحة التهيئة
          </Link>
          <Link className="btn btn-soft" to="/login">
            لدي حساب
          </Link>
        </div>
      </div>
    </div>
  );
}
