import express from 'express';
import { getAdmin } from '../supabase.js';
import { requireUser } from '../auth.js';
import { profileColumns, publicProfile, findProfile } from '../profiles.js';
import { assertSelfRegisterRole, roleLabel } from '../roles.js';
import { asyncHandler, httpError, isNonEmptyString } from '../util.js';

const router = express.Router();

/**
 * إكمال الملف الشخصي بعد إنشاء حساب Auth.
 * الدور يُقبل فقط من قائمة الأدوار المسموح بها للتسجيل الذاتي،
 * وأي محاولة لاختيار owner تُرفض على السيرفر قبل الوصول لقاعدة البيانات.
 */
router.post(
  '/profile',
  requireUser,
  asyncHandler(async (req, res) => {
    if (req.auth.profile) {
      return httpError(res, 409, 'profile_exists', 'لديك ملف شخصي بالفعل.');
    }

    let role;
    try {
      role = assertSelfRegisterRole(req.body?.role);
    } catch (error) {
      return httpError(res, 400, error.code ?? 'role_not_allowed', error.message, {
        allowedRoles: ['pharmacist', 'inventory_manager'],
      });
    }

    if (!isNonEmptyString(req.body?.fullName, 2)) {
      return httpError(res, 400, 'invalid_full_name', 'الاسم الكامل مطلوب.');
    }

    const admin = getAdmin();
    if (!admin) {
      return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.');
    }

    const columns = await profileColumns();
    const payload = {};
    payload[columns.idColumn] = req.auth.user.id;
    if (columns.roleColumn) payload[columns.roleColumn] = role;
    if (columns.nameColumn) payload[columns.nameColumn] = String(req.body.fullName).trim();
    if (columns.emailColumn) payload[columns.emailColumn] = req.auth.user.email;

    const inserted = await admin.from('profiles').insert(payload).select().limit(1);
    if (inserted.error) {
      return httpError(res, 500, 'profile_insert_failed', inserted.error.message);
    }

    return res.status(201).json({
      ok: true,
      profile: publicProfile(inserted.data?.[0]),
      role,
      roleLabel: roleLabel(role),
      note: 'بانتظار أن يربطك مالك الصيدلية بصيدليته.',
    });
  }),
);

/** حالة الحساب الحالي. */
router.get(
  '/me',
  requireUser,
  asyncHandler(async (req, res) => {
    const fresh = req.auth.profile ? { ok: true, profile: req.auth.profile } : await findProfile(req.auth.user.id);
    const profile = fresh.profile ?? null;
    const shaped = publicProfile(profile);
    return res.json({
      user: req.auth.user,
      hasProfile: Boolean(profile),
      profile: shaped,
      role: shaped?.role ?? null,
      roleLabel: shaped?.role ? roleLabel(shaped.role) : null,
      pharmacyId: shaped?.pharmacyId ?? null,
    });
  }),
);

export default router;
