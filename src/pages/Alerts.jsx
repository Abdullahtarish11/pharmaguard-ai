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
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');

  const canResolve = me?.role === 'owner' || me?.role === 'pharmacist';

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

  async function resolveAlert(alertId) {
    if (!token || !alertId) return;
    try {
      await api.resolveAlert(token, alertId);
      await load();
    } catch (err) {
      setError(err.message);
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
          <h2 className="section-title">القائمة</h2>
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
                  <th />
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
                      {canResolve && alert.batchId ? (
                        <button
                          className="btn btn-ghost"
                          type="button"
                          onClick={() => resolveAlert(alert.batchId)}
                        >
                          تعليم كمقروء
                        </button>
                      ) : (
                        <span className="muted small">—</span>
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
          <h2 className="section-title">التنبيهات المحفوظة في الجدول</h2>
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
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {data.stored.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.type ?? '—'}</td>
                    <td>{item.message ?? '—'}</td>
                    <td>{formatDate(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">
            لا توجد سجلات محفوظة في inventory_alerts. التنبيهات أعلاه محسوبة لحظيًا من المخزون ولا تعتمد على وجود سجلات.
          </p>
        )}
      </section>
    </div>
  );
}
