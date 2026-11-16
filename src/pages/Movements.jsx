import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';

const DEFAULT_TYPES = [
  { value: 'in', label: 'دخول' },
  { value: 'out', label: 'خروج' },
  { value: 'adjust', label: 'تعديل' },
  { value: 'waste', label: 'تلف' },
  { value: 'return', label: 'مرتجع' },
];

export default function Movements() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const canWrite = me?.role === 'owner' || me?.role === 'inventory_manager';

  const [data, setData] = useState(null);
  const [batches, setBatches] = useState([]);
  const [form, setForm] = useState({ batchId: '', type: 'out', quantity: '', note: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const [movementData, batchData] = await Promise.all([
        api.movements(token, '?limit=100'),
        api.batches(token).catch(() => ({ batches: [] })),
      ]);
      setData(movementData);
      setBatches(Array.isArray(batchData?.batches) ? batchData.batches : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(event) {
    event.preventDefault();
    if (!token || !form.batchId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.createMovement(token, {
        batchId: form.batchId,
        type: form.type,
        quantity: Number(form.quantity || 0),
        note: form.note.trim() || null,
      });
      setForm({ batchId: '', type: 'out', quantity: '', note: '' });
      setNotice('سُجّلت الحركة وتحدّثت كمية الدفعة.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const movements = Array.isArray(data?.movements) ? data.movements : [];
  const typeLabels = data?.typeLabels ?? {};
  const supportedTypes = Array.isArray(data?.supportedTypes) && data.supportedTypes.length
    ? data.supportedTypes
    : DEFAULT_TYPES.map((type) => type.value);

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <div>
            <h1 className="section-title">حركات المخزون</h1>
            <p className="muted small" style={{ margin: 0 }}>
              سجل stock_movements الفعلي. كل حركة تُحدّث كمية الدفعة داخل نفس العملية.
            </p>
          </div>
          <button className="btn btn-soft" type="button" onClick={load} disabled={busy}>
            {busy ? 'جارٍ التحديث…' : 'تحديث'}
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}
        {data?.quantityColumnPresent === false && (
          <div className="alert alert-warn">
            عمود الكمية غير موجود في stock_movements، لذلك لا يمكن تحديث الأرصدة تلقائيًا. الحركات تُسجّل فقط.
          </div>
        )}

        <div className="grid grid-3">
          <div className="stat">
            <span>عدد الحركات</span>
            <strong>{data?.totals?.count ?? movements.length}</strong>
          </div>
          <div className="stat">
            <span>دخول</span>
            <strong>{data?.totals?.in ?? 0}</strong>
          </div>
          <div className="stat">
            <span>خروج</span>
            <strong>{data?.totals?.out ?? 0}</strong>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">تسجيل حركة</h2>
        </div>
        <form className="form" onSubmit={submit}>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="mv-batch">الدفعة *</label>
              <select
                id="mv-batch"
                className="select"
                value={form.batchId}
                onChange={(event) => setForm({ ...form, batchId: event.target.value })}
                disabled={!canWrite || saving || !batches.length}
                required
              >
                <option value="">— اختر دفعة —</option>
                {batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.medicineName ?? batch.id} — {batch.batchNumber ?? 'بدون رقم'} ({batch.quantity ?? 0})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mv-type">النوع</label>
              <select
                id="mv-type"
                className="select"
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
                disabled={!canWrite || saving}
              >
                {supportedTypes.map((type) => (
                  <option key={type} value={type}>
                    {typeLabels[type] ?? type}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mv-quantity">الكمية *</label>
              <input
                id="mv-quantity"
                className="input"
                type="number"
                min="0"
                value={form.quantity}
                onChange={(event) => setForm({ ...form, quantity: event.target.value })}
                disabled={!canWrite || saving}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="mv-note">ملاحظة</label>
              <input
                id="mv-note"
                className="input"
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canWrite || saving || !form.batchId}>
              {saving ? 'جارٍ التسجيل…' : 'تسجيل'}
            </button>
          </div>
        </form>
        {!canWrite && (
          <div className="alert alert-warn" style={{ marginTop: '0.9rem' }}>
            العرض متاح للجميع، والتسجيل للمالك ومسؤول المخزون.
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">آخر الحركات</h2>
          <span className="badge badge-muted">{movements.length}</span>
        </div>
        {busy && !movements.length && <p className="muted small">جارٍ التحميل…</p>}
        {!busy && !movements.length && <p className="muted small">لا توجد حركات مسجّلة بعد.</p>}
        {movements.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الدفعة</th>
                  <th>الكمية</th>
                  <th>ملاحظة</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <td>{typeLabels[movement.type] ?? movement.type ?? '—'}</td>
                    <td>{movement.batchNumber ?? movement.batchId ?? '—'}</td>
                    <td>{movement.quantity ?? '—'}</td>
                    <td>{movement.note ?? '—'}</td>
                    <td>{formatDate(movement.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
