/**
 * العامل الخلفي الدائم لوكيل سلامة الأدوية متعدد المصادر (داخل الخادم):
 * - يعمل تلقائيًا داخل السيرفر (بصرف النظر عن إغلاق الهاتف أو Google AI Studio، رهن استمرارية الخادم Always-On).
 * - يُطلق فحصًا فوريًا عند إضافة دواء أو تعديله أو استيراده.
 * - ينفذ دورات دورية للتحقق من تحديثات المصادر ومعالجة المهام المتأخرة والفاشلة (Retry Queue بتراجع أسي).
 * - يمنع تكرار المهام والنتائج عبر بصمات الحفظ والتوقيت (Deduplication).
 * - يسجّل وقت آخر فحص ونتائجه وأخطاءه.
 * - يلتزم بالشرط #7: لا يكتب سجلات بحث جديدة في agent_runs / reports / inventory_alerts
 *   ما لم يُفعّل SAFETY_PERSIST_VERIFIED=true بعد التحقق من توافق الأعمدة والقيود.
 */

import { env } from '../env.js';
import { payloadFor, shapeMedicine } from '../inventory.js';
import { SAFETY_CLASSIFICATION } from './constants.js';
import { analyzeDrugPair, analyzeSingleMedicine } from './analyzer.js';
import { getSourcesTelemetry } from './sources/index.js';
import { inspectSafetyStorageCompatibility } from './storageCompat.js';

const MAX_FINDINGS = 60;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 15_000;
const WORKER_TICK_MS = 5_000;
const MAX_MEDS_PER_CYCLE = 20;
const MAX_PAIRS_PER_CYCLE = 12;

const GLOBAL_KEY = '__global__';

const workerState = {
  active: false,
  running: false,
  intervalMinutes: 60,
  startedAt: null,
  lastRunAt: null,
  lastPeriodicRunAt: null,
  nextPeriodicRunAt: null,
  lastTrigger: null,
  lastReason: null,
  lastError: null,
  cycleCount: 0,
  stats: {
    totalChecks: 0,
    succeededChecks: 0,
    failedChecks: 0,
    retriedSuccesses: 0,
    deduplicatedSkips: 0,
  },
  hostingContinuityNote:
    'يعمل الوكيل داخل عملية السيرفر الخلفية ويستمر عند إغلاق الهاتف أو Google AI Studio ما دامت خدمة الاستضافة قيد التشغيل المستمر (Always-On) ولا تُسبت العملية.',
};

const queue = [];
const queuedKeys = new Set();
const retryQueue = new Map();
const resultsByPharmacy = new Map();
const processedHashesByPharmacy = new Map();
const cursorByPharmacy = new Map();

let runtime = null;
let tickTimer = null;
let periodicTimer = null;

function keyForPharmacy(pharmacyId) {
  return pharmacyId ? String(pharmacyId) : GLOBAL_KEY;
}

function getPharmacyStore(pharmacyId) {
  const k = keyForPharmacy(pharmacyId);
  if (!resultsByPharmacy.has(k)) {
    resultsByPharmacy.set(k, {
      pharmacyId: pharmacyId ? String(pharmacyId) : null,
      lastCheckedAt: null,
      lastError: null,
      medicinesAnalyzed: 0,
      pairsChecked: 0,
      coverage: null,
      pairFindings: [],
      medicineWarnings: [],
      errorsLog: [],
    });
  }
  return resultsByPharmacy.get(k);
}

function upsertPairFinding(store, finding) {
  const existingIdx = store.pairFindings.findIndex((f) => f.pairKey === finding.pairKey);
  if (existingIdx >= 0) {
    store.pairFindings[existingIdx] = finding;
  } else {
    store.pairFindings.unshift(finding);
  }
  store.pairFindings.sort((a, b) => (a.classification?.rank ?? 9) - (b.classification?.rank ?? 9));
  if (store.pairFindings.length > MAX_FINDINGS) {
    store.pairFindings.length = MAX_FINDINGS;
  }
}

