import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';

const EMPTY_MEDICINE = {
  name: '',
  scientificName: '',
  form: '',
  strength: '',
  unit: '',
  reorderLevel: '',
  barcode: '',
};

const EMPTY_BATCH = {
  medicineId: '',
  batchNumber: '',
  quantity: '',
  expiryDate: '',
  costPrice: '',
  sellingPrice: '',
};

const BUCKET_LABELS = {
  expired: 'منتهية',
  critical: 'أقل من 30 يومًا',
  warning: 'أقل من 90 يومًا',
  ok: 'سارية',
  unknown: 'بدون تاريخ',
};

export default function Inventory() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const canWrite = me?.role === 'owner' || me?.role === 'inventory_manager';

  const [medicines, setMedicines] = useState([]);
  const [batches, setBatches] = useState([]);
  const [medicineForm, setMedicineForm] = useState(EMPTY_MEDICINE);
  const [batchForm, setBatchForm] = useState(EMPTY_BATCH);
  const [adjust, setAdjust] = useState({ batchId: '', type: 'out', quantity: '', note: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const [medicineData, batchData] = await Promise.all([
        api.medicines(token),
        api.batches(token).catch((err) => ({ error: err.message, batches: [] })),
      ]);
      setMedicines(Array.isArray(medicineData?.medicines) ? medicineData.medicines : []);
      setBatches(Array.isArray(batchData?.batches) ? batchData.batches : []);
      if (batchData?.error) setError(batchData.error);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const medicineOptions = useMemo(
    () => medicines.map((medicine) => ({ value: medicine.id, label: medicine.name })),
    [medicines],
  );

  async function submitMedicine(event) {
    event.preventDefault();
    if (!token || !medicineForm.name.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.createMedicine(token, {
        name: medicineForm.name.trim(),
        scientificName: medicineForm.scientificName.trim() || null,
        form: medicineForm.form.trim() || null,
        strength: medicineForm.strength.trim() || null,
        unit: medicineForm.unit.trim() || null,
        barcode: medicineForm.barcode.trim() || null,
        reorderLevel: medicineForm.reorderLevel === '' ? null : Number(medicineForm.reorderLevel),
      });
      setMedicineForm(EMPTY_MEDICINE);
      setNotice('أُضيف الدواء إلى جدول medicines.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function submitBatch(event) {
    event.preventDefault();
    if (!token || !batchForm.medicineId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.createBatch(token, {
        medicineId: batchForm.medicineId,
        batchNumber: batchForm.batchNumber.trim() || null,
        quantity: Number(batchForm.quantity || 0),
        expiryDate: batchForm.expiryDate || null,
        costPrice: batchForm.costPrice === '' ? null : Number(batchForm.costPrice),
        sellingPrice: batchForm.sellingPrice === '' ? null : Number(batchForm.sellingPrice),
      });
      setBatchForm(EMPTY_BATCH);
      setNotice('أُضيفت الدفعة إلى inventory_batches.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function submitAdjust(event) {
    event.preventDefault();
    if (!token || !adjust.batchId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.batchMovement(token, adjust.batchId, {
        type: adjust.type,
        quantity: Number(adjust.quantity || 0),
        note: adjust.note.trim() || null,
      });
      setAdjust({ batchId: '', type: 'out', quantity: '', note: '' });
      setNotice('سُجّلت الحركة في stock_movements وحُدّثت كمية الدفعة.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <div>
            <h1 className="section-title">المخزون</h1>
            <p className="muted small" style={{ margin: 0 }}>
              كل الأرقام محسوبة من جداول medicines وinventory_batches الحالية. لا بيانات تجريبية.
            </p>
          </div>
          <button className="btn btn-soft" type="button" onClick={load} disabled={busy}>
            {busy ? 'جارٍ التحديث…' : 'تحديث'}
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}
        {!canWrite && (
          <div className="alert alert-warn">
            دورك ({me?.role ?? 'غير محدد'}) يسمح بالعرض فقط. الإضافة والتعديل متاحان للمالك ومسؤول المخزون.
          </div>
        )}
        <div className="grid grid-3">
          <div className="stat">
            <span>أصناف</span>
            <strong>{medicines.length}</strong>
          </div>
          <div className="stat">
            <span>دفعات</span>
            <strong>{batches.length}</strong>
          </div>
          <div className="stat">
            <span>وحدات متاحة</span>
            <strong>
              {medicines.reduce((total, medicine) => total + (Number(medicine.availableUnits) || 0), 0)}
            </strong>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">إضافة دواء</h2>
        </div>
        <form className="form" onSubmit={submitMedicine}>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="m-name">الاسم التجاري *</label>
              <input
                id="m-name"
                className="input"
                value={medicineForm.name}
                onChange={(event) => setMedicineForm({ ...medicineForm, name: event.target.value })}
                disabled={!canWrite || saving}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="m-scientific">الاسم العلمي</label>
              <input
                id="m-scientific"
                className="input"
                value={medicineForm.scientificName}
                onChange={(event) => setMedicineForm({ ...medicineForm, scientificName: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="m-form">الشكل الدوائي</label>
              <input
                id="m-form"
                className="input"
                value={medicineForm.form}
                onChange={(event) => setMedicineForm({ ...medicineForm, form: event.target.value })}
                placeholder="أقراص / شراب / كبسولات"
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="m-strength">التركيز</label>
              <input
                id="m-strength"
                className="input"
                value={medicineForm.strength}
                onChange={(event) => setMedicineForm({ ...medicineForm, strength: event.target.value })}
                placeholder="500 mg"
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="m-unit">الوحدة</label>
              <input
                id="m-unit"
                className="input"
                value={medicineForm.unit}
                onChange={(event) => setMedicineForm({ ...medicineForm, unit: event.target.value })}
                placeholder="علبة"
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="m-reorder">حد إعادة الطلب</label>
              <input
                id="m-reorder"
                className="input"
                type="number"
                min="0"
                value={medicineForm.reorderLevel}
                onChange={(event) => setMedicineForm({ ...medicineForm, reorderLevel: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canWrite || saving}>
              {saving ? 'جارٍ الحفظ…' : 'حفظ الدواء'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">الأدوية</h2>
          <span className="badge badge-muted">{medicines.length}</span>
        </div>
        {busy && !medicines.length && <p className="muted small">جارٍ التحميل…</p>}
        {!busy && !medicines.length && <p className="muted small">لا توجد أدوية مسجّلة بعد.</p>}
        {medicines.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>علمي</th>
                  <th>الشكل</th>
                  <th>المتاح</th>
                  <th>الحد</th>
                  <th>أقرب صلاحية</th>
                  <th>دفعات</th>
                </tr>
              </thead>
              <tbody>
                {medicines.map((medicine) => (
                  <tr key={medicine.id}>
                    <td>{medicine.name}</td>
                    <td>{medicine.scientificName ?? '—'}</td>
                    <td>{medicine.form ?? '—'}</td>
                    <td>{medicine.availableUnits ?? 0}</td>
                    <td>{medicine.reorderLevel ?? '—'}</td>
                    <td dir="ltr">{medicine.nearestExpiry ?? '—'}</td>
                    <td>{medicine.batchCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">إضافة دفعة (تشغيلة)</h2>
        </div>
        <form className="form" onSubmit={submitBatch}>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="b-medicine">الدواء *</label>
              <select
                id="b-medicine"
                className="select"
                value={batchForm.medicineId}
                onChange={(event) => setBatchForm({ ...batchForm, medicineId: event.target.value })}
                disabled={!canWrite || saving || !medicineOptions.length}
                required
              >
                <option value="">— اختر دواءً —</option>
                {medicineOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="b-number">رقم الدفعة</label>
              <input
                id="b-number"
                className="input"
                value={batchForm.batchNumber}
                onChange={(event) => setBatchForm({ ...batchForm, batchNumber: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="b-quantity">الكمية *</label>
              <input
                id="b-quantity"
                className="input"
                type="number"
                min="0"
                value={batchForm.quantity}
                onChange={(event) => setBatchForm({ ...batchForm, quantity: event.target.value })}
                disabled={!canWrite || saving}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="b-expiry">تاريخ الصلاحية</label>
              <input
                id="b-expiry"
                className="input"
                type="date"
                value={batchForm.expiryDate}
                onChange={(event) => setBatchForm({ ...batchForm, expiryDate: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="b-cost">سعر التكلفة</label>
              <input
                id="b-cost"
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={batchForm.costPrice}
                onChange={(event) => setBatchForm({ ...batchForm, costPrice: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="b-selling">سعر البيع</label>
              <input
                id="b-selling"
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={batchForm.sellingPrice}
                onChange={(event) => setBatchForm({ ...batchForm, sellingPrice: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canWrite || saving || !batchForm.medicineId}>
              {saving ? 'جارٍ الحفظ…' : 'حفظ الدفعة'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">الدفعات والصلاحية</h2>
          <span className="badge badge-muted">{batches.length}</span>
        </div>
        {!busy && !batches.length && <p className="muted small">لا توجد دفعات مسجّلة بعد.</p>}
        {batches.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الدواء</th>
                  <th>الدفعة</th>
                  <th>الكمية</th>
                  <th>الصلاحية</th>
                  <th>الحالة</th>
                  <th>الأيام</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.medicineName ?? '—'}</td>
                    <td>{batch.batchNumber ?? '—'}</td>
                    <td>{batch.quantity ?? 0}</td>
                    <td dir="ltr">{batch.expiryDate ?? '—'}</td>
                    <td>
                      <span
                        className={
                          batch.expiryBucket === 'expired'
                            ? 'badge badge-danger'
                            : batch.expiryBucket === 'critical' || batch.expiryBucket === 'warning'
                              ? 'badge badge-warn'
                              : 'badge badge-muted'
                        }
                      >
                        {BUCKET_LABELS[batch.expiryBucket] ?? batch.expiryBucket ?? '—'}
                      </span>
                    </td>
                    <td>{batch.daysToExpiry ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">تعديل كمية دفعة</h2>
        </div>
        <form className="form" onSubmit={submitAdjust}>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="a-batch">الدفعة *</label>
              <select
                id="a-batch"
                className="select"
                value={adjust.batchId}
                onChange={(event) => setAdjust({ ...adjust, batchId: event.target.value })}
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
              <label htmlFor="a-type">نوع الحركة</label>
              <select
                id="a-type"
                className="select"
                value={adjust.type}
                onChange={(event) => setAdjust({ ...adjust, type: event.target.value })}
                disabled={!canWrite || saving}
              >
                <option value="out">صرف / خروج</option>
                <option value="in">إضافة / دخول</option>
                <option value="adjust">جرد / تعديل</option>
                <option value="waste">تلف</option>
                <option value="return">مرتجع</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="a-quantity">الكمية *</label>
              <input
                id="a-quantity"
                className="input"
                type="number"
                min="0"
                value={adjust.quantity}
                onChange={(event) => setAdjust({ ...adjust, quantity: event.target.value })}
                disabled={!canWrite || saving}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="a-note">ملاحظة</label>
              <input
                id="a-note"
                className="input"
                value={adjust.note}
                onChange={(event) => setAdjust({ ...adjust, note: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canWrite || saving || !adjust.batchId}>
              {saving ? 'جارٍ التسجيل…' : 'تسجيل الحركة'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
