import express from 'express';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  getLatestSweepForPharmacy,
  getLiveFeedForPharmacy,
  getSchedulerState,
  runAutonomousSweep,
  subscribeAgentEvents,
} from '../agentSweep.js';
import {
  inventoryColumns,
  shapeMedicine,
  shapeBatch,
  shapeMovement,
  buildInventorySummary,
  computeAlerts,
  scopeToPharmacy,
  requirePharmacy,
  payloadFor,
  sortBatchesFefo,
  MOVEMENT_TYPE_LABELS,
  INCREASING_MOVEMENTS,
  DECREASING_MOVEMENTS,
} from '../inventory.js';

const router = express.Router();

/**
 * الوكلاء الذكيون الثلاثة — قواعد صارمة ضد الاختلاق:
 * 1) وكيل إدارة المخزون (النقص، إعادة الطلب، الصلاحية، FEFO، الأرصدة).
 * 2) وكيل سلامة الأدوية (فحص التداخلات من جدول drug_interactions فقط دون اختراع أو تشخيص).
 * 3) وكيل التحليل والتقارير (تحليل الحركات والقيمة والتنبيهات).
 * لا ينفذ الوكيل أي تعديل على المخزون ولا يدّعي تنفيذ عمليات لم تتم عبر الـ API.
 */

export const AGENT_META = Object.freeze({
  inventory_agent: { id: 'inventory_agent', label: 'وكيل إدارة المخزون' },
  safety_agent: { id: 'safety_agent', label: 'وكيل سلامة الأدوية' },
  analytics_agent: { id: 'analytics_agent', label: 'وكيل التحليل والتقارير' },
});

const INTENTS = [
  { id: 'interaction', words: ['تداخل', 'تفاعل', 'تعارض', 'interaction', 'تفاعلات', 'تداخلات', 'سلامة'] },
  { id: 'fefo', words: ['fefo', 'ترتيب الصرف', 'أول دفعة', 'أي دفعة أصرف', 'الأقرب صرف'] },
  {
    id: 'shortage',
    words: ['نقص', 'نواقص', 'نفاد', 'قارب', 'انخفض', 'إعادة الطلب', 'طلب شراء', 'reorder', 'shortage', 'low stock', 'out of stock'],
  },
  { id: 'expiry', words: ['صلاحية', 'انتهاء', 'منتهي', 'منتهية', 'تنتهي', 'expiry', 'expire', 'expiring'] },
  { id: 'movements', words: ['حركة', 'حركات', 'صرف', 'استلام', 'إتلاف', 'مرتجع', 'إرجاع', 'movement', 'dispense'] },
  { id: 'report', words: ['تقرير', 'تحليل', 'ملخص', 'إجمالي', 'قيمة', 'إحصائيات', 'report', 'summary', 'analytics'] },
  { id: 'stock', words: ['كمية', 'كميات', 'مخزون', 'رصيد', 'دفعة', 'دفعات', 'stock', 'quantity'] },
];

const STOP_WORDS = new Set([
  'هل', 'يوجد', 'توجد', 'بين', 'مع', 'عن', 'في', 'من', 'على', 'إلى', 'ما', 'هي', 'هو',
  'تداخل', 'تداخلات', 'تفاعل', 'تفاعلات', 'تعارض', 'دواء', 'أدوية', 'دوائي', 'دوائية',
  'المخزون', 'فحص', 'افحص', 'تحقق', 'سلامة',
  'and', 'with', 'for', 'the', 'any', 'drug', 'drugs', 'interaction', 'interactions', 'check',
]);

export function detectIntent(text) {
  const normalized = String(text ?? '').toLowerCase();
  for (const intent of INTENTS) {
    if (intent.words.some((word) => normalized.includes(word))) return intent.id;
  }
  return 'general';
}

export function agentForIntent(intent) {
  if (intent === 'interaction') return AGENT_META.safety_agent;
  if (intent === 'shortage' || intent === 'expiry' || intent === 'stock' || intent === 'fefo') {
    return AGENT_META.inventory_agent;
  }
  return AGENT_META.analytics_agent;
}