function upsertMedicineAnalysis(store, analysis) {
  const medId = analysis?.medicine?.id || analysis?.medicine?.name;
  const existingIdx = store.medicineWarnings.findIndex((w) => (w.medicine?.id || w.medicine?.name) === medId);
  if (existingIdx >= 0) {
    store.medicineWarnings[existingIdx] = analysis;
  } else {
    store.medicineWarnings.unshift(analysis);
  }
  if (store.medicineWarnings.length > MAX_FINDINGS) {
    store.medicineWarnings.length = MAX_FINDINGS;
  }
}

function computeInventorySafetyHash(medicines = [], targetMedicineId = null) {
  const sig = medicines
    .filter((m) => m && m.isActive !== false)
    .map((m) => `${m.id}:${m.name ?? ''}:${m.scientificName ?? ''}:${m.strength ?? ''}:${m.form ?? ''}`)
    .sort()
    .join('|');
  return `${targetMedicineId ?? 'all'}::${sig}`;
}

export function registerSafetyRuntime(deps) {
  runtime = deps;
}

/**
 * يضيف مهمة فحص دوائي إلى الطابور مع منع التكرار لنفس الدواء/السبب.
 */
export function enqueueSafetyTask({
  pharmacyId = null,
  trigger = 'reactive',
  reason = 'تحديث قائمة الأدوية',
  targetMedicineId = null,
  force = false,
} = {}) {
  const pKey = keyForPharmacy(pharmacyId);
  const taskKey = `${pKey}::${targetMedicineId ?? 'all'}::${trigger}`;

  if (!force && queuedKeys.has(taskKey)) {
    workerState.stats.deduplicatedSkips += 1;
    return { queued: false, deduplicated: true, taskKey };
  }

  queuedKeys.add(taskKey);
  queue.push({
    taskKey,
    pharmacyId: pharmacyId ? String(pharmacyId) : null,
    trigger,
    reason,
    targetMedicineId: targetMedicineId ? String(targetMedicineId) : null,
    force,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  });

  return { queued: true, deduplicated: false, taskKey, queueLength: queue.length };
}

function scheduleRetryTask(task, errorMsg) {
  const nextAttempt = (task.attempts ?? 0) + 1;
  if (nextAttempt > MAX_RETRIES) {
    const store = getPharmacyStore(task.pharmacyId);
    store.errorsLog.unshift({
      at: new Date().toISOString(),
      trigger: task.trigger,
      reason: task.reason,
      error: `تجاوز الحد الأقصى لإعادة المحاولة (${MAX_RETRIES}): ${errorMsg}`,
    });
    store.errorsLog = store.errorsLog.slice(0, 20);
    return false;
  }

  const delayMs = RETRY_BASE_MS * Math.pow(2, nextAttempt - 1);
  retryQueue.set(task.taskKey, {
    ...task,
    attempts: nextAttempt,
    lastError: errorMsg,
    nextRetryAt: Date.now() + delayMs,
  });
  return true;
}

async function fetchPharmacyMedicines(admin, columns, pharmacyId) {
  const pharmCol = columns?.medicines?.pharmacy;
  if (pharmCol && !pharmacyId) return [];
  let q = admin.from('medicines').select('*').limit(500);
  if (pharmCol && pharmacyId) q = q.eq(pharmCol, pharmacyId);
  const { data, error } = await q;
  if (error) throw new Error(`فشل قراءة medicines: ${error.message}`);
  return (data ?? [])
    .filter((r) => !pharmCol || !pharmacyId || String(r[pharmCol] ?? '') === String(pharmacyId))
    .map((r) => shapeMedicine(r, columns.medicines))
    .filter((m) => m && m.isActive !== false);
}

