import {
  buildInventorySummary,
  computeAlerts,
  INCREASING_MOVEMENTS,
  DECREASING_MOVEMENTS,
  payloadFor,
  shapeBatch,
  shapeMedicine,
  shapeMovement,
  sortBatchesFefo,
} from './inventory.js';

export const SWEEP_INTERVAL_HOURS_DEFAULT = 6;

const DOSAGE_STOP_TOKENS = new Set([
  'mg', 'mcg', 'ml', 'gm', 'g', 'kg', 'iu', 'tab', 'tabs', 'tablet', 'tablets',
  'cap', 'caps', 'capsule', 'capsules', 'syrup', 'susp', 'suspension', 'inj',
  'injection', 'amp', 'ampoule', 'vial', 'cream', 'gel', 'ointment', 'drops',
  'spray', 'patch', 'sachet', 'suppository', 'powder', 'solution', 'oral',
  'plus', 'extra', 'advance', 'forte', 'retard', 'sr', 'xr', 'er', 'cr', 'mr',
  'od', 'bd', 'tds', 'for', 'with', 'and', 'the', 'acid', 'sodium', 'potassium',
  'hydrochloride', 'hcl', 'maleate', 'sulfate', 'calcium', 'citrate',
  'قرص', 'أقراص', 'كبسول', 'كبسولة', 'كبسولات', 'شراب', 'معلق', 'حقنة', 'حقن',
  'أمبول', 'كريم', 'مرهم', 'جل', 'قطرة', 'بخاخ', 'لبوس', 'فوار', 'محلول',
  'مجم', 'ملجم', 'مل', 'جم', 'مع', 'من', 'في',
]);

const AUTO_MANAGED_ALERT_TYPES = new Set([
  'out_of_stock',
  'low_stock',
  'expired_batch',
  'expiring_soon',
]);

const TRIGGER_LABELS = Object.freeze({
  scheduled: 'مجدول كل 6 ساعات',
  startup: 'فحص بدء التشغيل',
  manual: 'تشغيل يدوي شامل',
  cron: 'مجدول سحابي (Cron)',
  github_actions: 'أتمتة GitHub السحابية (كل 6 ساعات)',
});

const schedulerState = {
  active: false,
  intervalHours: SWEEP_INTERVAL_HOURS_DEFAULT,
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  lastTrigger: null,
  lastError: null,
  lastSummary: null,
};

let schedulerTimer = null;
let startupTimer = null;

export function getSchedulerState() {
  return { ...schedulerState };
}

function getColumnMeta(columns, table, columnName) {
  if (!columnName) return null;
  return columns?.tables?.[table]?.columns?.find((c) => c.name === columnName) ?? null;
}

function isJsonColumn(columns, table, columnName) {
  const meta = getColumnMeta(columns, table, columnName);
  const type = String(meta?.type ?? '').toLowerCase();
  return type.includes('json') || type === 'object';
}

export function resolveEnumValue(columns, table, columnName, preferred = [], fallback = null) {
  const meta = getColumnMeta(columns, table, columnName);
  const enumValues = Array.isArray(meta?.enumValues) && meta.enumValues.length > 0 ? meta.enumValues : null;
  if (!enumValues) return preferred[0] ?? fallback;

  for (const candidate of preferred) {
    const match = enumValues.find((v) => String(v).toLowerCase() === String(candidate).toLowerCase());
    if (match !== undefined) return match;
  }
  return fallback ?? enumValues[0];
}

function isEnumValueSupported(columns, table, columnName, value) {
  const meta = getColumnMeta(columns, table, columnName);
  const enumValues = Array.isArray(meta?.enumValues) && meta.enumValues.length > 0 ? meta.enumValues : null;
  if (!enumValues) return true;
  return enumValues.some((v) => String(v).toLowerCase() === String(value).toLowerCase());
}

export function extractMedicineTokens(medicine) {
  if (!medicine) return [];
  const tokens = new Set();

  for (const raw of [medicine.name, medicine.scientificName]) {
    const text = String(raw ?? '').trim().toLowerCase();
    if (!text) continue;
    const cleaned = text.replace(/\s+/g, ' ');
    if (cleaned.length >= 3 && !DOSAGE_STOP_TOKENS.has(cleaned)) {
      tokens.add(cleaned);
    }
    const parts = cleaned
      .split(/[\s/+()[\]{},،;:\-–—]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (part.length < 3) continue;
      if (/^\d+(?:\.\d+)?(?:mg|mcg|ml|g|iu|%)?$/i.test(part)) continue;
      if (DOSAGE_STOP_TOKENS.has(part)) continue;
      tokens.add(part);
    }
  }

  return [...tokens];
}

