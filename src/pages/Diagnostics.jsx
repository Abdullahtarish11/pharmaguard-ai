import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';

export default function Diagnostics() {
  const { session, me } = useApp();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sql, setSql] = useState(null);
  const [copied, setCopied] = useState(false);

  const token = session?.access_token;
  const isOwner = me?.role === 'owner';

  const run = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.diagnostics(token);
      setReport(data);
    } catch (err) {
      setError(err.message);
      setReport(null);
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => {
    if (isOwner) run();
  }, [isOwner, run]);

  async function loadSql() {
    try {
      const text = await api.setupSql();
      setSql(text);
    } catch (err) {
      setError(err.message);
    }
  }

  async function copySql() {
    try {
      const text = sql ?? (await api.setupSql());
      setSql(text);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setError(`تعذر النسخ التلقائي: ${err.message}. انسخ النص يدويًا.`);
    }
  }

  if (!isOwner) {
    return (
      <div className="card">
        <h1 className="section-title">تشخيص الربط</h1>
        <div className="alert alert-warn">
          هذا التقرير متاح لمالك الصيدلية فقط، لأنه يعرض بنية المخطط وحالة RLS وأسماء الجداول.
        </div>
      </div>
    );
  }

  return (
    <div className="grid">
      <div className="card">
        <div className="card-head">
          <h1 className="section-title">تشخيص الربط والصلاحيات</h1>
          <div className="btn-row" style={{ margin: 0 }}>
            <button className="btn btn-primary" type="button" onClick={run} disabled={busy}>
              {busy ? 'جارٍ الفحص…' : 'إعادة الفحص'}
            </button>
          </div>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {report && (
          <dl className="kv">
            <dt>المشروع</dt>
            <dd dir="ltr">{report.project?.url || '—'}</dd>
            <dt>وقت الفحص</dt>
            <dd dir="ltr">{report.checkedAt}</dd>
            <dt>مفتاح الخدمة</dt>
            <dd>{report.connection?.usingServiceRole ? 'مستخدم على السيرفر' : 'غير مضبوط'}</dd>
            <dt>المفتاح العام</dt>
            <dd>{report.connection?.usingAnonKey ? 'مضبوط' : 'غير مضبوط'}</dd>
            <dt>زمن الاستجابة</dt>
            <dd>{report.connection?.latencyMs ?? '—'} ms</dd>
          </dl>
        )}
      </div>

      {report?.schema && (
        <div className="card">
          <div className="card-head">
            <h2 className="section-title">المخطط</h2>
            <span className={report.schema.ok ? 'badge' : 'badge badge-warn'}>
              {report.schema.ok ? `${report.schema.tableCount} جدول` : report.schema.reason || 'غير مقروء'}
            </span>
          </div>
          {report.schema.missingTables?.length > 0 && (
            <div className="alert alert-warn">
              جداول غير موجودة: <span dir="ltr">{report.schema.missingTables.join(' , ')}</span>
            </div>
          )}
          {report.schema.error && <div className="alert alert-error">{report.schema.error}</div>}
        </div>
      )}

      {report?.tables?.length > 0 && (
        <div className="card">
          <h2 className="section-title">الجداول والقراءة</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الجدول</th>
                  <th>موجود</th>
                  <th>أعمدة</th>
                  <th>صفوف</th>
                  <th>ملاحظة</th>
                </tr>
              </thead>
              <tbody>
                {report.tables.map((table) => (
                  <tr key={table.name}>
                    <td dir="ltr">{table.name}</td>
                    <td>{table.exists === null ? '—' : table.exists ? 'نعم' : 'لا'}</td>
                    <td>{table.columnCount}</td>
                    <td>{table.rowCount ?? '—'}</td>
                    <td className="small" dir="ltr">
                      {table.error || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <section className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2 className="section-title">RLS</h2>
            <span className={report?.rls?.installed ? 'badge' : 'badge badge-warn'}>
              {report?.rls?.installed ? 'مثبّت' : 'غير مثبّت'}
            </span>
          </div>
          {report?.rls?.error && <div className="alert alert-warn">{report.rls.error}</div>}
          {report?.rls?.installed && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الجدول</th>
                    <th>RLS</th>
                    <th>سياسات</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.rls.tables ?? []).map((row) => (
                    <tr key={row.table_name}>
                      <td dir="ltr">{row.table_name}</td>
                      <td>{row.rls_enabled ? 'مفعّل' : 'معطّل'}</td>
                      <td>{row.policy_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="section-title">الكتابة والصلاحيات</h2>
          <dl className="kv">
            <dt>اختبار الكتابة</dt>
            <dd>{report?.write?.ok ? 'ناجح (بدون بقايا)' : report?.write?.error || '—'}</dd>
            <dt>طريقة الاختبار</dt>
            <dd dir="ltr">{report?.write?.method || '—'}</dd>
            <dt>قراءة كهوية المستخدم</dt>
            <dd dir="ltr">
              {report?.permissions?.userScopedReads
                ? Object.entries(report.permissions.userScopedReads)
                    .map(([table, value]) => `${table}: ${value.rowsVisible ?? value.denied ? 'ممنوع' : value.error ?? '—'}`)
                    .join(' | ')
                : '—'}
            </dd>
            <dt>المجهول محجوب</dt>
            <dd>{report?.permissions?.anonymousBlockedFromDiagnostics ? 'نعم' : 'غير مؤكد'}</dd>
          </dl>
          <p className="hint">
            اختبار الكتابة يُنفَّذ داخل دالة تُرجع كل شيء، فلا يبقى أي صف تجريبي في الجداول.
          </p>
        </div>
      </section>

      <div className="card">
        <div className="card-head">
          <h2 className="section-title">ملف سياسات RLS</h2>
          <div className="btn-row" style={{ margin: 0 }}>
            <button className="btn btn-soft" type="button" onClick={loadSql}>
              عرض الملف
            </button>
            <button className="btn btn-primary" type="button" onClick={copySql}>
              {copied ? 'تم النسخ ✓' : 'نسخ كل السياسات'}
            </button>
          </div>
        </div>
        <p className="muted small">
          الصق الملف كاملًا في Supabase → SQL Editor → Run. الملف لا يُنشئ جداول ولا يحذفها، ويعيد تفعيل RLS
          وسياسات الأدوار الثلاثة، ويمكن تشغيله أكثر من مرة بأمان.
        </p>
        {sql && <pre className="code">{sql}</pre>}
      </div>
    </div>
  );
}
