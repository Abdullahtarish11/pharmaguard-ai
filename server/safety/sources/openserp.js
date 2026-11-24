/**
 * موصل محرك البحث المفتوح المصدر: OpenSERP (أساسي) مع SearXNG (بديل).
 *
 * الضوابط الصارمة:
 * 1) لا يفترض تشغيل OpenSERP أو SearXNG دون ضبط OPENSERP_URL أو SEARXNG_URL.
 * 2) يدعم البحث المتعدد بالعربية والإنجليزية.
 * 3) يجلب صفحات المصادر الأصلية (HTML -> Text) بدل الاكتفاء بالمقتطفات، مع حماية SSRF كاملة.
 * 4) يرتّب النتائج حسب درجة الموثوقية (هيئات صحية رسمية > مجلات محكّمة > ويب عام).
 * 5) لا تُعتبر نتائج الويب العام أدلة طبية معتمدة تلقائيًا (clinicallyCertified = false).
 * 6) يعيد المحاولة مع تراجع أسي عند التأخر أو الأعطال المؤقتة.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { env } from '../../env.js';
import { OPENSERP_HOSTING_REQUIREMENTS } from '../constants.js';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 512 * 1024;

const OFFICIAL_DOMAIN_PATTERNS = [
  /(?:^|\.)fda\.gov$/i,
  /(?:^|\.)nlm\.nih\.gov$/i,
  /(?:^|\.)nih\.gov$/i,
  /(?:^|\.)who\.int$/i,
  /(?:^|\.)ema\.europa\.eu$/i,
  /(?:^|\.)sfda\.gov\.sa$/i,
  /(?:^|\.)moh\.gov\.sa$/i,
  /(?:^|\.)jfda\.jo$/i,
  /(?:^|\.)edaegypt\.gov\.eg$/i,
  /(?:^|\.)sbdma\.gov\.ye$/i,
  /(?:^|\.)gov\.uk$/i,
  /(?:^|\.)nhs\.uk$/i,
  /\.gov$/i,
];

const PEER_REVIEWED_PATTERNS = [
  /(?:^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/i,
  /(?:^|\.)pmc\.ncbi\.nlm\.nih\.gov$/i,
  /(?:^|\.)cochranelibrary\.com$/i,
  /(?:^|\.)nejm\.org$/i,
  /(?:^|\.)thelancet\.com$/i,
  /(?:^|\.)bmj\.com$/i,
  /(?:^|\.)jamanetwork\.com$/i,
  /(?:^|\.)nature\.com$/i,
  /(?:^|\.)sciencedirect\.com$/i,
  /(?:^|\.)springer\.com$/i,
  /(?:^|\.)wiley\.com$/i,
  /(?:^|\.)doi\.org$/i,
];

function isPrivateIpAddress(ip) {
  if (!ip) return true;
  const clean = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    const lower = clean.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    return false;
  }
  return true;
}

/**
 * يتحقق من أن الرابط http/https عام ولا يشير إلى شبكة محلية أو ميتاداتا سحابية (حماية SSRF).
 */
