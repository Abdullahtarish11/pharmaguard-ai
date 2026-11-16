import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE, canWriteInventory } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeBatch,
  shapeMedicine,
  payloadFor,
  scopeToPharmacy,
  classifyExpiry,
  toDateOnly,
  movementDelta,
} from '../inventory.js';

const router = express.Router();

function guard(req, res, next) {
  if (!canWriteInventory(req.auth?.role)) {
    return httpError(res, 403, 'forbidden_role', 'إدارة الدفعات متاحة للمالك ومسؤول المخزون.');
  }
  return next();
}

/** قائمة الدفعات مع اسم الدواء وحالة الصلاحية. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    if (columns.schemaOk && !columns.tables.inventory_batches) {
      return httpError(res, 404, 'table_missing', 'جدول inventory_batches غير موجود في المشروع.');
    }

    const cols = columns.batches;
    let query = admin.from('inventory_batches').select('*').limit(1000);
    query = scopeToPharmacy(query, columns, 'batches', req.auth.profile);
    if (req.query.medicineId && cols.medicine) query = query.eq(cols.medicine, req.query.medicineId);

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'batches_query_failed', error.message);

    const now = new Date();
    let batches = (data ?? []).map((row) => shapeBatch(row, cols, now));

    if (typeof req.query.bucket === 'string' && req.query.bucket) {
      batches = batches.filter((batch) => batch.expiryBucket === req.query.bucket);
    }

    // أسماء الأدوية لعرضها بجانب كل دفعة
    const medCols = columns.medicines;
    const medicineNames = new Map();
    if (medCols.name) {
      let medQuery = admin.from('medicines').select('*').limit(1000);
      medQuery = scopeToPharmacy(medQuery, columns, 'medicines', req.auth.profile);
      const medResult = await medQuery;
      if (!medResult.error) {
        for (const row of medResult.data ?? []) {
          const shaped = shapeMedicine(row, medCols);
          if (shaped?.id) medicineNames.set(String(shaped.id), shaped.name);
        }
      }
    }

    const summary = { total: 0, expired: 0, critical: 0, warning: 0, ok: 0, unknown: 0 };
    for (const batch of batches) {
      summary.total += 1;
      if (summary[batch.expiryBucket] !== undefined) summary[batch.expiryBucket] += 1;
    }

    return res.json({
      batches: batches.map((batch) => ({
        ...batch,
        medicineName: medicineNames.get(String(batch.medicineId)) ?? null,
      })),
      summary,
      hasMedicineNames: medicineNames.size > 0,
    });
  }),
);

/** إضافة دفعة جديدة (مع حركة استلام اختيارية لتوثيق المصدر). */
router.post(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    const columns = await inventoryColumns();
    const cols = columns.batches;

    if (!cols.medicine) {
      return httpError(res, 400, 'medicine_column_missing', 'لم يُعثر على عمود ربط الدفعة بالدواء.');
    }
    if (!isNonEmptyString(body.medicineId, 1)) {
      return httpError(res, 400, 'invalid_medicine', 'اختر الدواء المرتبط بالدفعة.');
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return httpError(res, 400, 'invalid_quantity', 'الكمية يجب أن تكون رقمًا أكبر من صفر.');
    }
    if (!isNonEmptyString(body.batchNumber, 1)) {
      return httpError(res, 400, 'invalid_batch_number', 'رقم التشغيلة مطلوب.');
    }
    if (!isNonEmptyString(body.expiryDate, 8) || !toDateOnly(body.expiryDate)) {
      return httpError(res, 400, 'invalid_expiry', 'تاريخ الصلاحية مطلوب بصيغة تاريخ صحيحة.');
    }

    const expiryBucket = classifyExpiry(toDateOnly(body.expiryDate));
    if (expiryBucket.bucket === 'expired') {
      return httpError(res, 400, 'expired_batch_rejected', 'لا يمكن إدخال دفعة منتهية الصلاحية بالفعل.', {
        expiryDate: toDateOnly(body.expiryDate),
      });
    }

    const desired = { [cols.medicine]: String(body.medicineId) };
    if (cols.batchNumber) desired[cols.batchNumber] = String(body.batchNumber).trim();
    if (cols.quantity) desired[cols.quantity] = Math.trunc(quantity);
    if (cols.expiryDate) desired[cols.expiryDate] = toDateOnly(body.expiryDate);
    if (cols.costPrice && body.costPrice !== undefined) desired[cols.costPrice] = Number(body.costPrice) || 0;
    if (cols.sellingPrice && body.sellingPrice !== undefined) desired[cols.sellingPrice] = Number(body.sellingPrice) || 0;
    if (cols.pharmacy) {
      const pharmacyId = req.auth.publicProfile?.pharmacyId;
      if (pharmacyId) desired[cols.pharmacy] = pharmacyId;
    }

    const payload = payloadFor(columns, 'inventory_batches', desired);
    const { data, error } = await admin.from('inventory_batches').insert(payload).select().limit(1);
    if (error) return httpError(res, 500, 'batch_insert_failed', error.message);

    const created = data?.[0];
    const createdId = created?.[cols.id] ?? null;

    // حركة استلام توثّق إدخال الكمية — تُنشأ فقط إن كان جدول الحركات قابلًا للكتابة.
    let movementNote = null;
    const moveCols = columns.movements;
    if (createdId && moveCols.batch && moveCols.type) {
      const movementDesired = {
        [moveCols.batch]: createdId,
        [moveCols.type]: 'receive',
      };
      if (moveCols.medicine) movementDesired[moveCols.medicine] = String(body.medicineId);
      if (moveCols.quantity) movementDesired[moveCols.quantity] = Math.trunc(quantity);
      if (moveCols.note) movementDesired[moveCols.note] = 'استلام دفعة جديدة';
      if (moveCols.user) movementDesired[moveCols.user] = req.auth.user.id;
      if (moveCols.pharmacy && req.auth.publicProfile?.pharmacyId) {
        movementDesired[moveCols.pharmacy] = req.auth.publicProfile.pharmacyId;
      }
      const movementPayload = payloadFor(columns, 'stock_movements', movementDesired);
      const movement = await admin.from('stock_movements').insert(movementPayload).select().limit(1);
      if (movement.error) movementNote = `تم إنشاء الدفعة، لكن تعذّر تسجيل حركة الاستلام: ${movement.error.message}`;
    }

    return res.status(201).json({
      ok: true,
      batch: shapeBatch(created, cols),
      movementLogged: movementNote === null,
      note: movementNote,
    });
  }),
);

