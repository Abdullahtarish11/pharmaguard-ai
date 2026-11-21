import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError } from '../util.js';
import {
  inventoryColumns,
  shapeMedicine,
  shapeBatch,
  shapeMovement,
  buildInventorySummary,
  computeAlerts,
  payloadFor,
  scopeToPharmacy,
  requirePharmacy,
  MOVEMENT_TYPE_LABELS,
} from '../inventory.js';

const router = express.Router();

async function loadData(admin, columns, profile) {
  const reads = {};

  let medQuery = admin.from('medicines').select('*').limit(2000);
  medQuery = scopeToPharmacy(medQuery, columns, 'medicines', profile);
  reads.medicines = await medQuery;

  let batchQuery = admin.from('inventory_batches').select('*').limit(4000);
  batchQuery = scopeToPharmacy(batchQuery, columns, 'batches', profile);
  reads.batches = await batchQuery;

  let moveQuery = admin.from('stock_movements').select('*').limit(4000);
  moveQuery = scopeToPharmacy(moveQuery, columns, 'movements', profile);
  if (columns.movements.createdAt) moveQuery = moveQuery.order(columns.movements.createdAt, { ascending: false });
  reads.movements = await moveQuery;

  const now = new Date();
  return {
    medicines: reads.medicines.error ? [] : (reads.medicines.data ?? []).map((row) => shapeMedicine(row, columns.medicines)),
    batches: reads.batches.error ? [] : (reads.batches.data ?? []).map((row) => shapeBatch(row, columns.batches, now)),
    movements: reads.movements.error ? [] : (reads.movements.data ?? []).map((row) => shapeMovement(row, columns.movements)),
    errors: {
      medicines: reads.medicines.error?.message ?? null,
      batches: reads.batches.error?.message ?? null,
      movements: reads.movements.error?.message ?? null,
    },
  };
}

/** ملخّص تشغيلي حقيقي: كميات، قيمة، نواقص، وقرب انتهاء. */
router.get(
  '/summary',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'medicines', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const data = await loadData(admin, columns, req.auth.profile);
    const summary = buildInventorySummary(data);
    const alerts = computeAlerts(data);

    return res.json({
      summary,
      typeLabels: MOVEMENT_TYPE_LABELS,
      alertCounts: {
        total: alerts.length,
        high: alerts.filter((alert) => alert.severity === 'high').length,
        medium: alerts.filter((alert) => alert.severity === 'medium').length,
      },
      dataErrors: data.errors,
      generatedFrom: 'قاعدة البيانات الفعلية (بدون بيانات تجريبية)',
    });
  }),
);

/** حفظ لقطة تقرير في جدول reports — لا يعدّل أي بيانات مخزون. */
router.post(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'reports', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const reportCols = columns.reports;
    if (!reportCols.id) {
      return httpError(res, 400, 'reports_unavailable', 'جدول reports غير متاح للحفظ.');
    }

    const data = await loadData(admin, columns, req.auth.profile);
    const summary = buildInventorySummary(data);
    const alerts = computeAlerts(data);

    const title = `لقطة مخزون ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const desired = {};
    if (reportCols.type) desired[reportCols.type] = 'inventory_snapshot';
    if (reportCols.title) desired[reportCols.title] = title;
    if (reportCols.payload) {
      desired[reportCols.payload] = {
        summary,
        alerts: alerts.slice(0, 50),
        counts: summary.counts,
      };
    }
    if (reportCols.user) desired[reportCols.user] = req.auth.user.id;
    if (reportCols.pharmacy && scope.pharmacyId) {
      desired[reportCols.pharmacy] = scope.pharmacyId;
    }

    const payload = payloadFor(columns, 'reports', desired);
    const { data: inserted, error } = await admin.from('reports').insert(payload).select().limit(1);
    if (error) return httpError(res, 500, 'report_insert_failed', error.message);

    return res.status(201).json({ ok: true, id: inserted?.[0]?.[reportCols.id] ?? null, title, summary });
  }),
);

/** قائمة التقارير المحفوظة. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await inventoryColumns();
    const scope = requirePharmacy(columns, 'reports', req.auth.profile);
    if (!scope.ok) return httpError(res, scope.status, scope.code, scope.message);

    const reportCols = columns.reports;
    if (!reportCols.id) {
      return res.json({ reports: [], available: false });
    }

    let query = admin.from('reports').select('*').limit(100);
    query = scopeToPharmacy(query, columns, 'reports', req.auth.profile);
    if (reportCols.createdAt) query = query.order(reportCols.createdAt, { ascending: false });

    const { data, error } = await query;
    if (error) return httpError(res, 500, 'reports_query_failed', error.message);

    return res.json({
      available: true,
      reports: (data ?? []).map((row) => ({
        id: row[reportCols.id] ?? null,
        type: reportCols.type ? row[reportCols.type] ?? null : null,
        title: reportCols.title ? row[reportCols.title] ?? null : null,
        createdAt: reportCols.createdAt ? row[reportCols.createdAt] ?? null : null,
        payload: reportCols.payload ? row[reportCols.payload] ?? null : null,
      })),
    });
  }),
);

export default router;
