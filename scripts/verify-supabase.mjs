#!/usr/bin/env node
/**
 * PharmaGuard AI — التحقق من الاتصال بمشروع Supabase القائم.
 *
 * التشغيل:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npm run verify:supabase
 *
 * لا يُنشئ أي جدول، ولا يُدخل أي بيانات دائمة:
 *   * القراءة: GET /rest/v1/<table>?select=*&limit=0 (بدون صفوف)
 *   * الكتابة: rpc('pg_selftest') تُدرج صفًا فارغًا ثم تتراجع عنه بالكامل
 *   * الصلاحيات: نفس الاستدعاءات بمفتاح anon للتأكد من أن RLS يمنعها
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const TABLES = [
  'profiles',
  'pharmacies',
  'medicines',
  'inventory_batches',
  'stock_movements',
  'inventory_alerts',
  'notifications',
  'device_tokens',
  'drug_interactions',
  'agent_runs',
  'reports',
];

async function loadDotEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const raw = await fs.readFile(path.resolve('.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (!process.env[key]) process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  } catch {
    // لا يوجد ملف .env — نعتمد على متغيرات البيئة
  }
}

const results = [];
function record(area, name, ok, detail) {
  results.push({ area, name, ok, detail });
}

async function rest(url, { method = 'GET', key, body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, ok: response.ok, data, headers: response.headers };
}

async function main() {
  await loadDotEnv();

  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  console.log('=== PharmaGuard AI — فحص مشروع Supabase ===\n');
  if (!url) {
    console.error('✖ SUPABASE_URL غير مضبوط.');
    process.exit(1);
  }
  console.log(`المشروع: ${url}`);
  console.log(`المفتاح العام: ${anon ? 'موجود' : 'مفقود'}`);
  console.log(`مفتاح الخدمة: ${service ? 'موجود' : 'مفقود (لن تُختبر الكتابة)'}\n`);

  const admin = service || anon;

  // 1) الاتصال + استكشاف المخطط
  const openapi = await rest(`${url}/rest/v1/`, { key: admin });
  const exposed = openapi.ok && openapi.data?.definitions
    ? Object.keys(openapi.data.definitions)
    : [];
  record(
    'connection',
    'PostgREST OpenAPI',
    openapi.ok,
    openapi.ok ? `${exposed.length} جدولًا مكشوفًا` : `HTTP ${openapi.status}`,
  );

  const missing = TABLES.filter((t) => !exposed.includes(t));
  record(
    'schema',
    'الجداول الـ11 موجودة',
    missing.length === 0,
    missing.length === 0 ? 'كل الجداول موجودة' : `مفقود: ${missing.join(', ')}`,
  );

  // 2) قراءة كل جدول بدون صفوف + العدد
  for (const table of TABLES) {
    if (!exposed.includes(table)) {
      record('read', table, false, 'الجدول غير مكشوف في PostgREST');
      continue;
    }
    const res = await rest(`${url}/rest/v1/${table}?select=*&limit=0`, {
      key: admin,
      headers: { Prefer: 'count=exact', Range: '0-0' },
    });
    const range = res.headers.get('content-range') || '';
    const total = range.includes('/') ? range.split('/')[1] : '?';
    record('read', table, res.ok, res.ok ? `HTTP ${res.status} — صفوف: ${total}` : `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
  }

  // 3) حالة RLS من الدالة المساعدة (بعد تشغيل apply_all.sql)
  const rls = await rest(`${url}/rest/v1/rpc/pg_rls_status`, { method: 'POST', key: admin, body: {} });
  if (rls.ok && Array.isArray(rls.data)) {
    const disabled = rls.data.filter((row) => !row.rls_enabled).map((row) => row.table_name);
    const noPolicy = rls.data.filter((row) => row.policy_count === 0).map((row) => row.table_name);
    record('rls', 'RLS مفعّل على كل الجداول', disabled.length === 0, disabled.length ? `بدون RLS: ${disabled.join(', ')}` : 'كل الجداول محمية');
    record('rls', 'سياسات موجودة', noPolicy.length === 0, noPolicy.length ? `بدون سياسات: ${noPolicy.join(', ')}` : 'كل الجداول لها سياسات');
  } else {
    record('rls', 'قراءة حالة RLS', false, `تعذّر استدعاء pg_rls_status (HTTP ${rls.status}) — شغّل supabase/apply_all.sql أولًا`);
  }

  // 4) اختبار كتابة غير دائم (إدراج ثم تراجع)
  if (service) {
    for (const table of ['medicines', 'inventory_batches', 'stock_movements', 'reports']) {
      const res = await rest(`${url}/rest/v1/rpc/pg_selftest`, {
        method: 'POST',
        key: service,
        body: { p_table: table },
      });
      if (!res.ok) {
        record('write', table, false, `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
        continue;
      }
      record('write', table, res.data?.ok === true, res.data?.note || res.data?.error || 'تم');
    }
  } else {
    record('write', 'اختبار الكتابة', false, 'مفتاح service_role غير مضبوط — لم يُختبر');
  }

  // 5) الصلاحيات: anon يجب ألا يستطيع تنفيذ pg_selftest أو قراءة الصفوف
  if (anon) {
    const anonSelftest = await rest(`${url}/rest/v1/rpc/pg_selftest`, {
      method: 'POST',
      key: anon,
      body: { p_table: 'reports' },
    });
    const blocked = !anonSelftest.ok || anonSelftest.data?.ok === false;
    record('permissions', 'anon لا يستطيع استدعاء pg_selftest', blocked, `HTTP ${anonSelftest.status}`);

    const anonRead = await rest(`${url}/rest/v1/profiles?select=*&limit=1`, { key: anon });
    const noRows = Array.isArray(anonRead.data) && anonRead.data.length === 0;
    record(
      'permissions',
      'anon لا يقرأ profiles',
      anonRead.ok ? noRows : true,
      anonRead.ok ? (noRows ? 'لا صفوف (RLS)' : '⚠ ظهرت صفوف بدون جلسة') : `HTTP ${anonRead.status} (مرفوض)`,
    );
  }

  // التقرير
  const groups = { connection: 'الاتصال', schema: 'المخطط', read: 'القراءة', rls: 'RLS', write: 'الكتابة', permissions: 'الصلاحيات' };
  for (const [key, label] of Object.entries(groups)) {
    const rows = results.filter((r) => r.area === key);
    if (!rows.length) continue;
    console.log(`\n--- ${label} ---`);
    for (const row of rows) {
      console.log(`${row.ok ? '✔' : '✖'} ${row.name}: ${row.detail}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nالنتيجة: ${results.length - failed.length}/${results.length} ناجح`);
  if (failed.length) {
    console.log('عناصر تحتاج مراجعة:');
    for (const row of failed) console.log(` - [${row.area}] ${row.name}: ${row.detail}`);
  }
  process.exit(failed.some((r) => r.area === 'connection') ? 1 : 0);
}

main().catch((error) => {
  console.error('فشل الفحص:', error.message);
  process.exit(1);
});
