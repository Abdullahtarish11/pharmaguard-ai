const clean = (value) => (typeof value === 'string' ? value.trim() : '');

function firstNonEmpty(...values) {
  for (const value of values) {
    const v = clean(value);
    if (v) return v;
  }
  return '';
}

export const env = {
  port: Number(process.env.PORT || 3000),
  supabaseUrl: firstNonEmpty(
    process.env.SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ).replace(/\/+$/, ''),
  anonKey: firstNonEmpty(
    process.env.SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_ANON_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
  serviceRoleKey: firstNonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY),
  bootstrapToken: firstNonEmpty(process.env.OWNER_BOOTSTRAP_TOKEN),
  agentCronSecret: firstNonEmpty(process.env.AGENT_CRON_SECRET, process.env.CRON_SECRET),
  agentSweepIntervalHours: (() => {
    const parsed = Number(process.env.AGENT_SWEEP_INTERVAL_HOURS || 6);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 24 ? parsed : 6;
  })(),
};

/** الحالة العامة للتكوين — لا تحتوي أي قيمة سرية. */
export function configState() {
  return {
    supabaseUrl: env.supabaseUrl,
    anonKeyPresent: Boolean(env.anonKey),
    serviceRolePresent: Boolean(env.serviceRoleKey),
    bootstrapTokenPresent: Boolean(env.bootstrapToken),
    agentCronSecretPresent: Boolean(env.agentCronSecret),
    agentSweepIntervalHours: env.agentSweepIntervalHours,
    ready: Boolean(env.supabaseUrl && env.anonKey && env.serviceRoleKey),
  };
}

export function missingConfigKeys() {
  const missing = [];
  if (!env.supabaseUrl) missing.push('SUPABASE_URL');
  if (!env.anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!env.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return missing;
}
