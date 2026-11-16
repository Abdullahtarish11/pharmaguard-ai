import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE, canWriteInventory } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeMovement,
  payloadFor,
  scopeToPharmacy,
  MOVEMENT_TYPES,
  movementDelta,
} from '../inventory.js';

const router = express.Router();

function guard(req, res, next) {
  if (!canWriteInventory(req.auth?.role)) {
    return httpError(res, 403, 'forbidden_role', 'تسجيل حركات المخزون متاح للمالك ومسؤول المخزون.');
  }
  return next();
}

const TYPE_LABELS = {
  receive: 'استلام',
  dispense: 'صرف',
  adjust: 'تسوية',
  write_off: 'إتلاف/سحب',
  return: 'إرجاع',
  unknown: 'غير محدد',
};

/** سجل الحركات مع أسماء الأدوية. */
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

    const movements = (data ?? []).map((row) => {
      const shaped = shapeMovement(row, cols);
      return { ...shaped, typeLabel: TYPE_LABELS[shaped.type] ?? TYPE_LABELS.unknown };
    });

    const totals = {};
    for (const movement of movements) {
      const key = movement.type ?? 'unknown';
      totals[key] = (totals[key] ?? 0) + Math.abs(movement.quantity);
    }

    return res.json({
      movements,
      totals,
      typeLabels: TYPE_LABELS,
      supportedTypes: [...MOVEMENT_TYPES],
      quantityColumnPresent: Boolean(cols.quantity),
    });
  }),
);

/**
 * تسجيل حركة مستقلة على دفعة (استلام إضافي، صرف، إرجاع، تسوية، إتلاف).
 * يحدّث كمية الدفعة في نفس الطلب ويرفض النتيجة السالبة.
 */
router.post(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  guard,
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const body = req.body ?? {};
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!MOVEMENT_TYPES.includes(type)) {
      return httpError(res, 400, 'invalid_movement_type', 'نوع الحركة غير مدعوم.', { allowed: [...MOVEMENT_TYPES] });
    }
    if (!isNonEmptyString(body.batchId, 1)) {
      return httpError(res, 400, 'invalid_batch', 'اختر الدفعة المرتبطة بالحركة.');
    }
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return httpError(res, 400, 'invalid_quantity', 'الكمية يجب أن تكون أكبر من صفر.');
    }

    const columns = await inventoryColumns();
    const batchCols = columns.batches;
    const moveCols = columns.movements;

    if (!moveCols.batch || !moveCols.type) {
      return httpError(res, 400, 'movement_schema_incomplete', 'جدول الحركات لا يحتوي أعمدة الربط المطلوبة.');
    }

    let readQuery = admin.from('inventory_batches').select('*').eq(batchCols.id, body.batchId).limit(1);
    readQuery = scopeToPharmacy(readQuery, columns, 'batches', req.auth.profile);
    const read = await readQuery;
    if (read.error) return httpError(res, 500, 'batch_read_failed', read.error.message);
    const batch = read.data?.[0];
    if (!batch) return httpError(res, 404, 'batch_not_found', 'الدفعة غير موجودة.');

    const current = Number(batch[batchCols.quantity] ?? 0) || 0;
    const next = current + movementDelta(type, quantity);
    if (next < 0) {
      return httpError(res, 409, 'insufficient_quantity', 'الكمية المتاحة لا تكفي لهذه الحركة.', {
        current,
        requested: quantity,
      });
    }

    if (batchCols.quantity) {
      const update = await admin
        .from('inventory_batches')
        .update({ [batchCols.quantity]: next })
        .eq(batchCols.id, body.batchId);
      if (update.error) return httpError(res, 500, 'batch_update_failed', update.error.message);
    }

    const desired = {
      [moveCols.batch]: body.batchId,
      [moveCols.type]: type,
    };
    if (moveCols.medicine && batchCols.medicine && batch[batchCols.medicine] != null) {
      desired[moveCols.medicine] = String(batch[batchCols.medicine]);
    }
    if (moveCols.quantity) desired[moveCols.quantity] = Math.trunc(quantity);
    if (moveCols.note && isNonEmptyString(body.note)) desired[moveCols.note] = String(body.note).trim();
    if (moveCols.user) desired[moveCols.user] = req.auth.user.id;
    if (moveCols.pharmacy && req.auth.publicProfile?.pharmacyId) {
      desired[moveCols.pharmacy] = req.auth.publicProfile.pharmacyId;
    }

    const payload = payloadFor(columns, 'stock_movements', desired);
    const { data, error } = await admin.from('stock_movements').insert(payload).select().limit(1);
    if (error) return httpError(res, 500, 'movement_insert_failed', error.message);

    return res.status(201).json({
      ok: true,
      movement: shapeMovement(data?.[0], moveCols),
      previousQuantity: current,
      newQuantity: next,
    });
  }),
);

export default router;
