import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE, canWriteInventory } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeBatch,
  shapeMedicine,
  shapeMovement,
  payloadFor,
  scopeToPharmacy,
  requirePharmacy,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABELS,
  INCREASING_MOVEMENTS,
  DECREASING_MOVEMENTS,
  movementDelta,
  planFefoDispense,
  findFefoBlockingBatch,
} from '../inventory.js';
import { notifyInventoryChange } from '../agentSweep.js';

const router = express.Router();

function guard(req, res, next) {
  if (!canWriteInventory(req.auth?.role)) {
    return httpError(res, 403, 'forbidden_role', 'تسجيل حركات المخزون متاح للمالك والصيدلي ومسؤول المخزون.');
  }
  return next();
}

/** سجل الحركات مع أسماء الأدوية وأرقام الدفعات وإجمالي الوارد والصادر. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    if (columns.schemaOk && !columns.tables.stock_movements) {
      return httpError(res, 404, 'table_missing', 'جدول stock_movements غير موجود في المشروع.');
    }

    const scope = requirePharmacy(columns, 'movements', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const cols = columns.movements;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    let query = admin.from('stock_movements').select('*').limit(limit);
    query = scopeToPharmacy(query, columns, 'movements', req.auth.profile);
    if (cols.createdAt) query = query.order(cols.createdAt, { ascending: false });
    if (typeof req.query.type === 'string' && req.query.type && cols.type) {
      query = query.eq(cols.type, req.query.type);
    }

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'movements_query_failed', error.message);

    // جلب أرقام الدفعات وأسماء الأدوية في نفس الصيدلية للعرض الواضح
    const batchNumbers = new Map();
    const batchCols = columns.batches;
    if (batchCols.id && batchCols.batchNumber) {
      let batchQuery = admin.from('inventory_batches').select(`${batchCols.id},${batchCols.batchNumber}`).limit(2000);
      batchQuery = scopeToPharmacy(batchQuery, columns, 'batches', req.auth.profile);
      const batchRes = await batchQuery;
      if (!batchRes.error) {
        for (const row of batchRes.data ?? []) {
          if (row[batchCols.id] != null) batchNumbers.set(String(row[batchCols.id]), row[batchCols.batchNumber] ?? null);
        }
      }
    }

    const medicineNames = new Map();
    const medCols = columns.medicines;
    if (medCols.id && medCols.name) {
      let medQuery = admin.from('medicines').select('*').limit(1000);
      medQuery = scopeToPharmacy(medQuery, columns, 'medicines', req.auth.profile);
      const medRes = await medQuery;
      if (!medRes.error) {
        for (const row of medRes.data ?? []) {
          const shaped = shapeMedicine(row, medCols);
          if (shaped?.id) medicineNames.set(String(shaped.id), shaped.name);
        }
      }
    }

    const movements = (data ?? []).map((row) => {
      const shaped = shapeMovement(row, cols);
      return {
        ...shaped,
        typeLabel: MOVEMENT_TYPE_LABELS[shaped.type] ?? MOVEMENT_TYPE_LABELS.unknown,
        batchNumber: shaped.batchId ? batchNumbers.get(String(shaped.batchId)) ?? null : null,
        medicineName: shaped.medicineId ? medicineNames.get(String(shaped.medicineId)) ?? null : null,
      };
    });

    const totals = {
      count: movements.length,
      inbound: 0,
      outbound: 0,
    };
    for (const movement of movements) {
      const key = movement.type ?? 'unknown';
      const qty = Math.abs(movement.quantity);
      totals[key] = (totals[key] ?? 0) + qty;
      if (INCREASING_MOVEMENTS.includes(key)) {
        totals.inbound += qty;
      } else if (DECREASING_MOVEMENTS.includes(key)) {
        totals.outbound += qty;
      }
    }

    return res.json({
      movements,
      totals,
      typeLabels: MOVEMENT_TYPE_LABELS,
      supportedTypes: [...MOVEMENT_TYPES],
      quantityColumnPresent: Boolean(cols.quantity),
    });
  }),
);

/**
 * تسجيل حركة على دفعة محددة، أو صرف تلقائي حسب FEFO على مستوى الدواء (medicineId).
 * يمنع الصرف من دفعة منتهية أو مخالفة FEFO أو النزول تحت الصفر.
 */