function textMatchesTokens(drugText, tokens) {
  const normalized = String(drugText ?? '').toLowerCase().trim();
  if (!normalized || !tokens?.length) return false;
  const words = normalized.split(/[\s/+()[\]{},،;:\-–—]+/).filter(Boolean);
  for (const token of tokens) {
    if (token.length <= 3) {
      if (words.includes(token)) return true;
    } else if (normalized.includes(token)) {
      return true;
    }
  }
  return false;
}

function severityRank(severity) {
  const s = String(severity ?? '').toLowerCase();
  if (['critical', 'high', 'major', 'severe', 'حرج', 'عالي', 'شديد'].includes(s)) return 0;
  if (['moderate', 'medium', 'متوسط'].includes(s)) return 1;
  if (['mild', 'low', 'minor', 'بسيط', 'منخفض'].includes(s)) return 2;
  return 3;
}

/** يفحص جميع الأدوية المتوفرة في المخزون مقابل كامل جدول التداخلات الدوائية. */
export function findInventoryInteractions(medicines = [], interactionRows = []) {
  const activeMeds = medicines.filter((m) => m && m.id != null && m.isActive !== false);
  const medWithTokens = activeMeds
    .map((med) => ({ med, tokens: extractMedicineTokens(med) }))
    .filter((entry) => entry.tokens.length > 0);

  const conflicts = [];
  const seen = new Set();

  for (const row of interactionRows) {
    const drugA = row?.drugA ?? null;
    const drugB = row?.drugB ?? null;
    if (!drugA || !drugB) continue;

    const matchA = medWithTokens.filter((entry) => textMatchesTokens(drugA, entry.tokens));
    const matchB = medWithTokens.filter((entry) => textMatchesTokens(drugB, entry.tokens));
    if (matchA.length === 0 || matchB.length === 0) continue;

    for (const a of matchA) {
      for (const b of matchB) {
        const idA = String(a.med.id);
        const idB = String(b.med.id);
        if (idA === idB) continue;

        const pairKey = idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
        const interactionKey = `${pairKey}::${String(drugA).toLowerCase()}::${String(drugB).toLowerCase()}`;
        if (seen.has(interactionKey)) continue;
        seen.add(interactionKey);

        conflicts.push({
          medicineA: { id: idA, name: a.med.name, scientificName: a.med.scientificName },
          medicineB: { id: idB, name: b.med.name, scientificName: b.med.scientificName },
          drugA,
          drugB,
          severity: row.severity ?? 'moderate',
          description: row.description ?? null,
          source: row.source ?? null,
        });
      }
    }
  }

  conflicts.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return conflicts;
}

function sameStoredAlert(computed, stored) {
  if (!computed || !stored) return false;
  if (computed.batchId && stored.batchId && String(computed.batchId) === String(stored.batchId)) {
    if (!stored.type || !computed.type || String(stored.type) === String(computed.type)) return true;
  }
  if (!computed.batchId && computed.medicineId && stored.medicineId && String(computed.medicineId) === String(stored.medicineId)) {
    if (!stored.type || !computed.type || String(stored.type) === String(computed.type)) return true;
  }
  if (computed.message && stored.message && computed.message === stored.message) return true;
  return false;
}

/** يحدد التنبيهات الجديدة المطلوب حفظها والتنبيهات المحلولة تلقائيًا لانتفاء سببها. */
export function selectAlertsToPersist(computedAlerts = [], storedAlerts = []) {
  const toInsert = [];
  const toResolve = [];

  for (const computed of computedAlerts) {
    const existing = storedAlerts.find((s) => sameStoredAlert(computed, s));
    if (!existing) {
      toInsert.push(computed);
    } else if (existing.resolved === true) {
      // إذا كان التنبيه محفوظًا كمحلول سابقًا ثم عادت المشكلة فعليًا، نُنشئ تنبيهًا نشطًا أو نعيد فتحه حسب المتاح
      // نكتفي بعدم التكرار إلا إذا لم يعد هناك أي تنبيه مفتوح، وسنعيد فتحه في المزامنة عند التحديث
    }
  }

  for (const stored of storedAlerts) {
    if (stored.resolved) continue;
    if (!AUTO_MANAGED_ALERT_TYPES.has(String(stored.type ?? ''))) continue;
    const stillActive = computedAlerts.some((c) => sameStoredAlert(c, stored));
    if (!stillActive && stored.id) {
      toResolve.push(stored);
    }
  }

  return { toInsert, toResolve };
}

