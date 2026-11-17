import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toDateOnly,
  daysUntil,
  classifyExpiry,
  shapeMedicine,
  shapeBatch,
  shapeMovement,
  movementDelta,
  aggregateStock,
  computeAlerts,
  buildInventorySummary,
} from '../server/inventory.js';

/**
 * اختبارات منطق المخزون: كل الحسابات تُجرى في الذاكرة على صفوف اختبارية،
 * ولا تُكتب أي بيانات إلى قاعدة البيانات ولا تُستخدم كبيانات دوائية حقيقية.
 */
const NOW = new Date('2026-01-15T00:00:00Z');

const MED_COLS = {
  id: 'id',
  name: 'name',
  scientificName: 'scientific_name',
  form: 'form',
  strength: 'strength',
  unit: 'unit',
  reorderLevel: 'reorder_level',
  isActive: 'is_active',
  barcode: 'barcode',
  pharmacy: 'pharmacy_id',
  createdAt: 'created_at',
};

const BATCH_COLS = {
  id: 'id',
  medicine: 'medicine_id',
  batchNumber: 'batch_number',
  quantity: 'quantity',
  expiryDate: 'expiry_date',
  costPrice: 'cost_price',
  sellingPrice: 'selling_price',
  receivedAt: 'received_at',
  pharmacy: 'pharmacy_id',
};

const MOVEMENT_COLS = {
  id: 'id',
  batch: 'batch_id',
  medicine: 'medicine_id',
  type: 'type',
  quantity: 'quantity',
  note: 'note',
  createdAt: 'created_at',
};

test('تصنيف الصلاحية يفصل المنتهي والحرج والقريب والسليم', () => {
  assert.equal(classifyExpiry('2026-01-10', NOW).bucket, 'expired');
  assert.equal(classifyExpiry('2026-01-10', NOW).days, -5);
  assert.equal(classifyExpiry('2026-01-30', NOW).bucket, 'critical');
  assert.equal(classifyExpiry('2026-02-14', NOW).bucket, 'critical');
  assert.equal(classifyExpiry('2026-03-01', NOW).bucket, 'warning');
  assert.equal(classifyExpiry('2026-12-31', NOW).bucket, 'ok');
  assert.deepEqual(classifyExpiry(null, NOW), { bucket: 'unknown', days: null });
  assert.equal(daysUntil('2026-01-15', NOW), 0);
});

test('تحويل التواريخ يقبل ISO ويرفض غير الصالح', () => {
  assert.equal(toDateOnly('2026-05-04T10:20:30Z'), '2026-05-04');
  assert.equal(toDateOnly(''), null);
  assert.equal(toDateOnly('not-a-date'), null);
});

test('شكل الدواء يُرجع الحقول المعروفة فقط ولا يخترع قيمًا', () => {
  const shaped = shapeMedicine(
    { id: 'm1', name: 'اسم تجريبي', reorder_level: '12', is_active: false, pharmacy_id: 'p1' },
    MED_COLS,
  );
  assert.equal(shaped.id, 'm1');
  assert.equal(shaped.name, 'اسم تجريبي');
  assert.equal(shaped.reorderLevel, 12);
  assert.equal(shaped.isActive, false);
  assert.equal(shaped.pharmacyId, 'p1');
  // أعمدة غير موجودة في تعيين الأعمدة تبقى null بدل التخمين
  const partial = shapeMedicine({ id: 'm2', name: 'س' }, { id: 'id', name: 'name' });
  assert.equal(partial.scientificName, null);
  assert.equal(partial.reorderLevel, 0);
});

test('شكل الدفعة يحسب الصلاحية ويحوّل الكميات أرقامًا', () => {
  const shaped = shapeBatch(
    {
      id: 'b1',
      medicine_id: 'm1',
      batch_number: 'LOT-1',
      quantity: '7',
      expiry_date: '2026-02-01T00:00:00Z',
      cost_price: '2.5',
      selling_price: '4',
    },
    BATCH_COLS,
    NOW,
  );
  assert.equal(shaped.quantity, 7);
  assert.equal(shaped.expiryDate, '2026-02-01');
  assert.equal(shaped.daysToExpiry, 17);
  assert.equal(shaped.expiryBucket, 'critical');
  assert.equal(shaped.costPrice, 2.5);
});

test('شكل الحركة يوحّد نوع الحركة ويحتفظ بالملاحظة', () => {
  const shaped = shapeMovement(
    { id: 'x1', batch_id: 'b1', medicine_id: 'm1', type: 'DISPENSE', quantity: '3', note: 'صرف' },
    MOVEMENT_COLS,
  );
  assert.equal(shaped.type, 'dispense');
  assert.equal(shaped.quantity, 3);
  assert.equal(shaped.note, 'صرف');
});

test('إشارة الحركة تزيد للاستلام والمرتجع وتنقص للصرف والتلف', () => {
  assert.equal(movementDelta('receive', 5), 5);
  assert.equal(movementDelta('return', 4), 4);
  assert.equal(movementDelta('adjust_in', 2), 2);
  assert.equal(movementDelta('dispense', 6), -6);
  assert.equal(movementDelta('write_off', 3), -3);
  assert.equal(movementDelta('adjust', 9), -9);
});

