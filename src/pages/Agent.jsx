import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { formatDate } from '../labels.js';

const SUGGESTIONS = [
  'ما الأصناف التي تحت حد إعادة الطلب؟',
  'أي دفعات تنتهي صلاحيتها قريبًا؟',
  'ما إجمالي الوحدات في المخزون؟',
  'لخّص حركات المخزون الأخيرة',
];

export default function Agent() {
  const { session, me } = useApp();
  const token = session?.access_token;
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const canRun = me?.role === 'owner' || me?.role === 'pharmacist' || me?.role === 'inventory_manager';

  const loadRuns = useCallback(async () => {
    if (!token) return;
    try {
      setRuns(await api.agentRuns(token));
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
      <section className="card">
        <div className="card-head">
          <div>
            <h1 className="section-title">الوكيل الذكي</h1>
            <p className="muted small" style={{ margin: 0 }}>
              يجيب من بيانات مخزونك فقط. لا يخترع أسماء أدوية ولا جرعات ولا تداخلات غير موجودة في جدول
              drug_interactions.
            </p>
          </div>
          <span className="badge badge-muted">بيانات فعلية</span>
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
              placeholder="مثال: أي دفعات تنتهي هذا الشهر؟"
              disabled={!canRun || busy}
            />
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={!canRun || busy || question.trim().length < 2}>
              {busy ? 'جارٍ التحليل…' : 'اسأل'}
            </button>
          </div>
        </form>

        {!canRun && (
          <div className="alert alert-warn" style={{ marginTop: '0.9rem' }}>
            الوكيل متاح للمالك والصيدلي ومسؤول المخزون.
          </div>
        )}

        <div className="pill-list" style={{ marginTop: '0.9rem' }}>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className="pill"
              type="button"
              onClick={() => ask(suggestion)}
              disabled={!canRun || busy}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </section>

      {result && (
        <section className="card">
          <div className="card-head">
            <h2 className="section-title">الإجابة</h2>
            <span className="badge">{result.intent ?? 'general'}</span>
          </div>
          <pre className="code" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {result.answer}
          </pre>
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
                        <td>{fact.type}</td>
                        <td dir="auto">
                          {Object.entries(fact)
                            .filter(([key]) => key !== 'type')
                            .map(([key, value]) => `${key}: ${value ?? '—'}`)
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
          <h2 className="section-title">آخر الأسئلة</h2>
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
                </tr>
              </thead>
              <tbody>
                {runs.runs.map((run) => (
                  <tr key={run.id}>
                    <td dir="auto">
                      {typeof run.input === 'string' ? run.input : run.input?.question ?? '—'}
                    </td>
                    <td>{run.status ?? '—'}</td>
                    <td>{formatDate(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">لا توجد أسئلة مسجّلة بعد.</p>
        )}
      </section>
    </div>
  );
}