function shapeStoredAlertRow(row, alertCols) {
  return {
    id: alertCols.id ? row[alertCols.id] ?? null : null,
    medicineId: alertCols.medicine && row[alertCols.medicine] != null ? String(row[alertCols.medicine]) : null,
    batchId: alertCols.batch && row[alertCols.batch] != null ? String(row[alertCols.batch]) : null,
    type: alertCols.type ? row[alertCols.type] ?? null : null,
    severity: alertCols.severity ? row[alertCols.severity] ?? null : null,
    message: alertCols.message ? row[alertCols.message] ?? null : null,
    resolved: alertCols.resolved ? Boolean(row[alertCols.resolved]) : false,
    createdAt: alertCols.createdAt ? row[alertCols.createdAt] ?? null : null,
  };
}

function scopeQueryByPharmacyId(query, columns, tableKey, pharmacyId) {
  const col = columns?.[tableKey]?.pharmacy;
  if (col && pharmacyId) return query.eq(col, pharmacyId);
  return query;
}

async function fetchAllRows(buildQuery, pageSize = 1000, maxPages = 10) {
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) return { data: all, error };
    const chunk = data ?? [];
    all.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return { data: all, error: null };
}

export async function discoverPharmacies(admin, columns) {
  const medPharmCol = columns?.medicines?.pharmacy;
  if (!medPharmCol) {
    return [{ id: null, name: 'الصيدلية الرئيسية' }];
  }

  const found = new Map();
  const hasPharmaciesTable = Boolean(columns?.tables?.pharmacies);
  if (hasPharmaciesTable) {
    const pharmCols = columns.tables.pharmacies.columnNames ?? [];
    const idCol = pharmCols.includes('id') ? 'id' : pharmCols[0];
    const nameCol = pharmCols.find((c) => ['name', 'pharmacy_name', 'title'].includes(c)) ?? null;
    if (idCol) {
      const { data, error } = await admin.from('pharmacies').select('*').limit(500);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const id = row[idCol] != null ? String(row[idCol]) : null;
          if (!id) continue;
          found.set(id, { id, name: nameCol && row[nameCol] ? String(row[nameCol]) : `صيدلية ${id.slice(0, 8)}` });
        }
      }
    }
  }

  const { data: medRows } = await admin.from('medicines').select(medPharmCol).limit(2000);
  if (Array.isArray(medRows)) {
    for (const row of medRows) {
      const id = row[medPharmCol] != null ? String(row[medPharmCol]) : null;
      if (id && !found.has(id)) {
        found.set(id, { id, name: `صيدلية ${id.slice(0, 8)}` });
      }
    }
  }

  return [...found.values()];
}

function buildFefoQueue(medicines, batches, now = new Date()) {
  const medNames = new Map(medicines.filter((m) => m?.id != null).map((m) => [String(m.id), m.name]));
  const grouped = new Map();
  for (const batch of batches) {
    if (!batch.medicineId) continue;
    const list = grouped.get(batch.medicineId) ?? [];
    list.push(batch);
    grouped.set(batch.medicineId, list);
  }

  const queue = [];
  for (const [medId, list] of grouped.entries()) {
    const sorted = sortBatchesFefo(list, now);
    if (sorted.length > 0) {
      queue.push({
        medicineId: medId,
        medicineName: medNames.get(medId) ?? medId,
        firstBatch: sorted[0].batchNumber ?? sorted[0].id,
        firstExpiry: sorted[0].expiryDate ?? null,
        firstQuantity: sorted[0].quantity,
        validBatches: sorted.length,
      });
    }
  }
  queue.sort((a, b) => String(a.firstExpiry ?? '9999').localeCompare(String(b.firstExpiry ?? '9999')));
  return queue;
}

