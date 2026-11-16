import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, LoadingScreen, useApp } from './context.jsx';
import { roleLabel } from './labels.js';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Setup from './pages/Setup.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Diagnostics from './pages/Diagnostics.jsx';
import './styles.css';

function Header() {
  const { session, me, signOut, config } = useApp();
  const location = useLocation();
  const role = me?.role ?? null;

  return (
    <header className="site-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          ✚
        </span>
        <div>
          <strong>PharmaGuard AI</strong>
          <span className="brand-sub">إدارة صيدلية محمية</span>
        </div>
      </div>
      <nav className="site-nav">
        {!session && (
          <>
            <Link className={location.pathname === '/' ? 'nav-link active' : 'nav-link'} to="/">
              الرئيسية
            </Link>
            <Link className="nav-link" to="/setup">
              تهيئة المالك
            </Link>
            <Link className="btn btn-ghost" to="/login">
              تسجيل الدخول
            </Link>
            <Link className="btn btn-primary" to="/register">
              إنشاء حساب
            </Link>
          </>
        )}
        {session && (
          <>
            <Link className={location.pathname === '/app' ? 'nav-link active' : 'nav-link'} to="/app">
              لوحة التحكم
            </Link>
            <Link
              className={location.pathname === '/app/diagnostics' ? 'nav-link active' : 'nav-link'}
              to="/app/diagnostics"
            >
              تشخيص الربط
            </Link>
            <span className="user-chip">
              <span className="dot-online" />
              {roleLabel(role)}
            </span>
            <button className="btn btn-ghost" type="button" onClick={signOut}>
              خروج
            </button>
          </>
        )}
        {config && !config.anonKeyPresent && <span className="badge badge-warn">قاعدة البيانات غير مربوطة</span>}
      </nav>
    </header>
  );
}

function RequireAuth({ children }) {
  const { session, loading } = useApp();
  if (loading) return <LoadingScreen />;
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <div className="app-shell">
          <Header />
          <main className="app-main">
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/setup" element={<Setup />} />
              <Route
                path="/app"
                element={
                  <RequireAuth>
                    <Dashboard />
                  </RequireAuth>
                }
              />
              <Route
                path="/app/diagnostics"
                element={
                  <RequireAuth>
                    <Diagnostics />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
          <footer className="site-footer">
            <span>PharmaGuard AI — نسخة الربط والتأمين (بدون بيانات تجريبية)</span>
            <span className="muted">الجداول فارغة عن قصد؛ لا تُضاف بيانات حقيقية قبل تأكيد الربط والصلاحيات.</span>
          </footer>
        </div>
      </AppProvider>
    </BrowserRouter>
  );
}
