import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';

const SEVERITY_LABELS = { high: 'حرج', medium: 'متوسط', low: 'منخفض' };
const TYPE_LABELS = {
  out_of_stock: 'نفاد المخزون',
  low_stock: 'كمية منخفضة',
  expired_batch: 'دفعة منتهية',
  expiring_soon: 'قرب انتهاء',
};

export default function Alerts() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resolvingKey, setResolvingKey] = useState(null);
  const [filter, setFilter] = useState('all');

  // متطابق مع server/routes/alerts.js و supabase/apply_all.sql
  const canResolve = me?.role === 'owner' || me?.role === 'pharmacist' || me?.role === 'inventory_manager';

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setData(await api.alerts(token));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  const visible = filter === 'all' ? alerts : alerts.filter((alert) => alert.severity === filter);
  const counts = useMemo(
    () => ({
      high: alerts.filter((alert) => alert.severity === 'high').length,
      medium: alerts.filter((alert) => alert.severity === 'medium').length,
      low: alerts.filter((alert) => alert.severity === 'low').length,
    }),
    [alerts],
  );

  async function resolveLiveAlert(alert) {
    if (!token || !alert) return;
    setResolvingKey(alert.key);
    setError(null);
    setNotice(null);
    try {
      if (alert.storedId) {
        await api.resolveAlert(token, alert.storedId);
      } else {
        await api.resolveComputedAlert(token, {
          key: alert.key,
          type: alert.type,
          severity: alert.severity,
          message: alert.message,
          medicineId: alert.medicineId ?? null,
          batchId: alert.batchId ?? null,
        });
      }
      setNotice('تم تعليم التنبيه كمحلول في سجل التنبيهات.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setResolvingKey(null);
    }
  }

  async function resolveStoredAlert(itemId) {
    if (!token || !itemId) return;
    setResolvingKey(itemId);
    setError(null);
    setNotice(null);
    try {
      await api.resolveAlert(token, itemId);
      setNotice('تم إغلاق التنبيه المحفوظ.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setResolvingKey(null);
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <div>
            <h1 className="section-title">التنبيهات</h1>
            <p className="muted small" style={{ margin: 0 }}>
              تُحسب من كميات الدفعات وتواريخ صلاحيتها الفعلية في قاعدة بياناتك فقط.
            </p>
          </div>
          <button className="btn btn-soft" type="button" onClick={load} disabled={busy}>
            {busy ? 'جارٍ التحديث…' : 'تحديث'}
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        <div className="grid grid-3">
          <div className="stat">
            <span>حرجة</span>
            <strong>{counts.high}</strong>
          </div>
          <div className="stat">
            <span>متوسطة</span>
            <strong>{counts.medium}</strong>
          </div>
          <div className="stat">
            <span>الإجمالي</span>
            <strong>{alerts.length}</strong>
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: '0.9rem' }}>
          <button
            className={filter === 'all' ? 'btn btn-primary' : 'btn btn-ghost'}
            type="button"
            onClick={() => setFilter('all')}
          >
            الكل
          </button>
          <button
            className={filter === 'high' ? 'btn btn-primary' : 'btn btn-ghost'}
            type="button"
            onClick={() => setFilter('high')}
          >
            حرجة
          </button>
          <button
            className={filter === 'medium' ? 'btn btn-primary' : 'btn btn-ghost'}
            type="button"
            onClick={() => setFilter('medium')}
          >
            متوسطة
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">التنبيهات اللحظية</h2>
          <span className="badge badge-muted">{visible.length} تنبيه</span>
        </div>

        {busy && !data && <p className="muted small">جارٍ التحميل…</p>}
        {!busy && data?.note && <div className="alert alert-success">{data.note}</div>}
        {!busy && !visible.length && !data?.note && (
          <p className="muted small">لا توجد تنبيهات مطابقة للتصفية الحالية.</p>
        )}

        {visible.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الرسالة</th>
                  <th>الخطورة</th>
                  <th>الوحدات</th>
                  <th>الحالة / إجراء</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((alert) => (
                  <tr key={alert.key}>
                    <td>{TYPE_LABELS[alert.type] ?? alert.type}</td>
                    <td>{alert.message}</td>
                    <td>
                      <span
                        className={
                          alert.severity === 'high'
                            ? 'badge badge-danger'
                            : alert.severity === 'medium'
                              ? 'badge badge-warn'
                              : 'badge badge-muted'
                        }
                      >
                        {SEVERITY_LABELS[alert.severity] ?? alert.severity}
                      </span>
                    </td>
                    <td>{alert.units ?? '—'}</td>
                    <td>
                      {alert.resolved ? (
                        <span className="badge">تمت المعالجة ✓</span>
                      ) : canResolve ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={resolvingKey === alert.key}
                          onClick={() => resolveLiveAlert(alert)}
                        >
                          {resolvingKey === alert.key ? 'جارٍ الإغلاق…' : 'تعليم كمحلول'}
                        </button>
                      ) : (
                        <span className="muted small">للمخولين بالصيدلية</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">سجل التنبيهات في inventory_alerts</h2>
          <span className="badge badge-muted">{data?.stored?.items?.length ?? 0}</span>
        </div>
        {data?.stored?.error && <div className="alert alert-warn">{data.stored.error}</div>}
        {data?.stored?.items?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الرسالة</th>
                  <th>الحالة</th>
                  <th>التاريخ</th>
                  {canResolve && <th />}
                </tr>
              </thead>
              <tbody>
                {data.stored.items.map((item) => (
                  <tr key={item.id}>
                    <td>{TYPE_LABELS[item.type] ?? item.type ?? '—'}</td>
                    <td>{item.message ?? '—'}</td>
                    <td>
                      <span className={item.resolved ? 'badge' : 'badge badge-warn'}>
                        {item.resolved ? 'محلول' : 'نشط'}
                      </span>
                    </td>
                    <td>{formatDate(item.createdAt)}</td>
                    {canResolve && (
                      <td>
                        {!item.resolved ? (
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            disabled={resolvingKey === item.id}
                            onClick={() => resolveStoredAlert(item.id)}
                          >
                            {resolvingKey === item.id ? 'جارٍ الإغلاق…' : 'إغلاق'}
                          </button>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">
            لا توجد سجلات محفوظة في inventory_alerts. التنبيهات أعلاه محسوبة لحظيًا من المخزون.
          </p>
        )}
      </section>
    </div>
  );
}
