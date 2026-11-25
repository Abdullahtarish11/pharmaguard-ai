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

function safeExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function classificationBadgeClass(code) {
  if (code === 'documented_interaction') return 'badge badge-danger';
  if (code === 'source_conflict' || code === 'documented_warning') return 'badge badge-warn';
  if (code === 'source_access_failed') return 'badge badge-danger';
  return 'badge badge-muted';
}

function stepBadgeClass(status) {
  if (status === 'matched' || status === 'executed') return 'badge';
  if (status === 'error') return 'badge badge-danger';
  if (status === 'partial') return 'badge badge-warn';
  return 'badge badge-muted';
}

function stepStatusLabel(status) {
  if (status === 'matched') return 'طابق';
  if (status === 'executed') return 'نُفّذ';
  if (status === 'partial') return 'جزئي';
  if (status === 'error') return 'تعذر';
  if (status === 'miss' || status === 'no_new_data') return 'بلا نتيجة';
  return status || '—';
}

function ResearchTraceBlock({ trace }) {
  if (!trace) return null;
  const plan = trace.plan;
  const rounds = trace.rounds ?? [];

  return (
    <details open style={{ marginTop: '0.35rem' }}>
      <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
        مسار الاستقصاء والتفكير التشغيلي للوكيل ({trace.roundsExecuted ?? rounds.length} جولة • {trace.totalDurationMs ?? 0} مللي ثانية
        {trace.reSearchTriggered ? ' • أُعيد البحث تلقائيًا' : ''})
      </summary>

      <div className="grid" style={{ gap: '0.5rem', marginTop: '0.55rem' }}>
        {plan && (
          <div className="live-feed-item">
            <div className="live-feed-meta">
              <span className="badge">خطة البحث</span>
              <span className="badge badge-muted">{plan.languageProfile?.label ?? '—'}</span>
              <span className="badge badge-muted">الحد الأقصى: {plan.maxRounds} جولات</span>
              <span className="badge badge-muted">الويب المفتوح: {plan.webSearchStatusLabel ?? 'غير مُعد'}</span>
            </div>
            <p className="small" style={{ margin: '0.25rem 0 0' }}>{plan.goal}</p>
            {Array.isArray(plan.plannedTools) && plan.plannedTools.length > 0 && (
              <div className="muted small" style={{ marginTop: '0.25rem' }}>
                الأدوات المختارة: {plan.plannedTools.map((t) => t.name).join(' ← ')}
              </div>
            )}
          </div>
        )}

        {trace.reSearchTriggered && Array.isArray(trace.reSearchReasons) && trace.reSearchReasons.length > 0 && (
          <div className="alert alert-warn" style={{ margin: 0, padding: '0.5rem 0.75rem' }}>
            <strong>سبب إعادة البحث:</strong> {trace.reSearchReasons.join(' • ')}
          </div>
        )}

        {rounds.map((r) => (
          <div key={r.round} className="live-feed-item">
            <div className="live-feed-meta">
              <span className="badge">الجولة {r.round}</span>
              <strong className="small">{r.phase}</strong>
              <span className="muted small">{r.durationMs ?? 0} مللي ثانية</span>
            </div>
            {r.reason && <p className="muted small" style={{ margin: '0.2rem 0' }}>{r.reason}</p>}
            <div className="grid" style={{ gap: '0.3rem', marginTop: '0.3rem' }}>
              {(r.steps ?? []).map((step, sIdx) => (
                <div key={sIdx} className="small" style={{ display: 'flex', gap: '0.45rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span className={stepBadgeClass(step.status)}>{stepStatusLabel(step.status)}</span>
                  <strong>{step.tool}:</strong>
                  <span>{step.detail}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function EvidenceItemCard({ ev }) {
  const safeUrl = safeExternalUrl(ev.sourceUrl);
  return (
    <div className="live-feed-item">
      <div className="live-feed-meta">
        <span className="badge">{ev.sourceName}</span>
        {ev.severity && <span className="badge badge-danger">{ev.severity}</span>}
        {ev.direction === 'negated' && <span className="badge badge-muted">ينفي التداخل</span>}
        {ev.publishedDate && <span className="muted small">تاريخ المصدر: {ev.publishedDate}</span>}
        {ev.issuer && <span className="muted small">{ev.issuer}</span>}
        {safeUrl && (
          <a
            href={safeUrl}
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
  );
}

export default function SafetyResearchPanel({ token, canRun = false }) {
  const [status, setStatus] = useState(null);
  const [drugA, setDrugA] = useState('Simvastatin');
  const [drugB, setDrugB] = useState('Clarithromycin');
  const [checkResult, setCheckResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadStatus = useCallback(async ({ probe = false } = {}) => {
    if (!token) return;
    try {
      const data = await api.safetyStatus(token, { probe });
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

  async function handleProbeSearchEngines() {
    if (!token) return;
    setProbeBusy(true);
    setError(null);
    try {
      await loadStatus({ probe: true });
    } finally {
      setProbeBusy(false);
    }
  }

  const worker = status?.worker;
  const telemetry = status?.telemetry;
  const pharmacy = status?.pharmacy;
  const pairFindings = pharmacy?.pairFindings ?? [];

  const result = checkResult?.result;
  const evidenceGroups = result?.evidenceGroups;
  const officialList = evidenceGroups
    ? [...(evidenceGroups.official ?? []), ...(evidenceGroups.local ?? [])]
    : (result?.evidences ?? []).filter((e) => e.sourceName !== 'PubMed');
  const literatureList = evidenceGroups
    ? (evidenceGroups.literature ?? [])
    : (result?.evidences ?? []).filter((e) => e.sourceName === 'PubMed');
  const webList = evidenceGroups?.webSearch ?? result?.webSearchResults ?? [];

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="section-title">وكيل سلامة الأدوية — البحث والاستقصاء المستقل</h2>
          <p className="muted small" style={{ margin: 0 }}>
            يخطط البحث، ويستدعي RxNorm وopenFDA وDailyMed وPubMed (+ OpenSERP/SearXNG عند ضبطهما)، ويعيد البحث عند النقص أو التعارض دون Gemini
          </p>
        </div>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <span className={worker?.active ? 'badge' : 'badge badge-muted'}>
            {worker?.statusLabel ?? 'بانتظار التحميل'}
          </span>
          <button
            className="btn btn-soft btn-sm"
            type="button"
            onClick={handleProbeSearchEngines}
            disabled={probeBusy}
          >
            {probeBusy ? 'جارٍ فحص المحرك…' : 'فحص جاهزية OpenSERP/SearXNG'}
          </button>
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
            {telemetry?.searchEngine?.statusLabel ?? 'غير مُعد'}
          </strong>
          <span className="hint">
            {telemetry?.searchEngine?.configured
              ? `الأساسي: ${telemetry.searchEngine.primary?.statusLabel} • البديل: ${telemetry.searchEngine.fallback?.statusLabel}`
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
            {busy ? 'جارٍ التخطيط والبحث…' : 'بدء البحث المستقل'}
          </button>
        </div>
      </form>

      {result && (
        <div className="stat" style={{ marginTop: '1rem', gap: '0.65rem', background: '#ffffff' }}>
          <div className="card-head" style={{ marginBottom: 0 }}>
            <strong style={{ fontSize: '0.98rem' }}>
              {checkResult.mode === 'pair'
                ? `${result.medicineA?.name} × ${result.medicineB?.name}`
                : result.medicine?.name}
            </strong>
            <span className={classificationBadgeClass(result.classification?.code)}>
              {result.classification?.label}
            </span>
          </div>

          {checkResult.mode === 'pair' ? (
            <>
              <p className="small" style={{ margin: 0 }}>{result.arabicSummary}</p>
              <div className="muted small">
                المادة الفعالة 1: <strong>{result.medicineA?.primaryIngredient ?? '—'}</strong>
                {' | '}المادة الفعالة 2: <strong>{result.medicineB?.primaryIngredient ?? '—'}</strong>
                {result.documentedSeverity && (
                  <>
                    {' | '}الشدة الموثقة: <strong>{result.documentedSeverity}</strong>
                  </>
                )}
              </div>

              <ResearchTraceBlock trace={result.researchTrace} />

              {officialList.length > 0 && (
                <div className="grid" style={{ gap: '0.45rem' }}>
                  <strong className="small">1) الأدلة الطبية الرسمية وقاعدة الصيدلية ({officialList.length})</strong>
                  {officialList.map((ev, idx) => (
                    <EvidenceItemCard key={`off-${idx}`} ev={ev} />
                  ))}
                </div>
              )}

              {literatureList.length > 0 && (
                <div className="grid" style={{ gap: '0.45rem' }}>
                  <strong className="small">2) الأبحاث العلمية المحكّمة — PubMed ({literatureList.length})</strong>
                  {literatureList.map((ev, idx) => (
                    <EvidenceItemCard key={`lit-${idx}`} ev={ev} />
                  ))}
                </div>
              )}

              {webList.length > 0 && (
                <div className="grid" style={{ gap: '0.45rem' }}>
                  <strong className="small">3) نتائج محرك البحث المفتوح — OpenSERP / SearXNG ({webList.length})</strong>
                  {webList.map((item, idx) => {
                    const safeItemUrl = safeExternalUrl(item.url);
                    return (
                      <div key={`web-${idx}`} className="live-feed-item">
                        <div className="live-feed-meta">
                          <span className={item.clinicallyCertified ? 'badge' : 'badge badge-warn'}>
                            {item.tierLabel}
                          </span>
                          <span className="badge badge-muted">{item.engine}</span>
                          {item.publishedDate && <span className="muted small">{item.publishedDate}</span>}
                          {safeItemUrl && (
                            <a
                              href={safeItemUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="small"
                              style={{ color: 'var(--accent-dark)', textDecoration: 'underline' }}
                            >
                              فتح الصفحة الأصلية
                            </a>
                          )}
                        </div>
                        <p className="small" dir="auto" style={{ margin: '0.25rem 0 0' }}>
                          <strong>{item.pageTitle || item.title}</strong>
                          {(item.pageText || item.snippet) ? ` — ${(item.pageText || item.snippet).slice(0, 320)}` : ''}
                        </p>
                        {item.nonAuthoritativeNotice && (
                          <p className="muted small" style={{ margin: '0.2rem 0 0' }}>{item.nonAuthoritativeNotice}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {result.clinicalWarnings?.length > 0 && (
                <details>
                  <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
                    تحذيرات الجرعة والعمر والحالة والحساسية الموثقة ({result.clinicalWarnings.length})
                  </summary>
                  <div className="grid" style={{ gap: '0.45rem', marginTop: '0.5rem' }}>
                    {result.clinicalWarnings.map((w, idx) => (
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
            <div className="grid" style={{ gap: '0.5rem' }}>
              <div className="muted small">
                المادة الفعالة الموحدة (RxNorm): <strong>{result.identity?.primaryIngredient ?? '—'}</strong>
                {result.identity?.strength && ` | التركيز: ${result.identity.strength}`}
                {result.identity?.dosageForm && ` | الشكل: ${result.identity.dosageForm}`}
              </div>
              <ResearchTraceBlock trace={result.researchTrace} />
              {(result.warnings ?? []).map((w, idx) => {
                const safeWarnUrl = safeExternalUrl(w.sourceUrl);
                return (
                  <div key={idx} className="live-feed-item">
                    <div className="live-feed-meta">
                      <span className="badge badge-warn">{w.categoryLabel}</span>
                      {w.publishedDate && <span className="muted small">{w.publishedDate}</span>}
                      {safeWarnUrl && (
                        <a href={safeWarnUrl} target="_blank" rel="noreferrer" className="small" style={{ textDecoration: 'underline' }}>
                          النشرة الرسمية
                        </a>
                      )}
                    </div>
                    <p className="small" dir="ltr" style={{ margin: '0.2rem 0 0' }}>{w.originalText}</p>
                  </div>
                );
              })}
            </div>
          )}

          <div className="alert alert-warn" style={{ marginBottom: 0 }}>
            {result.disclaimer}
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
                  <th>الجولات</th>
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
                    <td className="small">
                      {item.researchTrace?.roundsExecuted ?? 1}
                      {item.researchTrace?.reSearchTriggered ? ' (استدراك)' : ''}
                    </td>
                    <td>{item.documentedSeverity || '—'}</td>
                    <td className="small">
                      {item.arabicSummary}
                      {safeExternalUrl(item.evidences?.[0]?.sourceUrl) && (
                        <>
                          {' '}
                          <a
                            href={safeExternalUrl(item.evidences[0].sourceUrl)}
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

      {pharmacy?.coverage?.note && (
        <p className="muted small" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          {pharmacy.coverage.note}
        </p>
      )}

      {worker?.hostingContinuityNote && (
        <p className="muted small" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
          {worker.hostingContinuityNote}
        </p>
      )}
    </section>
  );
}
