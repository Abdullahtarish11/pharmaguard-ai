import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EXPIRY_SEVERITY_META, buildExpiryAlertItems } from '../expiryAlerts.js';

function formatDaysLabel(item) {
  if (typeof item.daysToExpiry !== 'number') return item.expiryDate || '—';
  if (item.daysToExpiry < 0) return `منتهٍ منذ ${Math.abs(item.daysToExpiry)} يومًا`;
  if (item.daysToExpiry === 0) return 'ينتهي اليوم';
  if (item.daysToExpiry === 1) return 'ينتهي غدًا';
  return `باقي ${item.daysToExpiry} يومًا`;
}

export default function ExpiryAlertsPanel({ summary, alerts = [], loading = false, onRefresh }) {
  const [filter, setFilter] = useState('all');

  const { items, counts } = useMemo(() => buildExpiryAlertItems({ summary, alerts }), [summary, alerts]);

  const visibleItems = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((item) => item.level === filter);
  }, [items, filter]);

  const badgeClassFor = (level) => {
    if (level === 'expired') return 'badge badge-danger';
    if (level === 'critical') return 'badge badge-critical';
    return 'badge badge-warn';
  };

  return (
    <section className="card expiry-panel" aria-label="التنبيه التلقائي لصلاحية الأدوية">
      <div className="card-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span
              className={
                counts.expired > 0 ? 'dot-danger' : counts.critical > 0 || counts.warning > 0 ? 'dot-warn' : 'dot-online'
              }
              aria-hidden="true"
            />
            <h2 className="section-title" style={{ margin: 0 }}>
              التنبيه التلقائي لصلاحية الأدوية
            </h2>
            <span className="badge badge-muted">تحديث تلقائي</span>
          </div>
          <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
            قائمة فورية بالأدوية والدفعات المنتهية أو القريبة من الانتهاء خلال 90 يومًا ملوّنة حسب درجة الخطورة.
          </p>
        </div>

        <div className="btn-row" style={{ marginTop: 0 }}>
          {onRefresh && (
            <button className="btn btn-soft btn-sm" type="button" onClick={onRefresh} disabled={loading}>
              {loading ? 'جارٍ الفحص…' : 'فحص الآن'}
            </button>
          )}
          <Link className="btn btn-ghost btn-sm" to="/app/alerts">
            صفحة التنبيهات
          </Link>
        </div>
      </div>

      <div className="expiry-filters" role="group" aria-label="تصفية حسب شدة التنبيه">
        <button
          type="button"
          className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setFilter('all')}
        >
          الكل ({counts.total})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${filter === 'expired' ? 'btn-soft' : 'btn-ghost'}`}
          onClick={() => setFilter('expired')}
        >
          <span className="dot-danger" /> منتهٍ ({counts.expired})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${filter === 'critical' ? 'btn-soft' : 'btn-ghost'}`}
          onClick={() => setFilter('critical')}
        >
          <span className="dot-critical" /> حرج ≤ 30 يومًا ({counts.critical})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${filter === 'warning' ? 'btn-soft' : 'btn-ghost'}`}
          onClick={() => setFilter('warning')}
        >
          <span className="dot-warn" /> قريب ≤ 90 يومًا ({counts.warning})
        </button>
      </div>

      {loading && items.length === 0 ? (
        <p className="muted small" style={{ margin: '0.75rem 0 0' }}>
          جارٍ فحص تواريخ صلاحية الدفعات…
        </p>
      ) : counts.total === 0 ? (
        <div className="alert alert-success" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          لا توجد أدوية منتهية أو قريبة من الانتهاء خلال الـ 90 يومًا القادمة وفق بيانات الدفعات المسجّلة.
        </div>
      ) : visibleItems.length === 0 ? (
        <p className="muted small" style={{ margin: '0.75rem 0 0' }}>
          لا توجد أدوية ضمن فئة التنبيه المحددة حاليًا.
        </p>
      ) : (
        <div className="expiry-alert-list">
          {visibleItems.map((item) => {
            const meta = EXPIRY_SEVERITY_META[item.level] ?? EXPIRY_SEVERITY_META.warning;
            return (
              <div key={item.id} className={`expiry-item expiry-item-${item.level}`}>
                <div className="expiry-item-main">
                  <div className="expiry-item-title-row">
                    <strong className={`expiry-name expiry-name-${item.level}`}>{item.medicineName}</strong>
                    <span className={badgeClassFor(item.level)}>{meta.label}</span>
                  </div>
                  <div className="expiry-item-meta small">
                    <span>دفعة: {item.batchNumber}</span>
                    <span>الكمية: {item.quantity} وحدة</span>
                    <span dir="ltr">{item.expiryDate ?? '—'}</span>
                    <strong>{formatDaysLabel(item)}</strong>
                  </div>
                </div>
                <div className="expiry-item-side">
                  <span className="small muted">{meta.action}</span>
                  <Link className="btn btn-ghost btn-sm" to="/app/inventory">
                    عرض بالمخزون
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
