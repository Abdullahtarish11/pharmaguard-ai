import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import BarcodeScannerModal from '../components/BarcodeScannerModal.jsx';
import { findMedicineByBarcode, parseBarcodePayload, pickFefoBatchForMedicine } from '../barcode.js';
import {
  PDF_INTERACTIONS,
  PDF_MEDICINES,
  buildMedicinesCsvTemplate,
  parseCatalogText,
} from '../catalogImport.js';

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
  const canWrite = me?.role === 'owner' || me?.role === 'pharmacist' || me?.role === 'inventory_manager';
  const canImportClinical = me?.role === 'owner' || me?.role === 'pharmacist';

  const [medicines, setMedicines] = useState([]);
  const [batches, setBatches] = useState([]);
  const [supportsBatchArchive, setSupportsBatchArchive] = useState(false);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [medicineForm, setMedicineForm] = useState(EMPTY_MEDICINE);
  const [batchForm, setBatchForm] = useState(EMPTY_BATCH);
  const [adjust, setAdjust] = useState({ batchId: '', type: 'dispense', quantity: '', note: '' });
  const [editingMedicine, setEditingMedicine] = useState(null);
  const [editingBatch, setEditingBatch] = useState(null);
  const [scanModalMode, setScanModalMode] = useState(null);
  const [quickScanInput, setQuickScanInput] = useState('');
  const [scanMatch, setScanMatch] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);

  const medSectionRef = useRef(null);
  const medNameInputRef = useRef(null);
  const batchSectionRef = useRef(null);
  const batchQtyInputRef = useRef(null);
  const adjustSectionRef = useRef(null);
  const adjustQtyInputRef = useRef(null);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (includeInactive) params.set('includeInactive', 'true');
      const medQuery = params.toString() ? `?${params.toString()}` : '';

      const batchQuery = includeInactive ? '?includeInactive=true' : '';

      const [medicineData, batchData] = await Promise.all([
        api.medicines(token, medQuery),
        api.batches(token, batchQuery).catch((err) => ({ error: err.message, batches: [] })),
      ]);
      setMedicines(Array.isArray(medicineData?.medicines) ? medicineData.medicines : []);
      setBatches(Array.isArray(batchData?.batches) ? batchData.batches : []);
      setSupportsBatchArchive(Boolean(batchData?.supportsArchive));
      if (batchData?.error) setError(batchData.error);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [token, search, includeInactive]);

  useEffect(() => {
    load();
  }, [load]);

  const medicineOptions = useMemo(
    () => medicines.filter((m) => m.isActive !== false).map((medicine) => ({ value: medicine.id, label: medicine.name })),
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

  async function runCatalogImport({ meds = [], interactions = [], label = 'قاعدة البيانات' }) {
    if (!token) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const parts = [];
      if (meds.length > 0 && canWrite) {
        const medRes = await api.importMedicines(token, meds);
        parts.push(
          `الأدوية: أُضيف ${medRes.insertedCount ?? 0}${medRes.skippedCount ? ` وتُخطّي ${medRes.skippedCount} مكرر` : ''}`,
        );
      }
      if (interactions.length > 0 && canImportClinical) {
        const ddiRes = await api.importInteractions(token, interactions);
        parts.push(
          `التداخلات: أُضيف ${ddiRes.insertedCount ?? 0}${ddiRes.skippedCount ? ` وتُخطّي ${ddiRes.skippedCount} مكرر` : ''}`,
        );
      }
      if (parts.length === 0) {
        setError('لا توجد صفوف صالحة للاستيراد أو أن دورك لا يملك صلاحية استيراد هذا النوع.');
        return;
      }
      setNotice(`اكتمل استيراد ${label} — ${parts.join(' • ')}.`);
      setImportPreview(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  }

  async function handleCatalogFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseCatalogText(text);
      if (parsed.medicines.length === 0 && parsed.interactions.length === 0) {
        setError('تعذر قراءة صفوف صالحة من الملف. تأكد أن الأعمدة مطابقة للقالب (CSV أو JSON).');
        setImportPreview(null);
        return;
      }
      setImportPreview({
        fileName: file.name,
        medicines: parsed.medicines,
        interactions: parsed.interactions,
      });
    } catch (err) {
      setError(`تعذر تحليل الملف: ${err.message}`);
      setImportPreview(null);
    }
  }

  function downloadCsvTemplate() {
    const csv = `\uFEFF${buildMedicinesCsvTemplate()}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pharmaguard-medicines-template.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function saveMedicineEdit(event) {
    event.preventDefault();
    if (!token || !editingMedicine?.id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateMedicine(token, editingMedicine.id, {
        name: editingMedicine.name.trim(),
        scientificName: editingMedicine.scientificName ?? '',
        form: editingMedicine.form ?? '',
        strength: editingMedicine.strength ?? '',
        unit: editingMedicine.unit ?? '',
        barcode: editingMedicine.barcode ?? '',
        reorderLevel:
          editingMedicine.reorderLevel === '' || editingMedicine.reorderLevel === null
            ? undefined
            : Number(editingMedicine.reorderLevel),
        isActive: editingMedicine.isActive !== false,
      });
      setEditingMedicine(null);
      setNotice('تم تحديث بيانات الدواء.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchiveMedicine(medicine) {
    if (!token || !medicine?.id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const nextActive = medicine.isActive === false;
      await api.updateMedicine(token, medicine.id, { isActive: nextActive });
      setNotice(nextActive ? `تمت استعادة «${medicine.name}».` : `تمت أرشفة «${medicine.name}».`);
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

  async function saveBatchEdit(event) {
    event.preventDefault();
    if (!token || !editingBatch?.id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateBatch(token, editingBatch.id, {
        batchNumber: editingBatch.batchNumber?.trim(),
        expiryDate: editingBatch.expiryDate,
        costPrice: editingBatch.costPrice === '' || editingBatch.costPrice === null ? undefined : Number(editingBatch.costPrice),
        sellingPrice:
          editingBatch.sellingPrice === '' || editingBatch.sellingPrice === null ? undefined : Number(editingBatch.sellingPrice),
      });
      setEditingBatch(null);
      setNotice('تم تحديث بيانات الدفعة.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchiveBatch(batch) {
    if (!token || !batch?.id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const nextActive = batch.isActive === false;
      await api.updateBatch(token, batch.id, { isActive: nextActive });
      setNotice(
        nextActive
          ? `تمت استعادة الدفعة «${batch.batchNumber ?? batch.id}».`
          : `تمت أرشفة الدفعة «${batch.batchNumber ?? batch.id}».`,
      );
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
      setAdjust({ batchId: '', type: 'dispense', quantity: '', note: '' });
      setNotice('سُجّلت الحركة في stock_movements وحُدّثت كمية الدفعة.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const handleScannedCode = useCallback(
    async (rawCode, mode = scanModalMode || 'quick') => {
      const parsed = parseBarcodePayload(rawCode);
      setScanModalMode(null);
      if (!parsed.barcode) {
        setError('لم يُقرأ رمز باركود صالح.');
        return;
      }

      setError(null);

      if (mode === 'new_medicine') {
        setMedicineForm((prev) => ({ ...prev, barcode: parsed.barcode }));
        if (parsed.batchNumber || parsed.expiryDate) {
          setBatchForm((prev) => ({
            ...prev,
            batchNumber: parsed.batchNumber ?? prev.batchNumber,
            expiryDate: parsed.expiryDate ?? prev.expiryDate,
          }));
        }
        setNotice(
          parsed.format === 'gs1'
            ? `تمت قراءة GS1: الباركود ${parsed.barcode}${parsed.batchNumber ? ` — دفعة ${parsed.batchNumber}` : ''}${parsed.expiryDate ? ` — صلاحية ${parsed.expiryDate}` : ''}.`
            : `تمت تعبئة الباركود (${parsed.barcode}) في نموذج الدواء.`,
        );
        setTimeout(() => medNameInputRef.current?.focus(), 60);
        return;
      }

      if (mode === 'edit_medicine') {
        setEditingMedicine((prev) => (prev ? { ...prev, barcode: parsed.barcode } : prev));
        setNotice(`تم تحديث باركود التعديل إلى ${parsed.barcode}.`);
        return;
      }

      // وضع المسح السريع: ابحث في القائمة المحملة أولًا ثم في السيرفر إذا كان هناك فلتر بحث نشط
      let matchedMed = findMedicineByBarcode(medicines, parsed);
      if (!matchedMed && token && search.trim()) {
        try {
          const allData = await api.medicines(token, '?includeInactive=true');
          matchedMed = findMedicineByBarcode(allData?.medicines ?? [], parsed);
        } catch {
          // ignore fallback search failure
        }
      }

      if (matchedMed) {
        const fefoBatch = pickFefoBatchForMedicine(batches, matchedMed.id);
        setScanMatch({ parsed, medicine: matchedMed, fefoBatch });

        if (canWrite) {
          if (fefoBatch) {
            setAdjust((prev) => ({ ...prev, batchId: fefoBatch.id, type: 'dispense' }));
          }
          setBatchForm((prev) => ({
            ...prev,
            medicineId: matchedMed.id,
            batchNumber: parsed.batchNumber ?? prev.batchNumber,
            expiryDate: parsed.expiryDate ?? prev.expiryDate,
          }));
        }

        setNotice(
          `تم التعرف على «${matchedMed.name}» بالباركود ${parsed.barcode}${
            fefoBatch ? ` — أول دفعة FEFO: ${fefoBatch.batchNumber ?? fefoBatch.id}` : ''
          }.`,
        );
      } else {
        setScanMatch({ parsed, medicine: null, fefoBatch: null });
        if (canWrite) {
          setMedicineForm((prev) => ({ ...prev, barcode: parsed.barcode }));
          if (parsed.batchNumber || parsed.expiryDate) {
            setBatchForm((prev) => ({
              ...prev,
              batchNumber: parsed.batchNumber ?? prev.batchNumber,
              expiryDate: parsed.expiryDate ?? prev.expiryDate,
            }));
          }
          setNotice(
            `الباركود ${parsed.barcode} غير مسجّل بعد — تم تعبئته في نموذج «إضافة دواء»${
              parsed.batchNumber || parsed.expiryDate ? ' وتجهيز بيانات الدفعة من GS1.' : '.'
            }`,
          );
          medSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setTimeout(() => medNameInputRef.current?.focus(), 200);
        } else {
          setNotice(`لم يُعثر على دواء مسجّل بالباركود ${parsed.barcode}.`);
        }
      }
    },
    [scanModalMode, medicines, batches, token, search, canWrite],
  );

  function submitQuickScan(event) {
    event.preventDefault();
    const code = quickScanInput.trim();
    if (!code) return;
    setQuickScanInput('');
    handleScannedCode(code, 'quick');
  }

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <h1 className="section-title">المخزون</h1>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary" type="button" onClick={() => setScanModalMode('quick')}>
              📷 مسح باركود
            </button>
            <button className="btn btn-soft" type="button" onClick={load} disabled={busy}>
              {busy ? 'جارٍ التحديث…' : 'تحديث'}
            </button>
          </div>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}
        {!canWrite && (
          <div className="alert alert-warn">
            دورك ({me?.role ?? 'غير محدد'}) يسمح بالعرض فقط. الإضافة والتعديل متاحان للمالك والصيدلي ومسؤول المخزون.
          </div>
        )}
        <form className="form" style={{ marginBottom: '0.9rem' }} onSubmit={submitQuickScan}>
          <div className="field">
            <label htmlFor="quick-scan-input">المسح السريع (مرّر قارئ USB أو الصق رمز باركود / GS1 واضغط Enter)</label>
            <div className="input-with-action">
              <input
                id="quick-scan-input"
                className="input"
                dir="ltr"
                placeholder="امسح هنا بقارئ الباركود أو أدخل الرقم يدويًا…"
                value={quickScanInput}
                onChange={(e) => setQuickScanInput(e.target.value)}
              />
              <button className="btn btn-soft" type="submit" disabled={!quickScanInput.trim()}>
                بحث / تطبيق
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setScanModalMode('quick')}>
                📷 الكاميرا
              </button>
            </div>
          </div>
        </form>

        {scanMatch && (
          <div className="scan-result-card">
            <div className="card-head" style={{ marginBottom: 0 }}>
              <div>
                <strong>
                  {scanMatch.medicine ? `دواء مطابق: ${scanMatch.medicine.name}` : `باركود جديد غير مسجّل: ${scanMatch.parsed.barcode}`}
                </strong>
                <div className="muted small">
                  {scanMatch.parsed.format === 'gs1'
                    ? `GS1 DataMatrix${scanMatch.parsed.batchNumber ? ` · دفعة: ${scanMatch.parsed.batchNumber}` : ''}${
                        scanMatch.parsed.expiryDate ? ` · صلاحية: ${scanMatch.parsed.expiryDate}` : ''
                      }`
                    : `الرمز: ${scanMatch.parsed.barcode}`}
                  {scanMatch.medicine ? ` · المتاح للصرف: ${scanMatch.medicine.availableUnits ?? 0}` : ''}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setScanMatch(null)}>
                إخفاء
              </button>
            </div>
            {scanMatch.medicine && (
              <div className="btn-row" style={{ marginTop: '0.25rem' }}>
                {canWrite && scanMatch.fefoBatch && (
                  <button
                    className="btn btn-primary btn-sm"
                    type="button"
                    onClick={() => {
                      setAdjust({ batchId: scanMatch.fefoBatch.id, type: 'dispense', quantity: '', note: '' });
                      adjustSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      setTimeout(() => adjustQtyInputRef.current?.focus(), 200);
                    }}
                  >
                    صرف FEFO ({scanMatch.fefoBatch.batchNumber ?? 'دفعة'} — {scanMatch.fefoBatch.expiryDate ?? 'بلا تاريخ'})
                  </button>
                )}
                {canWrite && (
                  <button
                    className="btn btn-soft btn-sm"
                    type="button"
                    onClick={() => {
                      setBatchForm((prev) => ({
                        ...prev,
                        medicineId: scanMatch.medicine.id,
                        batchNumber: scanMatch.parsed.batchNumber ?? prev.batchNumber,
                        expiryDate: scanMatch.parsed.expiryDate ?? prev.expiryDate,
                      }));
                      batchSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      setTimeout(() => batchQtyInputRef.current?.focus(), 200);
                    }}
                  >
                    تعبئة إضافة دفعة
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => setSearch(scanMatch.medicine.barcode || scanMatch.medicine.name)}
                >
                  تصفية الجدول
                </button>
              </div>
            )}
          </div>
        )}
        <div className="grid grid-3" style={{ marginTop: '0.9rem' }}>
          <div className="stat">
            <span>أصناف</span>
            <strong>{medicines.length}</strong>
          </div>
          <div className="stat">
            <span>دفعات</span>
            <strong>{batches.length}</strong>
          </div>
          <div className="stat">
            <span>وحدات متاحة للصرف</span>
            <strong>
              {medicines.reduce((total, medicine) => total + (Number(medicine.availableUnits) || 0), 0)}
            </strong>
          </div>
        </div>
      </section>

      <section className="card" ref={medSectionRef}>
        <div className="card-head">
          <h2 className="section-title">إضافة دواء</h2>
        </div>
        <form className="form" onSubmit={submitMedicine}>
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="m-name">الاسم التجاري *</label>
              <input
                ref={medNameInputRef}
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
                step="1"
                value={medicineForm.reorderLevel}
                onChange={(event) => setMedicineForm({ ...medicineForm, reorderLevel: event.target.value })}
                disabled={!canWrite || saving}
              />
            </div>
            <div className="field">
              <label htmlFor="m-barcode">الباركود</label>
              <div className="input-with-action">
                <input
                  id="m-barcode"
                  className="input"
                  dir="ltr"
                  value={medicineForm.barcode}
                  onChange={(event) => setMedicineForm({ ...medicineForm, barcode: event.target.value })}
                  disabled={!canWrite || saving}
                />
                <button
                  className="btn btn-soft btn-sm"
                  type="button"
                  disabled={!canWrite || saving}
                  onClick={() => setScanModalMode('new_medicine')}
                >
                  📷 مسح
                </button>
              </div>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canWrite || saving}>
              {saving ? 'جارٍ الحفظ…' : 'حفظ الدواء'}
            </button>
          </div>
        </form>
      </section>

      {canWrite && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">استيراد قاعدة بيانات أدوية وتداخلات (دفعة واحدة)</h2>
            <button className="btn btn-ghost btn-sm" type="button" onClick={downloadCsvTemplate}>
              تحميل قالب CSV
            </button>
          </div>

          <div className="btn-row" style={{ marginTop: 0 }}>
            <button
              className="btn btn-primary"
              type="button"
              disabled={importing}
              onClick={() =>
                runCatalogImport({
                  meds: PDF_MEDICINES,
                  interactions: canImportClinical ? PDF_INTERACTIONS : [],
                  label: 'دليل PharmaGuard PDF',
                })
              }
            >
              {importing
                ? 'جارٍ الاستيراد…'
                : canImportClinical
                  ? 'استيراد دليل PDF كاملًا (25 دواءً + 15 تداخلًا)'
                  : 'استيراد أدوية دليل PDF (25 دواءً)'}
            </button>
            <button
              className="btn btn-soft"
              type="button"
              disabled={importing}
              onClick={() => runCatalogImport({ meds: PDF_MEDICINES, label: 'أدوية دليل PDF' })}
            >
              استيراد الـ 25 دواءً فقط
            </button>
            {canImportClinical && (
              <button
                className="btn btn-soft"
                type="button"
                disabled={importing}
                onClick={() => runCatalogImport({ interactions: PDF_INTERACTIONS, label: 'التداخلات الدوائية (15)' })}
              >
                استيراد الـ 15 تداخلًا دوائيًا
              </button>
            )}
          </div>

          <div className="field" style={{ marginTop: '1rem' }}>
            <label htmlFor="catalog-file-input">أو ارفع ملف CSV / JSON من جهازك</label>
            <input
              id="catalog-file-input"
              className="input"
              type="file"
              accept=".csv,.json,.txt"
              disabled={importing}
              onChange={handleCatalogFile}
            />
          </div>

          {importPreview && (
            <div className="scan-result-card">
              <div className="card-head" style={{ marginBottom: 0 }}>
                <div>
                  <strong>جاهز للاستيراد: {importPreview.fileName}</strong>
                  <div className="muted small">
                    أدوية مكتشفة: {importPreview.medicines.length} • تداخلات مكتشفة: {importPreview.interactions.length}
                  </div>
                </div>
                <div className="btn-row" style={{ marginTop: 0 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    type="button"
                    disabled={importing}
                    onClick={() =>
                      runCatalogImport({
                        meds: importPreview.medicines,
                        interactions: importPreview.interactions,
                        label: importPreview.fileName,
                      })
                    }
                  >
                    {importing ? 'جارٍ الاستيراد…' : 'تأكيد الاستيراد'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    disabled={importing}
                    onClick={() => setImportPreview(null)}
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">الأدوية</h2>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <input
              className="input"
              style={{ width: '210px', padding: '0.4rem 0.7rem' }}
              type="search"
              placeholder="بحث بالاسم أو الباركود…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="small muted" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
              />
              المؤرشفة
            </label>
            <span className="badge badge-muted">{medicines.length}</span>
          </div>
        </div>
        {busy && !medicines.length && <p className="muted small">جارٍ التحميل…</p>}
        {!busy && !medicines.length && <p className="muted small">لا توجد أدوية مطابقة للبحث الحالي.</p>}
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
                  {canWrite && <th>إجراءات</th>}
                </tr>
              </thead>
              <tbody>
                {medicines.map((medicine) => (
                  <tr key={medicine.id}>
                    <td>
                      {medicine.name}
                      {medicine.isActive === false && (
                        <span className="badge badge-muted" style={{ marginInlineStart: '0.4rem' }}>
                          مؤرشف
                        </span>
                      )}
                    </td>
                    <td>{medicine.scientificName ?? '—'}</td>
                    <td>{medicine.form ?? '—'}</td>
                    <td>{medicine.availableUnits ?? 0}</td>
                    <td>{medicine.reorderLevel ?? '—'}</td>
                    <td dir="ltr">{medicine.nearestExpiry ?? '—'}</td>
                    <td>{medicine.batchCount ?? 0}</td>
                    {canWrite && (
                      <td>
                        <div className="btn-row" style={{ marginTop: 0 }}>
                          <button
                            className="btn btn-soft btn-sm"
                            type="button"
                            onClick={() =>
                              setEditingMedicine({
                                id: medicine.id,
                                name: medicine.name ?? '',
                                scientificName: medicine.scientificName ?? '',
                                form: medicine.form ?? '',
                                strength: medicine.strength ?? '',
                                unit: medicine.unit ?? '',
                                barcode: medicine.barcode ?? '',
                                reorderLevel: medicine.reorderLevel ?? 0,
                                isActive: medicine.isActive !== false,
                              })
                            }
                          >
                            تعديل
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            type="button"
                            disabled={saving}
                            onClick={() => toggleArchiveMedicine(medicine)}
                          >
                            {medicine.isActive === false ? 'استعادة' : 'أرشفة'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" ref={batchSectionRef}>
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
              <label htmlFor="b-number">رقم الدفعة *</label>
              <input
                id="b-number"
                className="input"
                value={batchForm.batchNumber}
                onChange={(event) => setBatchForm({ ...batchForm, batchNumber: event.target.value })}
                disabled={!canWrite || saving}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="b-quantity">الكمية *</label>
              <input
                ref={batchQtyInputRef}
                id="b-quantity"
                className="input"
                type="number"
                min="1"
                step="1"
                value={batchForm.quantity}
                onChange={(event) => setBatchForm({ ...batchForm, quantity: event.target.value })}
                disabled={!canWrite || saving}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="b-expiry">تاريخ الصلاحية *</label>
              <input
                id="b-expiry"
                className="input"
                type="date"
                value={batchForm.expiryDate}
                onChange={(event) => setBatchForm({ ...batchForm, expiryDate: event.target.value })}
                disabled={!canWrite || saving}
                required
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
          <h2 className="section-title">الدفعات والصلاحية (مرتبة حسب FEFO)</h2>
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
                  {canWrite && <th>تعديل</th>}
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.medicineName ?? '—'}</td>
                    <td>
                      {batch.batchNumber ?? '—'}
                      {batch.isFefoNext && (
                        <span className="badge" style={{ marginInlineStart: '0.4rem' }}>
                          FEFO
                        </span>
                      )}
                      {batch.isActive === false && (
                        <span className="badge badge-muted" style={{ marginInlineStart: '0.4rem' }}>
                          مؤرشفة
                        </span>
                      )}
                    </td>
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
                    {canWrite && (
                      <td>
                        <div className="btn-row" style={{ marginTop: 0 }}>
                          <button
                            className="btn btn-soft btn-sm"
                            type="button"
                            onClick={() =>
                              setEditingBatch({
                                id: batch.id,
                                batchNumber: batch.batchNumber ?? '',
                                expiryDate: batch.expiryDate ?? '',
                                costPrice: batch.costPrice ?? '',
                                sellingPrice: batch.sellingPrice ?? '',
                              })
                            }
                          >
                            تعديل
                          </button>
                          {supportsBatchArchive && (
                            <button
                              className="btn btn-ghost btn-sm"
                              type="button"
                              disabled={saving}
                              onClick={() => toggleArchiveBatch(batch)}
                            >
                              {batch.isActive === false ? 'استعادة' : 'أرشفة'}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" ref={adjustSectionRef}>
        <div className="card-head">
          <h2 className="section-title">تسجيل حركة على دفعة</h2>
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
                    {batch.medicineName ?? batch.id} — {batch.batchNumber ?? 'بدون رقم'} ({batch.quantity ?? 0}) —{' '}
                    {batch.expiryDate ?? 'بلا تاريخ'}
                    {batch.isFefoNext ? ' [FEFO]' : ''}
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
                <option value="dispense">صرف</option>
                <option value="receive">استلام</option>
                <option value="adjust">تعديل</option>
                <option value="write_off">إتلاف</option>
                <option value="return">إرجاع</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="a-quantity">الكمية *</label>
              <input
                ref={adjustQtyInputRef}
                id="a-quantity"
                className="input"
                type="number"
                min="1"
                step="1"
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

      {editingMedicine && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تعديل بيانات الدواء">
          <div className="modal-card">
            <h3 className="section-title">تعديل دواء</h3>
            <form className="form" onSubmit={saveMedicineEdit}>
              <div className="field">
                <label htmlFor="em-name">الاسم التجاري *</label>
                <input
                  id="em-name"
                  className="input"
                  value={editingMedicine.name}
                  onChange={(e) => setEditingMedicine({ ...editingMedicine, name: e.target.value })}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="em-sci">الاسم العلمي</label>
                <input
                  id="em-sci"
                  className="input"
                  value={editingMedicine.scientificName}
                  onChange={(e) => setEditingMedicine({ ...editingMedicine, scientificName: e.target.value })}
                />
              </div>
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="em-reorder">حد إعادة الطلب</label>
                  <input
                    id="em-reorder"
                    className="input"
                    type="number"
                    min="0"
                    step="1"
                    value={editingMedicine.reorderLevel}
                    onChange={(e) => setEditingMedicine({ ...editingMedicine, reorderLevel: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="em-barcode">الباركود</label>
                  <div className="input-with-action">
                    <input
                      id="em-barcode"
                      className="input"
                      dir="ltr"
                      value={editingMedicine.barcode}
                      onChange={(e) => setEditingMedicine({ ...editingMedicine, barcode: e.target.value })}
                    />
                    <button
                      className="btn btn-soft btn-sm"
                      type="button"
                      onClick={() => setScanModalMode('edit_medicine')}
                    >
                      📷 مسح
                    </button>
                  </div>
                </div>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? 'جارٍ الحفظ…' : 'حفظ التعديلات'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setEditingMedicine(null)}>
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingBatch && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تعديل بيانات الدفعة">
          <div className="modal-card">
            <h3 className="section-title">تعديل بيانات الدفعة</h3>
            <form className="form" onSubmit={saveBatchEdit}>
              <div className="field">
                <label htmlFor="eb-num">رقم الدفعة</label>
                <input
                  id="eb-num"
                  className="input"
                  value={editingBatch.batchNumber}
                  onChange={(e) => setEditingBatch({ ...editingBatch, batchNumber: e.target.value })}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="eb-exp">تاريخ الصلاحية</label>
                <input
                  id="eb-exp"
                  className="input"
                  type="date"
                  value={editingBatch.expiryDate}
                  onChange={(e) => setEditingBatch({ ...editingBatch, expiryDate: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="eb-cost">سعر التكلفة</label>
                  <input
                    id="eb-cost"
                    className="input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={editingBatch.costPrice}
                    onChange={(e) => setEditingBatch({ ...editingBatch, costPrice: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="eb-sell">سعر البيع</label>
                  <input
                    id="eb-sell"
                    className="input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={editingBatch.sellingPrice}
                    onChange={(e) => setEditingBatch({ ...editingBatch, sellingPrice: e.target.value })}
                  />
                </div>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? 'جارٍ الحفظ…' : 'حفظ الدفعة'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setEditingBatch(null)}>
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <BarcodeScannerModal
        open={Boolean(scanModalMode)}
        title={
          scanModalMode === 'new_medicine'
            ? 'مسح باركود الدواء الجديد'
            : scanModalMode === 'edit_medicine'
              ? 'مسح باركود لتحديث الدواء'
              : 'مسح باركود المخزون (كاميرا / قارئ)'
        }
        onDetected={(code) => handleScannedCode(code, scanModalMode || 'quick')}
        onClose={() => setScanModalMode(null)}
      />
    </div>
  );
}
