import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBarcodePayload, findMedicineByBarcode, pickFefoBatchForMedicine } from '../src/barcode.js';

test('محلل الباركود يقرأ الباركود الخطي القياسي وينشئ احتمالات المطابقة', () => {
  const parsed = parseBarcodePayload(' 6291000012345 ');
  assert.equal(parsed.format, 'standard');
  assert.equal(parsed.barcode, '6291000012345');
  assert.equal(parsed.batchNumber, null);
  assert.equal(parsed.expiryDate, null);
  assert.ok(parsed.candidates.includes('6291000012345'));
  assert.ok(parsed.candidates.includes('06291000012345'));
});

test('محلل GS1 DataMatrix يفكك GTIN وتاريخ الصلاحية ورقم الدفعة بصيغة FNC1', () => {
  const gs = '\u001d';
  const payload = `]d201062910000123451727083110LOT-99${gs}21SER001`;
  const parsed = parseBarcodePayload(payload);
  assert.equal(parsed.format, 'gs1');
  assert.equal(parsed.gtin, '06291000012345');
  assert.equal(parsed.barcode, '6291000012345');
  assert.equal(parsed.expiryDate, '2027-08-31');
  assert.equal(parsed.batchNumber, 'LOT-99');
});

test('محلل GS1 يتعامل مع اليوم 00 كآخر يوم في الشهر وصيغة الأقواس', () => {
  const parsed = parseBarcodePayload('(01)06291111222233(17)270200(10)B-FEB');
  assert.equal(parsed.format, 'gs1');
  assert.equal(parsed.barcode, '6291111222233');
  assert.equal(parsed.expiryDate, '2027-02-28');
  assert.equal(parsed.batchNumber, 'B-FEB');
});

test('مطابقة الدواء بالباركود تربط EAN-13 مع GTIN-14 وتختار دفعة FEFO الصالحة', () => {
  const medicines = [
    { id: 'm1', name: 'أموبيك', barcode: '6291000012345' },
    { id: 'm2', name: 'بنادول', barcode: '5000123456789' },
  ];
  const parsed = parseBarcodePayload('(01)06291000012345(17)270831(10)LOT-A');
  const med = findMedicineByBarcode(medicines, parsed);
  assert.equal(med?.id, 'm1');

  const batches = [
    { id: 'b0', medicineId: 'm1', batchNumber: 'OLD', quantity: 5, expiryDate: '2025-01-01', expiryBucket: 'expired', isFefoNext: false },
    { id: 'b2', medicineId: 'm1', batchNumber: 'LATE', quantity: 10, expiryDate: '2027-12-01', expiryBucket: 'ok', isFefoNext: false },
    { id: 'b1', medicineId: 'm1', batchNumber: 'SOON', quantity: 4, expiryDate: '2027-03-01', expiryBucket: 'ok', isFefoNext: true },
  ];
  const chosen = pickFefoBatchForMedicine(batches, med.id);
  assert.equal(chosen?.id, 'b1');
});