async function fetchLocalInteractions(admin, columns, pharmacyId) {
  const cols = columns?.interactions ?? {};
  if (!cols.id || !cols.drugA || !cols.drugB) return [];
  let q = admin.from('drug_interactions').select('*').limit(1000);
  if (cols.pharmacy) {
    const safePid = pharmacyId ? String(pharmacyId).replace(/[^a-zA-Z0-9_-]/g, '') : '';
    if (safePid) {
      q = q.or(`${cols.pharmacy}.eq.${safePid},${cols.pharmacy}.is.null`);
    } else {
      q = q.is(cols.pharmacy, null);
    }
  }
  const { data, error } = await q;
  if (error || !Array.isArray(data)) return [];
  return data
    .filter((row) => {
      if (!cols.pharmacy) return true;
      const rowPid = row[cols.pharmacy] != null ? String(row[cols.pharmacy]) : null;
      if (pharmacyId) return rowPid === null || rowPid === String(pharmacyId);
      return rowPid === null;
    })
    .map((row) => ({
      drugA: row[cols.drugA] ?? null,
      drugB: row[cols.drugB] ?? null,
      severity: cols.severity ? row[cols.severity] ?? null : null,
      description: cols.description ? row[cols.description] ?? null : null,
      source: cols.source ? row[cols.source] ?? null : null,
    }));
}

async function maybePersistVerifiedSafetySummary(admin, columns, pharmacyId, store, trigger) {
  if (!env.safetyPersistVerified) {
    return {
      persisted: false,
      skippedReason: 'condition_7_verification_required',
    };
  }
  const compat = inspectSafetyStorageCompatibility(columns);
  if (!compat.allCompatible) {
    return {
      persisted: false,
      skippedReason: 'storage_incompatible',
      compat,
    };
  }

  // لا يُكتب إلا عند تأكيد التوافق وتفعيل SAFETY_PERSIST_VERIFIED=true
  const runCols = columns.agentRuns ?? {};
  if (runCols.id && (!runCols.pharmacy || pharmacyId)) {
    const desired = {};
    if (runCols.agentType) desired[runCols.agentType] = 'safety_agent';
    if (runCols.prompt) desired[runCols.prompt] = `فحص مصادر سلامة الأدوية (${trigger})`;
    if (runCols.answer) {
      desired[runCols.answer] = JSON.stringify({
        checkedAt: store.lastCheckedAt,
        medicinesAnalyzed: store.medicinesAnalyzed,
        pairsChecked: store.pairsChecked,
        documentedInteractions: store.pairFindings.filter(
          (f) => f.classification?.code === SAFETY_CLASSIFICATION.DOCUMENTED_INTERACTION.code,
        ).length,
      });
    }
    if (runCols.status) desired[runCols.status] = 'completed';
    if (runCols.pharmacy && pharmacyId) desired[runCols.pharmacy] = pharmacyId;
    const payload = payloadFor(columns, 'agent_runs', desired);
    if (Object.keys(payload).length > 0) {
      const { error } = await admin.from('agent_runs').insert(payload);
      if (error) return { persisted: false, error: error.message };
      return { persisted: true };
    }
  }
  return { persisted: false, skippedReason: 'no_writable_columns' };
}

function pickRotatingMedicineWindow(sortedMeds, startOffset, limit) {
  const n = sortedMeds.length;
  if (n === 0) return { items: [], nextOffset: 0 };
  const start = ((startOffset % n) + n) % n;
  const count = Math.min(limit, n);
  const items = [];
  for (let idx = 0; idx < count; idx += 1) {
    items.push(sortedMeds[(start + idx) % n]);
  }
  return {
    items,
    nextOffset: (start + count) % n,
  };
}

function pickRotatingPairWindow(sortedMeds, startPairOffset, limit) {
  const n = sortedMeds.length;
  const totalPairs = Math.floor((n * (n - 1)) / 2);
  if (totalPairs === 0) return { pairs: [], totalPairs: 0, nextPairOffset: 0 };
  const start = ((startPairOffset % totalPairs) + totalPairs) % totalPairs;
  const count = Math.min(limit, totalPairs);
  const pairs = [];

  let offset = start;
  let i = 0;
  while (i < n - 1) {
    const rowLen = n - 1 - i;
    if (offset < rowLen) break;
    offset -= rowLen;
    i += 1;
  }
  let j = i + 1 + offset;

  for (let k = 0; k < count; k += 1) {
    pairs.push([sortedMeds[i], sortedMeds[j]]);
    j += 1;
    if (j >= n) {
      i += 1;
      if (i >= n - 1) i = 0;
      j = i + 1;
    }
  }

  return {
    pairs,
    totalPairs,
    nextPairOffset: (start + count) % totalPairs,
  };
}

