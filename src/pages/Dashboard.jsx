import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { roleLabel } from '../labels.js';
import CompleteProfile from './CompleteProfile.jsx';

export default function Dashboard() {
  const { me, meError, session, config } = useApp();
  const [report, setReport] = useState(null);
  const [staff, setStaff] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const token = session?.access_token;
  const isOwner = me?.role === 'owner';
  const hasProfile = me?.hasProfile === true;

  const loadOwnerData = useCallback(async () => {
    if (!token || !isOwner) return;
    setBusy(true);
    setError(null);
    try {
      const [diagnostics, staffList] = await Promise.all([
        api.diagnostics(token).catch((err) => ({ error: err.message })),
        api.staff(token).catch((err) => ({ error: err.message })),
      ]);
      setReport(diagnostics);
      setStaff(staffList);
    } finally {
      setBusy(false);
    }
  }, [token, isOwner]);

  useEffect(() => {
    loadOwnerData();
  }, [loadOwnerData]);

  if (meError) {
    return (
      <div className="card">
        <h1 className="section-title">تعذر تحميل الحساب</h1>
        <div className="alert alert-error">{meError}</div>
        <p className="muted small">
          تحقق من إعدادات Supabase في متغيرات البيئة، ومن وجود ملف شخصي مرتبط بحسابك في جدول profiles.
        </p>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="centered">
        <div className="spinner" />
        <p className="muted">جارٍ تحميل الحساب…</p>
      </div>
    );
  }

  if (!hasProfile) return <CompleteProfile />;

  const connection = report?.connection;
  const write = report?.write;
  const rls = report?.rls;
  const tables = Array.isArray(report?.tables) ? report.tables : [];
  const totalRows = tables.reduce((sum, table) => sum + (table.rowCount ?? 0), 0);

  return (
    <div className="grid">
      <section className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h1 className="section-title">حسابك</h1>
            <span className="badge">{roleLabel(me.role)}</span>
          </div>
          <dl className="kv">
            <dt>الاسم</dt>
            <dd>{me.profile?.fullName || '—'}</dd>
            <dt>البريد</dt>
            <dd dir="ltr">{me.user?.email || me.profile?.email || '—'}</dd>
            <dt>الدور</dt>
            <dd>{roleLabel(me.role)}</dd>
            <dt>الصيدلية</dt>
            <dd dir="ltr">{me.pharmacyId || 'غير مرتبط بعد'}</dd>
            <dt>حالة الربط</dt>
            <dd>
              {config?.ready ? (
                <span className="badge">المفاتيح مكتملة</span>
              ) : (
                <span className="badge badge-warn">ناقص: {config?.missing?.join(' , ') || 'مفاتيح'}</span>
              )}
            </dd>
          </dl>
          {me.role !== 'owner' && (
            <div className="alert alert-warn" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              حسابك غير مرتبط بصيدلية بعد. مالك الصيدلية هو من يربطك من صفحة الموظفين.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="section-title">حالة قاعدة البيانات</h2>
            <button className="btn btn-soft" type="button" onClick={loadOwnerData} disabled={busy || !isOwner}>
              {busy ? 'جارٍ الفحص…' : 'تحديث'}
            </button>
          </div>
          {!isOwner && (
            <p className="muted small">التشخيص الكامل متاح لمالك الصيدلية فقط لأنه يكشف بنية المخطط.</p>
          )}
          {isOwner && report?.error && <div className="alert alert-error">{report.error}</div>}
          {isOwner && connection && (
            <div className="grid grid-3">
              <div className="stat">
                <span>الاتصال</span>
                <strong>{connection.ok ? 'ناجح' : 'فاشل'}</strong>
                <span className="hint">{connection.latencyMs} ms</span>
              </div>
              <div className="stat">
                <span>RLS</span>
                <strong>{rls?.installed ? 'مثبّت' : 'غير مثبّت'}</strong>
                <span className="hint">{rls?.installed ? `${rls.tables?.length ?? 0} جدول` : 'شغّل ملف السياسات'}</span>
              </div>
              <div className="stat">
                <span>اختبار الكتابة</span>
                <strong>{write?.ok ? 'ناجح' : 'لم ينجح'}</strong>
                <span className="hint">{write?.method ?? '—'}</span>
              </div>
              <div className="stat">
                <span>الجداول</span>
                <strong>{tables.length}</strong>
                <span className="hint">صفوف: {totalRows}</span>
              </div>
            </div>
          )}
          {isOwner && connection && !connection.ok && (
            <div className="alert alert-error" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              {connection.error}
            </div>
          )}
          {isOwner && (
            <div className="btn-row">
              <Link className="btn btn-primary" to="/app/diagnostics">
                تقرير التشخيص الكامل
              </Link>
            </div>
          )}
        </div>
      </section>

      {isOwner && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">الموظفون</h2>
            <span className="badge badge-muted">{staff?.staff?.length ?? 0} حساب</span>
          </div>
          {staff?.error && <div className="alert alert-error">{staff.error}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          {staff?.staff?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الاسم</th>
                    <th>البريد</th>
                    <th>الدور</th>
                    <th>الصيدلية</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.staff.map((member) => (
                    <tr key={member.id}>
                      <td>{member.fullName || '—'}</td>
                      <td dir="ltr">{member.email || '—'}</td>
                      <td>{member.roleLabel}</td>
                      <td dir="ltr">{member.pharmacyId || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">لا يوجد موظفون مسجّلون بعد. شارك صفحة التسجيل مع فريقك.</p>
          )}
        </section>
      )}

      <section className="card locked">
        <h2 className="section-title">وظائف مؤجلة حتى تأكيد الربط</h2>
        <p className="muted small">
          المخزون والوكيل الذكي لم يُبنَ بعد بشكل مقصود. الخطوة التالية بعد تأكيد الربط والصلاحيات: دفعات المخزون،
          حركات الصيد، التنبيهات، ثم الوكيل الذكي فوق الجداول نفسها.
        </p>
        <div className="pill-list">
          <span className="pill">inventory_batches</span>
          <span className="pill">stock_movements</span>
          <span className="pill">inventory_alerts</span>
          <span className="pill">agent_runs</span>
        </div>
      </section>
    </div>
  );
}
