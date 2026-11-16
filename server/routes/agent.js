import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeMedicine,
  shapeBatch,
  shapeMovement,
  buildInventorySummary,
  computeAlerts,
  scopeToPharmacy,
  payloadFor,
  daysUntil,
} from '../inventory.js';

const router = express.Router();

/**
 * الوكيل الذكي — قواعد صارمة ضد الاختلاق:
 * 1) كل رقم أو اسم دواء في الإجابة يأتي من صفوف قاعدة البيانات المرفقة في facts.
 * 2) لا تُصاغ أي معلومة دوائية (جرعة، دواعٍ، تحذيرات) من معرفة عامة.
 * 3) التداخلات تُذكر فقط إن وُجدت فعليًا في جدول drug_interactions؛ وإلا يُصرَّح بعدم توفر بيانات.
 */

const INTENTS = [
  { id: 'interaction', words: ['تداخل', 'تفاعل', 'interaction', 'تفاعلات', 'تداخلات'] },
  { id: 'shortage', words: ['نقص', 'نواقص', 'نفاد', 'قارب', 'انخفض', 'shortage', 'low stock', 'out of stock'] },
  { id: 'expiry', words: ['صلاحية', 'انتهاء', 'منتهي', 'تنتهي', 'expiry', 'expire', 'expiring'] },
  { id: 'movements', words: ['حركة', 'حركات', 'صرف', 'استلام', 'إتلاف', 'movement', 'dispense'] },
  { id: 'stock', words: ['كمية', 'كميات', 'مخزون', 'رصيد', 'stock', 'quantity'] },
  { id: 'report', words: ['تقرير', 'ملخص', 'إجمالي', 'قيمة', 'report', 'summary'] },
];

function detectIntent(text) {
  const normalized = text.toLowerCase();
  for (const intent of INTENTS) {
    if (intent.words.some((word) => normalized.includes(word))) return intent.id;
  }
  return 'general';
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

  return {
    medicines: reads.medicines.error ? [] : (reads.medicines.data ?? []).map((row) => shapeMedicine(row, columns.medicines)),
    batches: reads.batches.error ? [] : (reads.batches.data ?? []).map((row) => shapeBatch(row, columns.batches)),
    movements: reads.movements.error ? [] : (reads.movements.data ?? []).map((row) => shapeMovement(row, columns.movements)),
    errors: {
      medicines: reads.medicines.error?.message ?? null,
      batches: reads.batches.error?.message ?? null,
      movements: reads.movements.error?.message ?? null,
    },
  };
}

/** يبحث عن الدواء المذكور في السؤال بمطابقة نصية على الأسماء الموجودة فعليًا. */
function findMentionedMedicine(text, medicines) {
  const normalized = text.toLowerCase();
  let best = null;
  for (const medicine of medicines) {
    const name = (medicine.name ?? '').toLowerCase().trim();
    if (name.length < 3) continue;
    if (normalized.includes(name)) {
      if (!best || name.length > best.name.length) best = { medicine, name };
    }
  }
  return best?.medicine ?? null;
}

async function interactionsFor(admin, columns, text, medicine) {
  const cols = columns.interactions;
  if (!cols.id || (!cols.a && !cols.b)) {
    return { available: false, rows: [], reason: 'جدول التداخلات غير متاح أو لا يحتوي أعمدة أسماء الدواء.' };
  }

  let query = admin.from('drug_interactions').select('*').limit(200);
  if (cols.a && cols.b) {
    query = query.or(`${cols.a}.ilike.%${text}%,${cols.b}.ilike.%${text}%`);
  }
  const result = await query;
  if (result.error) {
    return { available: false, rows: [], reason: result.error.message };
  }

  const rows = (result.data ?? []).map((row) => ({
    drugA: cols.a ? row[cols.a] ?? null : null,
    drugB: cols.b ? row[cols.b] ?? null : null,
    severity: cols.severity ? row[cols.severity] ?? null : null,
    description: cols.description ? row[cols.description] ?? null : null,
  }));

  const filtered = medicine?.name
    ? rows.filter(
        (row) =>
          String(row.drugA ?? '').toLowerCase().includes(medicine.name.toLowerCase()) ||
          String(row.drugB ?? '').toLowerCase().includes(medicine.name.toLowerCase()),
      )
    : rows;

  return { available: true, rows: filtered, totalRows: rows.length, reason: null };
}

