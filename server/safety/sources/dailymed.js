/**
 * موصل DailyMed الرسمي (U.S. National Library of Medicine v2 REST API):
 * - يبحث عن النشرات الدوائية الرسمية المعتمدة (SPL) بالاسم أو RxCUI.
 * - يستخرج أقسام التداخلات وموانع الاستعمال والتحذيرات من ملف SPL XML الرسمي عند الحاجة للتحقق المستقل.
 */

const DAILYMED_BASE = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';
const CACHE_TTL_MS = 12 * 3600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const cache = new Map();

const LOINC_SECTIONS = Object.freeze({
  boxedWarning: '34066-1',
  contraindications: '34070-3',
  drugInteractions: '34073-7',
  warningsAndPrecautions: '43685-7',
  dosageAndAdministration: '34068-7',
});

export function clearDailyMedCache() {
  cache.clear();
}

function stripXml(xml) {
  return String(xml ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLoincSectionText(xml, loincCode, maxLen = 4000) {
  if (!xml || !loincCode) return null;
  const codePattern = new RegExp(
    `<code[^>]*code=["']${loincCode}["'][^>]*>[\\s\\S]{0,6000}?(?=<\\/section>)`,
    'i',
  );
  const match = String(xml).match(codePattern);
  if (!match) return null;
  const text = stripXml(match[0]);
  if (!text) return null;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/**
 * يستعلم عن أحدث نشرة SPL في DailyMed ويستخرج أقسامها السريرية الموثقة.
 */
export async function fetchDailyMedSpl(
  { drugName = null, rxcui = null, fetchXml = true } = {},
  { fetchImpl = fetch } = {},
) {
  const cleanName = String(drugName ?? '').trim();
  const cleanRxcui = rxcui ? String(rxcui).trim() : null;
  if (!cleanName && !cleanRxcui) {
    return {
      ok: false,
      source: 'DailyMed',
      issuer: 'U.S. National Library of Medicine (DailyMed SPL)',
      found: false,
      error: 'اسم الدواء أو RxCUI مطلوب للبحث في DailyMed.',
      retrievedAt: new Date().toISOString(),
    };
  }

  const key = `${cleanRxcui ?? ''}|${cleanName.toLowerCase()}|${fetchXml ? 'xml' : 'meta'}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && fetchImpl === fetch) {
    return cached.value;
  }

  const retrievedAt = new Date().toISOString();
  const listUrl = cleanName
    ? `${DAILYMED_BASE}/spls.json?drug_name=${encodeURIComponent(cleanName)}&pagesize=2`
    : `${DAILYMED_BASE}/spls.json?rxcui=${encodeURIComponent(cleanRxcui)}&pagesize=2`;

  try {
    const res = await fetchImpl(listUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`DailyMed HTTP ${res.status}`);
    }

    const json = await res.json();
    const items = Array.isArray(json?.data) ? json.data : [];

    // محاولة احتياطية بـ rxcui إذا لم يعد drug_name نتائج
    if (items.length === 0 && cleanName && cleanRxcui) {
      const byRxUrl = `${DAILYMED_BASE}/spls.json?rxcui=${encodeURIComponent(cleanRxcui)}&pagesize=2`;
      const rxRes = await fetchImpl(byRxUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (rxRes.ok) {
        const rxJson = await rxRes.json();
        if (Array.isArray(rxJson?.data)) items.push(...rxJson.data);
      }
    }

    if (items.length === 0) {
      const miss = {
        ok: true,
        source: 'DailyMed',
        issuer: 'U.S. National Library of Medicine (DailyMed SPL)',
        found: false,
        setId: null,
        title: null,
        publishedDate: null,
        sourceUrl: listUrl,
        sections: null,
        retrievedAt,
        error: null,
      };
      if (fetchImpl === fetch) cache.set(key, { at: Date.now(), value: miss });
      return miss;
    }

    const top = items[0];
    const setId = top.setid;
    const sourceUrl = `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}`;
    let sections = null;

    if (fetchXml && setId) {
      try {
        const xmlRes = await fetchImpl(`${DAILYMED_BASE}/spls/${encodeURIComponent(setId)}.xml`, {
          headers: { Accept: 'application/xml, text/xml', 'User-Agent': 'PharmaGuardAI/1.0' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (xmlRes.ok) {
          const xmlText = await xmlRes.text();
          sections = {
            boxedWarning: extractLoincSectionText(xmlText, LOINC_SECTIONS.boxedWarning, 2500),
            contraindications: extractLoincSectionText(xmlText, LOINC_SECTIONS.contraindications, 3500),
            drugInteractions: extractLoincSectionText(xmlText, LOINC_SECTIONS.drugInteractions, 6000),
            warningsAndPrecautions: extractLoincSectionText(xmlText, LOINC_SECTIONS.warningsAndPrecautions, 3500),
            dosageAndAdministration: extractLoincSectionText(xmlText, LOINC_SECTIONS.dosageAndAdministration, 2500),
          };
        }
      } catch {
        // نبقي بيانات SPL التعريفية حتى لو تعذر تنزيل XML الكبير
      }
    }

    const found = {
      ok: true,
      source: 'DailyMed',
      issuer: 'U.S. National Library of Medicine (DailyMed SPL)',
      found: true,
      setId,
      title: top.title ?? null,
      publishedDate: top.published_date ?? null,
      splVersion: top.spl_version ?? null,
      sourceUrl,
      apiUrl: listUrl,
      sections,
      retrievedAt,
      error: null,
    };

    if (fetchImpl === fetch) cache.set(key, { at: Date.now(), value: found });
    return found;
  } catch (error) {
    return {
      ok: false,
      source: 'DailyMed',
      issuer: 'U.S. National Library of Medicine (DailyMed SPL)',
      found: false,
      setId: null,
      title: null,
      publishedDate: null,
      sourceUrl: listUrl,
      sections: null,
      retrievedAt,
      error: error?.name === 'TimeoutError' ? 'انتهت مهلة الاتصال بـ DailyMed' : String(error?.message ?? error),
    };
  }
}

export function extractInteractionFromDailyMed(spl, targetTerms = []) {
  if (!spl?.sections || !targetTerms.length) return null;
  const normalizedTerms = targetTerms.map((t) => String(t ?? '').trim().toLowerCase()).filter((t) => t.length >= 3);
  if (!normalizedTerms.length) return null;

  const checkSection = (text) => {
    if (!text) return [];
    const sentences = String(text).split(/(?<=[.!?])\s+/).filter((s) => s.length >= 12);
    return sentences
      .filter((s) => normalizedTerms.some((term) => s.toLowerCase().includes(term)))
      .slice(0, 2)
      .map((s) => (s.length > 380 ? `${s.slice(0, 380)}…` : s));
  };

  const contraHits = checkSection(spl.sections.contraindications);
  const boxedHits = checkSection(spl.sections.boxedWarning);
  const interHits = checkSection(spl.sections.drugInteractions);
  const warnHits = checkSection(spl.sections.warningsAndPrecautions);

  const snippets = [...contraHits, ...boxedHits, ...interHits, ...warnHits].slice(0, 3);
  if (!snippets.length) return { mentioned: false, negated: false, severity: null, snippets: [] };

  const joined = snippets.join(' ').toLowerCase();
  const negated = /\bno\s+clinically\s+significant\b|\bdid\s+not\s+affect\b|\bno\s+interaction\b/i.test(joined);
  let severity = null;
  if (!negated) {
    if (contraHits.length > 0 || /\bcontraindicated\b|\bdo\s+not\s+(?:use|coadminister)\b/i.test(joined)) {
      severity = 'contraindicated';
    } else if (boxedHits.length > 0 || /\bavoid\b|\brhabdomyolysis\b|\bmyopathy\b|\bfatal\b|\bsevere\b/i.test(joined)) {
      severity = 'major';
    } else if (interHits.length > 0 || warnHits.length > 0) {
      severity = 'moderate';
    }
  }

  return {
    mentioned: true,
    negated,
    severity,
    snippets,
    sourceUrl: spl.sourceUrl,
    publishedDate: spl.publishedDate,
    issuer: spl.issuer,
  };
}
