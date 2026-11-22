import { env } from './env.js';
import { isAdminReady } from './supabase.js';

/** الجداول الـ11 الموجودة مسبقًا في المشروع — لا تُنشأ ولا تُعاد تسميتها. */
export const TABLES = Object.freeze([
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
]);

export const TABLE_LABELS = Object.freeze({
  profiles: 'الملفات الشخصية',
  pharmacies: 'الصيدليات',
  medicines: 'الأدوية',
  inventory_batches: 'دفعات المخزون',
  stock_movements: 'حركات المخزون',
  inventory_alerts: 'تنبيهات المخزون',
  notifications: 'الإشعارات',
  device_tokens: 'أجهزة الإشعارات',
  drug_interactions: 'التفاعلات الدوائية',
  agent_runs: 'تشغيلات الوكيل',
  reports: 'التقارير',
});

const CACHE_TTL_MS = 60_000;
let cache = { at: 0, value: null };

/**
 * يقرأ وصف المخطط (أعمدة كل جدول) من وصف OpenAPI الذي يقدمه PostgREST.
 * لا نكتب أي شيء في قاعدة البيانات، ولا نفترض أسماء الأعمدة.
 */
export async function getSchema(force = false) {
  if (!isAdminReady()) {
    return { ok: false, reason: 'not_configured', error: 'مفتاح service_role غير متوفر', tables: {} };
  }
  if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/`, {
      headers: {
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
        Accept: 'application/openapi+json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        reason: 'openapi_failed',
        error: `HTTP ${res.status}: ${body.slice(0, 300)}`,
        tables: {},
      };
    }

    const spec = await res.json();
    const definitions = spec.definitions ?? spec.components?.schemas ?? {};
    const tables = {};

    for (const [name, definition] of Object.entries(definitions)) {
      const properties = definition?.properties ?? {};
      const required = Array.isArray(definition?.required) ? definition.required : [];
      const columns = Object.entries(properties).map(([columnName, meta]) => {
        const description = typeof meta?.description === 'string' ? meta.description : '';
        return {
          name: columnName,
          type: meta?.format || meta?.type || 'unknown',
          enumValues: Array.isArray(meta?.enum) ? meta.enum : null,
          required: required.includes(columnName),
          primaryKey: /primary key/i.test(description),
          foreignKey: /foreign key/i.test(description),
        };
      });
      tables[name] = {
        columns,
        columnNames: columns.map((column) => column.name),
      };
    }

    const value = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      tables,
      knownTables: TABLES.filter((table) => Boolean(tables[table])),
      missingTables: TABLES.filter((table) => !tables[table]),
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (error) {
    return {
      ok: false,
      reason: 'request_failed',
      error: error?.name === 'TimeoutError' ? 'انتهت مهلة الاتصال بـ Supabase' : String(error?.message ?? error),
      tables: {},
    };
  }
}

export function clearSchemaCache() {
  cache = { at: 0, value: null };
}

export function columnsOf(schema, table) {
  return schema?.tables?.[table]?.columns ?? [];
}

export function tableExists(schema, table) {
  if (!schema?.ok) return null;
  return Boolean(schema.tables?.[table]);
}

/**
 * يختار اسم العمود الفعلي من بين أسماء محتملة.
 * إذا كان المخطط معروفًا ولم يوجد أي مرشح ⇒ null (لا نخمّن).
 */
export function resolveColumn(schema, table, candidates) {
  if (!schema?.ok) return candidates[0] ?? null;
  const names = schema.tables?.[table]?.columnNames ?? [];
  const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
  const normalizedMap = new Map();
  for (const name of names) {
    const key = normalize(name);
    if (!normalizedMap.has(key)) normalizedMap.set(key, name);
  }
  for (const candidate of candidates) {
    if (names.includes(candidate)) return candidate;
    const matched = normalizedMap.get(normalize(candidate));
    if (matched) return matched;
  }
  return null;
}

/** يبني كائن إدراج/تحديث مقيّدًا بالأعمدة الموجودة فعليًا. */
export function pickPayload(schema, table, desired) {
  if (!schema?.ok) return { ...desired };
  const names = new Set(schema.tables?.[table]?.columnNames ?? []);
  const payload = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (names.has(key)) payload[key] = value;
  }
  return payload;
}
