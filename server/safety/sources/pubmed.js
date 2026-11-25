/**
 * موصل PubMed العلمي الرسمي (NCBI E-utilities):
 * - يبحث في الأبحاث المحكّمة والنشرات الطبية عن التداخلات الدوائية بين مادتين فعالتين.
 * - يلتزم بمعدل طلبات NCBI بدون مفتاح (تنظيم تسلسلي بفاصل ≥ 350ms).
 * - يعيد العنوان الأصلي، المجلة، تاريخ النشر، رابط PMID الموثق، ومقتطف الخلاصة عند توفره.
 */

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const CACHE_TTL_MS = 12 * 3600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_SPACING_MS = 380;

const cache = new Map();
let lastRequestAt = 0;

export function clearPubMedCache() {
  cache.clear();
}

async function waitForRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < MIN_SPACING_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_SPACING_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function fetchPubMedJson(url, fetchImpl = fetch) {
  if (fetchImpl === fetch) await waitForRateLimit();
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`);
  return res.json();
}

async function fetchPubMedText(url, fetchImpl = fetch) {
  if (fetchImpl === fetch) await waitForRateLimit();
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/xml, text/xml', 'User-Agent': 'PharmaGuardAI/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`);
  return res.text();
}

function parseAbstractsFromXml(xml) {
  const map = new Map();
  const articleBlocks = String(xml ?? '').match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) ?? [];
  for (const block of articleBlocks) {
    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    if (!pmidMatch) continue;
    const pmid = pmidMatch[1];
    const absParts = [...block.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    if (absParts.length > 0) {
      const text = absParts.join(' ');
      map.set(pmid, text.length > 650 ? `${text.slice(0, 650)}…` : text);
    }
  }
  return map;
}

/**
 * يبحث عن دراسات وتقارير تداخل موثقة بين دوائين في PubMed.
 */
export async function searchPubMedInteraction(
  drugA,
  drugB,
  { fetchImpl = fetch, maxResults = 3, mode = 'strict' } = {},
) {
  const a = String(drugA ?? '').trim();
  const b = String(drugB ?? '').trim();
  if (!a || !b) {
    return {
      ok: false,
      source: 'PubMed',
      issuer: 'NCBI PubMed (National Library of Medicine)',
      totalCount: 0,
      articles: [],
      error: 'يجب تمرير اسمي الدوائين للبحث في PubMed.',
      retrievedAt: new Date().toISOString(),
    };
  }

  const normalizedMode = ['broad', 'clinical_review'].includes(mode) ? mode : 'strict';
  const pair = [a.toLowerCase(), b.toLowerCase()].sort();
  const cacheKey = `${normalizedMode}::${pair[0]}::${pair[1]}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && fetchImpl === fetch) {
    return cached.value;
  }

  const retrievedAt = new Date().toISOString();
  let term;
  if (normalizedMode === 'broad') {
    term = `("${a}"[All Fields] AND "${b}"[All Fields] AND (interaction[All Fields] OR coadministration[All Fields] OR pharmacokinetics[All Fields] OR toxicity[All Fields] OR adverse[All Fields]))`;
  } else if (normalizedMode === 'clinical_review') {
    term = `("${a}"[Title/Abstract] AND "${b}"[Title/Abstract] AND ("clinical"[Title/Abstract] OR "systematic review"[Publication Type] OR "case reports"[Publication Type] OR "pharmacokinetics"[MeSH Terms] OR "drug interactions"[MeSH Terms]))`;
  } else {
    term = `("${a}"[Title/Abstract] AND "${b}"[Title/Abstract] AND ("drug interactions"[MeSH Terms] OR interaction[Title/Abstract] OR contraindicated[Title/Abstract] OR rhabdomyolysis[Title/Abstract] OR toxicity[Title/Abstract]))`;
  }
  const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json&retmax=${maxResults}&sort=relevance`;

  try {
    const searchRes = await fetchPubMedJson(searchUrl, fetchImpl);
    const idList = Array.isArray(searchRes?.esearchresult?.idlist) ? searchRes.esearchresult.idlist : [];
    const totalCount = Number(searchRes?.esearchresult?.count ?? 0) || 0;

    if (idList.length === 0) {
      const empty = {
        ok: true,
        source: 'PubMed',
        mode: normalizedMode,
        issuer: 'NCBI PubMed (National Library of Medicine)',
        totalCount: 0,
        articles: [],
        evidenceDirection: 'none',
        sourceUrl: searchUrl,
        retrievedAt,
        error: null,
      };
      if (fetchImpl === fetch) cache.set(cacheKey, { at: Date.now(), value: empty });
      return empty;
    }

    const idsParam = idList.slice(0, maxResults).join(',');
    const summaryUrl = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(idsParam)}&retmode=json`;
    const summaryRes = await fetchPubMedJson(summaryUrl, fetchImpl);

    let abstracts = new Map();
    try {
      const efetchUrl = `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(idList.slice(0, 2).join(','))}&retmode=xml`;
      const xml = await fetchPubMedText(efetchUrl, fetchImpl);
      abstracts = parseAbstractsFromXml(xml);
    } catch {
      // تبقى الملخصات الببليوغرافية صالحة حتى لو تعذر جلب نص الخلاصة
    }

    const resultMap = summaryRes?.result ?? {};
    const articles = idList
      .map((pmid) => {
        const item = resultMap[pmid];
        if (!item) return null;
        return {
          pmid: String(pmid),
          title: String(item.title ?? '').trim(),
          journal: item.fulljournalname || item.source || 'PubMed Indexed Journal',
          publishedDate: item.pubdate || item.epubdate || null,
          sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          abstractExcerpt: abstracts.get(String(pmid)) ?? null,
        };
      })
      .filter(Boolean);

    const combinedText = articles
      .map((art) => `${art.title} ${art.abstractExcerpt ?? ''}`)
      .join(' ')
      .toLowerCase();

    const hasNegation = /\bno\s+(?:significant|clinically\s+relevant)\s+interaction\b|\bdoes\s+not\s+interact\b/i.test(
      combinedText,
    );
    const hasPositiveInteraction =
      /\binteraction\b|\bcontraindicated\b|\brhabdomyolysis\b|\bmyopathy\b|\btoxicity\b|\bbleeding\b|\bclearance\b|\bcyp3a4\b|\bplasma\s+concentration\b/i.test(
        combinedText,
      );

    let evidenceDirection = 'inconclusive';
    if (hasPositiveInteraction && !hasNegation) evidenceDirection = 'supports_interaction';
    else if (hasNegation && !hasPositiveInteraction) evidenceDirection = 'reports_no_interaction';
    else if (hasPositiveInteraction && hasNegation) evidenceDirection = 'mixed';

    const out = {
      ok: true,
      source: 'PubMed',
      issuer: 'NCBI PubMed (National Library of Medicine)',
      totalCount,
      articles,
      evidenceDirection,
      sourceUrl: articles[0]?.sourceUrl || searchUrl,
      retrievedAt,
      error: null,
    };

    if (fetchImpl === fetch) cache.set(cacheKey, { at: Date.now(), value: out });
    return out;
  } catch (error) {
    return {
      ok: false,
      source: 'PubMed',
      issuer: 'NCBI PubMed (National Library of Medicine)',
      totalCount: 0,
      articles: [],
      evidenceDirection: 'unavailable',
      sourceUrl: searchUrl,
      retrievedAt,
      error: error?.name === 'TimeoutError' ? 'انتهت مهلة الاتصال بـ PubMed' : String(error?.message ?? error),
    };
  }
}
