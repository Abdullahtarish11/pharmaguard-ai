import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpiryAlertItems } from '../src/expiryAlerts.js';
import { computeAlerts, shapeMedicine, shapeBatch } from '../server/inventory.js';

const NOW = new Date('2026-01-15T00:00:00Z');
const MED_COLS = { id: 'id', name: 'name', reorderLevel: 'reorder_level', isActive: 'is_active' };
const BATCH_COLS = { id: 'id', medicine: 'medicine_id', batchNumber: 'batch_number', quantity: 'quantity', expiryDate: 'expiry_date' };

test('التنبيه التلقائي يرتّب الأدوية ويلوّنها حسب الشدة: منتهٍ ثم حرج ثم قريب', () => {
  const medicines = [
    shapeMedicine({ id: 'm1', name: 'أموكسيسيلين' }, MED_COLS),
    shapeMedicine({ id: 'm2', name: 'باراسيتامول' }, MED_COLS),
    shapeMedicine({ id: 'm3', name: 'أوميبرازول' }, MED_COLS),
  ];
  const batches = [
    shapeBatch({ id: 'b1', medicine_id: 'm1', batch_number: 'LOT-EXP', quantity: 5, expiry_date: '2026-01-01' }, BATCH_COLS, NOW),
    shapeBatch({ id: 'b2', medicine_id: 'm2', batch_number: 'LOT-CRIT', quantity: 8, expiry_date: '2026-01-25' }, BATCH_COLS, NOW),
  ];

  const alerts = computeAlerts({ medicines, batches, now: NOW });
  // تأكد أن computeAlerts أضاف medicineName للتنبيهات المرتبطة بالدفعات
  const expAlert = alerts.find((a) => a.type === 'expired_batch');
  assert.equal(expAlert.medicineName, 'أموكسيسيلين');

  const summary = {
    expiring: [
      {
        batchId: 'b3',
        batchNumber: 'LOT-WARN',
        medicineId: 'm3',
        medicineName: 'أوميبرازول',
        quantity: 12,
        expiryDate: '2026-03-10',
        daysToExpiry: 54,
        bucket: 'warning',
      },
      {
        batchId: 'b2',
        batchNumber: 'LOT-CRIT',
        medicineId: 'm2',
        medicineName: 'باراسيتامول',
        quantity: 8,
        expiryDate: '2026-01-25',
        daysToExpiry: 10,
        bucket: 'critical',
      },
    ],
  };

  const result = buildExpiryAlertItems({ summary, alerts });
  assert.equal(result.counts.expired, 1);
  assert.equal(result.counts.critical, 1);
  assert.equal(result.counts.warning, 1);
  assert.equal(result.counts.total, 3);

  assert.deepEqual(
    result.items.map((i) => ({ name: i.medicineName, level: i.level, severity: i.severity })),
    [
      { name: 'أموكسيسيلين', level: 'expired', severity: 'high' },
      { name: 'باراسيتامول', level: 'critical', severity: 'medium' },
      { name: 'أوميبرازول', level: 'warning', severity: 'low' },
    ],
  );
});
