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
  requirePharmacy,
  classifyExpiry,
  toDateOnly,
  movementDelta,
  MOVEMENT_TYPES,
  sortBatchesFefo,
  findFefoBlockingBatch,
} from '../inventory.js';

const router = express.Router();

function guard(req, res, next) {
  if (!canWriteInventory(req.auth?.role)) {
    return httpError(res, 403, 'forbidden_role', 'إدارة الدفعات متاحة للمالك والصيدلي ومسؤول المخزون.');
  }
  return next();
}

/** قائمة الدفعات مع اسم الدواء وحالة الصلاحية وترتيب FEFO. */
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

    const scope = requirePharmacy(columns, 'batches', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const cols = columns.batches;
    const includeInactive = req.query.includeInactive === 'true';
    let query = admin.from('inventory_batches').select('*').limit(1000);
    query = scopeToPharmacy(query, columns, 'batches', req.auth.profile);
    if (cols.isActive && !includeInactive) query = query.eq(cols.isActive, true);
    if (req.query.medicineId && cols.medicine) query = query.eq(cols.medicine, req.query.medicineId);

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'batches_query_failed', error.message);

    const now = new Date();
    const allBatches = (data ?? []).map((row) => shapeBatch(row, cols, now));

    // تحديد أول دفعة واجبة الصرف وفق FEFO لكل دواء من الدفعات الصالحة ذات الكمية > 0
    const fefoNextByMedicine = new Map();
    const byMedicine = new Map();
    for (const batch of allBatches) {
      if (!batch.medicineId) continue;
      const list = byMedicine.get(batch.medicineId) ?? [];
      list.push(batch);
      byMedicine.set(batch.medicineId, list);
    }
    for (const [medId, list] of byMedicine.entries()) {
      const sorted = sortBatchesFefo(list, now);
      if (sorted.length > 0) fefoNextByMedicine.set(medId, String(sorted[0].id));
    }

    let batches = allBatches;
    if (typeof req.query.bucket === 'string' && req.query.bucket) {
      batches = batches.filter((batch) => batch.expiryBucket === req.query.bucket);
    }

    // ترتيب العرض: الدفعات الصالحة ذات الكمية أولًا بترتيب FEFO، ثم الفارغة/المنتهية
    batches = batches.slice().sort((a, b) => {
      const aSellable = a.quantity > 0 && a.expiryBucket !== 'expired' ? 0 : 1;
      const bSellable = b.quantity > 0 && b.expiryBucket !== 'expired' ? 0 : 1;
      if (aSellable !== bSellable) return aSellable - bSellable;
      if (a.expiryDate && !b.expiryDate) return -1;
      if (!a.expiryDate && b.expiryDate) return 1;
      if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) {
        return a.expiryDate < b.expiryDate ? -1 : 1;
      }
      const recA = a.receivedAt ? String(a.receivedAt) : '';
      const recB = b.receivedAt ? String(b.receivedAt) : '';
      if (recA && recB && recA !== recB) return recA < recB ? -1 : 1;
      return String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });

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
        isFefoNext: Boolean(batch.medicineId && fefoNextByMedicine.get(String(batch.medicineId)) === String(batch.id)),
      })),
      summary,
      hasMedicineNames: medicineNames.size > 0,
      supportsArchive: Boolean(cols.isActive),
    });
  }),
);

