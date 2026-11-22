import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;

async function waitForServer(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // الخادم لم يبدأ بعد
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      OWNER_BOOTSTRAP_TOKEN: '',
    },
    stdio: 'ignore',
  });
  const ready = await waitForServer(`${BASE}/api/health`);
  assert.equal(ready, true, 'السيرفر لم يبدأ');
});

after(() => {
  if (child) child.kill('SIGKILL');
});

test('الصحة تُبلّغ عن نقص الإعدادات بدون أي قيمة سرية', async () => {
  const response = await fetch(`${BASE}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'pharmaguard-ai');
  assert.deepEqual(body.missing.sort(), [
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_URL',
  ]);
});

test('/api/config لا يكشف مفتاح الخدمة أبدًا', async () => {
  const response = await fetch(`${BASE}/api/config`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.serviceRolePresent, false);
  assert.equal(body.supabaseAnonKey, null);
  assert.equal('serviceRoleKey' in body, false);
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in body, false);
  assert.equal(JSON.stringify(body).includes('service_role_key'), false);
  assert.deepEqual(body.selfRegisterRoles, ['pharmacist', 'inventory_manager']);
});

test('حالة التهيئة تُغلق المسار عندما لا تكون المفاتيح مضبوطة', async () => {
  const response = await fetch(`${BASE}/api/bootstrap/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ownerExists, null);
  assert.equal(body.canBootstrap, false);
  assert.equal(body.reason, 'not_configured');
});

test('إنشاء المالك مرفوض بدون إعدادات سيرفر', async () => {
  const response = await fetch(`${BASE}/api/bootstrap/owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bootstrapToken: 'x',
      fullName: 'مالك تجريبي',
      email: 'owner@example.com',
      password: 'password123',
      pharmacyName: 'صيدلية',
    }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'supabase_not_configured');
});

test('المسارات المحمية ترفض الطلبات بدون جلسة', async () => {
  for (const [method, route, payload] of [
    ['GET', '/api/auth/me'],
    ['GET', '/api/diagnostics'],
    ['GET', '/api/staff'],
    ['POST', '/api/auth/profile', { fullName: 'x', role: 'owner' }],
    ['PATCH', '/api/staff/u1', { linkToMyPharmacy: true }],
    ['GET', '/api/medicines'],
    ['POST', '/api/medicines', { name: 'test' }],
    ['POST', '/api/medicines/import', { medicines: [{ name: 'test' }] }],
    ['PATCH', '/api/medicines/m1', { name: 'test2' }],
    ['GET', '/api/interactions'],
    ['POST', '/api/interactions/import', { interactions: [{ drugA: 'a', drugB: 'b' }] }],
    ['GET', '/api/batches'],
    ['POST', '/api/batches', { medicineId: 'm1', quantity: 5 }],
    ['POST', '/api/batches/b1/movements', { type: 'dispense', quantity: 1 }],
    ['GET', '/api/movements'],
    ['POST', '/api/movements', { batchId: 'b1', type: 'dispense', quantity: 1 }],
    ['GET', '/api/alerts'],
    ['PATCH', '/api/alerts/a1/resolve'],
    ['POST', '/api/alerts/resolve-computed', { type: 'low_stock', message: 'test' }],
    ['GET', '/api/reports'],
    ['GET', '/api/reports/summary'],
    ['POST', '/api/reports'],
    ['POST', '/api/agent/ask', { question: 'ما حالة المخزون؟' }],
    ['GET', '/api/agent/runs'],
    ['GET', '/api/agent/stream'],
    ['GET', '/api/agent/sweep/latest'],
    ['POST', '/api/agent/sweep'],
  ]) {
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${route} يجب أن يرفض بدون جلسة`);
  }
});

test('مسار الأتمتة الخارجي /api/agent/cron يرفض التشغيل بدون مفتاح أتمتة', async () => {
  const response = await fetch(`${BASE}/api/agent/cron`, { method: 'POST' });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'cron_secret_not_configured');
});

test('ملف سياسات RLS متاح ولا يُنشئ جداول ويطابق صلاحيات الصيدلي', async () => {
  const response = await fetch(`${BASE}/api/setup/sql`);
  assert.equal(response.status, 200);
  const sql = await response.text();
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /from pg_policies/i);
  assert.match(sql, /drop policy if exists %I on public\.%I/i);
  assert.match(sql, /create policy/i);
  assert.match(sql, /\('medicines',\s*'\{owner,pharmacist,inventory_manager\}'/);
  assert.match(sql, /\('inventory_batches',\s*'\{owner,pharmacist,inventory_manager\}'/);
  assert.match(sql, /\('stock_movements',\s*'\{owner,pharmacist,inventory_manager\}'.*false,\s*false\)/);
  assert.match(sql, /\('inventory_alerts',\s*'\{owner,pharmacist,inventory_manager\}'/);
  assert.match(sql, /pg_guard_bypass/i);
  assert.equal(/create\s+table/i.test(sql), false, 'ملف السياسات يجب ألا يُنشئ جداول');
  assert.equal(/drop\s+table/i.test(sql), false, 'ملف السياسات يجب ألا يحذف جداول');
  assert.equal(/insert\s+into\s+public\.(medicines|inventory_batches)/i.test(sql), false);
});

test('المسار غير الموجود يعيد 404 بصيغة JSON', async () => {
  const response = await fetch(`${BASE}/api/unknown-route`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'not_found');
});
