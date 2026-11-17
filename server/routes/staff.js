import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { profileColumns, pharmacyIdOf, publicProfile } from '../profiles.js';
import { ROLE, assertSelfRegisterRole, roleLabel } from '../roles.js';
import { asyncHandler, httpError } from '../util.js';

const router = express.Router();

/** قائمة الموظفين — لمالك الصيدلية فقط. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await profileColumns();
    let query = admin.from('profiles').select('*').limit(200);
    const pharmacyId = pharmacyIdOf(req.auth.profile);
    if (columns.pharmacyColumn && pharmacyId) {
      query = query.eq(columns.pharmacyColumn, pharmacyId);
    }
    const { data, error } = await query;
    if (error) return httpError(res, 500, 'profiles_query_failed', error.message);

    return res.json({
      staff: (data ?? []).map((row) => {
        const shaped = publicProfile(row);
        return {
          id: shaped.id,
          fullName: shaped.fullName,
          email: shaped.email,
          role: shaped.role,
          roleLabel: shaped.role ? roleLabel(shaped.role) : 'غير محدد',
          pharmacyId: shaped.pharmacyId,
        };
      }),
    });
  }),
);

/** تحديث موظف (الدور أو ربطه بالصيدلية) — لا يمكن ترقية أحد إلى owner. */
router.patch(
  '/:id',
  requireUser,
  requireRole(ROLE.OWNER),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await profileColumns();
    const payload = {};

    if (req.body?.role !== undefined) {
      let role;
      try {
        role = assertSelfRegisterRole(req.body.role);
      } catch (error) {
        return httpError(res, 400, 'role_not_allowed', 'لا يمكن تعيين دور المالك من هنا.', {
          allowedRoles: ['pharmacist', 'inventory_manager'],
        });
      }
      if (!columns.roleColumn) {
        return httpError(res, 400, 'role_column_missing', 'لا يوجد عمود دور في جدول profiles.');
      }
      payload[columns.roleColumn] = role;
    }

    if (req.body?.linkToMyPharmacy === true) {
      if (!columns.pharmacyColumn) {
        return httpError(res, 400, 'pharmacy_column_missing', 'لا يوجد عمود صيدلية في جدول profiles.');
      }
      payload[columns.pharmacyColumn] = pharmacyIdOf(req.auth.profile);
    }

    if (Object.keys(payload).length === 0) {
      return httpError(res, 400, 'empty_update', 'لا توجد حقول للتحديث.');
    }

    const { data, error } = await admin
      .from('profiles')
      .update(payload)
      .eq(columns.idColumn, req.params.id)
      .select()
      .limit(1);
    if (error) return httpError(res, 500, 'profile_update_failed', error.message);

    return res.json({ ok: true, profile: publicProfile(data?.[0]) });
  }),
);

export default router;
