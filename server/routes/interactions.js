import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import { inventoryColumns, payloadFor, requirePharmacy, scopeToPharmacy } from '../inventory.js';

const router = express.Router();

function normalizeSeverity(raw, enumValues) {
  const value = String(raw ?? '').trim().toLowerCase();
  const bucket =
    /critical|high|severe|major|شديد|حرج/.test(value)
      ? 'high'
      : /mild_to_moderate|moderate|medium|متوسط/.test(value)
        ? 'medium'
        : /mild|low|minor|طفيف|منخفض/.test(value)
          ? 'low'
          : value || 'medium';

  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const exact = enumValues.find((item) => String(item).toLowerCase() === value);
    if (exact !== undefined) return exact;
    const matchers = {
      high: ['critical', 'high', 'severe', 'major'],
      medium: ['moderate', 'medium'],
      low: ['mild', 'low', 'minor'],
    };
    const candidates = matchers[bucket] ?? [];
    for (const candidate of candidates) {
      const found = enumValues.find((item) => String(item).toLowerCase() === candidate);
      if (found !== undefined) return found;
    }
    return enumValues[0];
  }

  return value || 'moderate';
}

function pairKey(a, b) {
  const left = String(a ?? '').trim().toLowerCase();
  const right = String(b ?? '').trim().toLowerCase();
  return left <= right ? `${left}||${right}` : `${right}||${left}`;
}

/** عرض التداخلات الدوائية المسجّلة في drug_interactions. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    if (columns.schemaOk && !columns.tables.drug_interactions) {
      return httpError(res, 404, 'table_missing', 'جدول drug_interactions غير موجود في المشروع.');
    }

    const cols = columns.interactions;
    if (cols.pharmacy) {
      const scope = requirePharmacy(columns, 'interactions', req.auth.profile);
      if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);
    }

    let query = admin.from('drug_interactions').select('*').limit(500);
    if (cols.pharmacy) {
      query = scopeToPharmacy(query, columns, 'interactions', req.auth.profile);
    }
    const { data, error } = await query;
    if (error) return httpError(res, 500, 'interactions_query_failed', error.message);

    return res.json({
      interactions: (data ?? []).map((row) => ({
        id: cols.id ? row[cols.id] ?? null : null,
        drugA: cols.drugA ? row[cols.drugA] ?? null : null,
        drugB: cols.drugB ? row[cols.drugB] ?? null : null,
        severity: cols.severity ? row[cols.severity] ?? null : null,
        description: cols.description ? row[cols.description] ?? null : null,
        source: cols.source ? row[cols.source] ?? null : null,
      })),
    });
  }),
);

/** استيراد تداخلات دوائية دفعة واحدة (JSON / CSV / دليل PDF) مع منع التكرار. */
router.post(
  '/import',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const items = Array.isArray(req.body?.interactions) ? req.body.interactions : null;
    if (!items || items.length === 0) {
      return httpError(res, 400, 'empty_import', 'أرسل مصفوفة interactions غير فارغة.');
    }
    if (items.length > 500) {
      return httpError(res, 400, 'too_many_items', 'الحد الأقصى في الدفعة الواحدة 500 تداخل.');
    }

    const columns = await inventoryColumns();
    if (columns.schemaOk && !columns.tables.drug_interactions) {
      return httpError(res, 404, 'table_missing', 'جدول drug_interactions غير موجود في المشروع.');
    }

    const cols = columns.interactions;
    if (!cols.drugA || !cols.drugB) {
      return httpError(
        res,
        400,
        'interaction_columns_missing',
        'لم يُعثر على عمودَي الدواء الأول والثاني في جدول drug_interactions.',
      );
    }

    let pharmacyId = null;
    if (cols.pharmacy) {
      const scope = requirePharmacy(columns, 'interactions', req.auth.profile);
      if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);
      pharmacyId = scope.pharmacyId;
    }

    let existingQuery = admin.from('drug_interactions').select(`${cols.drugA},${cols.drugB}`).limit(2000);
    if (cols.pharmacy && pharmacyId) {
      existingQuery = existingQuery.eq(cols.pharmacy, pharmacyId);
    }
    const existingRes = await existingQuery;
    if (existingRes.error) {
      return httpError(res, 500, 'interactions_query_failed', existingRes.error.message);
    }

    const seen = new Set(
      (existingRes.data ?? [])
        .map((row) => pairKey(row[cols.drugA], row[cols.drugB]))
        .filter((k) => k !== '||'),
    );

    const severityMeta =
      cols.severity &&
      columns.tables?.drug_interactions?.columns?.find((col) => col.name === cols.severity);
    const severityEnum = severityMeta?.enumValues ?? null;

    const toInsert = [];
    let skippedCount = 0;

    for (const item of items) {
      if (!item || !isNonEmptyString(item.drugA) || !isNonEmptyString(item.drugB)) {
        skippedCount += 1;
        continue;
      }
      const drugA = String(item.drugA).trim();
      const drugB = String(item.drugB).trim();
      const key = pairKey(drugA, drugB);
      if (seen.has(key)) {
        skippedCount += 1;
        continue;
      }
      seen.add(key);

      const desired = {
        [cols.drugA]: drugA,
        [cols.drugB]: drugB,
      };
      if (cols.severity) {
        desired[cols.severity] = normalizeSeverity(item.severity, severityEnum);
      }
      if (cols.description && isNonEmptyString(item.description)) {
        desired[cols.description] = String(item.description).trim();
      }
      if (cols.source && isNonEmptyString(item.source)) {
        desired[cols.source] = String(item.source).trim();
      }
      if (cols.pharmacy && pharmacyId) {
        desired[cols.pharmacy] = pharmacyId;
      }

      toInsert.push(payloadFor(columns, 'drug_interactions', desired));
    }

    if (toInsert.length === 0) {
      return res.status(200).json({
        ok: true,
        insertedCount: 0,
        skippedCount,
        interactions: [],
        message: 'جميع التداخلات المحددة مسجّلة مسبقًا في جدول drug_interactions.',
      });
    }

    const { data, error } = await admin.from('drug_interactions').insert(toInsert).select();
    if (error) return httpError(res, 500, 'interactions_import_failed', error.message);

    return res.status(201).json({
      ok: true,
      insertedCount: data?.length ?? toInsert.length,
      skippedCount,
      interactions: (data ?? []).map((row) => ({
        id: cols.id ? row[cols.id] ?? null : null,
        drugA: cols.drugA ? row[cols.drugA] ?? null : null,
        drugB: cols.drugB ? row[cols.drugB] ?? null : null,
        severity: cols.severity ? row[cols.severity] ?? null : null,
        description: cols.description ? row[cols.description] ?? null : null,
        source: cols.source ? row[cols.source] ?? null : null,
      })),
    });
  }),
);

export default router;
