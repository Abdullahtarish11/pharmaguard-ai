import { getAdmin } from './supabase.js';
import { findProfile, publicProfile } from './profiles.js';
import { readRoleFromProfile, normalizeRole } from './roles.js';
import { httpError } from './util.js';

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/** يتحقق من رمز الجلسة عبر Supabase ويحمّل ملف المستخدم ودوره. */
export async function requireUser(req, res, next) {
  try {
    const admin = getAdmin();
    if (!admin) {
      return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase إلى إعدادات البيئة بعد.');
    }
    const token = bearerToken(req);
    if (!token) {
      return httpError(res, 401, 'missing_token', 'مطلوب تسجيل الدخول.');
    }

    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) {
      return httpError(res, 401, 'invalid_token', 'الجلسة غير صالحة أو منتهية.');
    }

    const profileResult = await findProfile(data.user.id);
    if (!profileResult.ok && profileResult.reason === 'query_failed') {
      return httpError(res, 500, 'profile_query_failed', profileResult.error ?? 'تعذر قراءة الملف الشخصي.');
    }

    const profile = profileResult.profile ?? null;
    const role = profile ? readRoleFromProfile(profile) : null;

    req.auth = {
      token,
      user: { id: data.user.id, email: data.user.email ?? null },
      profile,
      role,
      publicProfile: publicProfile(profile),
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

/** يسمح فقط للأدوار المحددة. */
export function requireRole(...allowed) {
  const allowedRoles = allowed.map((role) => normalizeRole(role)).filter(Boolean);
  return (req, res, next) => {
    if (!req.auth?.user) return httpError(res, 401, 'unauthenticated', 'مطلوب تسجيل الدخول.');
    if (!req.auth.profile) {
      return httpError(res, 403, 'profile_missing', 'لا يوجد ملف شخصي مرتبط بهذا الحساب بعد.');
    }
    if (!req.auth.role || !allowedRoles.includes(req.auth.role)) {
      return httpError(res, 403, 'forbidden_role', 'صلاحياتك الحالية لا تسمح بهذا الإجراء.', {
        requiredRoles: allowedRoles,
        currentRole: req.auth.role,
      });
    }
    return next();
  };
}
