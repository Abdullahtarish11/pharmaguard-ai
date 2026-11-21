import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import ExpiryAlertsPanel from '../components/ExpiryAlertsPanel.jsx';

export default function Landing() {
  const { config, session, me } = useApp();
  const [status, setStatus] = useState(null);
  const [expiryData, setExpiryData] = useState({ summary: null, alerts: [], loading: false });

  const token = session?.access_token;
  const isLinked = Boolean(me?.pharmacyId);

  const loadExpiryAlerts = useCallback(async () => {
    if (!token || !isLinked) return;
    setExpiryData((prev) => ({ ...prev, loading: true }));
    try {
      const [summaryRes, alertsRes] = await Promise.all([
        api.reportSummary(token).catch(() => null),
        api.alerts(token).catch(() => null),
      ]);
      setExpiryData({
        summary: summaryRes?.summary ?? null,
        alerts: Array.isArray(alertsRes?.alerts) ? alertsRes.alerts : [],
        loading: false,
      });
    } catch {
      setExpiryData((prev) => ({ ...prev, loading: false }));
    }
  }, [token, isLinked]);

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

  useEffect(() => {
    if (!token || !isLinked) return undefined;
    loadExpiryAlerts();
    const timer = setInterval(loadExpiryAlerts, 60_000);
    return () => clearInterval(timer);
  }, [token, isLinked, loadExpiryAlerts]);

  const keysReady = Boolean(config?.anonKeyPresent && config?.serviceRolePresent);

  return (
    <div className="grid">
      <section className="hero">
        <div>
          <h1>إدارة صيدلية ذكية وآمنة على بياناتك الحقيقية</h1>
          <div className="btn-row">
            {session ? (
              <Link className="btn btn-primary" to="/app">
                الانتقال إلى لوحة التحكم
              </Link>
            ) : (
              <>
                <Link className="btn btn-primary" to="/login">
                  تسجيل الدخول
                </Link>
                <Link className="btn btn-soft" to="/register">
                  إنشاء حساب موظف
                </Link>
                <Link className="btn btn-ghost" to="/setup">
                  تهيئة أول مالك
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="section-title">حالة الربط الحي</h2>
            <span className={keysReady ? 'badge' : 'badge badge-warn'}>
              {keysReady ? 'المفاتيح مضبوطة' : 'بانتظار المفاتيح'}
            </span>
          </div>
          <dl className="kv">
            <dt>مشروع Supabase</dt>
            <dd dir="ltr">{config?.supabaseUrl || '—'}</dd>
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

      {isLinked && (
        <ExpiryAlertsPanel
          summary={expiryData.summary}
          alerts={expiryData.alerts}
          loading={expiryData.loading}
          onRefresh={loadExpiryAlerts}
        />
      )}

      <section className="grid grid-3">
        <div className="card">
          <h3 className="section-title">١. مخزون دقيق ونظام FEFO</h3>
          <p className="muted small">
            إدارة الأدوية والدفعات وتواريخ الصلاحية مع تطبيق قاعدة الأقرب انتهاءً أولًا (FEFO) ومنع الصرف
            منتهي الصلاحية أو النزول تحت الصفر.
          </p>
        </div>
        <div className="card">
          <h3 className="section-title">٢. ثلاثة وكلاء ذكيين بلا اختلاق</h3>
          <p className="muted small">
            وكيل إدارة المخزون وإعادة الطلب، وكيل سلامة الأدوية من جدول التداخلات الفعلي، ووكيل التحليل والتقارير
            بأرقام موثقة.
          </p>
        </div>
        <div className="card">
          <h3 className="section-title">٣. عزل الصيدليات وصلاحيات RLS</h3>
          <p className="muted small">
            ثلاثة أدوار مفصولة الصلاحيات (مالك الصيدلية، صيدلي، مسؤول المخزون) مع عزل كامل لبيانات كل صيدلية
            على مستوى قاعدة البيانات والخادم.
          </p>
        </div>
      </section>

      <section className="card">
        <h2 className="section-title">الوحدات التشغيلية المتصلة بـ Supabase</h2>
        <p className="muted small">
          جميع الوحدات التالية مربوطة مباشرةً بالجداول الـ11 دون بيانات وهمية وجاهزة للعمل فور تسجيل الدخول:
        </p>
        <div className="pill-list">
          <span className="pill">الأدوية والدفعات (FEFO)</span>
          <span className="pill">حركات الاستلام والصرف والإتلاف</span>
          <span className="pill">تنبيهات النقص والصلاحية</span>
          <span className="pill">التقارير وحفظ اللقطات</span>
          <span className="pill">الوكيل الذكي وسجل الأسئلة</span>
          <span className="pill">تطبيق ويب متقدم (PWA)</span>
        </div>
      </section>
    </div>
  );
}
