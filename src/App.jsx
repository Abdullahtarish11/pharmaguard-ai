import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, LoadingScreen, useApp } from './context.jsx';
import { roleLabel } from './labels.js';
import { OfflineIndicator, PWAInstallButton } from './components/PwaControls.jsx';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Setup from './pages/Setup.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Diagnostics from './pages/Diagnostics.jsx';
import Inventory from './pages/Inventory.jsx';
import Movements from './pages/Movements.jsx';
import Alerts from './pages/Alerts.jsx';
import Reports from './pages/Reports.jsx';
import Agent from './pages/Agent.jsx';
import './styles.css';

function Header() {
  const { session, me, signOut, config } = useApp();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const role = me?.role ?? null;

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <header className="site-header">
      <Link className="brand" to={session ? '/app' : '/'}>
        <span className="brand-mark">
          <img
            className="brand-logo"
            src="/assets/aistudio/IMG-20261121-WA0000_ff2dfbd8.jpg"
            alt="شعار PharmaGuard AI"
          />
        </span>
        <div>
          <strong>PharmaGuard AI</strong>
          <span className="brand-sub">إدارة صيدلية محمية</span>
        </div>
      </Link>

      <button
        className="btn btn-ghost btn-sm nav-toggle"
        type="button"
        aria-expanded={menuOpen}
        aria-label="تبديل قائمة التنقل"
        onClick={() => setMenuOpen((prev) => !prev)}
      >
        {menuOpen ? '✕ إغلاق' : '☰ القائمة'}
      </button>

      <nav className={`site-nav${menuOpen ? ' open' : ''}`}>
        {!session && (
          <>
            <Link className={location.pathname === '/' ? 'nav-link active' : 'nav-link'} to="/">
              الرئيسية
            </Link>
            <Link className={location.pathname === '/setup' ? 'nav-link active' : 'nav-link'} to="/setup">
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
              className={location.pathname === '/app/inventory' ? 'nav-link active' : 'nav-link'}
              to="/app/inventory"
            >
              المخزون
            </Link>
            <Link
              className={location.pathname === '/app/movements' ? 'nav-link active' : 'nav-link'}
              to="/app/movements"
            >
              الحركات
            </Link>
            <Link
              className={location.pathname === '/app/alerts' ? 'nav-link active' : 'nav-link'}
              to="/app/alerts"
            >
              التنبيهات
            </Link>
            <Link
              className={location.pathname === '/app/reports' ? 'nav-link active' : 'nav-link'}
              to="/app/reports"
            >
              التقارير
            </Link>
            <Link
              className={location.pathname === '/app/agent' ? 'nav-link active' : 'nav-link'}
              to="/app/agent"
            >
              الوكيل
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
        <PWAInstallButton />
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
                path="/app/inventory"
                element={
                  <RequireAuth>
                    <Inventory />
                  </RequireAuth>
                }
              />
              <Route
                path="/app/movements"
                element={
                  <RequireAuth>
                    <Movements />
                  </RequireAuth>
                }
              />
              <Route
                path="/app/alerts"
                element={
                  <RequireAuth>
                    <Alerts />
                  </RequireAuth>
                }
              />
              <Route
                path="/app/reports"
                element={
                  <RequireAuth>
                    <Reports />
                  </RequireAuth>
                }
              />
              <Route
                path="/app/agent"
                element={
                  <RequireAuth>
                    <Agent />
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
          <OfflineIndicator />
          <footer className="site-footer">
            <span>PharmaGuard AI — إدارة صيدلية ذكية محمية</span>
            <span className="muted">لا بيانات تجريبية؛ كل الأرقام من جداول مشروعك في Supabase.</span>
          </footer>
        </div>
      </AppProvider>
    </BrowserRouter>
  );
}
