import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE,
  SELF_REGISTER_ROLES,
  assertSelfRegisterRole,
  normalizeRole,
  readRoleFromProfile,
  canManageStaff,
  canWriteInventory,
  canReadClinical,
  canRunAgent,
} from '../server/roles.js';

test('دور المالك لا يمكن اختياره أو إرساله من التسجيل الذاتي', () => {
  assert.throws(() => assertSelfRegisterRole('owner'), /غير مسموح/);
  assert.throws(() => assertSelfRegisterRole('pharmacy_owner'), /غير مسموح/);
  assert.throws(() => assertSelfRegisterRole('admin'), /غير مسموح/);
  assert.throws(() => assertSelfRegisterRole(undefined), /غير مسموح/);
  assert.equal(SELF_REGISTER_ROLES.includes(ROLE.OWNER), false);
});

test('الأدوار المسموحة للتسجيل تُقبل وتُوحَّد', () => {
  assert.equal(assertSelfRegisterRole('pharmacist'), ROLE.PHARMACIST);
  assert.equal(assertSelfRegisterRole('inventory_manager'), ROLE.INVENTORY);
  assert.equal(assertSelfRegisterRole('inventory'), ROLE.INVENTORY);
  assert.equal(assertSelfRegisterRole('stock_manager'), ROLE.INVENTORY);
});

test('قراءة الدور من أي عمود محتمل في profiles', () => {
  assert.equal(readRoleFromProfile({ role: 'owner' }), ROLE.OWNER);
  assert.equal(readRoleFromProfile({ user_role: 'pharmacist' }), ROLE.PHARMACIST);
  assert.equal(readRoleFromProfile({ account_role: 'inventory' }), ROLE.INVENTORY);
  assert.equal(readRoleFromProfile({ role_name: 'PHARMACIST' }), ROLE.PHARMACIST);
  assert.equal(readRoleFromProfile({}), null);
  assert.equal(readRoleFromProfile(null), null);
});

test('صلاحيات الأدوار مطابقة لتفويض الصيدلي وعزل إدارة الموظفين', () => {
  assert.equal(canManageStaff('owner'), true);
  assert.equal(canManageStaff('pharmacist'), false);
  assert.equal(canManageStaff('inventory_manager'), false);

  assert.equal(canWriteInventory('owner'), true);
  assert.equal(canWriteInventory('pharmacist'), true);
  assert.equal(canWriteInventory('inventory_manager'), true);

  assert.equal(canReadClinical('owner'), true);
  assert.equal(canReadClinical('pharmacist'), true);
  assert.equal(canReadClinical('inventory_manager'), false);

  assert.equal(canRunAgent('owner'), true);
  assert.equal(canRunAgent('pharmacist'), true);
  assert.equal(canRunAgent('inventory_manager'), true);
});

test('الأدوار غير المعروفة تُرفض ولا تُخمَّن', () => {
  assert.equal(normalizeRole('superadmin'), null);
  assert.equal(normalizeRole(''), null);
  assert.equal(normalizeRole(42), null);
});
