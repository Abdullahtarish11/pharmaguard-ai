import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE, canWriteInventory } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeMedicine,
  shapeBatch,
  payloadFor,
  scopeToPharmacy,
  requirePharmacy,
  aggregateStock,
} from '../inventory.js';
import { notifyInventoryChange } from '../agentSweep.js';
import { notifySafetyMedicineChange } from '../safety/worker.js';

const router = express.Router();

function guard(req, res, next) {
  if (!canWriteInventory(req.auth?.role)) {
    return httpError(res, 403, 'forbidden_role', 'إدارة الأدوية متاحة للمالك والصيدلي ومسؤول المخزون.');
  }
  return next();
}

function sanitizeFilter(value) {
  return String(value ?? '')
    .replace(/[,%()*\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** قائمة الأدوية مع البحث والكميات المحسوبة من الدفعات. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    if (columns.schemaOk && !columns.tables.medicines) {
      return httpError(res, 404, 'table_missing', 'جدول medicines غير موجود في المشروع.');
    }

    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const cols = columns.medicines;
    const includeInactive = req.query.includeInactive === 'true';
    let query = admin.from('medicines').select('*').limit(500);
    query = scopeToPharmacy(query, columns, 'medicines', req.auth.profile);
    if (cols.isActive && !includeInactive) query = query.eq(cols.isActive, true);
    if (cols.name) query = query.order(cols.name, { ascending: true });

    const search = typeof req.query.q === 'string' ? sanitizeFilter(req.query.q) : '';
    if (search && (cols.name || cols.scientificName || cols.barcode)) {
      const parts = [cols.name, cols.scientificName, cols.barcode].filter(Boolean);
      query = query.or(parts.map((column) => `${column}.ilike.%${search}%`).join(','));
    }

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'medicines_query_failed', error.message);

    const medicines = (data ?? []).map((row) => shapeMedicine(row, cols));

    const now = new Date();
    const batchCols = columns.batches;
    let batchQuery = admin.from('inventory_batches').select('*').limit(2000);
    batchQuery = scopeToPharmacy(batchQuery, columns, 'batches', req.auth.profile);
    const batchResult = await batchQuery;
    const batches = batchResult.error
      ? []
      : (batchResult.data ?? []).map((row) => shapeBatch(row, batchCols, now));

    const stock = aggregateStock(batches, now);

    return res.json({
      medicines: medicines.map((medicine) => {
        const entry = stock.get(String(medicine.id));
        return {
          ...medicine,
          availableUnits: entry?.sellableUnits ?? 0,
          totalUnits: entry?.totalUnits ?? 0,
          expiredUnits: entry?.expiredUnits ?? 0,
          nearestExpiry: entry?.nearestExpiry ?? null,
          batchCount: entry?.batches ?? 0,
        };
      }),
      columnsDetected: {
        name: Boolean(cols.name),
        scientificName: Boolean(cols.scientificName),
        reorderLevel: Boolean(cols.reorderLevel),
        barcode: Boolean(cols.barcode),
      },
      batchesReadable: !batchResult.error,
      batchesError: batchResult.error?.message ?? null,
    });
  }),
);

