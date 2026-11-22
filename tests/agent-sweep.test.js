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

test('resolveColumn يكتشف أعمدة drug_interactions باختلاف تسميتها أو حالة أحرفها', async () => {
  const { resolveColumn } = await import('../server/schema.js');
  const { COLUMN_CANDIDATES } = await import('../server/inventory.js');

  const schemaA = {
    ok: true,
    tables: {
      drug_interactions: {
        columnNames: ['id', 'drug_1', 'drug_2', 'risk_level', 'clinical_effect'],
      },
    },
  };
  assert.equal(resolveColumn(schemaA, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.drugA), 'drug_1');
  assert.equal(resolveColumn(schemaA, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.drugB), 'drug_2');
  assert.equal(resolveColumn(schemaA, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.severity), 'risk_level');
  assert.equal(resolveColumn(schemaA, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.description), 'clinical_effect');

  const schemaB = {
    ok: true,
    tables: {
      drug_interactions: {
        columnNames: ['id', 'drugA', 'drugB', 'medicine_a_id'],
      },
    },
  };
  assert.equal(resolveColumn(schemaB, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.drugA), 'drugA');
  assert.equal(resolveColumn(schemaB, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.drugB), 'drugB');

  const schemaC = {
    ok: true,
    tables: {
      drug_interactions: { columnNames: ['id', 'drug_a', 'drug_b', 'source_name'] },
      medicines: { columnNames: ['id', 'brand_name', 'generic_name'] },
    },
  };
  assert.equal(resolveColumn(schemaC, 'drug_interactions', COLUMN_CANDIDATES.drug_interactions.source), 'source_name');
  assert.equal(resolveColumn(schemaC, 'medicines', COLUMN_CANDIDATES.medicines.name), 'brand_name');
  assert.equal(resolveColumn(schemaC, 'medicines', COLUMN_CANDIDATES.medicines.scientificName), 'generic_name');
});

test('buildSeveritySchemePayloads يعيد تكييف عمود الخطورة حسب قيود CHECK دون المساس ببقية الحقول', async () => {
  const { buildSeveritySchemePayloads } = await import('../server/routes/interactions.js');

  const baseRows = [
    { drug_a: 'Warfarin', drug_b: 'Aspirin', severity: 'critical', source_name: 'PharmaGuard' },
    { drug_a: 'Metformin', drug_b: 'Contrast', severity: 'moderate', source_name: 'PharmaGuard' },
    { drug_a: 'Calcium', drug_b: 'Zinc', severity: 'mild', source_name: 'PharmaGuard' },
  ];
  const buckets = ['high', 'medium', 'low'];

  const highLowRows = buildSeveritySchemePayloads(baseRows, buckets, 'severity', {
    high: 'high',
    medium: 'medium',
    low: 'low',
  });
  assert.deepEqual(
    highLowRows.map((r) => r.severity),
    ['high', 'medium', 'low'],
  );
  assert.equal(highLowRows[0].drug_a, 'Warfarin');
  assert.equal(highLowRows[0].source_name, 'PharmaGuard');

  const majorMinorRows = buildSeveritySchemePayloads(baseRows, buckets, 'severity', {
    high: 'major',
    medium: 'moderate',
    low: 'minor',
  });
  assert.deepEqual(
    majorMinorRows.map((r) => r.severity),
    ['major', 'moderate', 'minor'],
  );
});

test('computeAuditSignature يكشف تغير التنبيهات أو التعارضات ويبقى ثابتًا عند عدم التغيير', async () => {
  const { computeAuditSignature, WATCH_INTERVAL_SECONDS_DEFAULT } = await import('../server/agentSweep.js');
  assert.equal(WATCH_INTERVAL_SECONDS_DEFAULT, 30);

  const baseAudit = {
    agents: {
      inventory_agent: { medicinesScanned: 10, batchesScanned: 15, fefoReadyMedicines: 8 },
      safety_agent: {
        interactionsCatalogRows: 15,
        conflicts: [{ medicineA: { id: 'm1' }, medicineB: { id: 'm2' }, severity: 'critical' }],
      },
      analytics_agent: { movementsScanned: 5, inboundUnits: 50, outboundUnits: 10, costValue: 100, sellingValue: 150 },
    },
    summary: { units: { sellable: 40, expired: 0, total: 40 } },
    alerts: [{ type: 'low_stock', severity: 'medium', medicineId: 'm1', batchId: null, units: 3 }],
  };

  const sig1 = computeAuditSignature(baseAudit);
  const sig2 = computeAuditSignature(JSON.parse(JSON.stringify(baseAudit)));
  assert.equal(sig1, sig2);

  const changedAudit = JSON.parse(JSON.stringify(baseAudit));
  changedAudit.alerts.push({ type: 'expired_batch', severity: 'high', medicineId: 'm2', batchId: 'b9', units: 2 });
  const sig3 = computeAuditSignature(changedAudit);
  assert.notEqual(sig1, sig3);
});


