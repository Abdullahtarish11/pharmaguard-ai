/**
 * فحص توافق التخزين في قاعدة بيانات Supabase الحالية (الشرط #7):
 * - يقرأ فقط أسماء الأعمدة وأنواعها وقيودها الظاهرة في OpenAPI لجداول:
 *   agent_runs و reports و inventory_alerts.
 * - لا يُنشئ أو يحذف أو يعدّل أي جدول أو عمود أو سياسة RLS.
 */

import { resolveEnumValue } from '../agentSweep.js';

export const SAFETY_STORAGE_TABLES = Object.freeze(['agent_runs', 'reports', 'inventory_alerts']);

export const PG_CONSTRAINTS_INSPECTION_SQL = `-- استعلام قراءة فقط (لا يعدّل أي جدول) لعرض جميع الأعمدة والأنواع وقيود CHECK على جداول الوكيل:
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('agent_runs', 'reports', 'inventory_alerts')
ORDER BY c.table_name, c.ordinal_position;

SELECT
  conrelid::regclass AS table_name,
  conname AS constraint_name,
  contype AS constraint_type,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.agent_runs'::regclass,
  'public.reports'::regclass,
  'public.inventory_alerts'::regclass
)
ORDER BY table_name, constraint_name;`;

function summarizeTableCompatibility(schema, tableName, resolvedCols = {}) {
  const table = schema?.tables?.[tableName] ?? null;
  if (!table) {
    return {
      table: tableName,
      exists: false,
      compatible: false,
      columns: [],
      resolvedMappings: resolvedCols,
      notes: [`الجدول ${tableName} غير ظاهر في مخطط PostgREST.`],
    };
  }

  const columns = (table.columns ?? []).map((col) => ({
    name: col.name,
    type: col.type,
    required: Boolean(col.required),
    enumValues: col.enumValues ?? null,
    primaryKey: Boolean(col.primaryKey),
    foreignKey: Boolean(col.foreignKey),
  }));

  const notes = [];
  const requiredMissing = columns
    .filter((c) => c.required && !c.primaryKey && c.name !== 'created_at' && c.name !== 'inserted_at')
    .filter((c) => !Object.values(resolvedCols).includes(c.name));

  if (requiredMissing.length > 0) {
    notes.push(
      `أعمدة إلزامية (NOT NULL) لم تُربط بعد تلقائيًا: ${requiredMissing.map((c) => c.name).join(', ')}`,
    );
  }

  if (tableName === 'inventory_alerts' && resolvedCols.type) {
    const typeCol = columns.find((c) => c.name === resolvedCols.type);
    if (typeCol?.enumValues?.length && !typeCol.enumValues.includes('drug_interaction')) {
      notes.push(
        `عمود ${resolvedCols.type} مقيّد بـ ENUM (${typeCol.enumValues.join(', ')}) ولا يشمل drug_interaction؛ سيُستخدم فقط ما تسمح به القيود أو تبقى تنبيهات التداخلات في سجل الوكيل الحي.`,
      );
    }
  }

  if (tableName === 'agent_runs' && resolvedCols.agentType) {
    const chosen = resolveEnumValue({ tables: schema.tables }, 'agent_runs', resolvedCols.agentType, [
      'safety_agent',
      'autonomous_sweep',
      'inventory_agent',
    ]);
    notes.push(`القيمة المختارة لعمود ${resolvedCols.agentType}: ${chosen}`);
  }

  notes.push(
    'تنبيه تقني: واجهة OpenAPI لا تكشف قيود CHECK النصية داخل PostgreSQL؛ يُنصح بمراجعة ناتج الاستعلام القرائي المرفق في محرر SQL قبل تفعيل SAFETY_PERSIST_VERIFIED=true.',
  );

  return {
    table: tableName,
    exists: true,
    compatible: requiredMissing.length === 0,
    columns,
    resolvedMappings: resolvedCols,
    notes,
  };
}

export function inspectSafetyStorageCompatibility(columnsSnapshot) {
  const schema = columnsSnapshot?.schema ?? null;
  if (!schema?.ok) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      reason: schema?.reason ?? 'schema_unavailable',
      error: schema?.error ?? 'مخطط قاعدة البيانات غير متاح للفحص بعد.',
      tables: [],
      sqlInspectionQuery: PG_CONSTRAINTS_INSPECTION_SQL,
    };
  }

  const tables = [
    summarizeTableCompatibility(schema, 'agent_runs', columnsSnapshot.agentRuns ?? {}),
    summarizeTableCompatibility(schema, 'reports', columnsSnapshot.reports ?? {}),
    summarizeTableCompatibility(schema, 'inventory_alerts', columnsSnapshot.alerts ?? {}),
  ];

  return {
    ok: tables.every((t) => t.exists),
    allCompatible: tables.every((t) => t.compatible),
    checkedAt: new Date().toISOString(),
    tables,
    sqlInspectionQuery: PG_CONSTRAINTS_INSPECTION_SQL,
  };
}
