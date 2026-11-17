import { createClient } from '@supabase/supabase-js';

let client = null;
let signature = '';

/**
 * عميل المتصفح يستخدم المفتاح العام (anon) فقط.
 * كل قراءة/كتابة تخضع لسياسات RLS في قاعدة البيانات.
 */
export function getSupabase(config) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return null;
  const nextSignature = `${config.supabaseUrl}|${config.supabaseAnonKey}`;
  if (!client || signature !== nextSignature) {
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'pharmaguard-auth',
      },
    });
    signature = nextSignature;
  }
  return client;
}
