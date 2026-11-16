import express from 'express';
import { env, configState, missingConfigKeys } from '../env.js';
import { getAdmin, getAnonClient, getUserClient, isAdminReady } from '../supabase.js';
import { requireUser, requireRole } from '../auth.js';
import { TABLES, TABLE_LABELS, getSchema, clearSchemaCache } from '../schema.js';
import { ROLE } from '../roles.js';
import { asyncHandler, httpError, withTimeout } from '../util.js';

const router = express.Router();
const PROBE_TIMEOUT = 8_000;

async function safeCall(promise, label) {
  try {
    const result = await withTimeout(promise, PROBE_TIMEOUT, label);
    return { result, error: null };
  } catch (error) {
    return { result: null, error: error?.message ?? String(error) };
  }
}

/**
 * تشخيص شامل للربط بقاعدة البيانات: اتصال، قراءة، كتابة، RLS، وصلاحيات.
 * متاح لمالك الصيدلية فقط لأنه يكشف بنية المخطط.
 */
router.get(
  '/',
  requireUser,
  requireRole(ROLE.OWNER),
  asyncHandler(async (req, res) => {
    if (!isAdminReady()) {
      return httpError(res, 503, 'supabase_not_configured', 'لم تُضف مفاتيح Supabase بعد.', {
        missing: missingConfigKeys(),
        config: configState(),
      });
    }

    const admin = getAdmin();
    clearSchemaCache();
    const schema = await getSchema(true);

    const report = {
      checkedAt: new Date().toISOString(),
      project: { url: env.supabaseUrl },
      config: configState(),
      schema: {
        ok: Boolean(schema.ok),
        reason: schema.reason ?? null,
        error: schema.error ?? null,
        tableCount: Object.keys(schema.tables ?? {}).length,
        knownTables: schema.knownTables ?? [],
        missingTables: schema.missingTables ?? [],
        tables: schema.tables ?? {},
      },
      connection: {},
      tables: [],
      rls: {},
      write: {},
      permissions: {},
    };

    // 1) الاتصال والقراءة بمفتاح الخدمة
    const started = Date.now();
    const probe = await safeCall(
      admin.from('profiles').select('*', { count: 'exact', head: true }),
      'قراءة profiles',
    );
    report.connection = {
      ok: !probe.error && !probe.result?.error,
      latencyMs: Date.now() - started,
      error: probe.error ?? probe.result?.error?.message ?? null,
      errorCode: probe.result?.error?.code ?? null,
      usingServiceRole: Boolean(env.serviceRoleKey),
      usingAnonKey: Boolean(env.anonKey),
    };

    // 2) قراءة عدد الصفوف في كل جدول من الجداول الـ11
    for (const table of TABLES) {
      const entry = {
        name: table,
        label: TABLE_LABELS[table] ?? table,
        exists: schema.ok ? Boolean(schema.tables?.[table]) : null,
        columnCount: schema.tables?.[table]?.columns?.length ?? 0,
        rowCount: null,
        error: null,
      };
      const counted = await safeCall(
        admin.from(table).select('*', { count: 'exact', head: true }),
        `عدّ ${table}`,
      );
      if (counted.error) entry.error = counted.error;
      else if (counted.result?.error) entry.error = counted.result.error.message;
      else entry.rowCount = counted.result?.count ?? 0;
      report.tables.push(entry);
    }

    // 3) حالة RLS (تُقرأ من دالة pg_rls_status التي ينشئها ملف السياسات)
    const rlsStatus = await safeCall(admin.rpc('pg_rls_status'), 'pg_rls_status');
    if (rlsStatus.error) {
      report.rls = { installed: false, error: rlsStatus.error };
    } else if (rlsStatus.result?.error) {
      report.rls = { installed: false, error: rlsStatus.result.error.message };
    } else {
      report.rls = { installed: true, tables: rlsStatus.result?.data ?? [] };
    }

    // 4) اختبار كتابة حقيقي بدون أي بقايا (إدراج ثم تراجع داخل دالة)
    const writeTest = await safeCall(admin.rpc('pg_selftest', { p_table: 'reports' }), 'pg_selftest');
    if (writeTest.error) {
      report.write = { ok: false, method: 'pg_selftest', error: writeTest.error };
    } else if (writeTest.result?.error) {
      report.write = { ok: false, method: 'pg_selftest', error: writeTest.result.error.message };
    } else {
      report.write = { method: 'pg_selftest', ...(writeTest.result?.data ?? {}) };
    }

    // 5) الصلاحيات: ما يراه المالك نفسه عبر سياسات RLS، وما يُمنع على المجهول
    const userClient = getUserClient(req.auth.token);
    const userReads = {};
    for (const table of ['profiles', 'medicines', 'inventory_batches']) {
      if (!userClient) {
        userReads[table] = { skipped: 'no_anon_key' };
        continue;
      }
      const read = await safeCall(userClient.from(table).select('*').limit(1), `قراءة ${table} كهوية المستخدم`);
      if (read.error) userReads[table] = { error: read.error };
      else if (read.result?.error) {
        userReads[table] = { denied: true, message: read.result.error.message };
      } else {
        userReads[table] = { rowsVisible: read.result?.data?.length ?? 0 };
      }
    }

    const anon = getAnonClient();
    let anonDenied = null;
    let anonDetail = null;
    if (anon) {
      const anonCall = await safeCall(anon.rpc('pg_rls_status'), 'pg_rls_status كمجهول');
      anonDenied = Boolean(anonCall.error || anonCall.result?.error);
      anonDetail = anonCall.error ?? anonCall.result?.error?.message ?? 'نجح الاتصال — تحقق من صلاحيات الدالة';
    } else {
      anonDetail = 'no_anon_key';
    }

    report.permissions = {
      userScopedReads: userReads,
      anonymousBlockedFromDiagnostics: anonDenied,
      anonymousDetail: anonDetail,
    };

    return res.json(report);
  }),
);

export default router;
