import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { env, configState, missingConfigKeys } from './env.js';
import { getAdmin, isPublicConfigured } from './supabase.js';
import { inventoryColumns } from './inventory.js';
import { registerAgentRuntime, startAutonomousAgentScheduler } from './agentSweep.js';
import { ROLE_LABELS, SELF_REGISTER_ROLES } from './roles.js';
import bootstrapRouter from './routes/bootstrap.js';
import authRouter from './routes/auth.js';
import staffRouter from './routes/staff.js';
import diagnosticsRouter from './routes/diagnostics.js';
import medicinesRouter from './routes/medicines.js';
import batchesRouter from './routes/batches.js';
import movementsRouter from './routes/movements.js';
import alertsRouter from './routes/alerts.js';
import reportsRouter from './routes/reports.js';
import agentRouter from './routes/agent.js';
import interactionsRouter from './routes/interactions.js';
import { httpError } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');
const sqlFile = path.resolve(here, '..', 'supabase', 'apply_all.sql');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
  next();
});

/** حالة عامة — بدون أي قيم سرية. */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'pharmaguard-ai',
    config: configState(),
    missing: missingConfigKeys(),
    time: new Date().toISOString(),
  });
});

/**
 * إعدادات الواجهة: عنوان المشروع + المفتاح العام (anon) فقط.
 * المفتاح العام مصمم ليكون ظاهرًا في المتصفح، والحماية الفعلية عبر RLS.
 * مفتاح service_role لا يُرسل هنا أبدًا.
 */
app.get('/api/config', (req, res) => {
  const state = configState();
  res.json({
    supabaseUrl: state.supabaseUrl || null,
    supabaseAnonKey: isPublicConfigured() ? env.anonKey : null,
    anonKeyPresent: state.anonKeyPresent,
    serviceRolePresent: state.serviceRolePresent,
    bootstrapTokenPresent: state.bootstrapTokenPresent,
    ready: state.ready,
    missing: missingConfigKeys(),
    roleLabels: ROLE_LABELS,
    selfRegisterRoles: [...SELF_REGISTER_ROLES],
  });
});

app.use('/api/bootstrap', bootstrapRouter);
app.use('/api/auth', authRouter);
app.use('/api/staff', staffRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/medicines', medicinesRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/movements', movementsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/interactions', interactionsRouter);

/** ملف سياسات RLS جاهز للنسخ إلى محرر SQL في Supabase (لا يحتوي أسرارًا). */
app.get('/api/setup/sql', async (req, res, next) => {
  try {
    const sql = await fs.readFile(sqlFile, 'utf8');
    res.type('text/plain; charset=utf-8').send(sql);
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => httpError(res, 404, 'not_found', 'المسار غير موجود.'));

app.use(
  express.static(distDir, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  try {
    const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch {
    res
      .status(503)
      .type('html')
      .send(
        '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><body style="font-family:system-ui;background:#07130f;color:#e6f4ef;padding:40px"><h1>الواجهة غير مبنية بعد</h1><p>شغّل <code>npm run build</code> ثم أعد تشغيل السيرفر.</p></body></html>',
      );
  }
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error('[pharmaguard] server error:', error);
  return httpError(res, status, error?.code ?? 'internal_error', error?.message ?? 'خطأ غير متوقع.');
});

app.listen(env.port, '0.0.0.0', () => {
  const state = configState();
  console.log(`[pharmaguard] listening on 0.0.0.0:${env.port}`);
  console.log(`[pharmaguard] supabase url: ${state.supabaseUrl || '(غير مضبوط)'}`);
  console.log(`[pharmaguard] anon key: ${state.anonKeyPresent ? 'set' : 'missing'}`);
  console.log(`[pharmaguard] service_role: ${state.serviceRolePresent ? 'set' : 'missing'}`);
  console.log(`[pharmaguard] bootstrap token: ${state.bootstrapTokenPresent ? 'set' : 'missing'}`);
  registerAgentRuntime({ getAdmin, inventoryColumns });
  if (process.env.DISABLE_AGENT_SCHEDULER !== '1') {
    const sched = startAutonomousAgentScheduler({
      getAdmin,
      inventoryColumns,
      watchIntervalSeconds: env.agentWatchIntervalSeconds,
      intervalHours: env.agentSweepIntervalHours,
    });
    if (sched.started) {
      console.log(`[pharmaguard] continuous autonomous agents active (every ${sched.watchIntervalSeconds}s + reactive hooks)`);
    }
  }
});
