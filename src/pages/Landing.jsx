import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.jsx';

export default function Landing() {
  const { config } = useApp();
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .bootstrapStatus()
      .then((data) => {
        if (alive) setStatus(data);
      })
      .catch(() => {
        if (alive) setStatus(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const keysReady = Boolean(config?.anonKeyPresent && config?.serviceRolePresent);

  return (
    <div className="grid">
      <section className="hero">
        <div>
          <span className="eyebrow">مرحلة الربط والتأمين</span>
          <h1>PharmaGuard AI — صيدلية محمية بصلاحيات دقيقة</h1>
          <p className="lead">
            المشروع مربوط بمشروع Supabase القائم لديك عبر متغيرات بيئة فقط. لا نُنشئ مشروعًا جديدًا، ولا جداول
            بديلة، ولا بيانات تجريبية. كل ما يظهر الآن هو حالة الاتصال والأدوار وسياسات الوصول.
          </p>
          <div className="btn-row">
            <Link className="btn btn-primary" to="/setup">
              تهيئة أول مالك
            </Link>
            <Link className="btn btn-ghost" to="/login">
              تسجيل الدخول
            </Link>
            <Link className="btn btn-soft" to="/register">
              إنشاء حساب موظف
            </Link>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="section-title">حالة الربط</h2>
            <span className={keysReady ? 'badge' : 'badge badge-warn'}>
              {keysReady ? 'المفاتيح مضبوطة' : 'بانتظار المفاتيح'}
            </span>
          </div>
          <dl className="kv">
            <dt>مشروع Supabase</dt>
            <dd>{config?.supabaseUrl || '—'}</dd>
            <dt>المفتاح العام</dt>
            <dd>{config?.anonKeyPresent ? 'مضبوط (آمن للمتصفح)' : 'غير مضبوط'}</dd>
            <dt>مفتاح الخدمة</dt>
            <dd>{config?.serviceRolePresent ? 'مضبوط على السيرفر فقط' : 'غير مضبوط'}</dd>
            <dt>رمز التهيئة</dt>
            <dd>{config?.bootstrapTokenPresent ? 'مضبوط' : 'غير مضبوط'}</dd>
            <dt>مالك الصيدلية</dt>
            <dd>
              {status?.ownerExists === true
                ? 'موجود'
                : status?.ownerExists === false
                  ? 'لا يوجد بعد'
                  : 'غير معروف'}
            </dd>
          </dl>
          {config?.missing?.length > 0 && (
            <div className="alert alert-warn" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              متغيرات ناقصة: <span dir="ltr">{config.missing.join(' , ')}</span> — تُضاف من Settings → Environment
              variables.
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-3">
        <div className="card">
          <h3 className="section-title">١. ربط واحد وثابت</h3>
          <p className="muted small">
            التطبيق يقرأ عنوان المشروع والمفتاح العام من السيرفر وقت التشغيل، لا يوجد أي مفتاح مكتوب داخل الكود أو
            ملفات الواجهة.
          </p>
        </div>
        <div className="card">
          <h3 className="section-title">٢. ثلاثة أدوار فقط</h3>
          <p className="muted small">
            مالك الصيدلية، صيدلي، مسؤول المخزون. دور المالك لا يُتاح في نموذج التسجيل، ولا يمكن لأي مستخدم منحه
            لنفسه.
          </p>
        </div>
        <div className="card">
          <h3 className="section-title">٣. RLS مفعّل</h3>
          <p className="muted small">
            كل جدول من الجداول الـ11 يبقى محميًا بسياسات تقرأ الدور والصيدلية من ملف المستخدم نفسه، لا من مدخلات
            المتصفح.
          </p>
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">ما الذي لم يُبنَ بعد؟</h2>
        <p className="muted">
          وظائف المخزون والوكيل الذكي مؤجلة عن قصد حتى تأكيد نجاح الربط والقراءة والكتابة والصلاحيات على مشروع
          قاعدة البيانات القائم. بعد التأكيد تُبنى هذه الوحدات فوق نفس الجداول دون تغيير بنيتها.
        </p>
        <div className="pill-list">
          <span className="pill">inventory_batches</span>
          <span className="pill">stock_movements</span>
          <span className="pill">inventory_alerts</span>
          <span className="pill">drug_interactions</span>
          <span className="pill">agent_runs</span>
          <span className="pill">reports</span>
        </div>
      </section>
    </div>
  );
}
