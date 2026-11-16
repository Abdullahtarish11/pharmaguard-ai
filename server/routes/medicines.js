import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE, canWriteInventory } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeMedicine,
  payloadFor,
  scopeToPharmacy,
  aggregateStock,
} from '../inventory.js';

const router = express.Router();

function guard(req, res, next) {
  if (!canWriteInventory(req.auth?.role)) {
    return httpError(res, 403, 'forbidden_role', 'إدارة الأدوية متاحة للمالك ومسؤول المخزون.');
  }
  return next();
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

    const cols = columns.medicines;
    let query = admin.from('medicines').select('*').limit(500);
    query = scopeToPharmacy(query, columns, 'medicines', req.auth.profile);
    if (cols.isActive) query = query.eq(cols.isActive, true);

    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (search && (cols.name || cols.scientificName || cols.barcode)) {
      const parts = [cols.name, cols.scientificName, cols.barcode].filter(Boolean);
      query = query.or(parts.map((column) => `${column}.ilike.%${search.replace(/[,%]/g, ' ')}%`).join(','));
    }

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'medicines_query_failed', error.message);

    const medicines = (data ?? []).map((row) => shapeMedicine(row, cols));

    const batchCols = columns.batches;
    let batchQuery = admin.from('inventory_batches').select('*').limit(2000);
    batchQuery = scopeToPharmacy(batchQuery, columns, 'batches', req.auth.profile);
    const batchResult = await batchQuery;
    const batches = batchResult.error
      ? []
      : (batchResult.data ?? []).map((row) => ({
          id: row[batchCols.id] ?? null,
          medicineId: batchCols.medicine && row[batchCols.medicine] != null ? String(row[batchCols.medicine]) : null,
          quantity: Number(row[batchCols.quantity] ?? 0) || 0,
          expiryBucket:
            batchCols.expiryDate && row[batchCols.expiryDate]
              ? new Date(row[batchCols.expiryDate]) < new Date()
                ? 'expired'
                : 'ok'
              : 'unknown',
          costPrice: Number(row[batchCols.costPrice] ?? 0) || 0,
          sellingPrice: Number(row[batchCols.sellingPrice] ?? 0) || 0,
        }));

    const stock = aggregateStock(batches);

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
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    if (!isNonEmptyString(body.name, 2)) {
      return httpError(res, 400, 'invalid_name', 'اسم الدواء مطلوب.');
    }

    const columns = await inventoryColumns();
    const cols = columns.medicines;
    if (!cols.name) {
      return httpError(res, 400, 'name_column_missing', 'لم يُعثر على عمود اسم الدواء في جدول medicines.');
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
    if (cols.reorderLevel && body.reorderLevel !== undefined) {
      const level = Number(body.reorderLevel);
      if (!Number.isFinite(level) || level < 0) {
        return httpError(res, 400, 'invalid_reorder_level', 'حد إعادة الطلب يجب أن يكون رقمًا غير سالب.');
      }
      desired[cols.reorderLevel] = Math.trunc(level);
    }
    if (cols.pharmacy) {
      const pharmacyId = req.auth.publicProfile?.pharmacyId;
      if (pharmacyId) desired[cols.pharmacy] = pharmacyId;
    }

    const payload = payloadFor(columns, 'medicines', desired);
    const { data, error } = await admin.from('medicines').insert(payload).select().limit(1);
    if (error) return httpError(res, 500, 'medicine_insert_failed', error.message);

    return res.status(201).json({ ok: true, medicine: shapeMedicine(data?.[0], cols) });
  }),
);

/** تعديل دواء (بما فيه أرشفته عبر is_active بدل الحذف). */
router.patch(
  '/:id',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
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
    if (cols.reorderLevel && body.reorderLevel !== undefined) {
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

    return res.json({ ok: true, medicine: shapeMedicine(data[0], cols) });
  }),
);

export default router;