async function loadContext(admin, columns, profile) {
  const reads = {};
  let medQuery = admin.from('medicines').select('*').limit(2000);
  medQuery = scopeToPharmacy(medQuery, columns, 'medicines', profile);
  reads.medicines = await medQuery;

  let batchQuery = admin.from('inventory_batches').select('*').limit(4000);
  batchQuery = scopeToPharmacy(batchQuery, columns, 'batches', profile);
  reads.batches = await batchQuery;

  let moveQuery = admin.from('stock_movements').select('*').limit(500);
  moveQuery = scopeToPharmacy(moveQuery, columns, 'movements', profile);
  if (columns.movements.createdAt) moveQuery = moveQuery.order(columns.movements.createdAt, { ascending: false });
  reads.movements = await moveQuery;

  const now = new Date();
  return {
    medicines: reads.medicines.error ? [] : (reads.medicines.data ?? []).map((row) => shapeMedicine(row, columns.medicines)),
    batches: reads.batches.error ? [] : (reads.batches.data ?? []).map((row) => shapeBatch(row, columns.batches, now)),
    movements: reads.movements.error ? [] : (reads.movements.data ?? []).map((row) => shapeMovement(row, columns.movements)),
    errors: {
      medicines: reads.medicines.error?.message ?? null,
      batches: reads.batches.error?.message ?? null,
      movements: reads.movements.error?.message ?? null,
    },
  };
}

/** يبحث عن جميع الأدوية المذكورة في السؤال بمطابقة نصية على الأسماء الموجودة فعليًا. */
export function findMentionedMedicines(text, medicines) {
  const normalized = String(text ?? '').toLowerCase();
  const matches = [];
  const seen = new Set();

  for (const medicine of medicines) {
    if (!medicine) continue;
    let bestTerm = '';
    for (const candidate of [medicine.name, medicine.scientificName]) {
      const term = String(candidate ?? '').toLowerCase().trim();
      if (term.length < 3) continue;
      if (normalized.includes(term) && term.length > bestTerm.length) {
        bestTerm = term;
      }
    }
    if (bestTerm && !seen.has(String(medicine.id ?? medicine.name))) {
      seen.add(String(medicine.id ?? medicine.name));
      matches.push({ medicine, term: bestTerm });
    }
  }

  matches.sort((a, b) => b.term.length - a.term.length);
  return matches.map((m) => m.medicine);
}

/** يحافظ على التوافق الخلفي بإرجاع أول دواء مطابق. */
export function findMentionedMedicine(text, medicines) {
  return findMentionedMedicines(text, medicines)[0] ?? null;
}

