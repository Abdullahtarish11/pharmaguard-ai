import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';
import LiveAgentsMonitor from '../components/LiveAgentsMonitor.jsx';
import SafetyResearchPanel from '../components/SafetyResearchPanel.jsx';

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
      'هل يوجد تداخل بين Simvastatin و Clarithromycin؟',
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
  const [selectedRun, setSelectedRun] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const canRun = me?.role === 'owner' || me?.role === 'pharmacist' || me?.role === 'inventory_manager';

  const loadRuns = useCallback(async () => {
    if (!token) return;
    try {
      const runsRes = await api.agentRuns(token);
      setRuns(runsRes);
    } catch (err) {
      setRuns({ error: err.message, runs: [] });
    }
  }, [token]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

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

  return (
    <div className="grid">
      <LiveAgentsMonitor
        token={token}
        canRun={canRun}
        showDetails
        onLiveSweep={loadRuns}
      />

      <SafetyResearchPanel token={token} canRun={canRun} />

      <section className="card">
        <div className="card-head">
          <h1 className="section-title">الوكلاء الذكيون الثلاثة</h1>
          <span className="badge">بيانات ومصادر فعلية</span>
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
          {result.externalSafetyResult?.researchTrace && (
            <details style={{ marginTop: '0.8rem' }}>
              <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
                خطوات التفكير والبحث التشغيلية لوكيل السلامة ({result.externalSafetyResult.researchTrace.roundsExecuted} جولة)
              </summary>
              <div className="grid" style={{ gap: '0.45rem', marginTop: '0.5rem' }}>
                {(result.externalSafetyResult.researchTrace.rounds ?? []).map((round) => (
                  <div key={round.round} className="live-feed-item">
                    <div className="live-feed-meta">
                      <span className="badge">الجولة {round.round}</span>
                      <strong className="small">{round.phase}</strong>
                    </div>
                    <p className="muted small" style={{ margin: '0.2rem 0' }}>{round.reason}</p>
                    {(round.steps ?? []).map((st, idx) => (
                      <div key={idx} className="small">
                        <strong>{st.tool}:</strong> {st.detail}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
          {Array.isArray(result.facts) && result.facts.length > 0 && (
            <>
              <h3 className="section-title" style={{ marginTop: '1rem', fontSize: '1rem' }}>
                الحقائق المستخدمة ({result.facts.length})
              </h3>
              <div className="table-wrap table-mobile-cards">
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
                        <td data-label="النوع">{FACT_TYPE_LABELS[fact.type] ?? fact.type}</td>
                        <td data-label="التفصيل" className="col-wrap" dir="auto">
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
          <div className="table-wrap table-mobile-cards">
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
                    <td data-label="السؤال" className="col-wrap" dir="auto">
                      {typeof run.input === 'string' ? run.input : run.input?.question ?? '—'}
                    </td>
                    <td data-label="الحالة">{run.status === 'completed' ? 'مكتمل' : run.status ?? '—'}</td>
                    <td data-label="التاريخ">{formatDate(run.createdAt)}</td>
                    <td data-label="الإجابة" className="td-actions">
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
