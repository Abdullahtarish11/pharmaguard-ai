import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError } from '../util.js';
import {
  inventoryColumns,
  shapeMedicine,
  shapeBatch,
  computeAlerts,
  scopeToPharmacy,
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

  const medicines = medResult.error ? [] : (medResult.data ?? []).map((row) => shapeMedicine(row, medCols));
  const batches = batchResult.error ? [] : (batchResult.data ?? []).map((row) => shapeBatch(row, batchCols));

  return {
    medicines,
    batches,
    errors: {
      medicines: medResult.error?.message ?? null,
      batches: batchResult.error?.message ?? null,
    },
  };
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
    const { medicines, batches, errors } = await loadInventory(admin, columns, req.auth.profile);

    const alerts = computeAlerts({ medicines, batches });
    const counts = { high: 0, medium: 0, low: 0 };
    for (const alert of alerts) counts[alert.severity] = (counts[alert.severity] ?? 0) + 1;

    const byType = {};
    for (const alert of alerts) byType[alert.type] = (byType[alert.type] ?? 0) + 1;

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
        stored = (result.data ?? []).map((row) => ({
          id: row[alertCols.id] ?? null,
          type: alertCols.type ? row[alertCols.type] ?? null : null,
          severity: alertCols.severity ? row[alertCols.severity] ?? null : null,
          message: alertCols.message ? row[alertCols.message] ?? null : null,
          resolved: alertCols.resolved ? Boolean(row[alertCols.resolved]) : null,
          createdAt: alertCols.createdAt ? row[alertCols.createdAt] ?? null : null,
        }));
      }
    }

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

/** حل تنبيه محفوظ في الجدول (لا يحذفه — يعلّمه كمحلول). */
router.patch(
  '/:id/resolve',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const alertCols = columns.alerts;
    if (!alertCols.id || !alertCols.resolved) {
      return httpError(res, 400, 'alerts_not_writable', 'جدول التنبيهات لا يحتوي عمود الحالة المطلوب لحل التنبيه.');
    }

    const { data, error } = await admin
      .from('inventory_alerts')
      .update({ [alertCols.resolved]: true })
      .eq(alertCols.id, req.params.id)
      .select()
      .limit(1);
    if (error) return httpError(res, 500, 'alert_resolve_failed', error.message);
    if (!data?.length) return httpError(res, 404, 'alert_not_found', 'التنبيه غير موجود.');

    return res.json({ ok: true, id: req.params.id, resolved: true });
  }),
);

export default router;