test('تجميع الكميات يفصل المتاح للصرف عن المنتهي', () => {
  const batches = [
    shapeBatch({ id: 'b1', medicine_id: 'm1', quantity: 10, expiry_date: '2026-12-31' }, BATCH_COLS, NOW),
    shapeBatch({ id: 'b2', medicine_id: 'm1', quantity: 5, expiry_date: '2026-01-01' }, BATCH_COLS, NOW),
  ];
  const stock = aggregateStock(batches, NOW);
  const entry = stock.get('m1');
  assert.equal(entry.totalUnits, 15);
  assert.equal(entry.sellableUnits, 10);
  assert.equal(entry.expiredUnits, 5);
  assert.equal(entry.batches, 2);
  assert.equal(entry.nearestExpiry, '2026-01-01');
});

test('التنبيهات تُشتق من البيانات فعليًا: نفاد، انخفاض، انتهاء، قرب انتهاء', () => {
  const medicines = [
    shapeMedicine({ id: 'm1', name: 'صنف نفد', reorder_level: 5 }, MED_COLS),
    shapeMedicine({ id: 'm2', name: 'صنف منخفض', reorder_level: 10 }, MED_COLS),
  ];
  const batches = [
    shapeBatch({ id: 'b1', medicine_id: 'm1', quantity: 0, expiry_date: '2026-12-31' }, BATCH_COLS, NOW),
    shapeBatch({ id: 'b2', medicine_id: 'm2', quantity: 4, expiry_date: '2026-12-31' }, BATCH_COLS, NOW),
    shapeBatch({ id: 'b3', medicine_id: 'm2', quantity: 3, expiry_date: '2026-01-05' }, BATCH_COLS, NOW),
    shapeBatch({ id: 'b4', medicine_id: 'm2', quantity: 2, expiry_date: '2026-02-01' }, BATCH_COLS, NOW),
  ];
  const alerts = computeAlerts({ medicines, batches, now: NOW });
  const types = alerts.map((alert) => alert.type);
  assert.ok(types.includes('out_of_stock'));
  assert.ok(types.includes('low_stock'));
  assert.ok(types.includes('expired_batch'));
  assert.ok(types.includes('expiring_soon'));

  const out = alerts.find((alert) => alert.type === 'out_of_stock');
  assert.equal(out.severity, 'high');
  assert.equal(out.units, 0);

  const low = alerts.find((alert) => alert.type === 'low_stock');
  assert.equal(low.reorderLevel, 10);
  // 4 وحدات صالحة ≤ نصف حد إعادة الطلب (5) ⇒ خطورة عالية
  assert.equal(low.severity, 'high');

  // لا تنبيه لصنف بلا كمية ولا حد إعادة طلب
  const none = computeAlerts({
    medicines: [shapeMedicine({ id: 'm9', name: 'بلا حد' }, MED_COLS)],
    batches: [shapeBatch({ id: 'b9', medicine_id: 'm9', quantity: 50, expiry_date: '2026-12-31' }, BATCH_COLS, NOW)],
    now: NOW,
  });
  assert.equal(none.length, 0);

  // الترتيب: الأعلى خطورة أولًا
  const severities = alerts.map((alert) => alert.severity);
  const firstMedium = severities.indexOf('medium');
  if (firstMedium !== -1) {
    assert.ok(severities.slice(0, firstMedium).every((severity) => severity === 'high'));
  }
});

test('ملخص المخزون يعطي أرقامًا وقيمة من الدفعات فقط', () => {
  const medicines = [
    shapeMedicine({ id: 'm1', name: 'أ', reorder_level: 2, is_active: true }, MED_COLS),
    shapeMedicine({ id: 'm2', name: 'ب', reorder_level: 0, is_active: true }, MED_COLS),
  ];
  const batches = [
    shapeBatch(
      { id: 'b1', medicine_id: 'm1', quantity: 10, expiry_date: '2026-12-31', cost_price: 2, selling_price: 5 },
      BATCH_COLS,
      NOW,
    ),
    shapeBatch(
      { id: 'b2', medicine_id: 'm2', quantity: 4, expiry_date: '2026-01-01', cost_price: 1, selling_price: 3 },
      BATCH_COLS,
      NOW,
    ),
  ];
  const movements = [
    shapeMovement({ id: 'v1', medicine_id: 'm1', type: 'receive', quantity: 10 }, MOVEMENT_COLS),
    shapeMovement({ id: 'v2', medicine_id: 'm1', type: 'dispense', quantity: 2 }, MOVEMENT_COLS),
  ];

  const summary = buildInventorySummary({ medicines, batches, movements }, NOW);
  assert.equal(summary.counts.medicines, 2);
  assert.equal(summary.counts.batches, 2);
  assert.equal(summary.counts.movements, 2);
  assert.equal(summary.counts.activeMedicines, 2);
  assert.equal(summary.units.total, 14);
  assert.equal(summary.units.sellable, 10);
  assert.equal(summary.units.expired, 4);
  assert.equal(summary.value.cost, 24);
  assert.equal(summary.value.selling, 62);
  assert.equal(summary.movementsByType.receive, 10);
  assert.equal(summary.movementsByType.dispense, 2);
  // m1 فيه 10 وحدات وحد إعادة الطلب 2 ⇒ ليس منخفضًا
  assert.equal(summary.lowStock.length, 0);
  // الدفعة المنتهية لا تُحتسب «قريبة الانتهاء»
  assert.equal(summary.expiring.length, 0);
});