export async function validateSafePublicUrl(rawUrl, { resolveDns = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return { safe: false, reason: 'invalid_url' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, reason: 'unsupported_protocol' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { safe: false, reason: 'local_host_blocked' };
  }

  if (net.isIP(host)) {
    if (isPrivateIpAddress(host)) return { safe: false, reason: 'private_ip_blocked' };
    return { safe: true, url: parsed.toString(), host };
  }

  if (resolveDns) {
    try {
      const records = await dns.lookup(host, { all: true });
      if (!records.length || records.some((r) => isPrivateIpAddress(r.address))) {
        return { safe: false, reason: 'private_dns_blocked' };
      }
    } catch {
      return { safe: false, reason: 'dns_lookup_failed' };
    }
  }

  return { safe: true, url: parsed.toString(), host };
}

export function classifySourceReliability(rawUrl) {
  let host = '';
  try {
    host = new URL(String(rawUrl)).hostname.toLowerCase();
  } catch {
    return {
      tier: 'general_web',
      tierLabel: 'ويب عام (غير معتمد سريريًا)',
      score: 10,
      clinicallyCertified: false,
    };
  }

  if (OFFICIAL_DOMAIN_PATTERNS.some((p) => p.test(host))) {
    return {
      tier: 'official_authority',
      tierLabel: 'جهة صحية/تنظيمية رسمية',
      score: 100,
      clinicallyCertified: true,
    };
  }
  if (PEER_REVIEWED_PATTERNS.some((p) => p.test(host))) {
    return {
      tier: 'peer_reviewed',
      tierLabel: 'بحث علمي / مجلة طبية محكّمة',
      score: 85,
      clinicallyCertified: true,
    };
  }

  return {
    tier: 'general_web',
    tierLabel: 'نتيجة ويب عامة — غير معتمدة تلقائيًا',
    score: 20,
    clinicallyCertified: false,
  };
}

function htmlToReadableText(html) {
  const titleMatch = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;

  const dateMatch =
    String(html).match(/<meta[^>]+(?:name|property)=["'](?:article:published_time|date|DC\.Date|dcterms\.modified)["'][^>]+content=["']([^"']+)["']/i) ||
    String(html).match(/<time[^>]+datetime=["']([^"']+)["']/i);
  const publishedDate = dateMatch ? dateMatch[1].trim() : null;

  const body = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title,
    publishedDate,
    excerpt: body.length > 2200 ? `${body.slice(0, 2200)}…` : body,
  };
}

async function withRetries(fn, { retries = 2, baseDelayMs = 400 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * يجلب صفحة المصدر الأصلية ويستخرج نصها وتاريخ نشرها (بدل الاكتفاء بمقتطف محرك البحث).
 */
export async function fetchOriginalSourcePage(url, { fetchImpl = fetch, resolveDns = true } = {}) {
  const check = await validateSafePublicUrl(url, { resolveDns });
  if (!check.safe) {
    return { ok: false, url, error: `رابط محجوب أمنيًا (${check.reason})` };
  }

  try {
    return await withRetries(
      async () => {
        const res = await fetchImpl(check.url, {
          headers: {
            Accept: 'text/html, application/xhtml+xml, text/plain',
            'User-Agent': 'PharmaGuardAI-SafetyResearcher/1.0',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const raw = await res.text();
        const capped = raw.length > MAX_HTML_BYTES ? raw.slice(0, MAX_HTML_BYTES) : raw;
        const extracted = htmlToReadableText(capped);
        return {
          ok: true,
          url: check.url,
          title: extracted.title,
          publishedDate: extracted.publishedDate,
          excerpt: extracted.excerpt,
          fetchedAt: new Date().toISOString(),
        };
      },
      { retries: 1, baseDelayMs: 300 },
    );
  } catch (error) {
    return {
      ok: false,
      url: check.url,
      error: error?.name === 'TimeoutError' ? 'انتهت مهلة جلب صفحة المصدر' : String(error?.message ?? error),
    };
  }
}

async function queryOpenSerp(baseUrl, query, { fetchImpl = fetch, engines = 'google,duckduckgo,bing', limit = 6 } = {}) {
  const endpoint = `${baseUrl}/mega/search?text=${encodeURIComponent(query)}&engines=${encodeURIComponent(engines)}&limit=${limit}`;
  const res = await fetchImpl(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenSERP HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  return list
    .filter((item) => item?.url)
    .map((item) => ({
      title: String(item.title ?? '').trim(),
      url: String(item.url).trim(),
      snippet: String(item.description ?? item.snippet ?? '').trim(),
      engine: item.engine ?? 'openserp',
    }));
}

async function querySearXNG(baseUrl, query, { fetchImpl = fetch, language = 'all', limit = 6 } = {}) {
  const endpoint = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=${encodeURIComponent(language)}`;
  const res = await fetchImpl(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.results) ? data.results : [];
  return list
    .slice(0, limit)
    .filter((item) => item?.url)
    .map((item) => ({
      title: String(item.title ?? '').trim(),
      url: String(item.url).trim(),
      snippet: String(item.content ?? item.snippet ?? '').trim(),
      engine: item.engine ?? 'searxng',
    }));
}

function normalizeEngineUrl(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return trimmed;
  } catch {
    // رابط غير مكتمل/غير صالح يُعامل كغير مُعد دون افتراض رابط بديل
  }
  return '';
}

export function getSearchEngineConfigStatus({ openserpUrl = env.openserpUrl, searxngUrl = env.searxngUrl } = {}) {
  const cleanPrimary = normalizeEngineUrl(openserpUrl);
  const cleanFallback = normalizeEngineUrl(searxngUrl);
  const configuredPrimary = Boolean(cleanPrimary);
  const configuredFallback = Boolean(cleanFallback);
  const configured = configuredPrimary || configuredFallback;
  return {
    configured,
    mode: configured ? 'official_plus_web_search' : 'official_sources_only',
    primary: {
      name: 'OpenSERP',
      configured: configuredPrimary,
      status: configuredPrimary ? 'configured' : 'not_configured',
      statusLabel: configuredPrimary ? 'مُعد' : 'غير مُعد',
    },
    fallback: {
      name: 'SearXNG',
      configured: configuredFallback,
      status: configuredFallback ? 'configured' : 'not_configured',
      statusLabel: configuredFallback ? 'مُعد' : 'غير مُعد',
    },
    status: configured ? 'configured' : 'not_configured',
    statusLabel: configured ? 'مُعد' : 'غير مُعد',
    note: configured
      ? 'محرك البحث الشامل مفعّل إلى جانب المصادر الطبية الرسمية.'
      : 'غير مُعد — يعتمد الوكيل على المصادر الطبية الرسمية المدمجة فقط (RxNorm وopenFDA وDailyMed وPubMed).',
    hostingRequirements: OPENSERP_HOSTING_REQUIREMENTS,
  };
}

/**
 * بحث ويب طبي متعدد اللغات (العربية + الإنجليزية) عبر OpenSERP ثم SearXNG،
 * مع استخراج صفحات المصادر الأصلية وترتيب الموثوقية وعدم اعتماد الويب العام تلقائيًا.
 */
export async function searchMedicalWeb(
  { queries = [], fetchOriginalPages = true, maxPagesToFetch = 3 } = {},
  {
    openserpUrl = env.openserpUrl,
    searxngUrl = env.searxngUrl,
    fetchImpl = fetch,
    resolveDns = true,
  } = {},
) {
  const cleanOpenSerp = normalizeEngineUrl(openserpUrl);
  const cleanSearXNG = normalizeEngineUrl(searxngUrl);
  const cleanQueries = queries.map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, 4);

  if (!cleanOpenSerp && !cleanSearXNG) {
    return {
      ok: true,
      skipped: true,
      configured: false,
      engineUsed: null,
      status: 'not_configured',
      statusLabel: 'غير مُعد',
      results: [],
      error: null,
      note: 'محرك البحث الشامل غير مُعد (OPENSERP_URL / SEARXNG_URL غير محددين)؛ يتم الاعتماد على المصادر الطبية الرسمية المدمجة فقط.',
      hostingRequirements: OPENSERP_HOSTING_REQUIREMENTS,
      retrievedAt: new Date().toISOString(),
    };
  }

  if (cleanQueries.length === 0) {
    return {
      ok: false,
      skipped: false,
      configured: true,
      engineUsed: null,
      status: 'empty_query',
      results: [],
      error: 'لا توجد عبارات بحث صالحة.',
      retrievedAt: new Date().toISOString(),
    };
  }

  const collected = [];
  const seenUrls = new Set();
  const engineErrors = [];
  let engineUsed = null;

  for (const query of cleanQueries) {
    let rawResults = null;

    if (cleanOpenSerp) {
      try {
        rawResults = await withRetries(() => queryOpenSerp(cleanOpenSerp, query, { fetchImpl }), {
          retries: 1,
          baseDelayMs: 350,
        });
        engineUsed = 'OpenSERP';
      } catch (err) {
        engineErrors.push(`OpenSERP (${query}): ${err?.message ?? err}`);
      }
    }

    if (!rawResults && cleanSearXNG) {
      try {
        rawResults = await withRetries(() => querySearXNG(cleanSearXNG, query, { fetchImpl }), {
          retries: 1,
          baseDelayMs: 350,
        });
        engineUsed = 'SearXNG';
      } catch (err) {
        engineErrors.push(`SearXNG (${query}): ${err?.message ?? err}`);
      }
    }

    for (const item of rawResults ?? []) {
      const normalizedUrl = item.url.split('#')[0];
      if (seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);
      const reliability = classifySourceReliability(normalizedUrl);
      collected.push({
        ...item,
        url: normalizedUrl,
        query,
        ...reliability,
        pageExtracted: false,
        pageText: null,
        pageTitle: null,
        publishedDate: null,
        nonAuthoritativeNotice: reliability.clinicallyCertified
          ? null
          : 'نتيجة بحث ويب عام — لا تُعتمد تلقائيًا كدليل طبي موثق دون مراجعة مصدر رسمي.',
      });
    }
  }

  if (!engineUsed && engineErrors.length > 0) {
    return {
      ok: false,
      configured: true,
      engineUsed: null,
      status: 'unreachable',
      results: [],
      error: engineErrors.join(' | '),
      retrievedAt: new Date().toISOString(),
    };
  }

  // ترتيب حسب درجة الموثوقية ثم طول المقتطف
  collected.sort((a, b) => b.score - a.score || b.snippet.length - a.snippet.length);

  if (fetchOriginalPages && collected.length > 0) {
    const topItems = collected.slice(0, maxPagesToFetch);
    await Promise.allSettled(
      topItems.map(async (item) => {
        const page = await fetchOriginalSourcePage(item.url, { fetchImpl, resolveDns });
        if (page.ok) {
          item.pageExtracted = true;
          item.pageText = page.excerpt;
          item.pageTitle = page.title || item.title;
          item.publishedDate = page.publishedDate;
          item.fetchedAt = page.fetchedAt;
        } else {
          item.pageFetchError = page.error;
        }
      }),
    );
  }

  return {
    ok: true,
    configured: true,
    engineUsed,
    status: engineErrors.length > 0 ? 'degraded' : 'connected',
    results: collected,
    errors: engineErrors,
    retrievedAt: new Date().toISOString(),
  };
}
