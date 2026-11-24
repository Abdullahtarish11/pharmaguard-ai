import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('ar-EG', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function classificationBadgeClass(code) {
  if (code === 'documented_interaction') return 'badge badge-danger';
  if (code === 'source_conflict' || code === 'documented_warning') return 'badge badge-warn';
  if (code === 'source_access_failed') return 'badge badge-danger';
  return 'badge badge-muted';
}

export default function SafetyResearchPanel({ token, canRun = false }) {
  const [status, setStatus] = useState(null);
  const [drugA, setDrugA] = useState('Simvastatin');
  const [drugB, setDrugB] = useState('Clarithromycin');
  const [checkResult, setCheckResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadStatus = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api.safetyStatus(token);
      setStatus(data);
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function handlePairCheck(event) {
    event.preventDefault();
    if (!token || !canRun || !drugA.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.runSafetyCheck(token, {
        drugA: drugA.trim(),
        drugB: drugB.trim() || undefined,
      });
      setCheckResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleInventoryResearch() {
    if (!token || !canRun) return;
    setInventoryBusy(true);
    setError(null);
    try {
      const res = await api.runSafetyCheck(token, { fullScan: true });
      if (res?.safety) setStatus(res.safety);
      else await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setInventoryBusy(false);
    }
  }

  const worker = status?.worker;
  const telemetry = status?.telemetry;
  const pharmacy = status?.pharmacy;
  const pairFindings = pharmacy?.pairFindings ?? [];

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="section-title">وكيل سلامة الأدوية — البحث الطبي متعدد المصادر</h2>
          <p className="muted small" style={{ margin: 0 }}>
            تحقق مباشر ومجاني من RxNorm وopenFDA وDailyMed وPubMed (دون Gemini أو أي نموذج مدفوع، مع استبعاد DDInter حاليًا)
          </p>
        </div>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <span className={worker?.active ? 'badge' : 'badge badge-muted'}>
            {worker?.statusLabel ?? 'بانتظار التحميل'}
          </span>
          <button
            className="btn btn-soft btn-sm"
            type="button"
            onClick={handleInventoryResearch}
            disabled={!canRun || inventoryBusy}
          >
            {inventoryBusy ? 'جارٍ فحص المخزون…' : 'فحص مصادر أدوية المخزون الآن'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="grid grid-3" style={{ marginBottom: '1rem' }}>
        <div className="stat">
          <span>حالة الباحث الخلفي</span>
          <strong style={{ fontSize: '0.96rem' }}>
            {worker?.running ? 'يفحص المصادر الآن…' : worker?.active ? 'يعمل تلقائيًا على الخادم' : 'متوقف'}
          </strong>
          <span className="hint">آخر فحص: {formatDateTime(pharmacy?.lastCheckedAt || worker?.lastRunAt)}</span>
        </div>

        <div className="stat">
          <span>محرك البحث الشامل (OpenSERP / SearXNG)</span>
          <strong style={{ fontSize: '0.96rem' }}>
            {telemetry?.searchEngine?.configured
              ? telemetry.searchEngine.primary?.configured
                ? telemetry.searchEngine.primary.name
                : telemetry.searchEngine.fallback?.name
              : telemetry?.searchEngine?.statusLabel ?? 'غير مُعد'}
          </strong>
          <span className="hint">
            {telemetry?.searchEngine?.configured
              ? 'مفعّل لنتائج الويب والجهات الإقليمية'
              : 'غير مُعد — يعتمد الوكيل على المصادر الطبية الرسمية المدمجة فقط'}
          </span>
        </div>

        <div className="stat">
          <span>إحصاءات التحقق الخلفي</span>
          <strong style={{ fontSize: '0.96rem' }}>
            نجح {worker?.stats?.succeededChecks ?? 0} • تعذر {worker?.stats?.failedChecks ?? 0}
          </strong>
          <span className="hint">
            قيد الانتظار: {worker?.queuedJobs ?? 0} • إعادة محاولة: {worker?.retryQueueSize ?? 0}
          </span>
        </div>
      </div>

      {telemetry?.officialSources?.length > 0 && (
        <div className="pill-list" style={{ marginBottom: '1rem' }}>
          {telemetry.officialSources.map((src) => (
            <span
              key={src.id}
              className={src.status === 'degraded' ? 'badge badge-warn' : 'badge'}
              title={src.lastError || src.name}
            >
              {src.name}: {src.status === 'connected' ? 'متصل' : src.status === 'degraded' ? 'متعثر' : 'جاهز'}
            </span>
          ))}
          {(telemetry.excludedSources ?? []).map((ex) => (
            <span key={ex.id} className="badge badge-muted" title={ex.reason}>
              {ex.name}: مستبعد (غير تجاري/مدفوع)
            </span>
          ))}
        </div>
      )}

      <form className="grid grid-3" onSubmit={handlePairCheck} style={{ alignItems: 'end' }}>
        <div className="field">
          <label htmlFor="safety-drug-a">الدواء الأول (عربي أو إنجليزي)</label>
          <input
            id="safety-drug-a"
            className="input"
            value={drugA}
            onChange={(e) => setDrugA(e.target.value)}
            placeholder="مثال: Simvastatin أو سيمفاستاتين أو Zocor"
            disabled={!canRun || busy}
          />
        </div>
        <div className="field">
          <label htmlFor="safety-drug-b">الدواء الثاني (اختياري لفحص التداخل)</label>
          <input
            id="safety-drug-b"
            className="input"
            value={drugB}
            onChange={(e) => setDrugB(e.target.value)}
            placeholder="مثال: Clarithromycin أو كلاريثروميسين"
            disabled={!canRun || busy}
          />
        </div>
        <div className="field">
          <button className="btn btn-primary" type="submit" disabled={!canRun || busy || !drugA.trim()}>
            {busy ? 'جارٍ البحث في المصادر…' : 'تحقق من المصادر الرسمية'}
          </button>
        </div>
      </form>

      {checkResult?.result && (
        <div className="stat" style={{ marginTop: '1rem', gap: '0.6rem', background: '#ffffff' }}>
          <div className="card-head" style={{ marginBottom: 0 }}>
            <strong style={{ fontSize: '0.98rem' }}>
              {checkResult.mode === 'pair'
                ? `${checkResult.result.medicineA?.name} × ${checkResult.result.medicineB?.name}`
                : checkResult.result.medicine?.name}
            </strong>
            <span className={classificationBadgeClass(checkResult.result.classification?.code)}>
              {checkResult.result.classification?.label}
            </span>
          </div>

          {checkResult.mode === 'pair' ? (
            <>
              <p className="small" style={{ margin: 0 }}>{checkResult.result.arabicSummary}</p>
              <div className="muted small">
                المادة الفعالة 1: <strong>{checkResult.result.medicineA?.primaryIngredient ?? '—'}</strong>
                {' | '}المادة الفعالة 2: <strong>{checkResult.result.medicineB?.primaryIngredient ?? '—'}</strong>
                {checkResult.result.documentedSeverity && (
                  <>
                    {' | '}الشدة الموثقة: <strong>{checkResult.result.documentedSeverity}</strong>
                  </>
                )}
              </div>

              {checkResult.result.evidences?.length > 0 && (
                <div className="grid" style={{ gap: '0.5rem' }}>
                  {checkResult.result.evidences.map((ev, idx) => (
                    <div key={idx} className="live-feed-item">
                      <div className="live-feed-meta">
                        <span className="badge">{ev.sourceName}</span>
                        {ev.severity && <span className="badge badge-danger">{ev.severity}</span>}
                        {ev.publishedDate && <span className="muted small">تاريخ المصدر: {ev.publishedDate}</span>}
                        {ev.sourceUrl && (
                          <a
                            href={ev.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="small"
                            style={{ color: 'var(--accent-dark)', textDecoration: 'underline' }}
                          >
                            رابط المصدر الأصلي
                          </a>
                        )}
                      </div>
                      <p className="small" dir="auto" style={{ margin: '0.25rem 0 0' }}>
                        {ev.originalText}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {checkResult.result.clinicalWarnings?.length > 0 && (
                <details>
                  <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
                    تحذيرات الجرعة والعمر والحالة والحساسية الموثقة ({checkResult.result.clinicalWarnings.length})
                  </summary>
                  <div className="grid" style={{ gap: '0.45rem', marginTop: '0.5rem' }}>
                    {checkResult.result.clinicalWarnings.map((w, idx) => (
                      <div key={idx} className="live-feed-item">
                        <div className="live-feed-meta">
                          <span className="badge badge-warn">{w.medicine}</span>
                          <strong className="small">{w.categoryLabel}</strong>
                          <span className="muted small">{w.sourceName} ({w.publishedDate || '—'})</span>
                        </div>
                        <p className="small" dir="ltr" style={{ margin: '0.2rem 0 0' }}>{w.originalText}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          ) : (
            <div className="grid" style={{ gap: '0.45rem' }}>
              <div className="muted small">
                المادة الفعالة الموحدة (RxNorm): <strong>{checkResult.result.identity?.primaryIngredient ?? '—'}</strong>
                {checkResult.result.identity?.strength && ` | التركيز: ${checkResult.result.identity.strength}`}
                {checkResult.result.identity?.dosageForm && ` | الشكل: ${checkResult.result.identity.dosageForm}`}
              </div>
              {(checkResult.result.warnings ?? []).map((w, idx) => (
                <div key={idx} className="live-feed-item">
                  <div className="live-feed-meta">
                    <span className="badge badge-warn">{w.categoryLabel}</span>
                    {w.publishedDate && <span className="muted small">{w.publishedDate}</span>}
                    {w.sourceUrl && (
                      <a href={w.sourceUrl} target="_blank" rel="noreferrer" className="small" style={{ textDecoration: 'underline' }}>
                        النشرة الرسمية
                      </a>
                    )}
                  </div>
                  <p className="small" dir="ltr" style={{ margin: '0.2rem 0 0' }}>{w.originalText}</p>
                </div>
              ))}
            </div>
          )}

          <div className="alert alert-warn" style={{ marginBottom: 0 }}>
            {checkResult.result.disclaimer}
          </div>
        </div>
      )}

      {pairFindings.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h3 className="section-title" style={{ fontSize: '0.95rem' }}>
            نتائج الفحص التلقائي لمخزون الصيدلية عبر المصادر الرسمية ({pairFindings.length})
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الدواء الأول</th>
                  <th>الدواء الثاني</th>
                  <th>التصنيف الموثق</th>
                  <th>الشدة</th>
                  <th>المصادر والملخص</th>
                </tr>
              </thead>
              <tbody>
                {pairFindings.slice(0, 15).map((item) => (
                  <tr key={item.pairKey}>
                    <td>{item.medicineA?.name}</td>
                    <td>{item.medicineB?.name}</td>
                    <td>
                      <span className={classificationBadgeClass(item.classification?.code)}>
                        {item.classification?.label}
                      </span>
                    </td>
                    <td>{item.documentedSeverity || '—'}</td>
                    <td className="small">
                      {item.arabicSummary}
                      {item.evidences?.[0]?.sourceUrl && (
                        <>
                          {' '}
                          <a
                            href={item.evidences[0].sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: 'var(--accent-dark)', textDecoration: 'underline' }}
                          >
                            [المصدر]
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {worker?.hostingContinuityNote && (
        <p className="muted small" style={{ marginTop: '0.85rem', marginBottom: 0 }}>
          {worker.hostingContinuityNote}
        </p>
      )}
    </section>
  );
}
