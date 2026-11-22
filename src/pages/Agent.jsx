import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';

const AGENT_GROUPS = [
  {
    agent: 'وكيل إدارة المخزون',
    questions: [
      'ما الأصناف التي تحت حد إعادة الطلب؟',
      'ما ترتيب الصرف وفق FEFO؟',
      'أي دفعات تنتهي صلاحيتها قريبًا؟',
      'ما إجمالي الوحدات في المخزون؟',
    ],
  },
  {
    agent: 'وكيل سلامة الأدوية',
    questions: [
      'فحص تداخلات المخزون الحالية',
      'هل يوجد تداخل دوائي مسجل؟',
    ],
  },
  {
    agent: 'وكيل التحليل والتقارير',
    questions: [
      'لخّص حركات المخزون الأخيرة',
      'أعطني تقريرًا تحليليًا شاملًا للمخزون',
    ],
  },
];

const FACT_TYPE_LABELS = {
  interaction: 'تداخل دوائي',
  out_of_stock: 'نفاد مخزون',
  low_stock: 'نقص مخزون',
  expired_batch: 'دفعة منتهية',
  expiring_soon: 'قرب انتهاء',
  fefo_batch: 'ترتيب FEFO',
  fefo_next: 'الأولوية وفق FEFO',
  movement: 'حركة مخزون',
  batch: 'دفعة',
  medicine_total: 'إجمالي صنف',
  inventory_total: 'إجمالي المخزون',
  summary: 'ملخص تحليلي',
};

const FACT_KEY_LABELS = {
  drugA: 'الدواء أ',
  drugB: 'الدواء ب',
  severity: 'الشدة',
  medicine: 'الدواء',
  units: 'الوحدات',
  reorderLevel: 'حد إعادة الطلب',
  suggestedReorder: 'اقتراح إعادة الطلب',
  batchNumber: 'رقم الدفعة',
  expiryDate: 'تاريخ الانتهاء',
  order: 'الترتيب',
  quantity: 'الكمية',
  movementType: 'نوع الحركة',
  total: 'الإجمالي',
  sellable: 'الصالح للصرف',
  medicines: 'الأدوية',
  batches: 'الدفعات',
  totalUnits: 'إجمالي الوحدات',
  sellableUnits: 'الوحدات الصالحة',
  expiredUnits: 'الوحدات المنتهية',
  inbound: 'الوارد',
  outbound: 'الصادر',
  alerts: 'التنبيهات',
  highSeverityAlerts: 'تنبيهات حرجة',
};