function formatSweepArabicReport({ pharmacyName, trigger, summary, alerts, alertSync, fefoQueue, interactions, expiredCost, inbound, outbound, ranAt }) {
  const triggerLabel = TRIGGER_LABELS[trigger] ?? trigger;
  const lines = [
    `تقرير الفحص الآلي الشامل للوكلاء الثلاثة (${triggerLabel}) — ${pharmacyName}`,
    `وقت الفحص: ${ranAt}`,
    '',
    `1) وكيل إدارة المخزون وFEFO:`,
    `• إجمالي الأصناف المفحوصة: ${summary.counts.medicines} | الدفعات: ${summary.counts.batches}`,
    `• الوحدات الصالحة للصرف: ${summary.units.sellable} | المنتهية: ${summary.units.expired}`,
    `• التنبيهات المكتشفة: ${alerts.length} (حرجة: ${alerts.filter((a) => a.severity === 'high').length}) | تنبيهات جديدة محفوظة: ${alertSync.persistedNew} | معالجة تلقائيًا: ${alertSync.autoResolved}`,
    `• أصناف جاهزة بترتيب FEFO: ${fefoQueue.length}`,
    '',
    `2) وكيل سلامة الأدوية:`,
    `• التداخلات الدوائية المكتشفة بين أدوية المخزون: ${interactions.length} (حرجة/شديدة: ${interactions.filter((i) => severityRank(i.severity) === 0).length})`,
  ];

  for (const conflict of interactions.slice(0, 8)) {
    lines.push(`  - ${conflict.medicineA.name} × ${conflict.medicineB.name} (${conflict.severity}): ${conflict.description ?? `${conflict.drugA} + ${conflict.drugB}`}`);
  }

  lines.push(
    '',
    `3) وكيل التحليل والتقارير:`,
    `• قيمة المخزون بالتكلفة: ${summary.value.cost} | بسعر البيع: ${summary.value.selling}`,
    `• خسارة منتهي الصلاحية بالتكلفة: ${expiredCost}`,
    `• إجمالي الحركات المفحوصة: ${summary.counts.movements} (وارد: ${inbound} وحدة، صادر: ${outbound} وحدة)`,
  );

  return lines.join('\n');
}

