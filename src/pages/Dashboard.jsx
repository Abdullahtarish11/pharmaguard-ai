import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { SELF_REGISTER_ROLES, roleLabel } from '../labels.js';
import CompleteProfile from './CompleteProfile.jsx';
import ExpiryAlertsPanel from '../components/ExpiryAlertsPanel.jsx';

export default function Dashboard() {
  const { me, meError, session, config } = useApp();
  const [report, setReport] = useState(null);
  const [staff, setStaff] = useState(null);
  const [summary, setSummary] = useState(null);
  const [alertsList, setAlertsList] = useState([]);
  const [alertCounts, setAlertCounts] = useState(null);
  const [sweepStatus, setSweepStatus] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);

  const token = session?.access_token;
  const isOwner = me?.role === 'owner';
  const hasProfile = me?.hasProfile === true;
  const isLinked = Boolean(me?.pharmacyId);

  const loadDashboardData = useCallback(async () => {
    if (!token || !hasProfile) return;
    setBusy(true);
    setError(null);
    try {
      const tasks = [];
      if (isOwner) {
        tasks.push(
          api.diagnostics(token).catch((err) => ({ error: err.message })),
          api.staff(token).catch((err) => ({ error: err.message })),
        );
      } else {
        tasks.push(Promise.resolve(null), Promise.resolve(null));
      }

      if (isLinked) {
        tasks.push(
          api.reportSummary(token).catch(() => null),
          api.alerts(token).catch(() => null),
          api.agentSweepLatest(token).catch(() => null),
        );
      } else {
        tasks.push(Promise.resolve(null), Promise.resolve(null), Promise.resolve(null));
      }

      const [diagnostics, staffList, summaryData, alertsData, sweepData] = await Promise.all(tasks);
      if (isOwner) {
        setReport(diagnostics);
        setStaff(staffList);
      }
      setSummary(summaryData?.summary ?? null);
      setAlertsList(Array.isArray(alertsData?.alerts) ? alertsData.alerts : []);
      setAlertCounts(alertsData?.counts ? { total: alertsData.total, ...alertsData.counts } : null);
      setSweepStatus(sweepData);
    } finally {
      setBusy(false);
    }
  }, [token, hasProfile, isOwner, isLinked]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    if (!token || !hasProfile || !isLinked) return undefined;
    const timer = setInterval(loadDashboardData, 60_000);
    const onFocus = () => loadDashboardData();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [token, hasProfile, isLinked, loadDashboardData]);

  async function handleStaffUpdate(memberId, payload, successMessage) {
    if (!token || !memberId) return;
    setUpdatingId(memberId);
    setError(null);
    setNotice(null);
    try {
      await api.updateStaff(token, memberId, payload);
      setNotice(successMessage);
      await loadDashboardData();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdatingId(null);
    }
  }

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
      {isLinked && (
        <ExpiryAlertsPanel
          summary={summary}
          alerts={alertsList}
          loading={busy}
          onRefresh={loadDashboardData}
        />
      )}

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
          {me.role !== 'owner' && !me.pharmacyId && (
            <div className="alert alert-warn" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              حسابك غير مرتبط بصيدلية بعد. اطلب من مالك الصيدلية ربط حسابك من جدول الموظفين في لوحة التحكم.
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="section-title">{isOwner ? 'حالة قاعدة البيانات' : 'ملخص الصيدلية'}</h2>
            <button className="btn btn-soft" type="button" onClick={loadDashboardData} disabled={busy}>
              {busy ? 'جارٍ التحديث…' : 'تحديث'}
            </button>
          </div>
          {!isOwner && !isLinked && (
            <p className="muted small">ستظهر إحصائيات المخزون والتنبيهات فور ربط حسابك بالصيدلية.</p>
          )}
          {!isOwner && isLinked && summary && (
            <div className="grid grid-3">
              <div className="stat">
                <span>الأدوية</span>
                <strong>{summary.counts?.medicines ?? 0}</strong>
              </div>
              <div className="stat">
                <span>وحدات صالحة</span>
                <strong>{summary.units?.sellable ?? 0}</strong>
              </div>
              <div className="stat">
                <span>التنبيهات</span>
                <strong>{alertCounts?.total ?? 0}</strong>
                <span className="hint">حرجة: {alertCounts?.high ?? 0}</span>
              </div>
            </div>
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

      {isLinked && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">العمليات السريعة والمؤشرات الحية</h2>
            <span className="badge">متصل</span>
          </div>
          {summary && (
            <div className="grid grid-3" style={{ marginBottom: '1rem' }}>
              <div className="stat">
                <span>الأصناف المسجّلة</span>
                <strong>{summary.counts?.medicines ?? 0}</strong>
                <span className="hint">الدفعات: {summary.counts?.batches ?? 0}</span>
              </div>
              <div className="stat">
                <span>الوحدات القابلة للصرف</span>
                <strong>{summary.units?.sellable ?? 0}</strong>
                <span className="hint">منتهية: {summary.units?.expired ?? 0}</span>
              </div>
              <div className="stat">
                <span>التنبيهات النشطة</span>
                <strong>{alertCounts?.total ?? 0}</strong>
                <span className="hint">حرجة: {alertCounts?.high ?? 0}</span>
              </div>
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 0 }}>
            <Link className="btn btn-primary" to="/app/inventory">
              إدارة المخزون والدفعات
            </Link>
            <Link className="btn btn-soft" to="/app/movements">
              حركات المخزون (FEFO)
            </Link>
            <Link className="btn btn-soft" to="/app/alerts">
              التنبيهات ({alertCounts?.total ?? 0})
            </Link>
            <Link className="btn btn-ghost" to="/app/reports">
              التقارير
            </Link>
            <Link className="btn btn-ghost" to="/app/agent">
              الوكلاء الذكيون
            </Link>
          </div>
          {sweepStatus?.scheduler && (
            <p className="muted small" style={{ marginTop: '0.85rem', marginBottom: 0 }}>
              أتمتة الوكلاء (كل {sweepStatus.scheduler.intervalHours ?? 6} ساعات):{' '}
              {sweepStatus.latest?.audit?.agents
                ? `آخر فحص رصد ${sweepStatus.latest.audit.agents.inventory_agent?.alertsDetected ?? 0} تنبيهًا و${sweepStatus.latest.audit.agents.safety_agent?.inventoryConflictsCount ?? 0} تداخلًا دوائيًا.`
                : 'مفعّلة وجاهزة للفحص الدوري من صفحة الوكلاء.'}
            </p>
          )}
        </section>
      )}

      {isOwner && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">إدارة الموظفين</h2>
            <span className="badge badge-muted">{staff?.staff?.length ?? 0} حساب</span>
          </div>
          {staff?.error && <div className="alert alert-error">{staff.error}</div>}
          {error && <div className="alert alert-error">{error}</div>}
          {notice && <div className="alert alert-success">{notice}</div>}
          {staff?.staff?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الاسم</th>
                    <th>البريد</th>
                    <th>الدور</th>
                    <th>الحالة</th>
                    <th>إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.staff.map((member) => (
                    <tr key={member.id}>
                      <td>{member.fullName || '—'}</td>
                      <td dir="ltr">{member.email || '—'}</td>
                      <td>
                        {member.isSelf || member.role === 'owner' ? (
                          member.roleLabel
                        ) : (
                          <select
                            className="select"
                            style={{ minWidth: '140px', padding: '0.35rem 0.5rem' }}
                            value={member.role ?? 'pharmacist'}
                            disabled={updatingId === member.id}
                            onChange={(event) =>
                              handleStaffUpdate(
                                member.id,
                                { role: event.target.value },
                                `تم تحديث دور ${member.fullName || member.email} إلى ${roleLabel(event.target.value)}.`,
                              )
                            }
                          >
                            {SELF_REGISTER_ROLES.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <span className={member.linked ? 'badge' : 'badge badge-warn'}>
                          {member.linked ? 'مرتبط بالصيدلية' : 'بانتظار الربط'}
                        </span>
                      </td>
                      <td>
                        {member.isSelf || member.role === 'owner' ? (
                          <span className="muted small">—</span>
                        ) : !member.linked ? (
                          <button
                            className="btn btn-primary btn-sm"
                            type="button"
                            disabled={updatingId === member.id}
                            onClick={() =>
                              handleStaffUpdate(
                                member.id,
                                { linkToMyPharmacy: true },
                                `تم ربط ${member.fullName || member.email} بصيدليتك.`,
                              )
                            }
                          >
                            {updatingId === member.id ? 'جارٍ الربط…' : 'ربط بصيدليتي'}
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            disabled={updatingId === member.id}
                            onClick={() =>
                              handleStaffUpdate(
                                member.id,
                                { unlinkFromPharmacy: true },
                                `تم فك ربط ${member.fullName || member.email} من الصيدلية.`,
                              )
                            }
                          >
                            فك الربط
                          </button>
                        )}
                      </td>
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
    </div>
  );
}