/**
 * تعديل بيانات الدفعة (رقم التشغيلة/الصلاحية/الأسعار) — الكميات تُعدّل عبر الحركات.
 */
router.patch(
  '/:id',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const cols = columns.batches;
    const body = req.body ?? {};
    const desired = {};

    if (cols.batchNumber && body.batchNumber !== undefined) {
      if (!isNonEmptyString(body.batchNumber, 1)) return httpError(res, 400, 'invalid_batch_number', 'رقم التشغيلة غير صالح.');
      desired[cols.batchNumber] = String(body.batchNumber).trim();
    }
    if (cols.expiryDate && body.expiryDate !== undefined) {
      const dateOnly = toDateOnly(body.expiryDate);
      if (!dateOnly) return httpError(res, 400, 'invalid_expiry', 'تاريخ الصلاحية غير صالح.');
      desired[cols.expiryDate] = dateOnly;
    }
    if (cols.costPrice && body.costPrice !== undefined) desired[cols.costPrice] = Number(body.costPrice) || 0;
    if (cols.sellingPrice && body.sellingPrice !== undefined) desired[cols.sellingPrice] = Number(body.sellingPrice) || 0;

    const payload = payloadFor(columns, 'inventory_batches', desired);
    if (Object.keys(payload).length === 0) {
      return httpError(res, 400, 'empty_update', 'لا توجد حقول قابلة للتحديث. الكميات تُعدّل من حركات المخزون.');
    }

    let query = admin.from('inventory_batches').update(payload).eq(cols.id, req.params.id);
    query = scopeToPharmacy(query, columns, 'batches', req.auth.profile);
    const { data, error } = await query.select().limit(1);
    if (error) return httpError(res, 500, 'batch_update_failed', error.message);
    if (!data?.length) return httpError(res, 404, 'batch_not_found', 'الدفعة غير موجودة.');

    return res.json({ ok: true, batch: shapeBatch(data[0], cols) });
  }),
);