function sanitizePostgrestTerm(value) {
  return String(value ?? '')
    .replace(/[,%()*\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDrugSearchGroups(text, matchedMedicines = [], allMedicines = []) {
  const groups = [];
  const coveredTokens = new Set();

  for (const med of matchedMedicines) {
    const terms = [med?.name, med?.scientificName]
      .map((v) => sanitizePostgrestTerm(v))
      .filter((v) => v.length >= 2);
    if (terms.length > 0) {
      groups.push(terms);
      for (const term of terms) {
        for (const tok of term.toLowerCase().split(/\s+/)) coveredTokens.add(tok);
      }
    }
  }

  const words = String(text ?? '')
    .split(/[\s،,.;:!?؟/\\()[\]{}"'+]+/)
    .map((word) => sanitizePostgrestTerm(word))
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLowerCase()));

  for (const word of words) {
    const lower = word.toLowerCase();
    if (coveredTokens.has(lower)) continue;
    groups.push([word]);
    coveredTokens.add(lower);
  }

  const normalized = String(text ?? '').toLowerCase();
  const scanInventory =
    groups.length === 0 &&
    (normalized.includes('مخزون') || normalized.includes('inventory') || normalized.includes('جميع') || normalized.includes('أدوية'));

  if (scanInventory && Array.isArray(allMedicines)) {
    for (const med of allMedicines.slice(0, 15)) {
      const terms = [med?.scientificName, med?.name]
        .map((v) => sanitizePostgrestTerm(v))
        .filter((v) => v.length >= 2);
      if (terms.length > 0) groups.push(terms);
    }
  }

  return { groups: groups.slice(0, 10), scanInventory };
}

export async function interactionsFor(admin, columns, text, medicineOrList, allMedicines = []) {
  const cols = columns.interactions ?? {};
  if (!cols.id || (!cols.drugA && !cols.drugB)) {
    return { available: false, rows: [], pairMatches: [], reason: 'جدول التداخلات غير متاح أو لا يحتوي أعمدة أسماء الدواء.' };
  }

  const matchedMedicines = Array.isArray(medicineOrList)
    ? medicineOrList
    : medicineOrList
      ? [medicineOrList]
      : [];

  const { groups, scanInventory } = extractDrugSearchGroups(text, matchedMedicines, allMedicines);
  const flatTerms = [...new Set(groups.flat())].slice(0, 12);

  const colMetaA = columns.tables?.drug_interactions?.columns?.find((c) => c.name === cols.drugA);
  const colMetaB = columns.tables?.drug_interactions?.columns?.find((c) => c.name === cols.drugB);
  const isUuidA = Boolean(cols.drugA && (colMetaA?.type === 'uuid' || colMetaA?.foreignKey === true || cols.drugA.endsWith('_id')));
  const isUuidB = Boolean(cols.drugB && (colMetaB?.type === 'uuid' || colMetaB?.foreignKey === true || cols.drugB.endsWith('_id')));
  const medLabelById = new Map(
    (allMedicines ?? [])
      .filter((m) => m?.id != null)
      .map((m) => [String(m.id), [m.name, m.scientificName].filter(Boolean).join(' ') || String(m.id)]),
  );

  let query = admin.from('drug_interactions').select('*').limit(200);
  if (isUuidA || isUuidB) {
    const ids = matchedMedicines.map((m) => m?.id).filter(Boolean).slice(0, 12);
    if (ids.length > 0) {
      const clauses = [];
      for (const id of ids) {
        if (cols.drugA && isUuidA) clauses.push(`${cols.drugA}.eq.${id}`);
        if (cols.drugB && isUuidB) clauses.push(`${cols.drugB}.eq.${id}`);
      }
      if (clauses.length > 0) query = query.or(clauses.join(','));
    }
  } else if (flatTerms.length > 0 && (cols.drugA || cols.drugB)) {
    const clauses = [];
    for (const term of flatTerms) {
      if (cols.drugA) clauses.push(`${cols.drugA}.ilike.%${term}%`);
      if (cols.drugB) clauses.push(`${cols.drugB}.ilike.%${term}%`);
    }
    if (clauses.length > 0) query = query.or(clauses.join(','));
  }

  const result = await query;
  if (result.error) {
    return { available: false, rows: [], pairMatches: [], reason: result.error.message };
  }

  const mapDrugVal = (raw, isUuid) => {
    if (raw == null) return null;
    const str = String(raw);
    return isUuid && medLabelById.has(str) ? medLabelById.get(str) : raw;
  };

  const rows = (result.data ?? []).map((row) => ({
    drugA: cols.drugA ? mapDrugVal(row[cols.drugA], isUuidA) : null,
    drugB: cols.drugB ? mapDrugVal(row[cols.drugB], isUuidB) : null,
    severity: cols.severity ? row[cols.severity] ?? null : null,
    description: cols.description ? row[cols.description] ?? null : null,
    source: cols.source ? row[cols.source] ?? null : null,
  }));

  const lowerGroups = groups.map((g) => g.map((t) => t.toLowerCase()));
  const rowMatchesGroup = (drugText, groupTerms) => {
    const normalized = String(drugText ?? '').toLowerCase();
    return Boolean(normalized && groupTerms.some((term) => normalized.includes(term)));
  };

  const filtered =
    lowerGroups.length > 0
      ? rows.filter((row) =>
          lowerGroups.some((g) => rowMatchesGroup(row.drugA, g) || rowMatchesGroup(row.drugB, g)),
        )
      : rows;

  // عند ذكر دوائين أو فحص المخزون بالكامل: إبراز التداخلات التي تجمع بين طرفين مذكورين
  let pairMatches = [];
  if (lowerGroups.length >= 2) {
    pairMatches = filtered.filter((row) => {
      const aIndex = lowerGroups.findIndex((g) => rowMatchesGroup(row.drugA, g));
      const bIndex = lowerGroups.findIndex((g) => rowMatchesGroup(row.drugB, g));
      return aIndex !== -1 && bIndex !== -1 && aIndex !== bIndex;
    });
  }

  return {
    available: true,
    rows: filtered,
    pairMatches,
    pairRequested: lowerGroups.length >= 2 && !scanInventory,
    scanInventory,
    totalRows: rows.length,
    reason: null,
  };
}

export function buildAnswer(
  intent,
  { summary, alerts = [], medicines = [], batches = [], movements = [], interactionData, medicine, mentionedMedicines, now = new Date() },
) {
  const lines = [];
  const facts = [];
  const medicineById = new Map(medicines.filter((m) => m?.id != null).map((m) => [String(m.id), m.name]));
  const totalUnits = summary?.units?.total ?? 0;
  const sellableUnits = summary?.units?.sellable ?? 0;
  const expiredUnits = summary?.units?.expired ?? 0;
  const highAlertsCount = alerts.filter((alert) => alert.severity === 'high').length;
  const targetMedicine = medicine ?? (Array.isArray(mentionedMedicines) ? mentionedMedicines[0] : null);

  if (intent === 'interaction') {
    if (!interactionData?.available) {
      lines.push('لا يمكنني تقديم معلومات تداخلات موثوقة: ' + (interactionData?.reason ?? 'بيانات التداخلات غير متاحة.'));
      lines.push('لم أُصغ أي تداخل من معرفة عامة. أضف صفوفًا موثّقة في جدول drug_interactions ثم أعد السؤال.');
    } else if (interactionData.pairRequested) {
      if (interactionData.pairMatches?.length > 0) {
        lines.push(`⚠️ وُجد ${interactionData.pairMatches.length} تداخل مسجّل بين الأدوية المحددة في جدول drug_interactions:`);
        for (const row of interactionData.pairMatches.slice(0, 10)) {
          const severity = row.severity ? ` — الشدة المسجّلة: ${row.severity}` : '';
          const description = row.description ? ` — ${row.description}` : '';
          lines.push(`• ${row.drugA ?? '؟'} + ${row.drugB ?? '؟'}${severity}${description}`);
          facts.push({ type: 'interaction', drugA: row.drugA, drugB: row.drugB, severity: row.severity });
        }
      } else {
        lines.push('لم يُعثر على تداخل مسجّل يجمع مباشرة بين الأدوية المذكورة معًا في جدول drug_interactions.');
        if (interactionData.rows.length > 0) {
          lines.push(`توجد ${interactionData.rows.length} سجلات تداخل أخرى تخص أحد هذه الأدوية:`);
          for (const row of interactionData.rows.slice(0, 6)) {
            const severity = row.severity ? ` — الشدة: ${row.severity}` : '';
            lines.push(`• ${row.drugA ?? '؟'} + ${row.drugB ?? '؟'}${severity}`);
            facts.push({ type: 'interaction', drugA: row.drugA, drugB: row.drugB, severity: row.severity });
          }
        }
        lines.push('عدم وجود صف لا يعني تأكيد الأمان السريري؛ راجع مرجعًا صيدلانيًا معتمدًا قبل الصرف.');
      }
    } else if (interactionData.rows.length === 0) {
      lines.push('لا توجد صفوف تداخلات مطابقة في جدول drug_interactions لقاعدة بياناتك.');
      lines.push('عدم وجود صف لا يعني تأكيد عدم وجود تداخل؛ راجع مرجعًا صيدلانيًا معتمدًا قبل أي قرار سريري.');
    } else {
      const displayRows =
        interactionData.scanInventory && interactionData.pairMatches?.length > 0
          ? interactionData.pairMatches
          : interactionData.rows;
      lines.push(
        interactionData.scanInventory && interactionData.pairMatches?.length > 0
          ? `فحص المخزون كشف ${displayRows.length} تداخلًا بين أدوية متوفرة في صيدليتك:`
          : `وُجد ${displayRows.length} صف تداخل موثّق في قاعدة بياناتك:`,
      );
      for (const row of displayRows.slice(0, 10)) {
        const severity = row.severity ? ` — الشدة المسجّلة: ${row.severity}` : '';
        const description = row.description ? ` — ${row.description}` : '';
        lines.push(`• ${row.drugA ?? '؟'} + ${row.drugB ?? '؟'}${severity}${description}`);
        facts.push({ type: 'interaction', drugA: row.drugA, drugB: row.drugB, severity: row.severity });
      }
    }
  } else if (intent === 'shortage') {
    const low = alerts.filter((alert) => alert.type === 'out_of_stock' || alert.type === 'low_stock');
    if (low.length === 0) {
      lines.push('لا توجد نواقص أو مستويات منخفضة وفق كميات الدفعات وحدود إعادة الطلب المسجّلة حاليًا.');
    } else {
      lines.push(`يوجد ${low.length} صنفًا يحتاج متابعة وإعادة طلب:`);
      for (const alert of low.slice(0, 15)) {
        const medName = alert.medicineName ?? medicineById.get(String(alert.medicineId)) ?? 'دواء';
        const units = Number(alert.units ?? 0);
        const reorder = Number(alert.reorderLevel ?? 0);
        let suggestion = '';
        let suggestedQty = null;
        if (reorder > 0) {
          suggestedQty = Math.max(reorder * 2 - units, 1);
          suggestion = ` | اقتراح إعادة الطلب: ${suggestedQty} وحدة (لبلوغ ضعف الحد ${reorder * 2})`;
        } else {
          suggestion = ' | يُوصى بتحديد حد إعادة الطلب وإضافة دفعة جديدة';
        }
        lines.push(`• ${medName}: ${alert.message}${suggestion}`);
        facts.push({
          type: alert.type,
          medicine: medName,
          units,
          reorderLevel: reorder || null,
          suggestedReorder: suggestedQty,
        });
      }
    }
  } else if (intent === 'expiry') {
    const expiry = alerts.filter((alert) => alert.type === 'expired_batch' || alert.type === 'expiring_soon');
    if (expiry.length === 0) {
      lines.push('لا توجد دفعات منتهية أو قريبة الانتهاء ضمن تواريخ الصلاحية المسجّلة.');
    } else {
      lines.push(`يوجد ${expiry.length} تنبيه صلاحية (يُمنع صرف الدفعات المنتهية ويجب عزلها/إتلافها):`);
      for (const alert of expiry.slice(0, 15)) {
        const medName = alert.medicineName ?? medicineById.get(String(alert.medicineId)) ?? null;
        lines.push(medName ? `• ${medName}: ${alert.message}` : `• ${alert.message}`);
        facts.push({
          type: alert.type,
          medicine: medName,
          batchNumber: alert.batchNumber ?? null,
          expiryDate: alert.expiryDate ?? null,
          units: alert.units ?? null,
        });
      }
    }
  } else if (intent === 'fefo') {
    if (targetMedicine) {
      const related = batches.filter((b) => String(b.medicineId) === String(targetMedicine.id));
      const fefoOrder = sortBatchesFefo(related, now);
      if (fefoOrder.length === 0) {
        lines.push(`لا توجد دفعات صالحة للصرف لـ«${targetMedicine.name}» وفق قاعدة FEFO.`);
      } else {
        lines.push(`ترتيب الصرف الإلزامي (FEFO) لـ«${targetMedicine.name}»:`);
        fefoOrder.forEach((batch, index) => {
          lines.push(
            `${index + 1}. دفعة ${batch.batchNumber ?? batch.id} — كمية ${batch.quantity} — تنتهي في ${batch.expiryDate ?? 'بلا تاريخ'}`,
          );
          facts.push({
            type: 'fefo_batch',
            order: index + 1,
            medicine: targetMedicine.name,
            batchNumber: batch.batchNumber ?? batch.id,
            quantity: batch.quantity,
            expiryDate: batch.expiryDate ?? null,
          });
        });
      }
    } else {
      const grouped = new Map();
      for (const batch of batches) {
        if (!batch.medicineId) continue;
        const list = grouped.get(batch.medicineId) ?? [];
        list.push(batch);
        grouped.set(batch.medicineId, list);
      }
      const priorities = [];
      for (const [medId, list] of grouped.entries()) {
        const sorted = sortBatchesFefo(list, now);
        if (sorted.length > 0) {
          priorities.push({
            medicine: medicineById.get(medId) ?? medId,
            first: sorted[0],
            totalSellableBatches: sorted.length,
          });
        }
      }
      priorities.sort((a, b) => String(a.first.expiryDate ?? '9999').localeCompare(String(b.first.expiryDate ?? '9999')));
      if (priorities.length === 0) {
        lines.push('لا توجد دفعات صالحة للصرف حاليًا لترتيبها وفق FEFO.');
      } else {
        lines.push(`أولوية الصرف وفق FEFO (الأقرب انتهاءً أولًا عبر ${priorities.length} صنفًا):`);
        for (const item of priorities.slice(0, 15)) {
          lines.push(
            `• ${item.medicine}: اصرف أولًا من دفعة ${item.first.batchNumber ?? item.first.id} (تنتهي ${item.first.expiryDate ?? 'بلا تاريخ'} — ${item.first.quantity} وحدة، من أصل ${item.totalSellableBatches} دفعة صالحة)`,
          );
          facts.push({
            type: 'fefo_next',
            medicine: item.medicine,
            batchNumber: item.first.batchNumber ?? item.first.id,
            expiryDate: item.first.expiryDate ?? null,
            quantity: item.first.quantity,
          });
        }
      }
    }
  } else if (intent === 'movements') {
    if (movements.length === 0) {
      lines.push('لا توجد حركات مخزون مسجّلة حتى الآن.');
    } else {
      let inbound = 0;
      let outbound = 0;
      for (const movement of movements) {
        const qty = Math.abs(Number(movement.quantity) || 0);
        if (INCREASING_MOVEMENTS.includes(movement.type)) inbound += qty;
        else if (DECREASING_MOVEMENTS.includes(movement.type)) outbound += qty;
      }
      lines.push(`إجمالي الحركات المسجّلة: ${movements.length} حركة (الوارد: ${inbound} وحدة، الصادر: ${outbound} وحدة).`);
      lines.push(`آخر ${Math.min(movements.length, 10)} حركة مسجّلة:`);
      for (const movement of movements.slice(0, 10)) {
        const medName = movement.medicineId ? medicineById.get(String(movement.medicineId)) ?? null : null;
        const typeLabel = MOVEMENT_TYPE_LABELS[movement.type] ?? movement.type ?? 'غير محدد';
        const medSuffix = medName ? ` — ${medName}` : '';
        lines.push(
          `• ${typeLabel}${medSuffix} — كمية ${movement.quantity ?? '؟'}${
            movement.createdAt ? ` — ${String(movement.createdAt).slice(0, 10)}` : ''
          }`,
        );
        facts.push({ type: 'movement', movementType: typeLabel, medicine: medName, quantity: movement.quantity });
      }
    }
  } else if (intent === 'stock') {
    if (targetMedicine) {
      const related = batches.filter((batch) => String(batch.medicineId) === String(targetMedicine.id));
      const fefoOrder = sortBatchesFefo(related, now);
      const sellable = fefoOrder.reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0);
      const total = related.reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0);
      lines.push(
        `الرصيد المسجّل لـ«${targetMedicine.name}»: ${total} وحدة (الصالح للصرف: ${sellable}، المنتهي: ${total - sellable}) موزّعة على ${related.length} دفعة.`,
      );
      if (fefoOrder.length > 0) {
        lines.push(`أول دفعة واجبة الصرف حسب FEFO: ${fefoOrder[0].batchNumber ?? fefoOrder[0].id} (${fefoOrder[0].expiryDate ?? 'بلا تاريخ'}).`);
      }
      for (const batch of related) {
        lines.push(
          `• دفعة ${batch.batchNumber ?? 'بدون رقم'} — كمية ${batch.quantity ?? '؟'} — صلاحية ${batch.expiryDate ?? 'غير مسجّلة'}${
            batch.expiryBucket === 'expired' ? ' [منتهية]' : ''
          }`,
        );
        facts.push({ type: 'batch', batchNumber: batch.batchNumber, quantity: batch.quantity, expiryDate: batch.expiryDate });
      }
      facts.push({ type: 'medicine_total', medicine: targetMedicine.name, total, sellable });
    } else if (medicines.length === 0) {
      lines.push('لا توجد أدوية مسجّلة بعد. أضف الأدوية ودفعاتها أولًا لتتمكن من قراءة الأرصدة.');
    } else {
      lines.push(
        `يوجد ${medicines.length} دواءً مسجّلًا. إجمالي الوحدات في المخزون: ${totalUnits} (القابلة للصرف: ${sellableUnits}، المنتهية: ${expiredUnits}).`,
      );
      lines.push('اذكر اسم الدواء في سؤالك لعرض أرصدة دفعاته وترتيب FEFO لها.');
      facts.push({ type: 'inventory_total', medicines: medicines.length, totalUnits, sellableUnits, expiredUnits });
    }
  } else if (intent === 'report') {
    let inbound = 0;
    let outbound = 0;
    for (const movement of movements) {
      const qty = Math.abs(Number(movement.quantity) || 0);
      if (INCREASING_MOVEMENTS.includes(movement.type)) inbound += qty;
      else if (DECREASING_MOVEMENTS.includes(movement.type)) outbound += qty;
    }
    const expiredCost = batches
      .filter((b) => b.expiryBucket === 'expired' && b.quantity > 0)
      .reduce((sum, b) => sum + b.quantity * (Number(b.costPrice) || 0), 0);

    lines.push(
      `التقرير التحليلي للمخزون: ${summary.counts.medicines} دواءً، ${summary.counts.batches} دفعة، ${totalUnits} وحدة (قابل للصرف: ${sellableUnits}، منتهي: ${expiredUnits}).`,
    );
    lines.push(
      `القيمة التقديرية للمخزون — التكلفة: ${summary.value?.cost ?? 0}، البيع: ${summary.value?.selling ?? 0} (خسارة منتهي الصلاحية بالتكلفة: ${Number(expiredCost.toFixed(2))}).`,
    );
    lines.push(`حركة المخزون: ${movements.length} حركة (وارد: ${inbound}، صادر: ${outbound}).`);
    lines.push(`التنبيهات النشطة: ${alerts.length} (حرجة: ${highAlertsCount}، نقص تحت الحد: ${summary.lowStock?.length ?? 0}).`);
    facts.push({
      type: 'summary',
      medicines: summary.counts.medicines,
      batches: summary.counts.batches,
      totalUnits,
      sellableUnits,
      expiredUnits,
      inbound,
      outbound,
      alerts: alerts.length,
      highSeverityAlerts: highAlertsCount,
    });
  } else {
    lines.push(
      `حالة المخزون: ${summary.counts.medicines} دواءً و${summary.counts.batches} دفعة بإجمالي ${totalUnits} وحدة (قابل للصرف: ${sellableUnits}).`,
    );
    if (alerts.length > 0) {
      lines.push(`يوجد ${alerts.length} تنبيهًا، منها ${highAlertsCount} بدرجة عالية.`);
    } else {
      lines.push('لا توجد تنبيهات نشطة وفق البيانات المسجّلة.');
    }
    lines.push('يمكنك توجيه السؤال إلى الوكلاء الثلاثة: إدارة المخزون وFEFO، سلامة الأدوية والتداخلات، أو التحليل والتقارير.');
    facts.push({
      type: 'summary',
      medicines: summary.counts.medicines,
      batches: summary.counts.batches,
      totalUnits,
      sellableUnits,
      alerts: alerts.length,
      highSeverityAlerts: highAlertsCount,
    });
  }

  if (medicines.length === 0 && batches.length === 0 && intent !== 'interaction') {
    lines.push('تنبيه: قاعدة البيانات لا تحتوي أدوية أو دفعات بعد، لذلك هذه الإجابة تعكس صفرًا فعليًا وليست تقديرًا.');
  }

  return { answer: lines.join('\n'), facts };
}

function isJsonColumn(columns, table, columnName) {
  if (!columnName) return false;
  const colMeta = columns?.tables?.[table]?.columns?.find((c) => c.name === columnName);
  const type = String(colMeta?.type ?? '').toLowerCase();
  return type.includes('json') || type === 'object';
}

/** سؤال للوكيل: إجابة من بيانات قاعدة البيانات فقط، مع توضيح صريح لحدود المعرفة وعدم تنفيذ أي تعديل تلقائي. */
router.post(
  '/ask',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!isNonEmptyString(question, 2)) {
      return httpError(res, 400, 'invalid_question', 'اكتب سؤالًا عن المخزون أو التنبيهات أو التداخلات.');
    }
    if (question.length > 500) {
      return httpError(res, 400, 'question_too_long', 'السؤال طويل جدًا (الحد 500 حرف).');
    }

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const data = await loadContext(admin, columns, req.auth.profile);
    const summary = buildInventorySummary(data);
    const alerts = computeAlerts(data);
    const intent = detectIntent(question);
    const agent = agentForIntent(intent);
    const mentionedMedicines = findMentionedMedicines(question, data.medicines);
    const medicine = mentionedMedicines[0] ?? null;

    let interactionData = { available: false, rows: [], pairMatches: [], reason: 'لم يُطلب استعلام تداخلات.' };
    if (intent === 'interaction') {
      interactionData = await interactionsFor(admin, columns, question, mentionedMedicines, data.medicines);
    }

    const { answer, facts } = buildAnswer(intent, {
      summary,
      alerts,
      medicines: data.medicines,
      batches: data.batches,
      movements: data.movements,
      interactionData,
      medicine,
      mentionedMedicines,
      question,
    });

    const response = {
      answer,
      intent,
      agent,
      facts,
      medicine: medicine ? { id: medicine.id, name: medicine.name } : null,
      disclaimer:
        'هذه الإجابة مبنية حصريًا على البيانات المسجّلة في قاعدة بياناتك. الوكيل للتحليل والاستشارة فقط ولا ينفذ أي تعديل على المخزون؛ راجع مرجعًا صيدلانيًا معتمدًا للقرارات السريرية.',
      dataErrors: data.errors,
      generatedAt: new Date().toISOString(),
    };

    // تسجيل التشغيل في agent_runs إن كان الجدول قابلًا للكتابة.
    const runCols = columns.agentRuns;
    if (runCols.id) {
      const desired = {};
      if (runCols.prompt) {
        desired[runCols.prompt] = isJsonColumn(columns, 'agent_runs', runCols.prompt)
          ? { question, intent, agent: agent.id }
          : question;
      }
      if (runCols.answer) {
        desired[runCols.answer] = isJsonColumn(columns, 'agent_runs', runCols.answer)
          ? { answer, intent, agent: agent.id, facts: facts.length }
          : answer;
      }
      if (runCols.status) desired[runCols.status] = 'completed';
      if (runCols.user) desired[runCols.user] = req.auth.user.id;
      if (runCols.pharmacy && scope.pharmacyId) {
        desired[runCols.pharmacy] = scope.pharmacyId;
      }
      const payload = payloadFor(columns, 'agent_runs', desired);
      if (Object.keys(payload).length > 0) {
        const logged = await admin.from('agent_runs').insert(payload).select().limit(1);
        response.runLogged = !logged.error;
        if (logged.error) response.runLogError = logged.error.message;
      }
    }

    return res.json(response);
  }),
);

