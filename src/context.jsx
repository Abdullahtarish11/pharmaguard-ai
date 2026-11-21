import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { getSupabase } from './supabase.js';

const AppContext = createContext(null);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}

export function LoadingScreen({ label = 'جارٍ تحميل الإعدادات…' }) {
  return (
    <div className="centered">
      <div className="spinner" aria-label="جارٍ التحميل" />
      <p className="muted">{label}</p>
    </div>
  );
}

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [session, setSession] = useState(null);
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  useEffect(() => {
    let alive = true;
    let subscription = null;
    (async () => {
      try {
        const cfg = await api.config();
        if (!alive) return;
        setConfig(cfg);
        const supabase = getSupabase(cfg);
        if (supabase) {
          const { data } = await supabase.auth.getSession();
          if (alive) setSession(data?.session ?? null);
          const listener = supabase.auth.onAuthStateChange((event, nextSession) => {
            setSession(nextSession ?? null);
            if (event === 'PASSWORD_RECOVERY') {
              setPasswordRecovery(true);
            } else if (event === 'SIGNED_OUT') {
              setPasswordRecovery(false);
            }
          });
          subscription = listener?.data?.subscription ?? null;
        }
      } catch (error) {
        if (alive) setConfigError(error.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      subscription?.unsubscribe?.();
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
    setPasswordRecovery(false);
  }, [config]);

  const clearPasswordRecovery = useCallback(() => setPasswordRecovery(false), []);

  const value = useMemo(
    () => ({
      config,
      configError,
      session,
      me,
      meError,
      loading,
      passwordRecovery,
      clearPasswordRecovery,
      refreshMe,
      signOut,
      supabase: getSupabase(config),
    }),
    [config, configError, session, me, meError, loading, passwordRecovery, clearPasswordRecovery, refreshMe, signOut],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
