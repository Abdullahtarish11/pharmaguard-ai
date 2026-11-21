import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';
import {
  inventoryColumns,
  shapeMedicine,
  shapeBatch,
  computeAlerts,
  scopeToPharmacy,
  requirePharmacy,
  payloadFor,
} from '../inventory.js';

const router = express.Router();

async function loadInventory(admin, columns, profile) {
  const medCols = columns.medicines;
  const batchCols = columns.batches;

  let medQuery = admin.from('medicines').select('*').limit(1000);
  medQuery = scopeToPharmacy(medQuery, columns, 'medicines', profile);
  const medResult = await medQuery;

  let batchQuery = admin.from('inventory_batches').select('*').limit(2000);
  batchQuery = scopeToPharmacy(batchQuery, columns, 'batches', profile);
  const batchResult = await batchQuery;

  const now = new Date();
  const medicines = medResult.error ? [] : (medResult.data ?? []).map((row) => shapeMedicine(row, medCols));
  const batches = batchResult.error ? [] : (batchResult.data ?? []).map((row) => shapeBatch(row, batchCols, now));

  return {
    medicines,
    batches,
    errors: {
      medicines: medResult.error?.message ?? null,
      batches: batchResult.error?.message ?? null,
    },
  };
}

function shapeStoredAlert(row, alertCols) {
  return {
    id: row[alertCols.id] ?? null,
    medicineId: alertCols.medicine && row[alertCols.medicine] != null ? String(row[alertCols.medicine]) : null,
    batchId: alertCols.batch && row[alertCols.batch] != null ? String(row[alertCols.batch]) : null,
    type: alertCols.type ? row[alertCols.type] ?? null : null,
    severity: alertCols.severity ? row[alertCols.severity] ?? null : null,
    message: alertCols.message ? row[alertCols.message] ?? null : null,
    resolved: alertCols.resolved ? Boolean(row[alertCols.resolved]) : false,
    createdAt: alertCols.createdAt ? row[alertCols.createdAt] ?? null : null,
  };
}

function matchStoredAlert(alert, storedItems) {
  return (
    storedItems.find((item) => {
      if (alert.batchId && item.batchId && String(item.batchId) === String(alert.batchId)) {
        if (!item.type || !alert.type || item.type === alert.type) return true;
      }
      if (!alert.batchId && alert.medicineId && item.medicineId && String(item.medicineId) === String(alert.medicineId)) {
        if (!item.type || !alert.type || item.type === alert.type) return true;
      }
      if (alert.message && item.message && item.message === alert.message) return true;
      return false;
    }) ?? null
  );
}