/**
 * تعديل كمية الدفعة بحركة موثّقة (صرف/إرجاع/تسوية/إتلاف).
 * يرفض أي حركة تجعل الكمية سالبة.
 */
router.post(
  '/:id/movements',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!['dispense', 'return', 'adjust', 'write_off'].includes(type)) {
      return httpError(res, 400, 'invalid_movement_type', 'نوع الحركة غير مدعوم.', {
        allowed: ['dispense', 'return', 'adjust', 'write_off'],
      });
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return httpError(res, 400, 'invalid_quantity', 'الكمية يجب أن تكون أكبر من صفر.');
    }

    const columns = await inventoryColumns();
    const cols = columns.batches;
    if (!cols.quantity) {
      return httpError(res, 400, 'quantity_column_missing', 'لم يُعثر على عمود الكمية في جدول الدفعات.');
    }

    let readQuery = admin.from('inventory_batches').select('*').eq(cols.id, req.params.id).limit(1);
    readQuery = scopeToPharmacy(readQuery, columns, 'batches', req.auth.profile);
    const read = await readQuery;
    if (read.error) return httpError(res, 500, 'batch_read_failed', read.error.message);
    const batch = read.data?.[0];
    if (!batch) return httpError(res, 404, 'batch_not_found', 'الدفعة غير موجودة.');

    const current = Number(batch[cols.quantity] ?? 0) || 0;
    const delta = movementDelta(type, quantity);
    const next = current + delta;
    if (next < 0) {
      return httpError(res, 409, 'insufficient_quantity', 'الكمية المتاحة في الدفعة لا تكفي لهذه الحركة.', {
        current,
        requested: quantity,
      });
    }

    const update = await admin
      .from('inventory_batches')
      .update({ [cols.quantity]: next })
      .eq(cols.id, req.params.id)
      .select()
      .limit(1);
    if (update.error) return httpError(res, 500, 'batch_update_failed', update.error.message);

    const moveCols = columns.movements;
    let movement = null;
    let movementError = null;
    if (moveCols.batch && moveCols.type) {
      const desired = {
        [moveCols.batch]: req.params.id,
        [moveCols.type]: type,
      };
      if (moveCols.medicine && cols.medicine && batch[cols.medicine] != null) {
        desired[moveCols.medicine] = String(batch[cols.medicine]);
      }
      if (moveCols.quantity) desired[moveCols.quantity] = Math.trunc(quantity);
      if (moveCols.note && isNonEmptyString(body.note)) desired[moveCols.note] = String(body.note).trim();
      if (moveCols.user) desired[moveCols.user] = req.auth.user.id;
      if (moveCols.pharmacy && req.auth.publicProfile?.pharmacyId) {
        desired[moveCols.pharmacy] = req.auth.publicProfile.pharmacyId;
      }
      const payload = payloadFor(columns, 'stock_movements', desired);
      const inserted = await admin.from('stock_movements').insert(payload).select().limit(1);
      if (inserted.error) movementError = inserted.error.message;
      else movement = inserted.data?.[0] ?? null;
    } else {
      movementError = 'جدول حركات المخزون لا يحتوي أعمدة الربط المطلوبة.';
    }

    return res.json({
      ok: true,
      batch: shapeBatch(update.data?.[0], cols),
      previousQuantity: current,
      newQuantity: next,
      movementLogged: movement !== null,
      movementError,
    });
  }),
);

export default router;