/** إضافة دواء — بدون أي بيانات دوائية مُختلقة من عندنا. */
router.post(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    if (!isNonEmptyString(body.name, 2)) {
      return httpError(res, 400, 'invalid_name', 'اسم الدواء مطلوب (حرفان على الأقل).');
    }

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const cols = columns.medicines;
    if (!cols.name) {
      const detectedCols = columns.tables?.medicines?.columnNames ?? [];
      const colsHint = detectedCols.length ? ` الأعمدة الموجودة فعليًا: ${detectedCols.join(', ')}` : '';
      return httpError(
        res,
        400,
        'name_column_missing',
        `لم يُعثر على عمود اسم الدواء في جدول medicines.${colsHint}`,
        { detectedColumns: detectedCols },
      );
    }

    const desired = {
      [cols.name]: String(body.name).trim(),
    };
    if (cols.scientificName && isNonEmptyString(body.scientificName)) {
      desired[cols.scientificName] = String(body.scientificName).trim();
    }
    if (cols.form && isNonEmptyString(body.form)) desired[cols.form] = String(body.form).trim();
    if (cols.strength && isNonEmptyString(body.strength)) desired[cols.strength] = String(body.strength).trim();
    if (cols.barcode && isNonEmptyString(body.barcode)) desired[cols.barcode] = String(body.barcode).trim();
    if (cols.unit && isNonEmptyString(body.unit)) desired[cols.unit] = String(body.unit).trim();
    if (cols.reorderLevel && body.reorderLevel !== undefined && body.reorderLevel !== null && body.reorderLevel !== '') {
      const level = Number(body.reorderLevel);
      if (!Number.isFinite(level) || level < 0) {
        return httpError(res, 400, 'invalid_reorder_level', 'حد إعادة الطلب يجب أن يكون رقمًا غير سالب.');
      }
      desired[cols.reorderLevel] = Math.trunc(level);
    }
    if (cols.pharmacy && scope.pharmacyId) {
      desired[cols.pharmacy] = scope.pharmacyId;
    }

    const payload = payloadFor(columns, 'medicines', desired);
    const { data, error } = await admin.from('medicines').insert(payload).select().limit(1);
    if (error) return httpError(res, 500, 'medicine_insert_failed', error.message);

    const createdMedicine = shapeMedicine(data?.[0], cols);
    notifyInventoryChange(scope.pharmacyId, 'إضافة دواء جديد');
    notifySafetyMedicineChange(scope.pharmacyId, `فحص سلامة دواء جديد: ${createdMedicine?.name ?? ''}`, createdMedicine?.id);
    return res.status(201).json({ ok: true, medicine: createdMedicine });
  }),
);

/** استيراد قائمة أدوية دفعة واحدة (JSON / CSV / دليل PDF) مع منع تكرار الاسم في نفس الصيدلية. */
router.post(
  '/import',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const items = Array.isArray(req.body?.medicines) ? req.body.medicines : null;
    if (!items || items.length === 0) {
      return httpError(res, 400, 'empty_import', 'أرسل مصفوفة medicines غير فارغة.');
    }
    if (items.length > 500) {
      return httpError(res, 400, 'too_many_items', 'الحد الأقصى في الدفعة الواحدة 500 دواء.');
    }

    const columns = await inventoryColumns();
    if (columns.schemaOk && !columns.tables.medicines) {
      return httpError(res, 404, 'table_missing', 'جدول medicines غير موجود في المشروع.');
    }

    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const cols = columns.medicines;
    if (!cols.name) {
      const detectedCols = columns.tables?.medicines?.columnNames ?? [];
      const colsHint = detectedCols.length ? ` الأعمدة الموجودة فعليًا: ${detectedCols.join(', ')}` : '';
      return httpError(
        res,
        400,
        'name_column_missing',
        `لم يُعثر على عمود اسم الدواء في جدول medicines.${colsHint}`,
        { detectedColumns: detectedCols },
      );
    }

    let existingQuery = admin.from('medicines').select(cols.name).limit(2000);
    existingQuery = scopeToPharmacy(existingQuery, columns, 'medicines', req.auth.profile);
    const existingRes = await existingQuery;
    if (existingRes.error) return httpError(res, 500, 'medicines_query_failed', existingRes.error.message);

    const seenNames = new Set(
      (existingRes.data ?? [])
        .map((row) => String(row[cols.name] ?? '').trim().toLowerCase())
        .filter(Boolean),
    );

    const toInsert = [];
    let skippedCount = 0;

    for (const item of items) {
      if (!item || !isNonEmptyString(item.name, 2)) {
        skippedCount += 1;
        continue;
      }
      const name = String(item.name).trim();
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        skippedCount += 1;
        continue;
      }
      seenNames.add(key);

      const desired = { [cols.name]: name };
      if (cols.scientificName && isNonEmptyString(item.scientificName)) {
        desired[cols.scientificName] = String(item.scientificName).trim();
      }
      if (cols.form && isNonEmptyString(item.form)) desired[cols.form] = String(item.form).trim();
      if (cols.strength && isNonEmptyString(item.strength)) desired[cols.strength] = String(item.strength).trim();
      if (cols.barcode && isNonEmptyString(item.barcode)) desired[cols.barcode] = String(item.barcode).trim();
      if (cols.unit && isNonEmptyString(item.unit)) desired[cols.unit] = String(item.unit).trim();
      if (cols.reorderLevel && item.reorderLevel !== undefined && item.reorderLevel !== null && item.reorderLevel !== '') {
        const level = Number(item.reorderLevel);
        if (Number.isFinite(level) && level >= 0) {
          desired[cols.reorderLevel] = Math.trunc(level);
        }
      }
      if (cols.isActive) desired[cols.isActive] = true;
      if (cols.pharmacy && scope.pharmacyId) {
        desired[cols.pharmacy] = scope.pharmacyId;
      }

      toInsert.push(payloadFor(columns, 'medicines', desired));
    }

    if (toInsert.length === 0) {
      return res.status(200).json({
        ok: true,
        insertedCount: 0,
        skippedCount,
        medicines: [],
        message: 'جميع الأدوية المحددة مسجّلة مسبقًا في صيدليتك.',
      });
    }

    const { data, error } = await admin.from('medicines').insert(toInsert).select();
    if (error) return httpError(res, 500, 'medicines_import_failed', error.message);

    notifyInventoryChange(scope.pharmacyId, `استيراد ${data?.length ?? toInsert.length} دواءً`);
    notifySafetyMedicineChange(scope.pharmacyId, `فحص سلامة ${data?.length ?? toInsert.length} دواءً مستوردًا`);
    return res.status(201).json({
      ok: true,
      insertedCount: data?.length ?? toInsert.length,
      skippedCount,
      medicines: (data ?? []).map((row) => shapeMedicine(row, cols)),
    });
  }),
);