/**
 * ينفذ فحص سلامة متعدد المصادر لمخزون صيدلية (أو مقارنة دواء مضاف بجميع الأدوية الأخرى)
 * مع تدوير نوافذ الفحص عبر الدورات الدورية وإعادة استخدام الهوية والنشرات دون تكرار.
 */
export async function executeSafetyResearchTask(task, deps = runtime) {
  const admin = deps?.getAdmin?.();
  if (!admin) throw new Error('Supabase غير مهيأ.');

  const columns = await deps.inventoryColumns();
  if (!columns?.schemaOk) throw new Error('تعذر قراءة مخطط الجداول.');

  const store = getPharmacyStore(task.pharmacyId);
  const medicines = await fetchPharmacyMedicines(admin, columns, task.pharmacyId);
  const localInteractions = await fetchLocalInteractions(admin, columns, task.pharmacyId);

  const pKey = keyForPharmacy(task.pharmacyId);
  const currentHash = computeInventorySafetyHash(medicines, task.targetMedicineId);
  if (!task.force && task.trigger !== 'periodic' && processedHashesByPharmacy.get(pKey) === currentHash) {
    workerState.stats.deduplicatedSkips += 1;
    return { skipped: true, reason: 'unchanged_inventory_deduplicated', pharmacyId: task.pharmacyId };
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sortedMeds = [...medicines].sort((a, b) =>
    String(a.id ?? a.name).localeCompare(String(b.id ?? b.name)),
  );
  const cursor = cursorByPharmacy.get(pKey) ?? { medOffset: 0, pairOffset: 0 };

  let selectedPairs = [];
  let totalPossiblePairs = Math.floor((sortedMeds.length * (sortedMeds.length - 1)) / 2);
  let nextMedOffset = cursor.medOffset;
  let nextPairOffset = cursor.pairOffset;
  const medsMap = new Map();

  const addMedToBatch = (med) => {
    if (!med) return;
    const k = String(med.id ?? med.name);
    if (!medsMap.has(k)) medsMap.set(k, med);
  };

  if (task.targetMedicineId) {
    const targetMed = sortedMeds.find((m) => String(m.id) === String(task.targetMedicineId));
    if (targetMed) {
      addMedToBatch(targetMed);
      const others = sortedMeds.filter((m) => String(m.id) !== String(targetMed.id));
      for (const other of others.slice(0, MAX_PAIRS_PER_CYCLE)) {
        selectedPairs.push([targetMed, other]);
        addMedToBatch(other);
      }
    }
  }

  if (selectedPairs.length === 0 && sortedMeds.length > 0) {
    const pairPick = pickRotatingPairWindow(sortedMeds, cursor.pairOffset, MAX_PAIRS_PER_CYCLE);
    selectedPairs = pairPick.pairs;
    totalPossiblePairs = pairPick.totalPairs;
    nextPairOffset = pairPick.nextPairOffset;

    for (const [mA, mB] of selectedPairs) {
      addMedToBatch(mA);
      addMedToBatch(mB);
    }

    const medPick = pickRotatingMedicineWindow(sortedMeds, cursor.medOffset, MAX_MEDS_PER_CYCLE);
    nextMedOffset = medPick.nextOffset;
    for (const med of medPick.items) {
      if (medsMap.size >= Math.max(MAX_MEDS_PER_CYCLE, selectedPairs.length * 2)) break;
      addMedToBatch(med);
    }
  } else if (sortedMeds.length > 0 && medsMap.size < MAX_MEDS_PER_CYCLE) {
    const medPick = pickRotatingMedicineWindow(sortedMeds, cursor.medOffset, MAX_MEDS_PER_CYCLE);
    for (const med of medPick.items) {
      if (medsMap.size >= MAX_MEDS_PER_CYCLE) break;
      addMedToBatch(med);
    }
  }

  cursorByPharmacy.set(pKey, { medOffset: nextMedOffset, pairOffset: nextPairOffset });

  const activeMeds = [...medsMap.values()];
  const identities = new Map();
  const monographs = new Map();

  // فحص مفرد واحد لكل دواء في نافذة الدورة (مع includeDailyMedXml: false لتجنب جلب XML بلا داعٍ وتكرار النداءات)
  for (const med of activeMeds) {
    const k = String(med.id ?? med.name);
    let resolvedId = null;
    let resolvedMono = null;

    const singleAnalysis = await analyzeSingleMedicine(med, {
      fetchImpl,
      includeDailyMedXml: false,
      openserpUrl: env.openserpUrl,
      searxngUrl: env.searxngUrl,
      onResolvedState: ({ identity, monographs: mono }) => {
        resolvedId = identity;
        resolvedMono = mono;
      },
    });
    if (resolvedId) identities.set(k, resolvedId);
    if (resolvedMono) monographs.set(k, resolvedMono);
    upsertMedicineAnalysis(store, singleAnalysis);
  }

  let cycleFailedSources = 0;
  let reSearchedPairs = 0;
  for (const [medA, medB] of selectedPairs.slice(0, MAX_PAIRS_PER_CYCLE)) {
    const kA = String(medA.id ?? medA.name);
    const kB = String(medB.id ?? medB.name);
    workerState.stats.totalChecks += 1;

    const result = await analyzeDrugPair(medA, medB, {
      fetchImpl,
      preResolvedA: identities.get(kA) ?? null,
      preResolvedB: identities.get(kB) ?? null,
      preMonographsA: monographs.get(kA) ?? null,
      preMonographsB: monographs.get(kB) ?? null,
      localInteractions,
      includeWebSearch: false,
      openserpUrl: env.openserpUrl,
      searxngUrl: env.searxngUrl,
    });

    if (result.researchTrace?.reSearchTriggered) {
      reSearchedPairs += 1;
    }

    upsertPairFinding(store, result);
    if (result.classification?.code === SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED.code) {
      workerState.stats.failedChecks += 1;
      cycleFailedSources += 1;
    } else {
      workerState.stats.succeededChecks += 1;
      if ((task.attempts ?? 0) > 0) workerState.stats.retriedSuccesses += 1;
    }
  }

  store.lastCheckedAt = new Date().toISOString();
  store.medicinesAnalyzed = activeMeds.length;
  store.pairsChecked = selectedPairs.length;
  store.reSearchedPairs = reSearchedPairs;
  store.coverage = {
    totalMedicinesInInventory: sortedMeds.length,
    totalPossiblePairs,
    medicinesPerCycleLimit: MAX_MEDS_PER_CYCLE,
    pairsPerCycleLimit: MAX_PAIRS_PER_CYCLE,
    scannedMedicinesInLastCycle: activeMeds.length,
    scannedPairsInLastCycle: selectedPairs.length,
    nextMedicineOffset: nextMedOffset,
    nextPairOffset,
    cyclesForFullPairCoverage: totalPossiblePairs > 0 ? Math.ceil(totalPossiblePairs / MAX_PAIRS_PER_CYCLE) : 1,
    note:
      sortedMeds.length > MAX_MEDS_PER_CYCLE || totalPossiblePairs > MAX_PAIRS_PER_CYCLE
        ? `للحفاظ على استقرار الخادم وحدود المصادر الخارجية، يفحص كل دور حتى ${MAX_MEDS_PER_CYCLE} دواءً و${MAX_PAIRS_PER_CYCLE} زوجًا بالتناوب عبر الدورات الدورية حتى تغطية كامل المخزون (${sortedMeds.length} صنفًا / ${totalPossiblePairs} زوجًا).`
        : `تغطية كاملة لمخزون الصيدلية الحالي في دورة واحدة (${sortedMeds.length} صنفًا / ${totalPossiblePairs} زوجًا).`,
  };
  store.lastError = cycleFailedSources > 0 ? `تعذر الوصول لبعض المصادر في ${cycleFailedSources} زوجًا` : null;

  processedHashesByPharmacy.set(pKey, currentHash);

  const persistence = await maybePersistVerifiedSafetySummary(admin, columns, task.pharmacyId, store, task.trigger);

  if (cycleFailedSources > 0 && selectedPairs.length > 0 && cycleFailedSources === selectedPairs.length) {
    scheduleRetryTask(task, store.lastError);
  }

  deps?.onSafetyUpdated?.(task.pharmacyId, getSafetyStatusForPharmacy(task.pharmacyId));

  return {
    skipped: false,
    pharmacyId: task.pharmacyId,
    medicinesAnalyzed: activeMeds.length,
    pairsChecked: selectedPairs.length,
    coverage: store.coverage,
    persistence,
  };
}

async function processNextQueuedOrRetry() {
  if (!runtime || workerState.running) return null;

  // فحص المهام المؤجلة لإعادة المحاولة التي حان وقتها
  const now = Date.now();
  for (const [k, item] of retryQueue.entries()) {
    if (item.nextRetryAt <= now) {
      retryQueue.delete(k);
      queuedKeys.add(item.taskKey);
      queue.push(item);
    }
  }

  const nextTask = queue.shift();
  if (!nextTask) return null;
  queuedKeys.delete(nextTask.taskKey);

  workerState.running = true;
  workerState.lastError = null;
  try {
    const result = await executeSafetyResearchTask(nextTask, runtime);
    workerState.cycleCount += 1;
    workerState.lastRunAt = new Date().toISOString();
    workerState.lastTrigger = nextTask.trigger;
    workerState.lastReason = nextTask.reason;
    if (nextTask.trigger === 'periodic') {
      workerState.lastPeriodicRunAt = workerState.lastRunAt;
      workerState.nextPeriodicRunAt = new Date(Date.now() + workerState.intervalMinutes * 60_000).toISOString();
    }
    return result;
  } catch (error) {
    const msg = String(error?.message ?? error);
    workerState.lastError = msg;
    scheduleRetryTask(nextTask, msg);
    return { error: msg };
  } finally {
    workerState.running = false;
  }
}

export function getSafetyStatusForPharmacy(pharmacyId = null) {
  const store = getPharmacyStore(pharmacyId);
  const counts = {
    documented_interaction: 0,
    documented_warning: 0,
    source_conflict: 0,
    insufficient_information: 0,
    no_interaction_found: 0,
    source_access_failed: 0,
  };

  for (const finding of store.pairFindings) {
    const code = finding?.classification?.code;
    if (code && code in counts) counts[code] += 1;
  }
  for (const single of store.medicineWarnings) {
    if (single?.classification?.code === SAFETY_CLASSIFICATION.DOCUMENTED_WARNING.code) {
      counts.documented_warning += single.warnings?.length ?? 1;
    }
  }

  return {
    worker: {
      ...workerState,
      queuedJobs: queue.length,
      retryQueueSize: retryQueue.size,
      statusLabel: workerState.running ? 'يفحص الآن' : workerState.active ? 'يعمل في الخلفية' : 'متوقف',
    },
    telemetry: getSourcesTelemetry(),
    pharmacy: {
      pharmacyId: store.pharmacyId,
      lastCheckedAt: store.lastCheckedAt,
      lastError: store.lastError,
      medicinesAnalyzed: store.medicinesAnalyzed,
      pairsChecked: store.pairsChecked,
      coverage: store.coverage,
      counts,
      pairFindings: store.pairFindings.slice(0, 25),
      medicineWarnings: store.medicineWarnings.slice(0, 25),
      errorsLog: store.errorsLog.slice(0, 10),
    },
  };
}

export function notifySafetyMedicineChange(pharmacyId, reason = 'إضافة أو تعديل دواء', targetMedicineId = null) {
  return enqueueSafetyTask({
    pharmacyId,
    trigger: 'reactive',
    reason,
    targetMedicineId,
    force: true,
  });
}

export function startSafetyBackgroundWorker({
  getAdmin,
  inventoryColumns,
  onSafetyUpdated = null,
  intervalMinutes = env.safetyResearchIntervalMinutes,
  fetchImpl = fetch,
} = {}) {
  registerSafetyRuntime({ getAdmin, inventoryColumns, onSafetyUpdated, fetchImpl });

  if (tickTimer || periodicTimer) {
    return { started: true, alreadyRunning: true, intervalMinutes: workerState.intervalMinutes };
  }

  const mins = Number.isFinite(intervalMinutes) && intervalMinutes >= 5 && intervalMinutes <= 1440
    ? Math.trunc(intervalMinutes)
    : 60;

  workerState.active = true;
  workerState.intervalMinutes = mins;
  workerState.startedAt = new Date().toISOString();
  workerState.nextPeriodicRunAt = new Date(Date.now() + 8_000).toISOString();

  // فحص أولي بعد بدء الخادم بـ 8 ثوانٍ لاكتشاف الصيدليات النشطة دون تعطيل الإقلاع
  const startupCheck = setTimeout(async () => {
    try {
      const admin = getAdmin?.();
      if (!admin) return;
      const columns = await inventoryColumns?.();
      const medPharmCol = columns?.medicines?.pharmacy;
      if (medPharmCol) {
        const { data } = await admin.from('medicines').select(medPharmCol).limit(200);
        const ids = [...new Set((data ?? []).map((r) => r[medPharmCol]).filter(Boolean))];
        for (const id of ids.slice(0, 10)) {
          enqueueSafetyTask({ pharmacyId: id, trigger: 'periodic', reason: 'تحقق أولي من المصادر عند بدء التشغيل' });
        }
      } else {
        enqueueSafetyTask({ pharmacyId: null, trigger: 'periodic', reason: 'تحقق أولي من المصادر عند بدء التشغيل' });
      }
    } catch (err) {
      workerState.lastError = String(err?.message ?? err);
    }
  }, 8_000);
  startupCheck.unref?.();

  tickTimer = setInterval(() => {
    processNextQueuedOrRetry().catch((err) => {
      workerState.lastError = String(err?.message ?? err);
    });
  }, WORKER_TICK_MS);
  tickTimer.unref?.();

  periodicTimer = setInterval(async () => {
    try {
      const admin = getAdmin?.();
      if (!admin) return;
      const columns = await inventoryColumns?.();
      const medPharmCol = columns?.medicines?.pharmacy;
      if (medPharmCol) {
        const { data } = await admin.from('medicines').select(medPharmCol).limit(200);
        const ids = [...new Set((data ?? []).map((r) => r[medPharmCol]).filter(Boolean))];
        for (const id of ids.slice(0, 20)) {
          enqueueSafetyTask({ pharmacyId: id, trigger: 'periodic', reason: 'فحص دوري لتحديثات المصادر الطبية', force: true });
        }
      } else {
        enqueueSafetyTask({ pharmacyId: null, trigger: 'periodic', reason: 'فحص دوري لتحديثات المصادر الطبية', force: true });
      }
    } catch (err) {
      workerState.lastError = String(err?.message ?? err);
    }
  }, mins * 60_000);
  periodicTimer.unref?.();

  return { started: true, intervalMinutes: mins };
}

export function stopSafetyBackgroundWorker() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  workerState.active = false;
}

export function __resetSafetyWorkerForTests() {
  stopSafetyBackgroundWorker();
  queue.length = 0;
  queuedKeys.clear();
  retryQueue.clear();
  resultsByPharmacy.clear();
  processedHashesByPharmacy.clear();
  cursorByPharmacy.clear();
  workerState.running = false;
  workerState.cycleCount = 0;
  workerState.lastRunAt = null;
  workerState.lastError = null;
  workerState.stats = {
    totalChecks: 0,
    succeededChecks: 0,
    failedChecks: 0,
    retriedSuccesses: 0,
    deduplicatedSkips: 0,
  };
}