export async function auditSinglePharmacy({
  admin,
  columns,
  pharmacy,
  trigger = 'scheduled',
  triggeredBy = null,
  now = new Date(),
}) {
  const pharmacyId = pharmacy?.id ?? null;
  const pharmacyName = pharmacy?.name ?? 'الصيدلية';
  const ranAt = now.toISOString();

  // 1) قراءة كاملة لمخزون الصيدلية وحركاتها
  const medRes = await fetchAllRows(() => {
    let q = admin.from('medicines').select('*');
    return scopeQueryByPharmacyId(q, columns, 'medicines', pharmacyId);
  });
  const batchRes = await fetchAllRows(() => {
    let q = admin.from('inventory_batches').select('*');
    return scopeQueryByPharmacyId(q, columns, 'batches', pharmacyId);
  });
  const moveRes = await fetchAllRows(() => {
    let q = admin.from('stock_movements').select('*');
    q = scopeQueryByPharmacyId(q, columns, 'movements', pharmacyId);
    if (columns.movements.createdAt) q = q.order(columns.movements.createdAt, { ascending: false });
    return q;
  }, 1000, 4);

  const medicines = medRes.error ? [] : medRes.data.map((r) => shapeMedicine(r, columns.medicines));
  const batches = batchRes.error ? [] : batchRes.data.map((r) => shapeBatch(r, columns.batches, now));
  const movements = moveRes.error ? [] : moveRes.data.map((r) => shapeMovement(r, columns.movements));

  // 2) وكيل إدارة المخزون: تنبيهات + FEFO + مزامنة inventory_alerts
  const computedAlerts = computeAlerts({ medicines, batches, now });
  const fefoQueue = buildFefoQueue(medicines, batches, now);

  // 3) وكيل سلامة الأدوية: فحص شامل للتداخلات بين جميع الأدوية في المخزون
  const interCols = columns.interactions ?? {};
  let interactionRows = [];
  if (interCols.id && interCols.drugA && interCols.drugB) {
    const interRes = await fetchAllRows(() => {
      let q = admin.from('drug_interactions').select('*');
      if (interCols.pharmacy && pharmacyId) {
        q = q.or(`${interCols.pharmacy}.eq.${pharmacyId},${interCols.pharmacy}.is.null`);
      }
      return q;
    }, 1000, 5);
    if (!interRes.error) {
      interactionRows = interRes.data.map((row) => ({
        drugA: row[interCols.drugA] ?? null,
        drugB: row[interCols.drugB] ?? null,
        severity: interCols.severity ? row[interCols.severity] ?? null : null,
        description: interCols.description ? row[interCols.description] ?? null : null,
        source: interCols.source ? row[interCols.source] ?? null : null,
      }));
    }
  }
  const interactionConflicts = findInventoryInteractions(medicines, interactionRows);

  // 4) مزامنة التنبيهات مع inventory_alerts دون تكرار
  const alertCols = columns.alerts ?? {};
  const alertSync = { available: Boolean(alertCols.id), persistedNew: 0, autoResolved: 0, error: null };

  if (alertCols.id && (!alertCols.pharmacy || pharmacyId)) {
    const existingRes = await fetchAllRows(() => {
      let q = admin.from('inventory_alerts').select('*');
      return scopeQueryByPharmacyId(q, columns, 'alerts', pharmacyId);
    }, 500, 4);

    if (existingRes.error) {
      alertSync.error = existingRes.error.message;
    } else {
      const storedAlerts = existingRes.data.map((r) => shapeStoredAlertRow(r, alertCols));
      const { toInsert, toResolve } = selectAlertsToPersist(computedAlerts, storedAlerts);

      const alertsToPersist = [...toInsert];
      // إضافة تنبيهات التداخلات الحرجة إن سمح عمود النوع بذلك
      if (alertCols.type && isEnumValueSupported(columns, 'inventory_alerts', alertCols.type, 'drug_interaction')) {
        for (const conflict of interactionConflicts.filter((c) => severityRank(c.severity) === 0).slice(0, 15)) {
          const msg = `تداخل دوائي حرج في المخزون: ${conflict.medicineA.name} × ${conflict.medicineB.name}`;
          const alreadyExists = storedAlerts.some((s) => s.message === msg && !s.resolved);
          if (!alreadyExists) {
            alertsToPersist.push({
              type: 'drug_interaction',
              severity: 'high',
              medicineId: conflict.medicineA.id,
              batchId: null,
              message: msg,
            });
          }
        }
      }

      const payloads = [];
      for (const item of alertsToPersist.slice(0, 100)) {
        const desired = {};
        if (alertCols.medicine && item.medicineId) desired[alertCols.medicine] = item.medicineId;
        if (alertCols.batch && item.batchId) desired[alertCols.batch] = item.batchId;
        if (alertCols.type) {
          desired[alertCols.type] = resolveEnumValue(columns, 'inventory_alerts', alertCols.type, [item.type, 'low_stock']);
        }
        if (alertCols.severity) {
          desired[alertCols.severity] = resolveEnumValue(columns, 'inventory_alerts', alertCols.severity, [item.severity, 'medium']);
        }
        if (alertCols.message) desired[alertCols.message] = item.message;
        if (alertCols.resolved) desired[alertCols.resolved] = false;
        if (alertCols.pharmacy && pharmacyId) desired[alertCols.pharmacy] = pharmacyId;
        const payload = payloadFor(columns, 'inventory_alerts', desired);
        if (Object.keys(payload).length > 0) payloads.push(payload);
      }

      if (payloads.length > 0) {
        const ins = await admin.from('inventory_alerts').insert(payloads);
        if (ins.error) alertSync.error = ins.error.message;
        else alertSync.persistedNew = payloads.length;
      }

      if (alertCols.resolved && toResolve.length > 0) {
        for (const item of toResolve.slice(0, 50)) {
          let upd = admin
            .from('inventory_alerts')
            .update({ [alertCols.resolved]: true })
            .eq(alertCols.id, item.id);
          upd = scopeQueryByPharmacyId(upd, columns, 'alerts', pharmacyId);
          const { error: updErr } = await upd;
          if (!updErr) alertSync.autoResolved += 1;
        }
      }
    }
  }

  // 5) وكيل التحليل والتقارير: ملخص مالي وحركي وحفظ لقطة تلقائية
  const summary = buildInventorySummary({ medicines, batches, movements }, now);
  let inbound = 0;
  let outbound = 0;
  for (const m of movements) {
    const qty = Math.abs(Number(m.quantity) || 0);
    if (INCREASING_MOVEMENTS.includes(m.type)) inbound += qty;
    else if (DECREASING_MOVEMENTS.includes(m.type)) outbound += qty;
  }
  const expiredCost = Number(
    batches
      .filter((b) => b.expiryBucket === 'expired' && b.quantity > 0)
      .reduce((sum, b) => sum + b.quantity * (Number(b.costPrice) || 0), 0)
      .toFixed(2),
  );

  const reportText = formatSweepArabicReport({
    pharmacyName,
    trigger,
    summary,
    alerts: computedAlerts,
    alertSync,
    fefoQueue,
    interactions: interactionConflicts,
    expiredCost,
    inbound,
    outbound,
    ranAt,
  });

  const auditPayload = {
    kind: 'autonomous_sweep',
    trigger,
    triggerLabel: TRIGGER_LABELS[trigger] ?? trigger,
    intervalHours: schedulerState.intervalHours,
    ranAt,
    pharmacyId,
    pharmacyName,
    agents: {
      inventory_agent: {
        label: 'وكيل إدارة المخزون',
        medicinesScanned: medicines.length,
        batchesScanned: batches.length,
        alertsDetected: computedAlerts.length,
        highSeverityAlerts: computedAlerts.filter((a) => a.severity === 'high').length,
        fefoReadyMedicines: fefoQueue.length,
        persistedNewAlerts: alertSync.persistedNew,
        autoResolvedAlerts: alertSync.autoResolved,
      },
      safety_agent: {
        label: 'وكيل سلامة الأدوية',
        interactionsCatalogRows: interactionRows.length,
        inventoryConflictsCount: interactionConflicts.length,
        criticalConflictsCount: interactionConflicts.filter((c) => severityRank(c.severity) === 0).length,
        conflicts: interactionConflicts.slice(0, 25),
      },
      analytics_agent: {
        label: 'وكيل التحليل والتقارير',
        movementsScanned: movements.length,
        inboundUnits: inbound,
        outboundUnits: outbound,
        costValue: summary.value.cost,
        sellingValue: summary.value.selling,
        expiredCostLoss: expiredCost,
      },
    },
    summary,
    fefoTop: fefoQueue.slice(0, 15),
    alerts: computedAlerts.slice(0, 50),
  };

  // حفظ التقرير في جدول reports
  let reportSaved = false;
  let reportError = null;
  const reportCols = columns.reports ?? {};
  if (reportCols.id && (!reportCols.pharmacy || pharmacyId)) {
    const title = `فحص آلي شامل (${TRIGGER_LABELS[trigger] ?? trigger}) — ${ranAt.slice(0, 16).replace('T', ' ')}`;
    const desired = {};
    if (reportCols.type) {
      desired[reportCols.type] = resolveEnumValue(columns, 'reports', reportCols.type, [
        'autonomous_audit',
        'inventory_snapshot',
        'summary',
      ]);
    }
    if (reportCols.title) desired[reportCols.title] = title;
    if (reportCols.payload) {
      desired[reportCols.payload] = isJsonColumn(columns, 'reports', reportCols.payload)
        ? auditPayload
        : reportText;
    }
    if (reportCols.user && triggeredBy) desired[reportCols.user] = triggeredBy;
    if (reportCols.pharmacy && pharmacyId) desired[reportCols.pharmacy] = pharmacyId;

    const payload = payloadFor(columns, 'reports', desired);
    if (Object.keys(payload).length > 0) {
      const { error } = await admin.from('reports').insert(payload);
      if (error) reportError = error.message;
      else reportSaved = true;
    }
  }

  // تسجيل الفحص في جدول agent_runs
  let runSaved = false;
  let runError = null;
  const runCols = columns.agentRuns ?? {};
  if (runCols.id && (!runCols.pharmacy || pharmacyId)) {
    const promptText = `فحص تلقائي شامل للوكلاء الثلاثة (${TRIGGER_LABELS[trigger] ?? trigger})`;
    const desired = {};
    if (runCols.agentType) {
      desired[runCols.agentType] = resolveEnumValue(columns, 'agent_runs', runCols.agentType, [
        'autonomous_sweep',
        'all_agents',
        'inventory_agent',
      ]);
    }
    if (runCols.prompt) {
      desired[runCols.prompt] = isJsonColumn(columns, 'agent_runs', runCols.prompt)
        ? { question: promptText, kind: 'autonomous_sweep', trigger, intervalHours: schedulerState.intervalHours }
        : promptText;
    }
    if (runCols.answer) {
      desired[runCols.answer] = isJsonColumn(columns, 'agent_runs', runCols.answer)
        ? { answer: reportText, ...auditPayload }
        : reportText;
    }
    if (runCols.status) {
      desired[runCols.status] = resolveEnumValue(columns, 'agent_runs', runCols.status, ['completed', 'success', 'done']);
    }
    if (runCols.user && triggeredBy) desired[runCols.user] = triggeredBy;
    if (runCols.pharmacy && pharmacyId) desired[runCols.pharmacy] = pharmacyId;

    const payload = payloadFor(columns, 'agent_runs', desired);
    if (Object.keys(payload).length > 0) {
      const { error } = await admin.from('agent_runs').insert(payload);
      if (error) runError = error.message;
      else runSaved = true;
    }
  }

  return {
    pharmacyId,
    pharmacyName,
    ranAt,
    trigger,
    reportText,
    audit: auditPayload,
    persistence: {
      alerts: alertSync,
      reportSaved,
      reportError,
      runSaved,
      runError,
    },
  };
}

