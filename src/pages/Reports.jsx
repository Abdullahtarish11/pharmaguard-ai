import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';

const MOVEMENT_LABELS = {
  receive: 'استلام',
  dispense: 'صرف',
  adjust: 'تعديل',
  write_off: 'إتلاف',
  return: 'إرجاع',
};

export default function Reports() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const [data, setData] = useState(null);
  const [saved, setSaved] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const canSave = me?.role === 'owner' || me?.role === 'pharmacist';

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const [summary, list] = await Promise.all([
        api.reportSummary(token),
        api.reports(token).catch((err) => ({ error: err.message, reports: [] })),
      ]);
      setData(summary);
      setSaved(list);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveReport() {
    if (!token) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveReport(token);
      setNotice(`تم حفظ لقطة التقرير${result?.id ? ` (${result.id})` : ''}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const summary = data?.summary;
  const lowStock = Array.isArray(summary?.lowStock) ? summary.lowStock : [];
  const expiring = Array.isArray(summary?.expiring) ? summary.expiring : [];
  const movementsByType = summary?.movementsByType ?? {};
  const typeLabels = { ...MOVEMENT_LABELS, ...(data?.typeLabels ?? {}) };
  const activeErrors = Object.entries(data?.dataErrors ?? {}).filter(([, value]) => Boolean(value));

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <div>
            <h1 className="section-title">التقارير</h1>
            <p className="muted small" style={{ margin: 0 }}>
              {data?.generatedFrom ?? 'أرقام محسوبة من جداول قاعدة بياناتك الحالية.'}
            </p>
          </div>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button className="btn btn-soft" type="button" onClick={load} disabled={busy}>
              {busy ? 'جارٍ الحساب…' : 'تحديث'}
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => window.print()} disabled={!summary}>
              طباعة / PDF
            </button>
            {canSave && (
              <button className="btn btn-primary" type="button" onClick={saveReport} disabled={saving || !summary}>
                {saving ? 'جارٍ الحفظ…' : 'حفظ لقطة'}
              </button>
            )}
          </div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}
        {activeErrors.length > 0 && (
          <div className="alert alert-warn">
            تعذر قراءة بعض الجداول: {activeErrors.map(([key, value]) => `${key}: ${value}`).join(' • ')}
          </div>
        )}

        {!summary && busy && <p className="muted small">جارٍ التحميل…</p>}

        {summary && (
          <div className="grid grid-3" style={{ marginTop: '0.6rem' }}>
            <div className="stat">
              <span>الأدوية</span>
              <strong>{summary.counts?.medicines ?? 0}</strong>
              <span className="hint">نشط: {summary.counts?.activeMedicines ?? 0}</span>
            </div>
            <div className="stat">
              <span>الدفعات</span>
              <strong>{summary.counts?.batches ?? 0}</strong>
              <span className="hint">حركات: {summary.counts?.movements ?? 0}</span>
            </div>
            <div className="stat">
              <span>الوحدات القابلة للصرف</span>
              <strong>{summary.units?.sellable ?? 0}</strong>
              <span className="hint">منتهية: {summary.units?.expired ?? 0}</span>
            </div>
            <div className="stat">
              <span>قيمة المخزون (تكلفة)</span>
              <strong>{summary.value?.cost ?? 0}</strong>
            </div>
            <div className="stat">
              <span>قيمة المخزون (بيع)</span>
              <strong>{summary.value?.selling ?? 0}</strong>
            </div>
            <div className="stat">
              <span>التنبيهات</span>
              <strong>{data?.alertCounts?.total ?? 0}</strong>
              <span className="hint">حرجة: {data?.alertCounts?.high ?? 0}</span>
            </div>
          </div>
        )}
      </section>

      <section className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2 className="section-title">أدوية تحت حد إعادة الطلب</h2>
            <span className="badge badge-muted">{lowStock.length}</span>
          </div>
          {lowStock.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الدواء</th>
                    <th>المتاح</th>
                    <th>الحد</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStock.map((row) => (
                    <tr key={row.medicineId}>
                      <td>{row.name}</td>
                      <td>{row.units}</td>
                      <td>{row.reorderLevel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">لا توجد أصناف عند حد إعادة الطلب.</p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2 className="section-title">دفعات قاربت الانتهاء</h2>
            <span className="badge badge-muted">{expiring.length}</span>
          </div>
          {expiring.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الدواء</th>
                    <th>الدفعة</th>
                    <th>الكمية</th>
                    <th>الصلاحية</th>
                    <th>الأيام</th>
                  </tr>
                </thead>
                <tbody>
                  {expiring.map((row) => (
                    <tr key={row.batchId}>
                      <td>{row.medicineName ?? '—'}</td>
                      <td>{row.batchNumber ?? row.batchId}</td>
                      <td>{row.quantity}</td>
                      <td dir="ltr">{row.expiryDate}</td>
                      <td>{row.daysToExpiry}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">لا توجد دفعات تنتهي خلال 90 يومًا.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">الحركات حسب النوع</h2>
        </div>
        {Object.keys(movementsByType).length ? (
          <div className="pill-list">
            {Object.entries(movementsByType).map(([type, total]) => (
              <span className="pill" key={type}>
                {typeLabels[type] ?? type}: {total}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted small">لا توجد حركات مخزون مسجّلة بعد.</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">اللقطات المحفوظة</h2>
          <span className="badge badge-muted">{saved?.reports?.length ?? 0}</span>
        </div>
        {saved?.error && <div className="alert alert-warn">{saved.error}</div>}
        {saved?.reports?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>العنوان</th>
                  <th>النوع</th>
                  <th>التاريخ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {saved.reports.map((report) => (
                  <tr key={report.id}>
                    <td>{report.title ?? '—'}</td>
                    <td>{report.type === 'inventory_snapshot' ? 'لقطة مخزون' : report.type ?? '—'}</td>
                    <td>{formatDate(report.createdAt)}</td>
                    <td>
                      <button
                        className="btn btn-soft btn-sm"
                        type="button"
                        onClick={() => setSelectedReport(report)}
                      >
                        عرض التفاصيل
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">لا توجد لقطات محفوظة. زر «حفظ لقطة» يضيف سجلًا في جدول reports فقط.</p>
        )}
      </section>

      {selectedReport && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تفاصيل اللقطة المحفوظة">
          <div className="modal-card">
            <h3 className="section-title">{selectedReport.title ?? 'تفاصيل التقرير'}</h3>
            <p className="muted small">التاريخ: {formatDate(selectedReport.createdAt)}</p>
            {selectedReport.payload?.summary ? (
              <div className="grid grid-2" style={{ marginBottom: '1rem' }}>
                <div className="stat">
                  <span>الأدوية / الدفعات</span>
                  <strong>
                    {selectedReport.payload.summary.counts?.medicines ?? 0} /{' '}
                    {selectedReport.payload.summary.counts?.batches ?? 0}
                  </strong>
                </div>
                <div className="stat">
                  <span>الوحدات الصالحة</span>
                  <strong>{selectedReport.payload.summary.units?.sellable ?? 0}</strong>
                </div>
                <div className="stat">
                  <span>التكلفة</span>
                  <strong>{selectedReport.payload.summary.value?.cost ?? 0}</strong>
                </div>
                <div className="stat">
                  <span>البيع</span>
                  <strong>{selectedReport.payload.summary.value?.selling ?? 0}</strong>
                </div>
              </div>
            ) : (
              <pre className="code">{JSON.stringify(selectedReport.payload ?? {}, null, 2)}</pre>
            )}
            <div className="btn-row">
              <button className="btn btn-primary" type="button" onClick={() => setSelectedReport(null)}>
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
