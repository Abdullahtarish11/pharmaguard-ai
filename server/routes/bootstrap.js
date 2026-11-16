import express from 'express';
import crypto from 'node:crypto';
import { env, configState, missingConfigKeys } from '../env.js';
import { getAdmin, isAdminReady } from '../supabase.js';
import { getSchema, resolveColumn } from '../schema.js';
import { countOwners, profileColumns } from '../profiles.js';
import { ROLE } from '../roles.js';
import {
  asyncHandler,
  httpError,
  isValidEmail,
  isNonEmptyString,
  clientIp,
  createRateLimiter,
} from '../util.js';

const router = express.Router();
const allowAttempt = createRateLimiter({ windowMs: 10 * 60_000, max: 8 });

function tokenMatches(candidate) {
  if (!env.bootstrapToken || typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(env.bootstrapToken).digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** حالة التهيئة العامة — لا تكشف أي قيمة سرية. */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const state = configState();
    const payload = {
      config: state,
      missing: missingConfigKeys(),
      ownerExists: null,
      canBootstrap: false,
      reason: null,
      detail: null,
    };

    if (!isAdminReady()) {
      return res.json({ ...payload, reason: 'not_configured' });
    }

    const owners = await countOwners();
    if (!owners.ok) {
      return res.json({ ...payload, reason: owners.reason, detail: owners.error ?? null });
    }

    const ownerExists = owners.count > 0;
    return res.json({
      ...payload,
      ownerExists,
      canBootstrap: !ownerExists && state.bootstrapTokenPresent,
      reason: ownerExists
        ? 'owner_exists'
        : state.bootstrapTokenPresent
          ? null
          : 'bootstrap_token_missing',
    });
  }),
);

/**
 * إنشاء أول حساب مالك للصيدلية.
 * محمي برمز سري (OWNER_BOOTSTRAP_TOKEN) يعيش في السيرفر فقط،
 * ويعمل مرة واحدة فقط: بعد وجود مالك واحد يُغلق المسار نهائيًا.
 */
router.post(
  '/owner',
  asyncHandler(async (req, res) => {
    const ip = clientIp(req);
    if (!allowAttempt(ip)) {
      return httpError(res, 429, 'too_many_attempts', 'محاولات كثيرة. أعد المحاولة بعد بضع دقائق.');
    }

    if (!isAdminReady()) {
      return httpError(
        res,
        503,
        'supabase_not_configured',
        'أضف SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY في إعدادات البيئة أولًا.',
        { missing: missingConfigKeys() },
      );
    }
    if (!env.bootstrapToken) {
      return httpError(
        res,
        503,
        'bootstrap_disabled',
        'لم يُضبط OWNER_BOOTSTRAP_TOKEN، لذلك مسار إنشاء المالك معطّل.',
      );
    }

    const body = req.body ?? {};
    if (!tokenMatches(body.bootstrapToken)) {
      return httpError(res, 401, 'invalid_bootstrap_token', 'رمز التهيئة غير صحيح.');
    }
    if (!isValidEmail(body.email)) {
      return httpError(res, 400, 'invalid_email', 'البريد الإلكتروني غير صالح.');
    }
    if (!isNonEmptyString(body.password, 8)) {
      return httpError(res, 400, 'weak_password', 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.');
    }
    if (!isNonEmptyString(body.fullName, 2)) {
      return httpError(res, 400, 'invalid_full_name', 'الاسم الكامل مطلوب.');
    }
    if (!isNonEmptyString(body.pharmacyName, 2)) {
      return httpError(res, 400, 'invalid_pharmacy_name', 'اسم الصيدلية مطلوب.');
    }

    const admin = getAdmin();
    const owners = await countOwners();
    if (!owners.ok) {
      return httpError(res, 500, owners.reason, owners.error ?? 'تعذر التحقق من وجود مالك.');
    }
    if (owners.count > 0) {
      return httpError(res, 409, 'owner_already_exists', 'يوجد مالك للصيدلية بالفعل. هذا المسار مغلق.');
    }

    const schema = await getSchema();
    const columns = await profileColumns();
    const pharmacyNameColumn = resolveColumn(schema, 'pharmacies', [
      'name',
      'pharmacy_name',
      'title',
      'store_name',
    ]);
    const pharmacyIdColumn = resolveColumn(schema, 'pharmacies', ['id', 'pharmacy_id']) ?? 'id';

    let createdUserId = null;
    let createdPharmacyId = null;

    try {
      const created = await admin.auth.admin.createUser({
        email: String(body.email).trim().toLowerCase(),
        password: String(body.password),
        email_confirm: true,
        user_metadata: { full_name: String(body.fullName).trim(), role: ROLE.OWNER },
      });
      if (created.error || !created.data?.user) {
        return httpError(res, 400, 'auth_create_failed', created.error?.message ?? 'تعذر إنشاء حساب المالك.');
      }
      createdUserId = created.data.user.id;

      const pharmacyPayload = pharmacyNameColumn ? { [pharmacyNameColumn]: String(body.pharmacyName).trim() } : {};
      const pharmacyInsert = await admin
        .from('pharmacies')
        .insert(pharmacyPayload)
        .select()
        .limit(1);

      if (pharmacyInsert.error) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
        return httpError(
          res,
          500,
          'pharmacy_insert_failed',
          pharmacyInsert.error.message,
          { hint: 'أرسل هذه الرسالة لفهم أعمدة جدول pharmacies المطلوبة.' },
        );
      }
      createdPharmacyId = pharmacyInsert.data?.[0]?.[pharmacyIdColumn] ?? null;

      const profilePayload = {};
      profilePayload[columns.idColumn] = createdUserId;
      if (columns.roleColumn) profilePayload[columns.roleColumn] = ROLE.OWNER;
      if (columns.nameColumn) profilePayload[columns.nameColumn] = String(body.fullName).trim();
      if (columns.emailColumn) profilePayload[columns.emailColumn] = String(body.email).trim().toLowerCase();
      if (columns.pharmacyColumn && createdPharmacyId) {
        profilePayload[columns.pharmacyColumn] = createdPharmacyId;
      }

      const profileInsert = await admin.from('profiles').insert(profilePayload).select().limit(1);
      if (profileInsert.error) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
        if (createdPharmacyId) {
          await admin.from('pharmacies').delete().eq(pharmacyIdColumn, createdPharmacyId).then(
            () => {},
            () => {},
          );
        }
        return httpError(res, 500, 'profile_insert_failed', profileInsert.error.message, {
          hint: 'أرسل هذه الرسالة لفهم أعمدة جدول profiles المطلوبة.',
        });
      }

      return res.status(201).json({
        ok: true,
        owner: { id: createdUserId, email: String(body.email).trim().toLowerCase(), role: ROLE.OWNER },
        pharmacy: { id: createdPharmacyId, name: String(body.pharmacyName).trim() },
        next: 'سجّل الدخول بالبريد وكلمة المرور التي استخدمتها الآن.',
      });
    } catch (error) {
      if (createdUserId) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      }
      throw error;
    }
  }),
);

export default router;