/** آخر تشغيلات الوكيل. */
router.get(
  '/runs',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'agentRuns', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const runCols = columns.agentRuns;
    if (!runCols.id) return res.json({ runs: [], available: false });

    let query = admin.from('agent_runs').select('*').limit(50);
    query = scopeToPharmacy(query, columns, 'agentRuns', req.auth.profile);
    if (runCols.createdAt) query = query.order(runCols.createdAt, { ascending: false });

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'agent_runs_query_failed', error.message);

    return res.json({
      available: true,
      runs: (data ?? []).map((row) => {
        const promptValue = runCols.prompt ? row[runCols.prompt] ?? null : null;
        const answerValue = runCols.answer ? row[runCols.answer] ?? null : null;
        return {
          id: row[runCols.id] ?? null,
          type: runCols.agentType ? row[runCols.agentType] ?? null : row.agent_type ?? row.type ?? null,
          status: runCols.status ? row[runCols.status] ?? null : null,
          input: promptValue,
          prompt: promptValue,
          answer: answerValue,
          createdAt: runCols.createdAt ? row[runCols.createdAt] ?? null : null,
        };
      }),
    });
  }),
);

/** بث مباشر (SSE) لحالة الوكلاء الثلاثة ونتائج الفحص أولًا بأول لصيدلية المستخدم. */
router.get(
  '/stream',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (eventName, payload) => {
      if (res.writableEnded) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const initial = await getLatestSweepForPharmacy(admin, columns, scope.pharmacyId);
    send('init', initial);

    const unsubscribe = subscribeAgentEvents(scope.pharmacyId, send);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 20_000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),
);

