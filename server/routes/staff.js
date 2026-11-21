import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { profileColumns, pharmacyIdOf, publicProfile } from '../profiles.js';
import { ROLE, assertSelfRegisterRole, roleLabel } from '../roles.js';
import { asyncHandler, httpError } from '../util.js';

const router = express.Router();

/** قائمة موظفي الصيدلية بالإضافة إلى الحسابات غير المرتبطة بصيدلية بعد — لمالك الصيدلية فقط. */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    const columns = await profileColumns();
    const pharmacyId = pharmacyIdOf(req.auth.profile);
    if (columns.pharmacyColumn && !pharmacyId) {
      return httpError(res, 403, 'pharmacy_not_linked', 'حساب المالك غير مرتبط بصيدلية.');
    }

    let query = admin.from('profiles').select('*').limit(200);
    if (columns.pharmacyColumn && pharmacyId) {
      query = query.or(`${columns.pharmacyColumn}.eq.${pharmacyId},${columns.pharmacyColumn}.is.null`);
    }
    const { data, error } = await query;
    if (error) return httpError(res, 500, 'profiles_query_failed', error.message);

    const staff = (data ?? [])
      .map((row) => publicProfile(row))
      .filter((shaped) => {
        if (!shaped) return false;
        // لا تُعرض حسابات ملاك آخرين بلا صيدلية إن وُجدت
        if (!shaped.pharmacyId && shaped.role === ROLE.OWNER) return false;
        return true;
      })
      .map((shaped) => ({
        id: shaped.id,
        fullName: shaped.fullName,
        email: shaped.email,
        role: shaped.role,
        roleLabel: shaped.role ? roleLabel(shaped.role) : 'غير محدد',
        pharmacyId: shaped.pharmacyId,
        linked: Boolean(pharmacyId && shaped.pharmacyId === pharmacyId),
        isSelf: String(shaped.id) === String(req.auth.user.id),
      }));

    return res.json({ staff, ownerPharmacyId: pharmacyId });
  }),
);

/** تحديث موظف (الدور أو ربطه/فكه عن صيدلية المالك) — مع عزل تام بين الصيدليات ومنع تعديل المالك. */
router.patch(
  '/:id',
  requireUser,
  requireRole(ROLE.OWNER),
  asyncHandler(async (req, res) => {
    const admin = getAdmin();
    if (!admin) return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');

    if (String(req.params.id) === String(req.auth.user.id)) {
      return httpError(res, 400, 'cannot_modify_self', 'لا يمكنك تعديل دورك أو ربطك من هنا.');
    }

    const columns = await profileColumns();
    const ownerPharmacyId = pharmacyIdOf(req.auth.profile);
    if (columns.pharmacyColumn && !ownerPharmacyId) {
      return httpError(res, 403, 'pharmacy_not_linked', 'حساب المالك غير مرتبط بصيدلية.');
    }

    const existing = await admin
      .from('profiles')
      .select('*')
      .eq(columns.idColumn, req.params.id)
      .limit(1);
    if (existing.error) return httpError(res, 500, 'profile_read_failed', existing.error.message);
    const targetRow = existing.data?.[0];
    if (!targetRow) return httpError(res, 404, 'profile_not_found', 'المستخدم غير موجود.');

    const target = publicProfile(targetRow);
    if (target.role === ROLE.OWNER) {
      return httpError(res, 403, 'cannot_modify_owner', 'لا يمكن تعديل حساب مالك آخر.');
    }
    if (columns.pharmacyColumn && target.pharmacyId && target.pharmacyId !== ownerPharmacyId) {
      return httpError(res, 403, 'forbidden_pharmacy', 'لا يمكنك تعديل موظف يتبع صيدلية أخرى.');
    }

    const payload = {};

    if (req.body?.role !== undefined) {
      let role;
      try {
        role = assertSelfRegisterRole(req.body.role);
      } catch {
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
      payload[columns.pharmacyColumn] = ownerPharmacyId;
    } else if (req.body?.unlinkFromPharmacy === true) {
      if (!columns.pharmacyColumn) {
        return httpError(res, 400, 'pharmacy_column_missing', 'لا يوجد عمود صيدلية في جدول profiles.');
      }
      payload[columns.pharmacyColumn] = null;
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

    const updated = publicProfile(data?.[0]);
    return res.json({
      ok: true,
      profile: {
        ...updated,
        roleLabel: updated?.role ? roleLabel(updated.role) : 'غير محدد',
        linked: Boolean(ownerPharmacyId && updated?.pharmacyId === ownerPharmacyId),
      },
    });
  }),
);

export default router;
