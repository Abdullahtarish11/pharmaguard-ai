/**
 * الأدوار المعتمدة في PharmaGuard AI.
 * مالك الصيدلية (owner) لا يمكن أبدًا اختياره من قبل المستخدم عند التسجيل،
 * بل يُنشأ فقط عبر مسار التهيئة المحمي على السيرفر.
 */
export const ROLE = Object.freeze({
  OWNER: 'owner',
  PHARMACIST: 'pharmacist',
  INVENTORY: 'inventory_manager',
});

export const ALL_ROLES = Object.freeze([ROLE.OWNER, ROLE.PHARMACIST, ROLE.INVENTORY]);

/** الأدوار المسموح للمستخدم باختيارها بنفسه عند التسجيل. */
export const SELF_REGISTER_ROLES = Object.freeze([ROLE.PHARMACIST, ROLE.INVENTORY]);

export const ROLE_LABELS = Object.freeze({
  owner: 'مالك الصيدلية',
  pharmacist: 'صيدلي',
  inventory_manager: 'مسؤول المخزون',
});

/** أسماء أعمدة الدور المحتملة في جدول profiles (الجداول موجودة مسبقًا). */
export const ROLE_COLUMN_CANDIDATES = Object.freeze(['role', 'user_role', 'account_role', 'role_name']);

export function isRole(value) {
  return ALL_ROLES.includes(value);
}

export function isSelfRegisterRole(value) {
  return SELF_REGISTER_ROLES.includes(value);
}

export function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const aliases = {
    owner: ROLE.OWNER,
    'pharmacy_owner': ROLE.OWNER,
    'pharmacy-owner': ROLE.OWNER,
    pharmacist: ROLE.PHARMACIST,
    'صيدلي': ROLE.PHARMACIST,
    inventory: ROLE.INVENTORY,
    'inventory_manager': ROLE.INVENTORY,
    'inventory-manager': ROLE.INVENTORY,
    'stock_manager': ROLE.INVENTORY,
    'مسؤول المخزون': ROLE.INVENTORY,
  };
  return aliases[v] ?? (isRole(v) ? v : null);
}

export function roleLabel(value) {
  const role = normalizeRole(value);
  return role ? ROLE_LABELS[role] : 'غير محدد';
}

export function canManageStaff(role) {
  return normalizeRole(role) === ROLE.OWNER;
}

export function canWriteInventory(role) {
  const r = normalizeRole(role);
  return r === ROLE.OWNER || r === ROLE.PHARMACIST || r === ROLE.INVENTORY;
}

export function canReadClinical(role) {
  const r = normalizeRole(role);
  return r === ROLE.OWNER || r === ROLE.PHARMACIST;
}

export function canRunAgent(role) {
  const r = normalizeRole(role);
  return r === ROLE.OWNER || r === ROLE.PHARMACIST || r === ROLE.INVENTORY;
}

/**
 * يستخرج الدور من صف profiles مهما كان اسم عمود الدور في قاعدة البيانات.
 */
export function readRoleFromProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  for (const column of ROLE_COLUMN_CANDIDATES) {
    if (profile[column] != null) {
      const role = normalizeRole(profile[column]);
      if (role) return role;
    }
  }
  return null;
}

/** يحوّل الدور إلى قيمة صالحة للتخزين، أو يرفضه. */
export function assertSelfRegisterRole(value) {
  const role = normalizeRole(value);
  if (!role || !isSelfRegisterRole(role)) {
    const error = new Error('الدور المطلوب غير مسموح عند التسجيل الذاتي.');
    error.status = 400;
    error.code = 'role_not_allowed';
    throw error;
  }
  return role;
}
