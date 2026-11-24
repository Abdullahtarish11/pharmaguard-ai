import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { formatDate } from '../labels.js';

function formatClock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const FEED_STATUS_BADGE = {
  alert: { label: 'تنبيه مرصود', className: 'badge badge-danger' },
  resolved: { label: 'معالجة آلية', className: 'badge' },
  changed: { label: 'تغير مرصود', className: 'badge badge-warn' },
  ok: { label: 'مستقر', className: 'badge badge-muted' },
};

export default function LiveAgentsMonitor({
  token,
  canRun = false,
  showDetails = false,
  onLiveSweep = null,
}) {
  const [streamStatus, setStreamStatus] = useState('connecting');
  const [scheduler, setScheduler] = useState(null);
  const [latest, setLatest] = useState(null);
  const [liveFeed, setLiveFeed] = useState([]);
  const [activeAgent, setActiveAgent] = useState(null);
  const [scanningInfo, setScanningInfo] = useState(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepError, setSweepError] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const onLiveSweepRef = useRef(onLiveSweep);
  onLiveSweepRef.current = onLiveSweep;

  useEffect(() => {
    const ticker = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (!token) return undefined;

    const unsubscribe = api.subscribeAgentStream(token, {
      onStatusChange: (status) => setStreamStatus(status),
      onEvent: (eventName, payload) => {
        if (eventName === 'init') {
          if (payload?.scheduler) setScheduler(payload.scheduler);
          if (payload?.latest) setLatest(payload.latest);
          if (Array.isArray(payload?.liveFeed)) setLiveFeed(payload.liveFeed);
          setScanningInfo(null);
          setActiveAgent(null);
        } else if (eventName === 'safety:updated') {
          if (payload?.pharmacy) {
            setLatest((prev) => {
              if (!prev?.audit?.agents?.safety_agent) return prev;
              return {
                ...prev,
                audit: {
                  ...prev.audit,
                  agents: {
                    ...prev.audit.agents,
                    safety_agent: {
                      ...prev.audit.agents.safety_agent,
                      externalResearch: {
                        workerStatus: payload.worker?.statusLabel ?? 'يعمل في الخلفية',
                        workerRunning: Boolean(payload.worker?.running),
                        lastCheckedAt: payload.pharmacy?.lastCheckedAt ?? null,
                        lastError: payload.pharmacy?.lastError ?? null,
                        documentedInteractionsCount: payload.pharmacy?.counts?.documented_interaction ?? 0,
                        documentedWarningsCount: payload.pharmacy?.counts?.documented_warning ?? 0,
                        counts: payload.pharmacy?.counts ?? null,
                        searchEngineStatus: payload.telemetry?.searchEngine?.status ?? 'not_configured',
                      },
                    },
                  },
                },
              };
            });
          }
        } else if (eventName === 'sweep:started') {
          setScanningInfo(payload);
          setActiveAgent('inventory_agent');
        } else if (eventName === 'agent:checked') {
          const id = payload?.agentId;
          if (id === 'inventory_agent') setActiveAgent('safety_agent');
          else if (id === 'safety_agent') setActiveAgent('analytics_agent');
          else setActiveAgent(null);

          if (id && payload?.metrics) {
            setLatest((prev) => {
              if (!prev?.audit?.agents) return prev;
              return {
                ...prev,
                audit: {
                  ...prev.audit,
                  agents: {
                    ...prev.audit.agents,
                    [id]: payload.metrics,
                  },
                },
              };
            });
          }
        } else if (eventName === 'agent:feed') {
          if (payload?.id) {
            setLiveFeed((prev) => [payload, ...prev.filter((item) => item.id !== payload.id)].slice(0, 30));
          }
        } else if (eventName === 'sweep:completed') {
          if (payload?.scheduler) setScheduler(payload.scheduler);
          if (payload?.latest) setLatest(payload.latest);
          setScanningInfo(null);
          setActiveAgent(null);
          if (payload?.changed) {
            onLiveSweepRef.current?.(payload);
          }
        }
      },
    });

    return () => {
      unsubscribe?.();
    };
  }, [token]);

  async function runNow() {
    if (!token || !canRun) return;
    setSweepBusy(true);
    setSweepError(null);
    try {
      const res = await api.runAgentSweep(token);
      if (res?.scheduler) setScheduler(res.scheduler);
      if (res?.latest) setLatest(res.latest);
      if (Array.isArray(res?.liveFeed)) setLiveFeed(res.liveFeed);
      onLiveSweepRef.current?.(res);
    } catch (err) {
      setSweepError(err.message);
    } finally {
      setSweepBusy(false);
    }
  }

  const countdownSec = useMemo(() => {
    if (!scheduler?.nextRunAt) return null;
    const target = new Date(scheduler.nextRunAt).getTime();
    if (Number.isNaN(target)) return null;
    return Math.max(0, Math.ceil((target - nowMs) / 1000));
  }, [scheduler?.nextRunAt, nowMs]);

  const audit = latest?.audit ?? null;
  const invAgent = audit?.agents?.inventory_agent ?? null;
  const safetyAgent = audit?.agents?.safety_agent ?? null;
  const analyticsAgent = audit?.agents?.analytics_agent ?? null;
  const watchSeconds = scheduler?.watchIntervalSeconds ?? 30;
  const isScanning = Boolean(scanningInfo || scheduler?.running || sweepBusy);

  return (
    <section className="card live-monitor-card">
      <div className="card-head">
        <div>
          <h2 className="section-title" style={{ marginBottom: '0.2rem' }}>
            <span className={streamStatus === 'connected' ? 'dot-live' : 'dot-warn'} />
            المراقبة الحية المستمرة للوكلاء الثلاثة
          </h2>
          <p className="muted small" style={{ margin: 0 }}>
            فحص تلقائي متواصل كل {watchSeconds} ثانية + استجابة فورية لحظية عند أي إضافة أو صرف أو استيراد
          </p>
        </div>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <span className={isScanning ? 'badge badge-warn' : streamStatus === 'connected' ? 'badge' : 'badge badge-muted'}>
            {isScanning
              ? 'يفحص البيانات الآن…'
              : streamStatus === 'connected'
                ? 'بث مباشر متصل'
                : 'إعادة اتصال…'}
          </span>
          {!showDetails && (
            <Link className="btn btn-soft btn-sm" to="/app/agent">
              غرفة الوكلاء
            </Link>
          )}
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={runNow}
            disabled={!canRun || sweepBusy}
          >
            {sweepBusy ? 'جارٍ الفحص…' : 'فحص فوري الآن'}
          </button>
        </div>
      </div>

      {sweepError && <div className="alert alert-error">{sweepError}</div>}

      <div className="grid grid-3" style={{ marginTop: '0.5rem' }}>
        <div className="stat">
          <span>حالة الدورة المستمرة</span>
          <strong style={{ fontSize: '1rem' }}>
            {scheduler?.cycleCount ? `دورة #${scheduler.cycleCount}` : 'بانتظار أول دورة'}
          </strong>
          <span className="hint">
            {scheduler?.lastRunAt ? `آخر فحص: ${formatClock(scheduler.lastRunAt)}` : 'يبدأ تلقائيًا بعد ثوانٍ'}
          </span>
        </div>

        <div className="stat">
          <span>الفحص القادم</span>
          <strong style={{ fontSize: '1rem' }}>
            {isScanning
              ? 'جارٍ الفحص الآن…'
              : countdownSec !== null
                ? `خلال ${countdownSec} ثانية`
                : `كل ${watchSeconds} ثانية`}
          </strong>
          <span className="hint">
            {scanningInfo?.reason || audit?.reason || audit?.triggerLabel || 'مراقبة متواصلة'}
          </span>
        </div>

        <div className="stat">
          <span>ملخص الرصد الحالي</span>
          <strong style={{ fontSize: '1rem' }}>
            {invAgent
              ? `${invAgent.alertsDetected} تنبيه • ${safetyAgent?.inventoryConflictsCount ?? 0} تداخل`
              : '—'}
          </strong>
          <span className="hint">
            {invAgent
              ? `${invAgent.medicinesScanned} صنفًا • ${invAgent.batchesScanned} دفعة • ${analyticsAgent?.movementsScanned ?? 0} حركة`
              : 'يتم تجميع البيانات…'}
          </span>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginTop: '0.9rem' }}>
        <div className={`stat agent-live-card${activeAgent === 'inventory_agent' ? ' agent-live-scanning' : ''}`}>
          <div className="agent-live-head">
            <span className="agent-live-title">1. وكيل المخزون وFEFO</span>
            <span className={invAgent?.highSeverityAlerts > 0 ? 'badge badge-danger' : 'badge'}>
              {activeAgent === 'inventory_agent'
                ? 'يفحص الآن…'
                : invAgent?.alertsDetected > 0
                  ? `${invAgent.alertsDetected} تنبيه`
                  : 'مراقب'}
            </span>
          </div>
          {invAgent ? (
            <>
              <span className="small">أصناف: {invAgent.medicinesScanned} | دفعات: {invAgent.batchesScanned}</span>
              <span className="small">
                حرجة: {invAgent.highSeverityAlerts} | جاهز لـ FEFO: {invAgent.fefoReadyMedicines}
              </span>
              <span className="hint">
                مزامنة آلية: +{invAgent.persistedNewAlerts} جديد / ✓ {invAgent.autoResolvedAlerts} محلول
              </span>
            </>
          ) : (
            <span className="muted small">في انتظار نتائج الفحص الحي…</span>
          )}
        </div>

        <div className={`stat agent-live-card${activeAgent === 'safety_agent' ? ' agent-live-scanning' : ''}`}>
          <div className="agent-live-head">
            <span className="agent-live-title">2. وكيل سلامة الأدوية</span>
            <span
              className={
                safetyAgent?.criticalConflictsCount > 0 || (safetyAgent?.externalResearch?.documentedInteractionsCount ?? 0) > 0
                  ? 'badge badge-danger'
                  : safetyAgent?.inventoryConflictsCount > 0
                    ? 'badge badge-warn'
                    : 'badge'
              }
            >
              {activeAgent === 'safety_agent'
                ? 'يفحص الآن…'
                : safetyAgent?.inventoryConflictsCount > 0
                  ? `${safetyAgent.inventoryConflictsCount} تعارض`
                  : (safetyAgent?.externalResearch?.documentedInteractionsCount ?? 0) > 0
                    ? `${safetyAgent.externalResearch.documentedInteractionsCount} موثق مرجعيًا`
                    : 'مراقب متعدد المصادر'}
            </span>
          </div>
          {safetyAgent ? (
            <>
              <span className="small">قاعدة التداخلات: {safetyAgent.interactionsCatalogRows} سجلًا</span>
              <span className="small">
                تداخلات موثقة بالمخزون: {safetyAgent.inventoryConflictsCount} (مصادر رسمية: {safetyAgent.externalResearch?.documentedInteractionsCount ?? 0})
              </span>
              <span className="hint">
                المصادر: {safetyAgent.externalResearch?.workerStatus ?? 'مفعّل'} • تحذيرات: {safetyAgent.externalResearch?.documentedWarningsCount ?? 0} • البحث الشامل: {safetyAgent.externalResearch?.searchEngineStatus === 'configured' ? 'مُعد' : 'غير مُعد'}
              </span>
            </>
          ) : (
            <span className="muted small">في انتظار فحص التداخلات…</span>
          )}
        </div>

        <div className={`stat agent-live-card${activeAgent === 'analytics_agent' ? ' agent-live-scanning' : ''}`}>
          <div className="agent-live-head">
            <span className="agent-live-title">3. وكيل التحليل والتقارير</span>
            <span className="badge">
              {activeAgent === 'analytics_agent' ? 'يحلل الآن…' : 'محدّث'}
            </span>
          </div>
          {analyticsAgent ? (
            <>
              <span className="small">
                حركات: {analyticsAgent.movementsScanned} (وارد {analyticsAgent.inboundUnits} / صادر {analyticsAgent.outboundUnits})
              </span>
              <span className="small">قيمة البيع: {analyticsAgent.sellingValue}</span>
              <span className="hint">خسارة منتهي الصلاحية: {analyticsAgent.expiredCostLoss}</span>
            </>
          ) : (
            <span className="muted small">في انتظار التقرير المالي…</span>
          )}
        </div>
      </div>

      {safetyAgent?.conflicts?.length > 0 && (
        <div style={{ marginTop: '0.9rem' }}>
          {!showDetails ? (
            <div className="alert alert-warn" style={{ marginBottom: 0 }}>
              <strong>تنبيه وكيل السلامة:</strong> رُصد {safetyAgent.inventoryConflictsCount} تداخلًا بين أدوية متوفرة في مخزونك
              {' '}({safetyAgent.conflicts.slice(0, 3).map((c) => `${c.medicineA?.name} × ${c.medicineB?.name}`).join(' ، ')}).
              {' '}
              <Link to="/app/agent" style={{ textDecoration: 'underline', fontWeight: 700 }}>
                عرض التفاصيل الكاملة
              </Link>
            </div>
          ) : (
            <div className="table-wrap">
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
                  {safetyAgent.conflicts.slice(0, 12).map((c, idx) => (
                    <tr key={`${c.medicineA?.id}-${c.medicineB?.id}-${idx}`}>
                      <td>{c.medicineA?.name ?? '—'}</td>
                      <td>{c.medicineB?.name ?? '—'}</td>
                      <td>
                        <span
                          className={
                            ['critical', 'high', 'major', 'severe'].includes(String(c.severity ?? '').toLowerCase())
                              ? 'badge badge-danger'
                              : 'badge badge-warn'
                          }
                        >
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
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        <div className="card-head" style={{ marginBottom: '0.5rem' }}>
          <h3 className="section-title" style={{ fontSize: '0.95rem', marginBottom: 0 }}>
            السجل الحي للرصد والمراقبة (أولًا بأول)
          </h3>
          <span className="badge badge-muted">{liveFeed.length}</span>
        </div>
        {liveFeed.length > 0 ? (
          <div className="live-feed">
            {liveFeed.slice(0, showDetails ? 15 : 6).map((item) => {
              const badge = FEED_STATUS_BADGE[item.status] ?? FEED_STATUS_BADGE.ok;
              return (
                <div key={item.id} className="live-feed-item">
                  <div className="live-feed-meta">
                    <span className={badge.className}>{badge.label}</span>
                    <span className="muted small" dir="ltr">
                      {formatClock(item.at)}
                    </span>
                    <span className="small" style={{ fontWeight: 600 }}>
                      {item.triggerLabel ?? 'مراقبة'}
                    </span>
                  </div>
                  <div className="small">{item.summary}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            سيظهر هنا كل فحص أو تنبيه أو تغيير ترصده الوكلاء لحظيًا أولًا بأول.
          </p>
        )}
      </div>

      {showDetails && audit?.fefoTop?.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h3 className="section-title" style={{ fontSize: '0.95rem' }}>
            أولوية الصرف المراقبة وفق FEFO ({audit.fefoTop.length})
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الدواء</th>
                  <th>أول دفعة للصرف</th>
                  <th>تاريخ الانتهاء</th>
                  <th>الكمية</th>
                  <th>الدفعات الصالحة</th>
                </tr>
              </thead>
              <tbody>
                {audit.fefoTop.slice(0, 8).map((row) => (
                  <tr key={row.medicineId}>
                    <td>{row.medicineName}</td>
                    <td dir="ltr">{row.firstBatch ?? '—'}</td>
                    <td dir="ltr">{row.firstExpiry ? formatDate(row.firstExpiry) : '—'}</td>
                    <td>{row.firstQuantity}</td>
                    <td>{row.validBatches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showDetails && latest?.reportText && (
        <div style={{ marginTop: '0.85rem' }}>
          <button className="btn btn-soft btn-sm" type="button" onClick={() => setShowReport((v) => !v)}>
            {showReport ? 'إخفاء تقرير الفحص التفصيلي' : 'عرض تقرير الفحص التفصيلي'}
          </button>
          {showReport && (
            <pre className="agent-answer" style={{ marginTop: '0.65rem' }}>
              {latest.reportText}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