function buildAnswer(intent, { summary, alerts, medicines, batches, movements, interactionData, medicine, question }) {
  const lines = [];
  const facts = [];

  if (intent === 'interaction') {
    if (!interactionData.available) {
      lines.push('لا يمكنني تقديم معلومات تداخلات موثوقة: ' + (interactionData.reason ?? 'بيانات التداخلات غير متاحة.'));
      lines.push('لم أُصغ أي تداخل من معرفة عامة. أضف صفوفًا موثّقة في جدول drug_interactions ثم أعد السؤال.');
    } else if (interactionData.rows.length === 0) {
      lines.push('لا توجد صفوف تداخلات مطابقة في جدول drug_interactions لقاعدة بياناتك.');
      lines.push('عدم وجود صف لا يعني تأكيد عدم وجود تداخل؛ راجع مرجعًا صيدلانيًا معتمدًا قبل أي قرار سريري.');
    } else {
      lines.push(`وُجد ${interactionData.rows.length} صف تداخل موثّق في قاعدة بياناتك:`);
      for (const row of interactionData.rows.slice(0, 10)) {
        const severity = row.severity ? ` — الشدة المسجّلة: ${row.severity}` : '';
        const description = row.description ? ` — ${row.description}` : '';
        lines.push(`• ${row.drugA ?? '؟'} + ${row.drugB ?? '؟'}${severity}${description}`);
        facts.push({ type: 'interaction', drugA: row.drugA, drugB: row.drugB, severity: row.severity });
      }
    }
  } else if (intent === 'shortage') {
    const low = alerts.filter((alert) => alert.type === 'out_of_stock' || alert.type === 'low_stock');
    if (low.length === 0) {
      lines.push('لا توجد نواقص أو مستويات منخفضة وفق كميات الدفعات المسجّلة حاليًا.');
    } else {
      lines.push(`يوجد ${low.length} صنفًا يحتاج متابعة كمية:`);
      for (const alert of low.slice(0, 15)) {
        lines.push(`• ${alert.medicineName}: ${alert.message}`);
        facts.push({ type: alert.type, medicine: alert.medicineName, value: alert.value });
      }
    }
  } else if (intent === 'expiry') {
    const expiry = alerts.filter((alert) => alert.type === 'expired' || alert.type === 'expiring_soon');
    if (expiry.length === 0) {
      lines.push('لا توجد دفعات منتهية أو قريبة الانتهاء ضمن تواريخ الصلاحية المسجّلة.');
    } else {
      lines.push(`يوجد ${expiry.length} تنبيه صلاحية:`);
      for (const alert of expiry.slice(0, 15)) {
        lines.push(`• ${alert.medicineName}: ${alert.message}`);
        facts.push({ type: alert.type, medicine: alert.medicineName, expiryDate: alert.expiryDate });
      }
    }
  } else if (intent === 'movements') {
    if (movements.length === 0) {
      lines.push('لا توجد حركات مخزون مسجّلة حتى الآن.');
    } else {
      lines.push(`آخر ${Math.min(movements.length, 10)} حركة مسجّلة:`);
      for (const movement of movements.slice(0, 10)) {
        lines.push(`• ${movement.type ?? 'غير محدد'} — كمية ${movement.quantity ?? '؟'}${movement.createdAt ? ` — ${String(movement.createdAt).slice(0, 10)}` : ''}`);
        facts.push({ type: 'movement', movementType: movement.type, quantity: movement.quantity });
      }
    }
  } else if (intent === 'stock') {
    if (medicine) {
      const related = batches.filter((batch) => String(batch.medicineId) === String(medicine.id));
      const total = related.reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0);
      lines.push(`الرصيد المسجّل لـ«${medicine.name}»: ${total} وحدة موزّعة على ${related.length} دفعة.`);
      for (const batch of related) {
        lines.push(`• دفعة ${batch.batchNumber ?? 'بدون رقم'} — كمية ${batch.quantity ?? '؟'} — صلاحية ${batch.expiryDate ?? 'غير مسجّلة'}`);
        facts.push({ type: 'batch', batchNumber: batch.batchNumber, quantity: batch.quantity, expiryDate: batch.expiryDate });
      }
      facts.push({ type: 'medicine_total', medicine: medicine.name, total });
    } else if (medicines.length === 0) {
      lines.push('لا توجد أدوية مسجّلة بعد. أضف الأدوية ودفعاتها أولًا لتتمكن من قراءة الأرصدة.');
    } else {
      lines.push(`يوجد ${medicines.length} دواءً مسجّلًا. إجمالي الوحدات في المخزون: ${summary.totalUnits}.`);
      lines.push('اذكر اسم الدواء في سؤالك لعرض أرصدة دفعاته.');
      facts.push({ type: 'inventory_total', medicines: medicines.length, totalUnits: summary.totalUnits });
    }
  } else if (intent === 'report') {
    lines.push(`ملخص المخزون: ${summary.counts.medicines} دواءً، ${summary.counts.batches} دفعة، ${summary.totalUnits} وحدة.`);
    if (summary.inventoryValue !== null) lines.push(`القيمة التقديرية للمخزون: ${summary.inventoryValue}.`);
    lines.push(`تنبيهات: ${summary.counts.alerts} (عالية: ${summary.counts.highSeverityAlerts}).`);
    facts.push({ type: 'summary', ...summary.counts, totalUnits: summary.totalUnits });
  } else {
    lines.push(`حالة المخزون: ${summary.counts.medicines} دواءً و${summary.counts.batches} دفعة بإجمالي ${summary.totalUnits} وحدة.`);
    if (summary.counts.alerts > 0) {
      lines.push(`يوجد ${summary.counts.alerts} تنبيهًا، منها ${summary.counts.highSeverityAlerts} بدرجة عالية.`);
    } else {
      lines.push('لا توجد تنبيهات نشطة وفق البيانات المسجّلة.');
    }
    lines.push('يمكنك السؤال عن: النواقص، الصلاحية، رصيد دواء معيّن، آخر الحركات، أو ملخص التقرير.');
    facts.push({ type: 'summary', ...summary.counts, totalUnits: summary.totalUnits });
  }

  if (medicines.length === 0 && batches.length === 0 && intent !== 'interaction') {
    lines.push('تنبيه: قاعدة البيانات لا تحتوي أدوية أو دفعات بعد، لذلك هذه الإجابة تعكس صفرًا فعليًا وليست تقديرًا.');
  }

  return { answer: lines.join('\n'), facts };
}

