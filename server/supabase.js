import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-application-name': 'pharmaguard-ai' } },
};

let adminClient = null;

/** عميل بمفتاح service_role — للسيرفر فقط، لا يُرسل إلى المتصفح أبدًا. */
export function getAdmin() {
  if (!env.supabaseUrl || !env.serviceRoleKey) return null;
  if (!adminClient) {
    adminClient = createClient(env.supabaseUrl, env.serviceRoleKey, CLIENT_OPTIONS);
  }
  return adminClient;
}

let anonClient = null;

/** عميل بالمفتاح العام فقط — يخضع لسياسات RLS. */
export function getAnonClient() {
  if (!env.supabaseUrl || !env.anonKey) return null;
  if (!anonClient) {
    anonClient = createClient(env.supabaseUrl, env.anonKey, CLIENT_OPTIONS);
  }
  return anonClient;
}

/** عميل يحمل هوية المستخدم — يخضع لسياسات RLS كما لو كان في المتصفح. */
export function getUserClient(accessToken) {
  if (!env.supabaseUrl || !env.anonKey || !accessToken) return null;
  return createClient(env.supabaseUrl, env.anonKey, {
    ...CLIENT_OPTIONS,
    global: {
      ...CLIENT_OPTIONS.global,
      headers: { ...CLIENT_OPTIONS.global.headers, Authorization: `Bearer ${accessToken}` },
    },
  });
}

export function isPublicConfigured() {
  return Boolean(env.supabaseUrl && env.anonKey);
}

export function isAdminReady() {
  return Boolean(env.supabaseUrl && env.serviceRoleKey);
}