/** تعديل دواء (بما فيه أرشفته عبر is_active بدل الحذف). */
router.patch(
  '/:id',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const cols = columns.medicines;
    const body = req.body ?? {};
    const desired = {};

    if (cols.name && body.name !== undefined) {
      if (!isNonEmptyString(body.name, 2)) return httpError(res, 400, 'invalid_name', 'اسم الدواء غير صالح.');
      desired[cols.name] = String(body.name).trim();
    }
    if (cols.scientificName && body.scientificName !== undefined) {
      desired[cols.scientificName] = String(body.scientificName ?? '').trim() || null;
    }
    if (cols.form && body.form !== undefined) desired[cols.form] = String(body.form ?? '').trim() || null;
    if (cols.strength && body.strength !== undefined) desired[cols.strength] = String(body.strength ?? '').trim() || null;
    if (cols.barcode && body.barcode !== undefined) desired[cols.barcode] = String(body.barcode ?? '').trim() || null;
    if (cols.unit && body.unit !== undefined) desired[cols.unit] = String(body.unit ?? '').trim() || null;
    if (cols.reorderLevel && body.reorderLevel !== undefined && body.reorderLevel !== null && body.reorderLevel !== '') {
      const level = Number(body.reorderLevel);
      if (!Number.isFinite(level) || level < 0) {
        return httpError(res, 400, 'invalid_reorder_level', 'حد إعادة الطلب يجب أن يكون رقمًا غير سالب.');
      }
      desired[cols.reorderLevel] = Math.trunc(level);
    }
    if (cols.isActive && body.isActive !== undefined) desired[cols.isActive] = Boolean(body.isActive);

    const payload = payloadFor(columns, 'medicines', desired);
    if (Object.keys(payload).length === 0) {
      return httpError(res, 400, 'empty_update', 'لا توجد حقول قابلة للتحديث.');
    }

    let query = admin.from('medicines').update(payload).eq(cols.id, req.params.id);
    query = scopeToPharmacy(query, columns, 'medicines', req.auth.profile);
    const { data, error } = await query.select().limit(1);
    if (error) return httpError(res, 500, 'medicine_update_failed', error.message);
    if (!data?.length) return httpError(res, 404, 'medicine_not_found', 'الدواء غير موجود.');

    const updatedMedicine = shapeMedicine(data[0], cols);
    notifyInventoryChange(scope.pharmacyId, 'تحديث بيانات دواء');
    notifySafetyMedicineChange(scope.pharmacyId, `إعادة فحص دواء محدّث: ${updatedMedicine?.name ?? ''}`, updatedMedicine?.id);
    return res.json({ ok: true, medicine: updatedMedicine });
  }),
);

export default router;