/** حالة وآخر نتيجة للفحص التلقائي المستمر لصيدلية المستخدم. */
router.get(
  '/sweep/latest',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const data = await getLatestSweepForPharmacy(admin, columns, scope.pharmacyId);
    return res.json(data);
  }),
);

/** تشغيل يدوي فوري للفحص الشامل للوكلاء الثلاثة على صيدلية المستخدم. */
router.post(
  '/sweep',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const sweep = await runAutonomousSweep({
      admin,
      columns,
      pharmacyId: scope.pharmacyId,
      trigger: 'manual',
      reason: 'فحص فوري بطلب المستخدم',
      triggeredBy: req.auth.user.id,
      forcePersist: true,
    });

    const first = sweep.results[0] ?? null;
    return res.json({
      ok: true,
      scheduler: getSchedulerState(),
      liveFeed: getLiveFeedForPharmacy(scope.pharmacyId),
      latest: first
        ? {
            source: 'live',
            id: null,
            title: `فحص شامل (${sweep.triggerLabel})`,
            createdAt: first.ranAt,
            audit: first.audit,
            reportText: first.reportText,
            persistence: first.persistence,
          }
        : null,
    });
  }),
);

function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** نقطة تشغيل خارجية محمية بمفتاح أتمتة (Cron Webhook) تعمل كل 6 ساعات على جميع الصيدليات. */
router.post(
  '/cron',
  asyncHandler(async (req, res) => {
    if (!env.agentCronSecret) {
      return httpError(res, 503, 'cron_secret_not_configured', 'مفتاح أتمتة الوكلاء (AGENT_CRON_SECRET) غير مضبوط.');
    }

    const headerSecret = req.get('x-cron-secret') || '';
    const authHeader = req.get('authorization') || '';
    const bearerSecret = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const provided = headerSecret || bearerSecret;

    if (!secretsEqual(provided, env.agentCronSecret)) {
      return httpError(res, 401, 'invalid_cron_secret', 'مفتاح الأتمتة غير صالح.');
    }

    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const sweep = await runAutonomousSweep({
      admin,
      columns,
      pharmacyId: null,
      trigger: 'cron',
    });

    return res.json({
      ok: true,
      trigger: sweep.trigger,
      ranAt: sweep.ranAt,
      pharmaciesScanned: sweep.pharmaciesScanned,
      scheduler: getSchedulerState(),
    });
  }),
);

export default router;
