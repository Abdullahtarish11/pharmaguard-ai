import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';

const DEFAULT_TYPES = [
  { value: 'receive', label: 'استلام' },
  { value: 'dispense', label: 'صرف' },
  { value: 'adjust', label: 'تعديل' },
  { value: 'write_off', label: 'إتلاف' },
  { value: 'return', label: 'إرجاع' },
];

const DEFAULT_TYPE_LABELS = Object.fromEntries(DEFAULT_TYPES.map((item) => [item.value, item.label]));

const EMPTY_FORM = {
  mode: 'fefo',
  medicineId: '',
  batchId: '',
  type: 'dispense',
  quantity: '',
  note: '',
};

export default function Movements() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const canWrite = me?.role === 'owner' || me?.role === 'pharmacist' || me?.role === 'inventory_manager';

  const [data, setData] = useState(null);
  const [batches, setBatches] = useState([]);
  const [medicines, setMedicines] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (typeFilter) params.set('type', typeFilter);

      const [movementData, batchData, medicineData] = await Promise.all([
        api.movements(token, `?${params.toString()}`),
        api.batches(token).catch(() => ({ batches: [] })),
        api.medicines(token).catch(() => ({ medicines: [] })),
      ]);
      setData(movementData);
      setBatches(Array.isArray(batchData?.batches) ? batchData.batches : []);
      setMedicines(Array.isArray(medicineData?.medicines) ? medicineData.medicines : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [token, typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const isFefoDispense = form.type === 'dispense' && form.mode === 'fefo';

  async function submit(event) {
    event.preventDefault();
    if (!token) return;
    if (isFefoDispense && !form.medicineId) return;
    if (!isFefoDispense && !form.batchId) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = isFefoDispense
        ? {
            medicineId: form.medicineId,
            type: 'dispense',
            quantity: Number(form.quantity || 0),
            note: form.note.trim() || null,
          }
        : {
            batchId: form.batchId,
            type: form.type,
            quantity: Number(form.quantity || 0),
            note: form.note.trim() || null,
          };

      const result = await api.createMovement(token, payload);
      setForm((prev) => ({ ...EMPTY_FORM, mode: prev.mode, type: prev.type }));
      if (result?.mode === 'fefo' && Array.isArray(result.allocations)) {
        const summary = result.allocations
          .map((alloc) => `${alloc.batchNumber ?? alloc.batchId}: ${alloc.take}`)
          .join(' • ');
        setNotice(`تم الصرف وفق FEFO عبر ${result.allocations.length} دفعة (${summary}).`);
      } else {
        setNotice('سُجّلت الحركة وتحدّثت كمية الدفعة.');
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const movements = Array.isArray(data?.movements) ? data.movements : [];
  const typeLabels = { ...DEFAULT_TYPE_LABELS, ...(data?.typeLabels ?? {}) };
  const supportedTypes =
    Array.isArray(data?.supportedTypes) && data.supportedTypes.length
      ? data.supportedTypes
      : DEFAULT_TYPES.map((type) => type.value);

  const totals = data?.totals ?? {};
  const inboundTotal =
    totals.inbound ??
    (totals.receive ?? 0) + (totals.return ?? 0) + (totals.in ?? 0) + (totals.adjust_in ?? 0);
  const outboundTotal =
    totals.outbound ??
    (totals.dispense ?? 0) + (totals.adjust ?? 0) + (totals.write_off ?? 0) + (totals.out ?? 0) + (totals.waste ?? 0);

  const canSubmit = !saving && canWrite && (isFefoDispense ? Boolean(form.medicineId) : Boolean(form.batchId));

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <div>
            <h1 className="section-title">حركات المخزون</h1>
            <p className="muted small" style={{ margin: 0 }}>
              سجل stock_movements الفعلي. الصرف يطبّق قاعدة FEFO (الأقرب انتهاءً أولًا) ويمنع الكميات السالبة.
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
            <strong>{totals.count ?? movements.length}</strong>
          </div>
          <div className="stat">
            <span>إجمالي الوارد</span>
            <strong>{inboundTotal}</strong>
          </div>
          <div className="stat">
            <span>إجمالي الصادر</span>
            <strong>{outboundTotal}</strong>
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

            {form.type === 'dispense' && (
              <div className="field">
                <label htmlFor="mv-mode">طريقة الصرف</label>
                <select
                  id="mv-mode"
                  className="select"
                  value={form.mode}
                  onChange={(event) => setForm({ ...form, mode: event.target.value })}
                  disabled={!canWrite || saving}
                >
                  <option value="fefo">صرف تلقائي حسب FEFO (على مستوى الدواء)</option>
                  <option value="batch">اختيار دفعة محددة (مع فحص FEFO)</option>
                </select>
              </div>
            )}

            {isFefoDispense ? (
              <div className="field">
                <label htmlFor="mv-medicine">الدواء *</label>
                <select
                  id="mv-medicine"
                  className="select"
                  value={form.medicineId}
                  onChange={(event) => setForm({ ...form, medicineId: event.target.value })}
                  disabled={!canWrite || saving || !medicines.length}
                  required
                >
                  <option value="">— اختر دواءً —</option>
                  {medicines.map((medicine) => (
                    <option key={medicine.id} value={medicine.id}>
                      {medicine.name} (متاح: {medicine.availableUnits ?? 0})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
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
                      {batch.medicineName ?? batch.id} — {batch.batchNumber ?? 'بدون رقم'} ({batch.quantity ?? 0}) —{' '}
                      {batch.expiryDate ?? 'بلا تاريخ'}
                      {batch.isFefoNext ? ' [FEFO]' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor="mv-quantity">الكمية *</label>
              <input
                id="mv-quantity"
                className="input"
                type="number"
                min="1"
                step="1"
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
            <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
              {saving ? 'جارٍ التسجيل…' : 'تسجيل'}
            </button>
          </div>
        </form>
        {!canWrite && (
          <div className="alert alert-warn" style={{ marginTop: '0.9rem' }}>
            العرض والتسجيل متاحان للمالك والصيدلي ومسؤول المخزون.
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">آخر الحركات</h2>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <select
              className="select"
              style={{ width: 'auto', padding: '0.35rem 0.6rem' }}
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="">كل الأنواع</option>
              {supportedTypes.map((type) => (
                <option key={type} value={type}>
                  {typeLabels[type] ?? type}
                </option>
              ))}
            </select>
            <span className="badge badge-muted">{movements.length}</span>
          </div>
        </div>
        {busy && !movements.length && <p className="muted small">جارٍ التحميل…</p>}
        {!busy && !movements.length && <p className="muted small">لا توجد حركات مسجّلة بعد.</p>}
        {movements.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الدواء</th>
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
                    <td>{movement.medicineName ?? '—'}</td>
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