export async function runAutonomousSweep({
  admin,
  columns,
  pharmacyId = null,
  trigger = 'scheduled',
  triggeredBy = null,
  now = new Date(),
}) {
  if (!admin) throw new Error('Supabase admin client is not configured');

  schedulerState.running = true;
  schedulerState.lastError = null;
  try {
    let pharmacies = [];
    if (pharmacyId) {
      pharmacies = [{ id: String(pharmacyId), name: 'صيدليتك' }];
    } else {
      pharmacies = await discoverPharmacies(admin, columns);
    }

    const results = [];
    for (const pharmacy of pharmacies) {
      const res = await auditSinglePharmacy({
        admin,
        columns,
        pharmacy,
        trigger,
        triggeredBy,
        now,
      });
      results.push(res);
    }

    const finishedAt = new Date().toISOString();
    schedulerState.lastRunAt = finishedAt;
    schedulerState.lastTrigger = trigger;
    schedulerState.lastSummary = {
      pharmaciesScanned: results.length,
      totalAlertsDetected: results.reduce((s, r) => s + (r.audit?.agents?.inventory_agent?.alertsDetected ?? 0), 0),
      totalInteractionsFound: results.reduce((s, r) => s + (r.audit?.agents?.safety_agent?.inventoryConflictsCount ?? 0), 0),
    };
    if (schedulerState.active) {
      schedulerState.nextRunAt = new Date(Date.now() + schedulerState.intervalHours * 3600_000).toISOString();
    }

    return {
      ok: true,
      trigger,
      triggerLabel: TRIGGER_LABELS[trigger] ?? trigger,
      intervalHours: schedulerState.intervalHours,
      ranAt: finishedAt,
      pharmaciesScanned: results.length,
      results,
    };
  } catch (error) {
    schedulerState.lastError = String(error?.message ?? error);
    throw error;
  } finally {
    schedulerState.running = false;
  }
}

