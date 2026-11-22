import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import { inventoryColumns, payloadFor, requirePharmacy, scopeToPharmacy } from '../inventory.js';
import { notifyInventoryChange } from '../agentSweep.js';

const router = express.Router();

function severityBucket(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (/critical|high|severe|major|contraindicated|شديد|حرج/.test(value)) return 'high';
  if (/mild_to_moderate|moderate|medium|متوسط/.test(value)) return 'medium';
  if (/mild|low|minor|طفيف|منخفض/.test(value)) return 'low';
  return 'medium';
}

const SEVERITY_SCHEMES = Object.freeze([
  { high: 'high', medium: 'medium', low: 'low' },
  { high: 'critical', medium: 'medium', low: 'low' },
  { high: 'high', medium: 'moderate', low: 'low' },
  { high: 'critical', medium: 'moderate', low: 'low' },
  { high: 'major', medium: 'moderate', low: 'minor' },
  { high: 'severe', medium: 'moderate', low: 'mild' },
  { high: 'severe', medium: 'moderate', low: 'minor' },
  { high: 'high', medium: 'moderate', low: 'minor' },
  { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' },
  { high: 'CRITICAL', medium: 'MODERATE', low: 'MILD' },
  { high: 'MAJOR', medium: 'MODERATE', low: 'MINOR' },
  { high: 'HIGH', medium: 'MODERATE', low: 'LOW' },
  { high: 'CRITICAL', medium: 'MODERATE', low: 'LOW' },
  { high: 'حرج', medium: 'متوسط', low: 'طفيف' },
  { high: 'شديد', medium: 'متوسط', low: 'خفيف' },
]);

function normalizeSeverity(raw, enumValues) {
  const value = String(raw ?? '').trim().toLowerCase();
  const bucket = severityBucket(value);

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

export function buildSeveritySchemePayloads(toInsert, buckets, severityColumn, scheme) {
  return toInsert.map((row, index) => ({
    ...row,
    [severityColumn]: scheme[buckets[index] ?? 'medium'],
  }));
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
      const detectedCols = columns.tables?.drug_interactions?.columnNames ?? [];
      const colsHint = detectedCols.length ? ` الأعمدة الموجودة فعليًا: ${detectedCols.join(', ')}` : '';
      return httpError(
        res,
        400,
        'interaction_columns_missing',
        `لم يُعثر على عمودَي الدواء الأول والثاني في جدول drug_interactions.${colsHint}`,
        { detectedColumns: detectedCols },
      );
    }

    const colMetaA = columns.tables?.drug_interactions?.columns?.find((c) => c.name === cols.drugA);
    const colMetaB = columns.tables?.drug_interactions?.columns?.find((c) => c.name === cols.drugB);
    const isUuidA = colMetaA?.type === 'uuid' || colMetaA?.foreignKey === true || cols.drugA.endsWith('_id');
    const isUuidB = colMetaB?.type === 'uuid' || colMetaB?.foreignKey === true || cols.drugB.endsWith('_id');

    let pharmacyId = null;
    if (cols.pharmacy) {
      const scope = requirePharmacy(columns, 'interactions', req.auth.profile);
      if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);
      pharmacyId = scope.pharmacyId;
    }

    let medicineLookup = [];
    if (isUuidA || isUuidB) {
      const medCols = columns.medicines;
      let medQuery = admin.from('medicines').select('*').limit(2000);
      medQuery = scopeToPharmacy(medQuery, columns, 'medicines', req.auth.profile);
      const medRes = await medQuery;
      if (!medRes.error && Array.isArray(medRes.data)) {
        medicineLookup = medRes.data.map((row) => ({
          id: row[medCols.id],
          name: String(row[medCols.name] ?? '').toLowerCase(),
          scientificName: String(medCols.scientificName ? row[medCols.scientificName] ?? '' : '').toLowerCase(),
        }));
      }
    }

    const resolveDrugValue = (rawLabel, needsUuid) => {
      if (!needsUuid) return rawLabel;
      const lower = String(rawLabel ?? '').toLowerCase();
      for (const med of medicineLookup) {
        if (!med.id) continue;
        if (med.name && med.name.length >= 2 && lower.includes(med.name)) return med.id;
        const sciTokens = med.scientificName.split(/[\s/+()،,-]+/).filter((t) => t.length >= 3);
        if (sciTokens.some((tok) => lower.includes(tok))) return med.id;
      }
      return null;
    };

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
    const sourceMeta =
      cols.source &&
      columns.tables?.drug_interactions?.columns?.find((col) => col.name === cols.source);
    const sourceRequired = Boolean(sourceMeta?.required);
    const descMeta =
      cols.description &&
      columns.tables?.drug_interactions?.columns?.find((col) => col.name === cols.description);
    const descRequired = Boolean(descMeta?.required);

    const toInsert = [];
    const insertBuckets = [];
    let skippedCount = 0;

    for (const item of items) {
      if (!item || !isNonEmptyString(item.drugA) || !isNonEmptyString(item.drugB)) {
        skippedCount += 1;
        continue;
      }
      const drugAVal = resolveDrugValue(String(item.drugA).trim(), isUuidA);
      const drugBVal = resolveDrugValue(String(item.drugB).trim(), isUuidB);
      if (!drugAVal || !drugBVal) {
        skippedCount += 1;
        continue;
      }
      const key = pairKey(drugAVal, drugBVal);
      if (seen.has(key)) {
        skippedCount += 1;
        continue;
      }
      seen.add(key);

      const desired = {
        [cols.drugA]: drugAVal,
        [cols.drugB]: drugBVal,
      };
      if (cols.severity) {
        desired[cols.severity] = normalizeSeverity(item.severity, severityEnum);
      }
      if (cols.description) {
        if (isNonEmptyString(item.description)) {
          desired[cols.description] = String(item.description).trim();
        } else if (descRequired) {
          desired[cols.description] = 'تداخل دوائي مسجّل';
        }
      }
      if (cols.source) {
        if (isNonEmptyString(item.source)) {
          desired[cols.source] = String(item.source).trim();
        } else if (sourceRequired) {
          desired[cols.source] = 'PharmaGuard Import';
        }
      }
      if (cols.pharmacy && pharmacyId) {
        desired[cols.pharmacy] = pharmacyId;
      }

      toInsert.push(payloadFor(columns, 'drug_interactions', desired));
      insertBuckets.push(severityBucket(item.severity));
    }

    if (toInsert.length === 0) {
      return res.status(200).json({
        ok: true,
        insertedCount: 0,
        skippedCount,
        interactions: [],
        message:
          isUuidA || isUuidB
            ? 'لم تُطابق التداخلات مع أدوية مسجّلة بعد أو أنها مسجّلة مسبقًا. أضف/استورد الأدوية أولًا.'
            : 'جميع التداخلات المحددة مسجّلة مسبقًا في جدول drug_interactions.',
      });
    }

    let { data, error } = await admin.from('drug_interactions').insert(toInsert).select();
    const isSeverityCheckError = (err) =>
      Boolean(
        err &&
          cols.severity &&
          (err.code === '23514' || /severity_check|violates check constraint/i.test(String(err.message ?? ''))),
      );

    if (isSeverityCheckError(error)) {
      for (const scheme of SEVERITY_SCHEMES) {
        const adapted = buildSeveritySchemePayloads(toInsert, insertBuckets, cols.severity, scheme);
        const attempt = await admin.from('drug_interactions').insert(adapted).select();
        if (!attempt.error) {
          data = attempt.data;
          error = null;
          break;
        }
        error = attempt.error;
        if (!isSeverityCheckError(error)) break;
      }
    }

    if (error) return httpError(res, 500, 'interactions_import_failed', error.message);

    notifyInventoryChange(pharmacyId, `استيراد ${data?.length ?? toInsert.length} تداخل دوائي`);
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
