import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_META,
  detectIntent,
  agentForIntent,
  findMentionedMedicines,
  findMentionedMedicine,
  buildAnswer,
} from '../server/routes/agent.js';
import { buildInventorySummary, computeAlerts, shapeMedicine, shapeBatch, shapeMovement } from '../server/inventory.js';

const NOW = new Date('2026-01-15T00:00:00Z');
const MED_COLS = { id: 'id', name: 'name', scientificName: 'scientific_name', reorderLevel: 'reorder_level', isActive: 'is_active' };
const BATCH_COLS = {
  id: 'id',
  medicine: 'medicine_id',
  batchNumber: 'batch_number',
  quantity: 'quantity',
  expiryDate: 'expiry_date',
  costPrice: 'cost_price',
  sellingPrice: 'selling_price',
};
const MOVE_COLS = { id: 'id', batch: 'batch_id', medicine: 'medicine_id', type: 'type', quantity: 'quantity', createdAt: 'created_at' };

test('توجيه الأسئلة يختار النية والوكيل المتخصص الصحيح من الوكلاء الثلاثة', () => {
  assert.equal(detectIntent('هل يوجد تداخل بين دوائين؟'), 'interaction');
  assert.equal(agentForIntent('interaction').id, AGENT_META.safety_agent.id);

  assert.equal(detectIntent('ما ترتيب الصرف وفق FEFO؟'), 'fefo');
  assert.equal(agentForIntent('fefo').id, AGENT_META.inventory_agent.id);

  assert.equal(detectIntent('ما الأصناف التي تحت حد إعادة الطلب؟'), 'shortage');
  assert.equal(agentForIntent('shortage').id, AGENT_META.inventory_agent.id);

  assert.equal(detectIntent('أعطني تقريرًا شاملًا عن قيمة المخزون'), 'report');
  assert.equal(agentForIntent('report').id, AGENT_META.analytics_agent.id);
});

test('استخراج الأدوية المذكورة يطابق أكثر من دواء للتداخلات', () => {
  const medicines = [
    shapeMedicine({ id: 'm1', name: 'بنادول', scientific_name: 'Paracetamol' }, MED_COLS),
    shapeMedicine({ id: 'm2', name: 'وارفارين', scientific_name: 'Warfarin' }, MED_COLS),
  ];
  const found = findMentionedMedicines('هل يوجد تداخل بين Paracetamol و وارفارين؟', medicines);
  assert.equal(found.length, 2);
  assert.equal(findMentionedMedicine('فحص رصيد بنادول', medicines)?.id, 'm1');
});

test('وكلاء الذكاء الاصطناعي يولّدون إجابات حقيقية لـ FEFO وإعادة الطلب والتداخلات والتقارير', () => {
  const medicines = [
    shapeMedicine({ id: 'm1', name: 'أموبيك', scientific_name: 'Amoxicillin', reorder_level: 10 }, MED_COLS),
  ];
  const batches = [
    shapeBatch({ id: 'b1', medicine_id: 'm1', batch_number: 'LOT-A', quantity: 3, expiry_date: '2026-03-01', cost_price: 2, selling_price: 5 }, BATCH_COLS, NOW),
    shapeBatch({ id: 'b2', medicine_id: 'm1', batch_number: 'LOT-B', quantity: 4, expiry_date: '2026-08-01', cost_price: 2, selling_price: 5 }, BATCH_COLS, NOW),
  ];
  const movements = [
    shapeMovement({ id: 'v1', medicine_id: 'm1', type: 'receive', quantity: 10, created_at: '2026-01-10T00:00:00Z' }, MOVE_COLS),
    shapeMovement({ id: 'v2', medicine_id: 'm1', type: 'dispense', quantity: 3, created_at: '2026-01-12T00:00:00Z' }, MOVE_COLS),
  ];
  const summary = buildInventorySummary({ medicines, batches, movements }, NOW);
  const alerts = computeAlerts({ medicines, batches, now: NOW });

  // 1) وكيل المخزون: إعادة الطلب
  const shortageAns = buildAnswer('shortage', { summary, alerts, medicines, batches, movements, now: NOW });
  assert.match(shortageAns.answer, /اقتراح إعادة الطلب: 13 وحدة/);

  // 2) وكيل المخزون: FEFO
  const fefoAns = buildAnswer('fefo', { summary, alerts, medicines, batches, movements, medicine: medicines[0], now: NOW });
  assert.match(fefoAns.answer, /LOT-A/);

  // 3) وكيل سلامة الأدوية: لا يختلق تداخلات عند غيابها
  const emptyInter = buildAnswer('interaction', {
    summary,
    alerts,
    medicines,
    batches,
    movements,
    now: NOW,
    interactionData: { available: true, rows: [], pairMatches: [], pairRequested: true },
  });
  assert.match(emptyInter.answer, /لم يُعثر على تداخل مسجّل/);

  // 4) وكيل التحليل والتقارير: يترجم أنواع الحركات ويحسب الوارد والصادر
  const moveAns = buildAnswer('movements', { summary, alerts, medicines, batches, movements, now: NOW });
  assert.match(moveAns.answer, /الوارد: 10/);
  assert.match(moveAns.answer, /الصادر: 3/);
  assert.match(moveAns.answer, /استلام/);
  assert.match(moveAns.answer, /صرف/);
});
