import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { getSupabase } from './supabase.js';
import { roleLabel } from './labels.js';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Setup from './pages/Setup.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Diagnostics from './pages/Diagnostics.jsx';
import './styles.css';

const AppContext = createContext(null);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}

function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [session, setSession] = useState(null);
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api.config();
        if (!alive) return;
        setConfig(cfg);
        const supabase = getSupabase(cfg);
        if (supabase) {
          const { data } = await supabase.auth.getSession();
          if (alive) setSession(data?.session ?? null);
          supabase.auth.onAuthStateChange((_event, nextSession) => {
            setSession(nextSession ?? null);
          });
        }
      } catch (error) {
        if (alive) setConfigError(error.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshMe = useCallback(async () => {
    if (!session?.access_token) {
      setMe(null);
      return null;
    }
    try {
      const data = await api.me(session.access_token);
      setMe(data);
      setMeError(null);
      return data;
    } catch (error) {
      setMeError(error.message);
      setMe(null);
      return null;
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (session?.access_token) refreshMe();
    else {
      setMe(null);
      setMeError(null);
    }
  }, [session?.access_token, refreshMe]);

  const signOut = useCallback(async () => {
    const supabase = getSupabase(config);
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setMe(null);
  }, [config]);

  const value = useMemo(
    () => ({
      config,
      configError,
      session,
      me,
      meError,
      loading,
      refreshMe,
      signOut,
      supabase: getSupabase(config),
    }),
    [config, configError, session, me, meError, loading, refreshMe, signOut],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function LoadingScreen() {
  return (
    <div className="centered">
      <div className="spinner" aria-label="جارٍ التحميل" />
      <p className="muted">جارٍ تحميل الإعدادات…</p>
    </div>
  );
}

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
            <Link className="nav-link" to="/app">
              لوحة التحكم
            </Link>
            <Link className="nav-link" to="/app/diagnostics">
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
        {!config?.anonKeyPresent && <span className="badge badge-warn">قاعدة البيانات غير مربوطة</span>}
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
            <span className="muted">جميع الجداول فارغة عن قصد، والبيانات الحقيقية فقط بعد التحقق من الربط.</span>
          </footer>
        </div>
      </AppProvider>
    </BrowserRouter>
  );
}
