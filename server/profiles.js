import { getAdmin } from './supabase.js';
import { getSchema, resolveColumn } from './schema.js';
import { readRoleFromProfile, normalizeRole } from './roles.js';

export const PROFILE_ID_CANDIDATES = Object.freeze(['id', 'user_id', 'profile_id']);
export const PHARMACY_FK_CANDIDATES = Object.freeze([
  'pharmacy_id',
  'pharmacy',
  'store_id',
  'pharmacies_id',
]);

export async function profileColumns() {
  const schema = await getSchema();
  return {
    schema,
    idColumn: resolveColumn(schema, 'profiles', PROFILE_ID_CANDIDATES) ?? 'id',
    roleColumn: resolveColumn(schema, 'profiles', ['role', 'user_role', 'account_role', 'role_name']),
    nameColumn: resolveColumn(schema, 'profiles', ['full_name', 'name', 'display_name']),
    emailColumn: resolveColumn(schema, 'profiles', ['email']),
    pharmacyColumn: resolveColumn(schema, 'profiles', PHARMACY_FK_CANDIDATES),
    phoneColumn: resolveColumn(schema, 'profiles', ['phone', 'phone_number', 'mobile']),
  };
}

/** يجلب ملف المستخدم (أو null) مع الأخطاء الصريحة. */
export async function findProfile(userId) {
  const admin = getAdmin();
  if (!admin) return { ok: false, reason: 'not_configured', profile: null };
  const { idColumn } = await profileColumns();
  const { data, error } = await admin.from('profiles').select('*').eq(idColumn, userId).limit(1);
  if (error) {
    return { ok: false, reason: 'query_failed', error: error.message, code: error.code, profile: null };
  }
  return { ok: true, profile: data?.[0] ?? null };
}

export function pharmacyIdOf(profile) {
  if (!profile || typeof profile !== 'object') return null;
  for (const column of PHARMACY_FK_CANDIDATES) {
    if (profile[column] != null) return String(profile[column]);
  }
  return null;
}

export function publicProfile(profile) {
  if (!profile) return null;
  const role = readRoleFromProfile(profile);
  return {
    id: profile.id ?? profile.user_id ?? profile.profile_id ?? null,
    role,
    pharmacyId: pharmacyIdOf(profile),
    fullName: profile.full_name ?? profile.name ?? profile.display_name ?? null,
    email: profile.email ?? null,
    raw: profile,
  };
}

export async function countOwners() {
  const admin = getAdmin();
  if (!admin) return { ok: false, reason: 'not_configured', count: null };
  const { idColumn, roleColumn, schema } = await profileColumns();
  if (!roleColumn) {
    return {
      ok: false,
      reason: 'role_column_missing',
      count: null,
      schemaOk: Boolean(schema?.ok),
      error: 'لم يتم العثور على عمود الدور في جدول profiles',
    };
  }
  const { count, error } = await admin
    .from('profiles')
    .select(idColumn, { count: 'exact', head: true })
    .eq(roleColumn, normalizeRole('owner'));
  if (error) return { ok: false, reason: 'query_failed', count: null, error: error.message };
  return { ok: true, count: count ?? 0 };
}