/** إضافة دفعة جديدة (مع حركة استلام لتوثيق المصدر). */
router.post(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    const columns = await inventoryColumns();
    const cols = columns.batches;

    const scope = requirePharmacy(columns, 'batches', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    if (!cols.medicine) {
      return httpError(res, 400, 'medicine_column_missing', 'لم يُعثر على عمود ربط الدفعة بالدواء.');
    }
    if (!isNonEmptyString(body.medicineId, 1)) {
      return httpError(res, 400, 'invalid_medicine', 'اختر الدواء المرتبط بالدفعة.');
    }
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return httpError(res, 400, 'invalid_quantity', 'الكمية يجب أن تكون رقمًا صحيحًا أكبر من صفر.');
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

    // التحقق من أن الدواء ينتمي إلى صيدلية المستخدم نفسها
    const medCols = columns.medicines;
    if (medCols.id) {
      let medCheck = admin.from('medicines').select(medCols.id).eq(medCols.id, String(body.medicineId)).limit(1);
      medCheck = scopeToPharmacy(medCheck, columns, 'medicines', req.auth.profile);
      const medResult = await medCheck;
      if (medResult.error) return httpError(res, 500, 'medicine_check_failed', medResult.error.message);
      if (!medResult.data?.length) {
        return httpError(res, 404, 'medicine_not_found', 'الدواء غير موجود في صيدليتك.');
      }
    }

    const desired = { [cols.medicine]: String(body.medicineId) };
    if (cols.batchNumber) desired[cols.batchNumber] = String(body.batchNumber).trim();
    if (cols.quantity) desired[cols.quantity] = quantity;
    if (cols.expiryDate) desired[cols.expiryDate] = toDateOnly(body.expiryDate);
    if (cols.costPrice && body.costPrice !== undefined && body.costPrice !== null) {
      const costPrice = Number(body.costPrice);
      if (!Number.isFinite(costPrice) || costPrice < 0) {
        return httpError(res, 400, 'invalid_cost_price', 'سعر التكلفة يجب أن يكون رقمًا غير سالب.');
      }
      desired[cols.costPrice] = costPrice;
    }
    if (cols.sellingPrice && body.sellingPrice !== undefined && body.sellingPrice !== null) {
      const sellingPrice = Number(body.sellingPrice);
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
        return httpError(res, 400, 'invalid_selling_price', 'سعر البيع يجب أن يكون رقمًا غير سالب.');
      }
      desired[cols.sellingPrice] = sellingPrice;
    }
    if (cols.pharmacy && scope.pharmacyId) {
      desired[cols.pharmacy] = scope.pharmacyId;
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
      if (moveCols.quantity) movementDesired[moveCols.quantity] = quantity;
      if (moveCols.note) movementDesired[moveCols.note] = 'استلام دفعة جديدة';
      if (moveCols.user) movementDesired[moveCols.user] = req.auth.user.id;
      if (moveCols.pharmacy && scope.pharmacyId) {
        movementDesired[moveCols.pharmacy] = scope.pharmacyId;
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
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'batches', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

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
    if (cols.costPrice && body.costPrice !== undefined) {
      const costPrice = Number(body.costPrice);
      if (!Number.isFinite(costPrice) || costPrice < 0) return httpError(res, 400, 'invalid_cost_price', 'سعر التكلفة غير صالح.');
      desired[cols.costPrice] = costPrice;
    }
    if (cols.sellingPrice && body.sellingPrice !== undefined) {
      const sellingPrice = Number(body.sellingPrice);
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0) return httpError(res, 400, 'invalid_selling_price', 'سعر البيع غير صالح.');
      desired[cols.sellingPrice] = sellingPrice;
    }
    if (cols.isActive && body.isActive !== undefined) {
      desired[cols.isActive] = Boolean(body.isActive);
    }

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
 * تعديل كمية الدفعة بحركة موثّقة (استلام/صرف/تعديل/إتلاف/إرجاع).
 * يرفض أي حركة تجعل الكمية سالبة، ويمنع صرف دفعة منتهية، ويُنفذ قاعدة FEFO عند الصرف.
 */
router.post(
  '/:id/movements',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!MOVEMENT_TYPES.includes(type)) {
      return httpError(res, 400, 'invalid_movement_type', 'نوع الحركة غير مدعوم.', {
        allowed: [...MOVEMENT_TYPES],
      });
    }
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return httpError(res, 400, 'invalid_quantity', 'الكمية يجب أن تكون رقمًا صحيحًا أكبر من صفر.');
    }

    const columns = await inventoryColumns();
    const batchScope = requirePharmacy(columns, 'batches', req.auth.profile);
    if (!batchScope.ok) return httpError(res, batchScope.status, batchScope.code, batchScope.message);
    const moveScope = requirePharmacy(columns, 'movements', req.auth.profile);
    if (!moveScope.ok) return httpError(res, moveScope.status, moveScope.code, moveScope.message);

    const cols = columns.batches;
    const moveCols = columns.movements;
    if (!cols.quantity) {
      return httpError(res, 400, 'quantity_column_missing', 'لم يُعثر على عمود الكمية في جدول الدفعات.');
    }
    if (!moveCols.batch || !moveCols.type) {
      return httpError(res, 400, 'movement_schema_incomplete', 'جدول حركات المخزون لا يحتوي أعمدة الربط المطلوبة.');
    }

    let readQuery = admin.from('inventory_batches').select('*').eq(cols.id, req.params.id).limit(1);
    readQuery = scopeToPharmacy(readQuery, columns, 'batches', req.auth.profile);
    const read = await readQuery;
    if (read.error) return httpError(res, 500, 'batch_read_failed', read.error.message);
    const batch = read.data?.[0];
    if (!batch) return httpError(res, 404, 'batch_not_found', 'الدفعة غير موجودة.');

    const now = new Date();
    const shaped = shapeBatch(batch, cols, now);

    if (type === 'dispense' && shaped.expiryBucket === 'expired') {
      return httpError(res, 409, 'expired_batch_dispense_rejected', 'لا يمكن الصرف من دفعة منتهية الصلاحية.', {
        expiryDate: shaped.expiryDate,
      });
    }
    if (type === 'receive' && shaped.expiryBucket === 'expired') {
      return httpError(res, 409, 'expired_batch_receive_rejected', 'لا يمكن إضافة استلام إلى دفعة منتهية الصلاحية.', {
        expiryDate: shaped.expiryDate,
      });
    }

    // التحقق من FEFO عند الصرف من دفعة محددة إذا وُجدت دفعات أخرى لنفس الدواء
    if (type === 'dispense' && shaped.medicineId && cols.medicine) {
      let siblingQuery = admin.from('inventory_batches').select('*').eq(cols.medicine, shaped.medicineId).limit(500);
      siblingQuery = scopeToPharmacy(siblingQuery, columns, 'batches', req.auth.profile);
      const siblingsRes = await siblingQuery;
      if (siblingsRes.error) return httpError(res, 500, 'batches_read_failed', siblingsRes.error.message);
      const siblings = (siblingsRes.data ?? []).map((row) => shapeBatch(row, cols, now));
      const blocking = findFefoBlockingBatch(siblings, shaped, now);
      if (blocking) {
        return httpError(
          res,
          409,
          'fefo_violation',
          `يخالف قاعدة FEFO: يجب الصرف أولًا من الدفعة ${blocking.batchNumber ?? blocking.id} (تنتهي في ${blocking.expiryDate} وبها ${blocking.quantity} وحدة).`,
          { earliestBatch: blocking },
        );
      }
    }

    const current = Number(batch[cols.quantity] ?? 0) || 0;
    const delta = movementDelta(type, quantity);
    const next = current + delta;
    if (next < 0) {
      return httpError(res, 409, 'insufficient_quantity', 'الكمية المتاحة في الدفعة لا تكفي لهذه الحركة.', {
        current,
        requested: quantity,
      });
    }

    let updateQuery = admin
      .from('inventory_batches')
      .update({ [cols.quantity]: next })
      .eq(cols.id, req.params.id)
      .eq(cols.quantity, current);
    updateQuery = scopeToPharmacy(updateQuery, columns, 'batches', req.auth.profile);
    const update = await updateQuery.select().limit(1);
    if (update.error) return httpError(res, 500, 'batch_update_failed', update.error.message);
    if (!update.data?.length) {
      return httpError(res, 409, 'concurrent_modification', 'تغيّرت كمية الدفعة أثناء الطلب. حدّث الصفحة وأعد المحاولة.');
    }

    const desired = {
      [moveCols.batch]: req.params.id,
      [moveCols.type]: type,
    };
    if (moveCols.medicine && cols.medicine && batch[cols.medicine] != null) {
      desired[moveCols.medicine] = String(batch[cols.medicine]);
    }
    if (moveCols.quantity) desired[moveCols.quantity] = quantity;
    if (moveCols.note && isNonEmptyString(body.note)) desired[moveCols.note] = String(body.note).trim();
    if (moveCols.user) desired[moveCols.user] = req.auth.user.id;
    if (moveCols.pharmacy && batchScope.pharmacyId) {
      desired[moveCols.pharmacy] = batchScope.pharmacyId;
    }

    const payload = payloadFor(columns, 'stock_movements', desired);
    const inserted = await admin.from('stock_movements').insert(payload).select().limit(1);
    if (inserted.error) {
      // تراجع عن تحديث كمية الدفعة عند فشل تسجيل الحركة
      let rollbackQuery = admin.from('inventory_batches').update({ [cols.quantity]: current }).eq(cols.id, req.params.id);
      rollbackQuery = scopeToPharmacy(rollbackQuery, columns, 'batches', req.auth.profile);
      await rollbackQuery;
      return httpError(res, 500, 'movement_insert_failed', inserted.error.message);
    }

    return res.json({
      ok: true,
      batch: shapeBatch(update.data?.[0], cols),
      previousQuantity: current,
      newQuantity: next,
      movementLogged: true,
      movementError: null,
    });
  }),
);

export default router;

