import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMedicineTokens,
  findInventoryInteractions,
  resolveEnumValue,
  selectAlertsToPersist,
} from '../server/agentSweep.js';

test('استخراج الرموز يتجاهل وحدات الجرعات ويحتفظ بالأسماء الفعالة بالعربية والإنجليزية', () => {
  const tokens = extractMedicineTokens({
    id: 'm1',
    name: 'Coumadin 5mg Tablets',
    scientificName: 'Warfarin الوارفارين',
  });
  assert.equal(tokens.includes('coumadin'), true);
  assert.equal(tokens.includes('warfarin'), true);
  assert.equal(tokens.includes('الوارفارين'), true);
  assert.equal(tokens.includes('5mg'), false);
  assert.equal(tokens.includes('tablets'), false);
});

test('فحص التداخلات الشامل يكتشف التعارضات بين أدوية المخزون دون تكرار أو ربط الدواء بنفسه', () => {
  const medicines = [
    { id: 'm1', name: 'Coumadin 5mg', scientificName: 'Warfarin', isActive: true },
    { id: 'm2', name: 'Aspirin 100mg', scientificName: 'Acetylsalicylic Acid', isActive: true },
    { id: 'm3', name: 'Panadol 500mg', scientificName: 'Paracetamol', isActive: true },
    { id: 'm4', name: 'Brufen 400mg', scientificName: 'Ibuprofen', isActive: false },
  ];
  const interactions = [
    {
      drugA: 'Coumadin (Warfarin - الوارفارين)',
      drugB: 'Aspirin (الأسبرين)',
      severity: 'critical',
      description: 'زيادة خطر النزيف',
    },
    {
      drugA: 'Warfarin',
      drugB: 'Ibuprofen',
      severity: 'critical',
      description: 'دواء غير نشط يجب استبعاده',
    },
  ];

  const conflicts = findInventoryInteractions(medicines, interactions);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].medicineA.id, 'm1');
  assert.equal(conflicts[0].medicineB.id, 'm2');
  assert.equal(conflicts[0].severity, 'critical');
});

test('مزامنة التنبيهات تمنع التكرار وتغلق التنبيهات التي زال سببها فقط', () => {
  const computed = [
    { type: 'low_stock', medicineId: 'm1', batchId: null, message: 'نقص دواء 1' },
    { type: 'expired_batch', medicineId: 'm2', batchId: 'b2', message: 'انتهاء دفعة 2' },
  ];
  const stored = [
    { id: 'a1', type: 'low_stock', medicineId: 'm1', batchId: null, message: 'نقص دواء 1', resolved: false },
    { id: 'a2', type: 'out_of_stock', medicineId: 'm3', batchId: null, message: 'نفاد سابق', resolved: false },
    { id: 'a3', type: 'drug_interaction', medicineId: 'm4', batchId: null, message: 'تداخل يدوي', resolved: false },
  ];

  const { toInsert, toResolve } = selectAlertsToPersist(computed, stored);
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].batchId, 'b2');
  assert.equal(toResolve.length, 1);
  assert.equal(toResolve[0].id, 'a2');
});

test('resolveEnumValue يختار القيمة المطابقة لقيود enum في الجدول بأمان', () => {
  const columns = {
    tables: {
      reports: {
        columns: [{ name: 'report_type', enumValues: ['inventory_snapshot', 'weekly'] }],
      },
    },
  };
  assert.equal(resolveEnumValue(columns, 'reports', 'report_type', ['autonomous_audit', 'inventory_snapshot']), 'inventory_snapshot');
  assert.equal(resolveEnumValue(columns, 'reports', 'missing_col', ['autonomous_audit']), 'autonomous_audit');
});
