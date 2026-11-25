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

function NavLinks({ session, pathname, onNavigate }) {
  if (!session) {
    return (
      <>
        <Link
          className={pathname === '/' ? 'nav-link active' : 'nav-link'}
          to="/"
          onClick={onNavigate}
        >
          الرئيسية
        </Link>
        <Link
          className={pathname === '/setup' ? 'nav-link active' : 'nav-link'}
          to="/setup"
          onClick={onNavigate}
        >
          تهيئة المالك
        </Link>
        <Link className="btn btn-ghost" to="/login" onClick={onNavigate}>
          تسجيل الدخول
        </Link>
        <Link className="btn btn-primary" to="/register" onClick={onNavigate}>
          إنشاء حساب
        </Link>
      </>
    );
  }

  return (
    <>
      <Link
        className={pathname === '/app' ? 'nav-link active' : 'nav-link'}
        to="/app"
        onClick={onNavigate}
      >
        لوحة التحكم
      </Link>
      <Link
        className={pathname === '/app/inventory' ? 'nav-link active' : 'nav-link'}
        to="/app/inventory"
        onClick={onNavigate}
      >
        المخزون
      </Link>
      <Link
        className={pathname === '/app/movements' ? 'nav-link active' : 'nav-link'}
        to="/app/movements"
        onClick={onNavigate}
      >
        الحركات
      </Link>
      <Link
        className={pathname === '/app/alerts' ? 'nav-link active' : 'nav-link'}
        to="/app/alerts"
        onClick={onNavigate}
      >
        التنبيهات
      </Link>
      <Link
        className={pathname === '/app/reports' ? 'nav-link active' : 'nav-link'}
        to="/app/reports"
        onClick={onNavigate}
      >
        التقارير
      </Link>
      <Link
        className={pathname === '/app/agent' ? 'nav-link active' : 'nav-link'}
        to="/app/agent"
        onClick={onNavigate}
      >
        <span className="dot-live" />
        الوكلاء (حي)
      </Link>
      <Link
        className={pathname === '/app/diagnostics' ? 'nav-link active' : 'nav-link'}
        to="/app/diagnostics"
        onClick={onNavigate}
      >
        تشخيص الربط
      </Link>
    </>
  );
}

function Header() {
  const { session, me, signOut, config } = useApp();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const role = me?.role ?? null;

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="brand" to={session ? '/app' : '/'}>
            <span className="brand-mark">
              <img
                className="brand-logo"
                src="/assets/aistudio/IMG-20261121-WA0000_ff2dfbd8.jpg"
                alt="شعار PharmaGuard AI"
              />
            </span>
            <div className="brand-text">
              <strong>PharmaGuard AI</strong>
              <span className="brand-sub">إدارة صيدلية محمية</span>
            </div>
          </Link>

          <div className="header-mobile-actions">
            {session && (
              <span className="user-chip">
                <span className="dot-online" />
                {roleLabel(role)}
              </span>
            )}
            <button
              className="btn btn-ghost btn-sm nav-toggle"
              type="button"
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation-drawer"
              aria-label="تبديل قائمة التنقل"
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              {menuOpen ? '✕ إغلاق' : '☰ القائمة'}
            </button>
          </div>

          <nav className="site-nav site-nav-desktop" aria-label="التنقل الرئيسي">
            <NavLinks session={session} pathname={location.pathname} />
            {session && (
              <div className="nav-actions-cluster">
                <span className="user-chip">
                  <span className="dot-online" />
                  {roleLabel(role)}
                </span>
                <button className="btn btn-ghost btn-sm" type="button" onClick={signOut}>
                  خروج
                </button>
              </div>
            )}
            <PWAInstallButton />
            {config && !config.anonKeyPresent && <span className="badge badge-warn">قاعدة البيانات غير مربوطة</span>}
          </nav>
        </div>
      </header>

      {menuOpen && (
        <>
          <div className="drawer-backdrop" onClick={closeMenu} aria-hidden="true" />
          <aside
            id="mobile-navigation-drawer"
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="قائمة التنقل"
          >
            <div className="mobile-drawer-head">
              <Link className="brand" to={session ? '/app' : '/'} onClick={closeMenu}>
                <span className="brand-mark">
                  <img
                    className="brand-logo"
                    src="/assets/aistudio/IMG-20261121-WA0000_ff2dfbd8.jpg"
                    alt="شعار PharmaGuard AI"
                  />
                </span>
                <div className="brand-text">
                  <strong>PharmaGuard AI</strong>
                  <span className="brand-sub">إدارة صيدلية محمية</span>
                </div>
              </Link>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                aria-label="إغلاق القائمة"
                onClick={closeMenu}
              >
                ✕
              </button>
            </div>

            {session && (
              <div style={{ marginBottom: '0.85rem' }}>
                <span className="user-chip">
                  <span className="dot-online" />
                  {roleLabel(role)}
                </span>
              </div>
            )}

            <nav className="mobile-drawer-nav" aria-label="قائمة الجوال">
              <NavLinks session={session} pathname={location.pathname} onNavigate={closeMenu} />
            </nav>

            <div className="mobile-drawer-footer">
              {config && !config.anonKeyPresent && (
                <span className="badge badge-warn">قاعدة البيانات غير مربوطة</span>
              )}
              <PWAInstallButton />
              {session && (
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    closeMenu();
                    signOut();
                  }}
                >
                  تسجيل الخروج
                </button>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}

function MobileBottomNav() {
  const { session } = useApp();
  const { pathname } = useLocation();
  if (!session) return null;

  const items = [
    {
      to: '/app',
      label: 'الرئيسية',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9.5Z" />
        </svg>
      ),
    },
    {
      to: '/app/inventory',
      label: 'المخزون',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
        </svg>
      ),
    },
    {
      to: '/app/movements',
      label: 'الحركات',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M7 17 17 7M7 7h10v10" />
        </svg>
      ),
    },
    {
      to: '/app/alerts',
      label: 'التنبيهات',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
    },
    {
      to: '/app/agent',
      label: 'الوكلاء',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 2a4 4 0 0 1 4 4v2h2a3 3 0 0 1 3 3v5a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-5a3 3 0 0 1 3-3h2V6a4 4 0 0 1 4-4Z" />
          <circle cx="9.5" cy="13.5" r="1" />
          <circle cx="14.5" cy="13.5" r="1" />
        </svg>
      ),
    },
  ];

  return (
    <nav className="mobile-bottom-nav" aria-label="التنقل السريع للجوال">
      {items.map((item) => {
        const active = pathname === item.to;
        return (
          <Link
            key={item.to}
            to={item.to}
            className={active ? 'mobile-bottom-link active' : 'mobile-bottom-link'}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function RequireAuth({ children }) {
  const { session, loading } = useApp();
  if (loading) return <LoadingScreen />;
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function AppLayout() {
  const { session } = useApp();

  return (
    <div className={`app-shell${session ? ' has-bottom-nav' : ''}`}>
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
      <MobileBottomNav />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <AppLayout />
      </AppProvider>
    </BrowserRouter>
  );
}