router.post(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!MOVEMENT_TYPES.includes(type)) {
      return httpError(res, 400, 'invalid_movement_type', 'نوع الحركة غير مدعوم.', { allowed: [...MOVEMENT_TYPES] });
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

    const batchCols = columns.batches;
    const moveCols = columns.movements;

    if (!moveCols.batch || !moveCols.type) {
      return httpError(res, 400, 'movement_schema_incomplete', 'جدول الحركات لا يحتوي أعمدة الربط المطلوبة.');
    }
    if (!batchCols.quantity) {
      return httpError(res, 400, 'quantity_column_missing', 'لم يُعثر على عمود الكمية في جدول الدفعات.');
    }

    const now = new Date();
    const hasBatchId = isNonEmptyString(body.batchId, 1);
    const hasMedicineId = isNonEmptyString(body.medicineId, 1);

    // 1) الصرف التلقائي بترتيب FEFO على مستوى الدواء عند عدم تحديد دفعة بعينها
    if (type === 'dispense' && !hasBatchId && hasMedicineId) {
      if (!batchCols.medicine) {
        return httpError(res, 400, 'medicine_column_missing', 'لم يُعثر على عمود ربط الدفعة بالدواء.');
      }

      let medBatchesQuery = admin
        .from('inventory_batches')
        .select('*')
        .eq(batchCols.medicine, String(body.medicineId))
        .limit(500);
      medBatchesQuery = scopeToPharmacy(medBatchesQuery, columns, 'batches', req.auth.profile);
      const medBatchesRes = await medBatchesQuery;
      if (medBatchesRes.error) return httpError(res, 500, 'batches_read_failed', medBatchesRes.error.message);

      const shapedBatches = (medBatchesRes.data ?? []).map((row) => shapeBatch(row, batchCols, now));
      if (shapedBatches.length === 0) {
        return httpError(res, 404, 'batch_not_found', 'لا توجد دفعات مسجّلة لهذا الدواء.');
      }

      const plan = planFefoDispense(shapedBatches, quantity, now);
      if (!plan.ok) {
        return httpError(
          res,
          409,
          'insufficient_quantity',
          `الكمية الصالحة المتاحة عبر الدفعات (${plan.available}) لا تكفي لصرف ${quantity} وحدة.`,
          { available: plan.available, requested: quantity },
        );
      }

      const appliedBatches = [];
      const insertedMovementIds = [];
      const createdMovements = [];

      const rollbackApplied = async () => {
        for (const applied of appliedBatches.reverse()) {
          let rb = admin
            .from('inventory_batches')
            .update({ [batchCols.quantity]: applied.previousQuantity })
            .eq(batchCols.id, applied.batchId);
          rb = scopeToPharmacy(rb, columns, 'batches', req.auth.profile);
          await rb;
        }
        if (moveCols.id && insertedMovementIds.length > 0) {
          let del = admin.from('stock_movements').delete().in(moveCols.id, insertedMovementIds);
          del = scopeToPharmacy(del, columns, 'movements', req.auth.profile);
          await del;
        }
      };

      for (const alloc of plan.allocations) {
        let upd = admin
          .from('inventory_batches')
          .update({ [batchCols.quantity]: alloc.newQuantity })
          .eq(batchCols.id, alloc.batchId)
          .eq(batchCols.quantity, alloc.previousQuantity);
        upd = scopeToPharmacy(upd, columns, 'batches', req.auth.profile);
        const updateRes = await upd.select().limit(1);
        if (updateRes.error || !updateRes.data?.length) {
          await rollbackApplied();
          if (updateRes.error) return httpError(res, 500, 'batch_update_failed', updateRes.error.message);
          return httpError(res, 409, 'concurrent_modification', 'تغيّرت كمية إحدى الدفعات أثناء الصرف. أعد المحاولة.');
        }
        appliedBatches.push(alloc);

        const desired = {
          [moveCols.batch]: alloc.batchId,
          [moveCols.type]: 'dispense',
        };
        if (moveCols.medicine) desired[moveCols.medicine] = String(body.medicineId);
        if (moveCols.quantity) desired[moveCols.quantity] = alloc.take;
        if (moveCols.note && isNonEmptyString(body.note)) desired[moveCols.note] = String(body.note).trim();
        if (moveCols.user) desired[moveCols.user] = req.auth.user.id;
        if (moveCols.pharmacy && batchScope.pharmacyId) {
          desired[moveCols.pharmacy] = batchScope.pharmacyId;
        }

        const payload = payloadFor(columns, 'stock_movements', desired);
        const ins = await admin.from('stock_movements').insert(payload).select().limit(1);
        if (ins.error) {
          await rollbackApplied();
          return httpError(res, 500, 'movement_insert_failed', ins.error.message);
        }
        const row = ins.data?.[0];
        if (row && moveCols.id && row[moveCols.id] != null) insertedMovementIds.push(row[moveCols.id]);
        createdMovements.push(shapeMovement(row, moveCols));
      }

      notifyInventoryChange(batchScope.pharmacyId, 'صرف تلقائي بترتيب FEFO');
      return res.status(201).json({
        ok: true,
        mode: 'fefo',
        medicineId: String(body.medicineId),
        quantity,
        allocations: plan.allocations,
        movements: createdMovements,
      });
    }

    // 2) حركة على دفعة محددة
    if (!hasBatchId) {
      return httpError(
        res,
        400,
        'invalid_batch',
        type === 'dispense'
          ? 'اختر الدفعة المرتبطة بالحركة، أو اختر الدواء للصرف التلقائي حسب FEFO.'
          : 'اختر الدفعة المرتبطة بالحركة.',
      );
    }

    let readQuery = admin.from('inventory_batches').select('*').eq(batchCols.id, body.batchId).limit(1);
    readQuery = scopeToPharmacy(readQuery, columns, 'batches', req.auth.profile);
    const read = await readQuery;
    if (read.error) return httpError(res, 500, 'batch_read_failed', read.error.message);
    const batch = read.data?.[0];
    if (!batch) return httpError(res, 404, 'batch_not_found', 'الدفعة غير موجودة.');

    const shaped = shapeBatch(batch, batchCols, now);
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

    // إنفاذ FEFO عند الصرف من دفعة محددة
    if (type === 'dispense' && shaped.medicineId && batchCols.medicine) {
      let siblingQuery = admin
        .from('inventory_batches')
        .select('*')
        .eq(batchCols.medicine, shaped.medicineId)
        .limit(500);
      siblingQuery = scopeToPharmacy(siblingQuery, columns, 'batches', req.auth.profile);
      const siblingsRes = await siblingQuery;
      if (siblingsRes.error) return httpError(res, 500, 'batches_read_failed', siblingsRes.error.message);
      const siblings = (siblingsRes.data ?? []).map((row) => shapeBatch(row, batchCols, now));
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

    const current = Number(batch[batchCols.quantity] ?? 0) || 0;
    const next = current + movementDelta(type, quantity);
    if (next < 0) {
      return httpError(res, 409, 'insufficient_quantity', 'الكمية المتاحة لا تكفي لهذه الحركة.', {
        current,
        requested: quantity,
      });
    }

    let updateQuery = admin
      .from('inventory_batches')
      .update({ [batchCols.quantity]: next })
      .eq(batchCols.id, body.batchId)
      .eq(batchCols.quantity, current);
    updateQuery = scopeToPharmacy(updateQuery, columns, 'batches', req.auth.profile);
    const update = await updateQuery.select().limit(1);
    if (update.error) return httpError(res, 500, 'batch_update_failed', update.error.message);
    if (!update.data?.length) {
      return httpError(res, 409, 'concurrent_modification', 'تغيّرت كمية الدفعة أثناء الطلب. حدّث الصفحة وأعد المحاولة.');
    }

    const desired = {
      [moveCols.batch]: body.batchId,
      [moveCols.type]: type,
    };
    if (moveCols.medicine && batchCols.medicine && batch[batchCols.medicine] != null) {
      desired[moveCols.medicine] = String(batch[batchCols.medicine]);
    }
    if (moveCols.quantity) desired[moveCols.quantity] = quantity;
    if (moveCols.note && isNonEmptyString(body.note)) desired[moveCols.note] = String(body.note).trim();
    if (moveCols.user) desired[moveCols.user] = req.auth.user.id;
    if (moveCols.pharmacy && batchScope.pharmacyId) {
      desired[moveCols.pharmacy] = batchScope.pharmacyId;
    }

    const payload = payloadFor(columns, 'stock_movements', desired);
    const { data, error } = await admin.from('stock_movements').insert(payload).select().limit(1);
    if (error) {
      let rollbackQuery = admin
        .from('inventory_batches')
        .update({ [batchCols.quantity]: current })
        .eq(batchCols.id, body.batchId);
      rollbackQuery = scopeToPharmacy(rollbackQuery, columns, 'batches', req.auth.profile);
      await rollbackQuery;
      return httpError(res, 500, 'movement_insert_failed', error.message);
    }

    notifyInventoryChange(batchScope.pharmacyId, `حركة مخزون (${type})`);
    return res.status(201).json({
      ok: true,
      mode: 'batch',
      movement: shapeMovement(data?.[0], moveCols),
      previousQuantity: current,
      newQuantity: next,
    });
  }),
);

export default router;