export async function getLatestSweepForPharmacy(admin, columns, pharmacyId = null) {
  const status = getSchedulerState();
  let latest = null;

  const reportCols = columns.reports ?? {};
  if (reportCols.id) {
    let q = admin.from('reports').select('*').limit(15);
    q = scopeQueryByPharmacyId(q, columns, 'reports', pharmacyId);
    if (reportCols.createdAt) q = q.order(reportCols.createdAt, { ascending: false });
    const { data, error } = await q;
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const typeVal = reportCols.type ? String(row[reportCols.type] ?? '') : '';
        const titleVal = reportCols.title ? String(row[reportCols.title] ?? '') : '';
        const payloadVal = reportCols.payload ? row[reportCols.payload] : null;
        if (
          typeVal === 'autonomous_audit' ||
          titleVal.includes('فحص آلي شامل') ||
          (payloadVal && typeof payloadVal === 'object' && payloadVal.kind === 'autonomous_sweep')
        ) {
          latest = {
            source: 'reports',
            id: row[reportCols.id] ?? null,
            title: titleVal || null,
            createdAt: reportCols.createdAt ? row[reportCols.createdAt] ?? null : null,
            audit: payloadVal && typeof payloadVal === 'object' ? payloadVal : null,
            reportText: typeof payloadVal === 'string' ? payloadVal : null,
          };
          break;
        }
      }
    }
  }

  if (!latest && columns.agentRuns?.id) {
    const runCols = columns.agentRuns;
    let q = admin.from('agent_runs').select('*').limit(15);
    q = scopeQueryByPharmacyId(q, columns, 'agentRuns', pharmacyId);
    if (runCols.createdAt) q = q.order(runCols.createdAt, { ascending: false });
    const { data, error } = await q;
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const promptVal = runCols.prompt ? row[runCols.prompt] : null;
        const answerVal = runCols.answer ? row[runCols.answer] : null;
        const promptStr = typeof promptVal === 'string' ? promptVal : promptVal?.question ?? '';
        const isSweep =
          (typeof promptVal === 'object' && promptVal?.kind === 'autonomous_sweep') ||
          String(promptStr).includes('فحص تلقائي شامل');
        if (isSweep) {
          latest = {
            source: 'agent_runs',
            id: row[runCols.id] ?? null,
            title: promptStr,
            createdAt: runCols.createdAt ? row[runCols.createdAt] ?? null : null,
            audit: typeof answerVal === 'object' && answerVal?.agents ? answerVal : null,
            reportText: typeof answerVal === 'string' ? answerVal : answerVal?.answer ?? null,
          };
          break;
        }
      }
    }
  }

  const lastTimestamp = latest?.createdAt || status.lastRunAt || null;
  let nextScheduledAt = status.nextRunAt;
  if (!nextScheduledAt && lastTimestamp) {
    const parsed = new Date(lastTimestamp);
    if (!Number.isNaN(parsed.getTime())) {
      nextScheduledAt = new Date(parsed.getTime() + status.intervalHours * 3600_000).toISOString();
    }
  }

  return {
    scheduler: {
      ...status,
      lastRunAt: lastTimestamp,
      nextRunAt: nextScheduledAt,
    },
    latest,
  };
}