/** سؤال للوكيل: إجابة من بيانات قاعدة البيانات فقط، مع توضيح صريح لحدود المعرفة. */
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
    const data = await loadContext(admin, columns, req.auth.profile);
    const summary = buildInventorySummary(data);
    const alerts = computeAlerts(data);
    const intent = detectIntent(question);
    const medicine = findMentionedMedicine(question, data.medicines);

    let interactionData = { available: false, rows: [], reason: 'لم يُطلب استعلام تداخلات.' };
    if (intent === 'interaction') {
      interactionData = await interactionsFor(admin, columns, question, medicine);
    }

    const { answer, facts } = buildAnswer(intent, {
      summary,
      alerts,
      medicines: data.medicines,
      batches: data.batches,
      movements: data.movements,
      interactionData,
      medicine,
      question,
    });

    const response = {
      answer,
      intent,
      facts,
      medicine: medicine ? { id: medicine.id, name: medicine.name } : null,
      disclaimer:
        'هذه الإجابة مبنية حصريًا على البيانات المسجّلة في قاعدة بياناتك. لا تُغني عن مرجع صيدلاني معتمد أو حكم الصيدلي المسؤول.',
      dataErrors: data.errors,
      generatedAt: new Date().toISOString(),
    };

    // تسجيل التشغيل في agent_runs إن كان الجدول قابلًا للكتابة.
    const runCols = columns.agentRuns;
    if (runCols.id) {
      const desired = {};
      if (runCols.type) desired[runCols.type] = 'inventory_question';
      if (runCols.input) desired[runCols.input] = { question, intent };
      if (runCols.output) desired[runCols.output] = { answer, facts: facts.length };
      if (runCols.status) desired[runCols.status] = 'completed';
      if (runCols.user) desired[runCols.user] = req.auth.user.id;
      if (runCols.pharmacy && req.auth.publicProfile?.pharmacyId) {
        desired[runCols.pharmacy] = req.auth.publicProfile.pharmacyId;
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
  requireRole(ROLE.OWNER, ROLE.PHARMACIST),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const runCols = columns.agentRuns;
    if (!runCols.id) return res.json({ runs: [], available: false });

    let query = admin.from('agent_runs').select('*').limit(50);
    query = scopeToPharmacy(query, columns, 'agentRuns', req.auth.profile);
    if (runCols.createdAt) query = query.order(runCols.createdAt, { ascending: false });

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'agent_runs_query_failed', error.message);

    return res.json({
      available: true,
      runs: (data ?? []).map((row) => ({
        id: row[runCols.id] ?? null,
        type: runCols.type ? row[runCols.type] ?? null : null,
        status: runCols.status ? row[runCols.status] ?? null : null,
        input: runCols.input ? row[runCols.input] ?? null : null,
        createdAt: runCols.createdAt ? row[runCols.createdAt] ?? null : null,
      })),
    });
  }),
);

export default router;