/** التنبيهات محسوبة من البيانات الفعلية: نفاد، انخفاض، انتهاء صلاحية، قرب انتهاء. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const medScope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!medScope.ok) return httpError(res, medScope.status, medScope.code, medScope.message);

    const { medicines, batches, errors } = await loadInventory(admin, columns, req.auth.profile);

    // تنبيهات محفوظة سابقًا في الجدول (إن وُجدت) — تُعرض مع حالة الحل
    let stored = [];
    let storedError = null;
    if (columns.alerts && columns.alerts.id) {
      const alertCols = columns.alerts;
      let query = admin.from('inventory_alerts').select('*').limit(200);
      query = scopeToPharmacy(query, columns, 'alerts', req.auth.profile);
      if (alertCols.createdAt) query = query.order(alertCols.createdAt, { ascending: false });
      const result = await query;
      if (result.error) storedError = result.error.message;
      else {
        stored = (result.data ?? []).map((row) => shapeStoredAlert(row, alertCols));
      }
    }

    const alerts = computeAlerts({ medicines, batches }).map((alert) => {
      const matched = matchStoredAlert(alert, stored);
      return {
        ...alert,
        storedId: matched?.id ?? null,
        resolved: Boolean(matched?.resolved),
      };
    });

    const counts = { high: 0, medium: 0, low: 0 };
    for (const alert of alerts) counts[alert.severity] = (counts[alert.severity] ?? 0) + 1;

    const byType = {};
    for (const alert of alerts) byType[alert.type] = (byType[alert.type] ?? 0) + 1;

    return res.json({
      alerts,
      counts,
      byType,
      total: alerts.length,
      stored: { available: Boolean(columns.alerts?.id), items: stored, error: storedError },
      dataErrors: errors,
      note:
        alerts.length === 0
          ? 'لا توجد تنبيهات حاليًا. التنبيهات تُحسب من كميات الدفعات وتواريخ صلاحيتها الفعلية فقط.'
          : null,
    });
  }),
);

/** تعليم تنبيه محسوب كمقروء/محلول عبر تحديث السجل المطابق أو حفظ حالة الإغلاق في inventory_alerts. */
router.post(
  '/resolve-computed',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'alerts', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const alertCols = columns.alerts;
    if (!alertCols.id || !alertCols.resolved) {
      return httpError(res, 400, 'alerts_not_writable', 'جدول التنبيهات لا يحتوي أعمدة الحفظ المطلوبة.');
    }

    const body = req.body ?? {};
    if (!isNonEmptyString(body.message, 2) && !isNonEmptyString(body.type, 2)) {
      return httpError(res, 400, 'invalid_alert', 'بيانات التنبيه غير مكتملة.');
    }

    let existingQuery = admin.from('inventory_alerts').select('*').limit(200);
    existingQuery = scopeToPharmacy(existingQuery, columns, 'alerts', req.auth.profile);
    const existingRes = await existingQuery;
    if (existingRes.error) return httpError(res, 500, 'alerts_query_failed', existingRes.error.message);

    const storedItems = (existingRes.data ?? []).map((row) => shapeStoredAlert(row, alertCols));
    const matched = matchStoredAlert(
      {
        batchId: body.batchId ?? null,
        medicineId: body.medicineId ?? null,
        type: body.type ?? null,
        message: body.message ?? null,
      },
      storedItems,
    );

    if (matched?.id) {
      let upd = admin
        .from('inventory_alerts')
        .update({ [alertCols.resolved]: true })
        .eq(alertCols.id, matched.id);
      upd = scopeToPharmacy(upd, columns, 'alerts', req.auth.profile);
      const { data, error } = await upd.select().limit(1);
      if (error) return httpError(res, 500, 'alert_resolve_failed', error.message);
      return res.json({ ok: true, id: data?.[0]?.[alertCols.id] ?? matched.id, resolved: true });
    }

    const desired = {
      [alertCols.resolved]: true,
    };
    if (alertCols.medicine && body.medicineId) desired[alertCols.medicine] = String(body.medicineId);
    if (alertCols.batch && body.batchId) desired[alertCols.batch] = String(body.batchId);
    if (alertCols.type && body.type) desired[alertCols.type] = String(body.type);
    if (alertCols.severity && body.severity) desired[alertCols.severity] = String(body.severity);
    if (alertCols.message && body.message) desired[alertCols.message] = String(body.message);
    if (alertCols.pharmacy && scope.pharmacyId) desired[alertCols.pharmacy] = scope.pharmacyId;

    const payload = payloadFor(columns, 'inventory_alerts', desired);
    const { data, error } = await admin.from('inventory_alerts').insert(payload).select().limit(1);
    if (error) return httpError(res, 500, 'alert_resolve_failed', error.message);

    return res.status(201).json({
      ok: true,
      id: data?.[0]?.[alertCols.id] ?? null,
      resolved: true,
    });
  }),
);

/** حل تنبيه محفوظ في الجدول (لا يحذفه — يعلّمه كمحلول ضمن صيدلية المستخدم فقط). */
router.patch(
  '/:id/resolve',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'alerts', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const alertCols = columns.alerts;
    if (!alertCols.id || !alertCols.resolved) {
      return httpError(res, 400, 'alerts_not_writable', 'جدول التنبيهات لا يحتوي عمود الحالة المطلوب لحل التنبيه.');
    }

    let query = admin
      .from('inventory_alerts')
      .update({ [alertCols.resolved]: true })
      .eq(alertCols.id, req.params.id);
    query = scopeToPharmacy(query, columns, 'alerts', req.auth.profile);
    const { data, error } = await query.select().limit(1);
    if (error) return httpError(res, 500, 'alert_resolve_failed', error.message);
    if (!data?.length) return httpError(res, 404, 'alert_not_found', 'التنبيه غير موجود.');

    return res.json({ ok: true, id: req.params.id, resolved: true });
  }),
);

export default router;