async function hasRecentGlobalSweep(admin, columns, withinHours) {
  const cutoffMs = Date.now() - withinHours * 3600_000;
  const runCols = columns.agentRuns ?? {};
  if (!runCols.id || !runCols.createdAt) return false;

  const { data, error } = await admin
    .from('agent_runs')
    .select('*')
    .order(runCols.createdAt, { ascending: false })
    .limit(10);
  if (error || !Array.isArray(data)) return false;

  for (const row of data) {
    const promptVal = runCols.prompt ? row[runCols.prompt] : null;
    const promptStr = typeof promptVal === 'string' ? promptVal : promptVal?.question ?? '';
    const isSweep =
      (typeof promptVal === 'object' && promptVal?.kind === 'autonomous_sweep') ||
      String(promptStr).includes('فحص تلقائي شامل');
    if (!isSweep) continue;
    const ts = new Date(row[runCols.createdAt]).getTime();
    if (Number.isFinite(ts) && ts >= cutoffMs) return true;
  }
  return false;
}

/** يبدأ مجدول الوكلاء التلقائي داخل السيرفر كل 6 ساعات دون تداخل. */
export function startAutonomousAgentScheduler({ getAdmin, inventoryColumns, intervalHours = SWEEP_INTERVAL_HOURS_DEFAULT }) {
  const admin = getAdmin();
  if (!admin) return { started: false, reason: 'supabase_not_configured' };
  if (schedulerTimer || startupTimer) return { started: true, alreadyRunning: true };

  const hours = Number.isFinite(intervalHours) && intervalHours >= 1 ? intervalHours : SWEEP_INTERVAL_HOURS_DEFAULT;
  const intervalMs = hours * 3600_000;
  schedulerState.active = true;
  schedulerState.intervalHours = hours;
  schedulerState.nextRunAt = new Date(Date.now() + intervalMs).toISOString();

  const execute = async (trigger) => {
    if (schedulerState.running) return;
    const client = getAdmin();
    if (!client) return;
    try {
      const columns = await inventoryColumns();
      if (!columns?.schemaOk) return;
      await runAutonomousSweep({ admin: client, columns, trigger });
    } catch (error) {
      console.error('[pharmaguard] autonomous sweep failed:', error?.message ?? error);
    }
  };

  startupTimer = setTimeout(async () => {
    startupTimer = null;
    const client = getAdmin();
    if (!client) return;
    try {
      const columns = await inventoryColumns();
      if (!columns?.schemaOk) return;
      const recent = await hasRecentGlobalSweep(client, columns, hours);
      if (!recent) {
        await execute('startup');
      }
    } catch (error) {
      console.error('[pharmaguard] startup sweep check failed:', error?.message ?? error);
    }
  }, 15_000);
  startupTimer.unref?.();

  schedulerTimer = setInterval(() => {
    execute('scheduled');
  }, intervalMs);
  schedulerTimer.unref?.();

  return { started: true, intervalHours: hours };
}