export default function Agent() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [runs, setRuns] = useState(null);
  const [sweepData, setSweepData] = useState(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepError, setSweepError] = useState(null);
  const [showSweepReport, setShowSweepReport] = useState(false);
  const [selectedRun, setSelectedRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const canRun = me?.role === 'owner' || me?.role === 'pharmacist' || me?.role === 'inventory_manager';

  const loadRuns = useCallback(async () => {
    if (!token) return;
    try {
      const [runsRes, sweepRes] = await Promise.all([
        api.agentRuns(token),
        api.agentSweepLatest(token).catch(() => null),
      ]);
      setRuns(runsRes);
      if (sweepRes) setSweepData(sweepRes);
    } catch (err) {
      setRuns({ error: err.message, runs: [] });
    }
  }, [token]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  async function runComprehensiveSweep() {
    if (!token || !canRun) return;
    setSweepBusy(true);
    setSweepError(null);
    try {
      const res = await api.runAgentSweep(token);
      setSweepData({ scheduler: res.scheduler, latest: res.latest });
      setShowSweepReport(true);
      await loadRuns();
    } catch (err) {
      setSweepError(err.message);
    } finally {
      setSweepBusy(false);
    }
  }

  async function ask(text) {
    const value = (text ?? question).trim();
    if (!token || value.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.askAgent(token, value);
      setResult(response);
      setQuestion(value);
      await loadRuns();
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  const latestAudit = sweepData?.latest?.audit ?? null;
  const invAgent = latestAudit?.agents?.inventory_agent ?? null;
  const safetyAgent = latestAudit?.agents?.safety_agent ?? null;
  const analyticsAgent = latestAudit?.agents?.analytics_agent ?? null;
  const scheduler = sweepData?.scheduler ?? null;

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <h2 className="section-title">المراقبة والأتمتة التلقائية للوكلاء (كل {scheduler?.intervalHours ?? 6} ساعات)</h2>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <span className={scheduler?.active ? 'badge' : 'badge badge-muted'}>
              {scheduler?.active ? `مجدول كل ${scheduler.intervalHours} ساعات` : 'جاهز للفحص'}
            </span>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={runComprehensiveSweep}
              disabled={!canRun || sweepBusy}
            >
              {sweepBusy ? 'جارٍ الفحص الشامل…' : 'تشغيل فحص شامل الآن'}
            </button>
          </div>
        </div>

        {sweepError && <div className="alert alert-error">{sweepError}</div>}

        <div className="grid grid-3" style={{ marginTop: '0.75rem' }}>
          <div className="stat">
            <span>آخر فحص شامل</span>
            <strong style={{ fontSize: '1rem' }}>
              {scheduler?.lastRunAt ? formatDate(scheduler.lastRunAt) : 'لم يُنفَّذ بعد'}
            </strong>
            {latestAudit?.triggerLabel && <span className="hint">{latestAudit.triggerLabel}</span>}
          </div>
          <div className="stat">
            <span>الفحص المجدول القادم</span>
            <strong style={{ fontSize: '1rem' }}>
              {scheduler?.nextRunAt ? formatDate(scheduler.nextRunAt) : 'كل 6 ساعات'}
            </strong>
          </div>
          <div className="stat">
            <span>ملخص آخر تدقيق</span>
            <strong style={{ fontSize: '1rem' }}>
              {invAgent ? `${invAgent.alertsDetected} تنبيه / ${safetyAgent?.inventoryConflictsCount ?? 0} تداخل` : '—'}
            </strong>
            {invAgent && (
              <span className="hint">
                {`فُحص ${invAgent.medicinesScanned} دواءً و${invAgent.batchesScanned} دفعة`}
              </span>
            )}
          </div>
        </div>

        {latestAudit && (
          <div className="grid grid-3" style={{ marginTop: '0.9rem' }}>
            <div className="stat" style={{ gap: '0.35rem' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>1. وكيل إدارة المخزون وFEFO</span>
              <span className="small">أدوية: {invAgent?.medicinesScanned ?? 0} | دفعات: {invAgent?.batchesScanned ?? 0}</span>
              <span className="small">تنبيهات: {invAgent?.alertsDetected ?? 0} (جديد محفوظ: {invAgent?.persistedNewAlerts ?? 0})</span>
              <span className="hint">أصناف جاهزة بترتيب FEFO: {invAgent?.fefoReadyMedicines ?? 0}</span>
            </div>
            <div className="stat" style={{ gap: '0.35rem' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>2. وكيل سلامة الأدوية</span>
              <span className="small">قاعدة التداخلات: {safetyAgent?.interactionsCatalogRows ?? 0} سجلًا</span>
              <span className="small">تعارضات مكتشفة بالمخزون: {safetyAgent?.inventoryConflictsCount ?? 0}</span>
              <span className="hint">تعارضات حرجة/شديدة: {safetyAgent?.criticalConflictsCount ?? 0}</span>
            </div>
            <div className="stat" style={{ gap: '0.35rem' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>3. وكيل التحليل والتقارير</span>
              <span className="small">حركات مفحوصة: {analyticsAgent?.movementsScanned ?? 0}</span>
              <span className="small">قيمة البيع: {analyticsAgent?.sellingValue ?? 0}</span>
              <span className="hint">خسارة منتهي الصلاحية: {analyticsAgent?.expiredCostLoss ?? 0}</span>
            </div>
          </div>
        )}

        {safetyAgent?.conflicts?.length > 0 && (
          <div className="table-wrap" style={{ marginTop: '0.9rem' }}>
            <table>
              <thead>
                <tr>
                  <th>الدواء الأول بالمخزون</th>
                  <th>الدواء الثاني بالمخزون</th>
                  <th>الشدة</th>
                  <th>تفاصيل التداخل</th>
                </tr>
              </thead>
              <tbody>
                {safetyAgent.conflicts.slice(0, 8).map((c, idx) => (
                  <tr key={`${c.medicineA?.id}-${c.medicineB?.id}-${idx}`}>
                    <td>{c.medicineA?.name ?? '—'}</td>
                    <td>{c.medicineB?.name ?? '—'}</td>
                    <td>
                      <span className={c.severity === 'critical' || c.severity === 'high' ? 'badge badge-danger' : 'badge badge-warn'}>
                        {c.severity ?? '—'}
                      </span>
                    </td>
                    <td className="small">{c.description ?? `${c.drugA} + ${c.drugB}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {sweepData?.latest?.reportText && (
          <div style={{ marginTop: '0.85rem' }}>
            <button
              className="btn btn-soft btn-sm"
              type="button"
              onClick={() => setShowSweepReport((v) => !v)}
            >
              {showSweepReport ? 'إخفاء تقرير الفحص التفصيلي' : 'عرض تقرير الفحص التفصيلي'}
            </button>
            {showSweepReport && (
              <pre className="agent-answer" style={{ marginTop: '0.65rem' }}>
                {sweepData.latest.reportText}
              </pre>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h1 className="section-title">الوكلاء الذكيون الثلاثة</h1>
          <span className="badge">بيانات فعلية</span>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            ask();
          }}
        >
          <div className="field">
            <label htmlFor="agent-question">سؤالك</label>
            <input
              id="agent-question"
              className="input"
              value={question}
              maxLength={500}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="مثال: ما ترتيب الصرف وفق FEFO؟ أو هل يوجد تداخل بين دوائين؟"
              disabled={!canRun || busy}
            />
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canRun || busy || question.trim().length < 2}>
              {busy ? 'جارٍ التحليل…' : 'اسأل الوكيل'}
            </button>
          </div>
        </form>

        {!canRun && (
          <div className="alert alert-warn" style={{ marginTop: '0.9rem' }}>
            الوكيل متاح للمالك والصيدلي ومسؤول المخزون.
          </div>
        )}

        <div className="grid grid-3" style={{ marginTop: '1rem' }}>
          {AGENT_GROUPS.map((group) => (
            <div key={group.agent} className="stat" style={{ gap: '0.45rem' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{group.agent}</span>
              <div className="pill-list">
                {group.questions.map((suggestion) => (
                  <button
                    key={suggestion}
                    className="pill"
                    type="button"
                    style={{ cursor: canRun && !busy ? 'pointer' : 'not-allowed', color: 'var(--text)' }}
                    onClick={() => ask(suggestion)}
                    disabled={!canRun || busy}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {result && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">الإجابة</h2>
            <div className="btn-row" style={{ marginTop: 0 }}>
              {result.agent?.label && <span className="badge">{result.agent.label}</span>}
              <span className="badge badge-muted">{result.intent ?? 'general'}</span>
            </div>
          </div>
          <pre className="agent-answer">{result.answer}</pre>
          {Array.isArray(result.facts) && result.facts.length > 0 && (
            <>
              <h3 className="section-title" style={{ marginTop: '1rem', fontSize: '1rem' }}>
                الحقائق المستخدمة ({result.facts.length})
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>النوع</th>
                      <th>التفصيل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.facts.map((fact, index) => (
                      <tr key={`${fact.type}-${index}`}>
                        <td>{FACT_TYPE_LABELS[fact.type] ?? fact.type}</td>
                        <td dir="auto">
                          {Object.entries(fact)
                            .filter(([key]) => key !== 'type')
                            .map(([key, value]) => `${FACT_KEY_LABELS[key] ?? key}: ${value ?? '—'}`)
                            .join(' • ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {result.disclaimer && (
            <div className="alert alert-warn" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              {result.disclaimer}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">سجل المحادثات السابقة</h2>
          <span className="badge badge-muted">{runs?.runs?.length ?? 0}</span>
        </div>
        {runs?.error && <div className="alert alert-warn">{runs.error}</div>}
        {runs?.available === false && (
          <p className="muted small">جدول agent_runs غير متاح للتسجيل، لكن الإجابات تعمل بشكل طبيعي.</p>
        )}
        {runs?.runs?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>السؤال</th>
                  <th>الحالة</th>
                  <th>التاريخ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.runs.map((run) => (
                  <tr key={run.id}>
                    <td dir="auto">
                      {typeof run.input === 'string' ? run.input : run.input?.question ?? '—'}
                    </td>
                    <td>{run.status === 'completed' ? 'مكتمل' : run.status ?? '—'}</td>
                    <td>{formatDate(run.createdAt)}</td>
                    <td>
                      {run.answer ? (
                        <button
                          className="btn btn-soft btn-sm"
                          type="button"
                          onClick={() => setSelectedRun(run)}
                        >
                          عرض الإجابة
                        </button>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">لا توجد أسئلة مسجّلة بعد.</p>
        )}
      </section>

      {selectedRun && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تفاصيل المحادثة السابقة">
          <div className="modal-card">
            <h3 className="section-title">سؤال سابق</h3>
            <p className="small">
              {typeof selectedRun.input === 'string' ? selectedRun.input : selectedRun.input?.question ?? '—'}
            </p>
            <pre className="agent-answer">
              {typeof selectedRun.answer === 'string'
                ? selectedRun.answer
                : selectedRun.answer?.answer ?? JSON.stringify(selectedRun.answer, null, 2)}
            </pre>
            <div className="btn-row">
              <button className="btn btn-primary" type="button" onClick={() => setSelectedRun(null)}>
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
