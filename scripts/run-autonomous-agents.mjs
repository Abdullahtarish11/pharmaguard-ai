#!/usr/bin/env node
/**
 * PharmaGuard AI — تشغيل الوكلاء الثلاثة تلقائيًا على قاعدة البيانات (كل 6 ساعات).
 *
 * الاستخدام:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/run-autonomous-agents.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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
    // لا يوجد ملف .env — يعتمد على متغيرات البيئة في السحابة
  }
}

async function main() {
  await loadDotEnv();

  const { getAdmin } = await import('../server/supabase.js');
  const { inventoryColumns } = await import('../server/inventory.js');
  const { runAutonomousSweep } = await import('../server/agentSweep.js');

  const admin = getAdmin();
  if (!admin) {
    console.error('✖ مفاتيح Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) غير مضبوطة.');
    process.exit(1);
  }

  const columns = await inventoryColumns(true);
  if (!columns?.schemaOk) {
    console.error('✖ تعذّر قراءة مخطط قاعدة البيانات:', columns?.schema?.error ?? 'unknown');
    process.exit(1);
  }

  const trigger = process.env.GITHUB_ACTIONS === 'true' ? 'github_actions' : 'cron';
  const result = await runAutonomousSweep({ admin, columns, pharmacyId: null, trigger });

  console.log(`✔ اكتمل الفحص الشامل للوكلاء الثلاثة (${result.triggerLabel}) — ${result.ranAt}`);
  console.log(`• الصيدليات المفحوصة: ${result.pharmaciesScanned}`);
  for (const item of result.results) {
    const inv = item.audit.agents.inventory_agent;
    const saf = item.audit.agents.safety_agent;
    const ana = item.audit.agents.analytics_agent;
    console.log(
      `  - ${item.pharmacyName}: أدوية=${inv.medicinesScanned} | دفعات=${inv.batchesScanned} | تنبيهات=${inv.alertsDetected} (جديد=${inv.persistedNewAlerts}) | تداخلات=${saf.inventoryConflictsCount} | حركات=${ana.movementsScanned}`,
    );
  }
}

main().catch((error) => {
  console.error('✖ فشل تشغيل الوكلاء التلقائي:', error?.message ?? error);
  process.exit(1);
});
