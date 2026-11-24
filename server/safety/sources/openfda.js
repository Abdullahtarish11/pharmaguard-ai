/**
 * موصل openFDA الرسمي لنشرات الأدوية (Drug Product Labeling):
 * - يقرأ نشرات الأدوية الرسمية، تحذيرات الصندوق الأسود، موانع الاستعمال، التداخلات الدوائية،
 *   تحذيرات الجرعة، العمر، الحالات الصحية، والحساسية.
 * - يستخرج النص الأصلي كما ورد في النشرة دون اختلاق مع تاريخ الاعتماد ورابط DailyMed/openFDA.
 */

const OPENFDA_LABEL_URL = 'https://api.fda.gov/drug/label.json';
const CACHE_TTL_MS = 12 * 3600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const cache = new Map();

export function clearOpenFdaCache() {
  cache.clear();
}

function formatEffectiveTime(raw) {
  const s = String(raw ?? '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s || null;
}

function firstText(arr, maxLen = 4000) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const joined = arr.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n');
  if (!joined) return null;
  return joined.length > maxLen ? `${joined.slice(0, maxLen)}…` : joined;
}

function extractSentencesMatching(text, terms = [], maxSnippets = 3) {
  if (!text || !terms.length) return [];
  const normalizedTerms = terms
    .map((t) => String(t ?? '').trim().toLowerCase())
    .filter((t) => t.length >= 3);
  if (!normalizedTerms.length) return [];

  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);

  const hits = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (normalizedTerms.some((term) => lower.includes(term))) {
      hits.push(sentence.length > 420 ? `${sentence.slice(0, 420)}…` : sentence);
      if (hits.length >= maxSnippets) break;
    }
  }
  return hits;
}

async function queryOpenFdaUrl(searchExpr, fetchImpl = fetch) {
  const apiUrl = `${OPENFDA_LABEL_URL}?search=${encodeURIComponent(searchExpr)}&limit=3`;
  const response = await fetchImpl(apiUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 404) {
    return { ok: true, found: false, apiUrl, results: [] };
  }
  if (!response.ok) {
    const err = new Error(`openFDA HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return { ok: true, found: results.length > 0, apiUrl, results };
}

function shapeLabel(raw, apiUrl) {
  const openfda = raw?.openfda ?? {};
  const setId = raw?.set_id ?? openfda?.spl_set_id?.[0] ?? null;
  return {
    setId,
    effectiveTime: formatEffectiveTime(raw?.effective_time),
    brandNames: Array.isArray(openfda.brand_name) ? openfda.brand_name : [],
    genericNames: Array.isArray(openfda.generic_name) ? openfda.generic_name : [],
    substanceNames: Array.isArray(openfda.substance_name) ? openfda.substance_name : [],
    rxcuis: Array.isArray(openfda.rxcui) ? openfda.rxcui : [],
    manufacturer: openfda.manufacturer_name?.[0] ?? null,
    issuer: 'U.S. FDA / openFDA Drug Label',
    apiUrl,
    dailyMedUrl: setId ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}` : null,
    sections: {
      boxedWarning: firstText(raw?.boxed_warning, 3500),
      contraindications: firstText(raw?.contraindications, 4000),
      drugInteractions: firstText(raw?.drug_interactions, 8000),
      warningsAndCautions: firstText(raw?.warnings_and_cautions ?? raw?.warnings, 4000),
      dosageAndAdministration: firstText(raw?.dosage_and_administration, 3000),
      useInSpecificPopulations: firstText(raw?.use_in_specific_populations, 3000),
      pregnancy: firstText(raw?.pregnancy, 2000),
      pediatricUse: firstText(raw?.pediatric_use, 2000),
      geriatricUse: firstText(raw?.geriatric_use, 2000),
      nursingMothers: firstText(raw?.nursing_mothers, 1500),
      renalImpairment: firstText(raw?.renal_impairment, 1500),
      hepaticImpairment: firstText(raw?.hepatic_impairment, 1500),
    },
  };
}

/**
 * يبحث في openFDA عن النشرة الرسمية للدواء باستخدام RxCUI أو الاسم العلمي أو التجاري.
 */
export async function fetchOpenFdaLabel(
  { rxcui = null, genericName = null, brandName = null } = {},
  { fetchImpl = fetch } = {},
) {
  const cleanGeneric = String(genericName ?? '').trim().replace(/"/g, '');
  const cleanBrand = String(brandName ?? '').trim().replace(/"/g, '');
  const cleanRxcui = rxcui ? String(rxcui).trim().replace(/"/g, '') : null;

  const cacheKey = `${cleanRxcui ?? ''}|${cleanGeneric.toLowerCase()}|${cleanBrand.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && fetchImpl === fetch) {
    return cached.value;
  }

  const retrievedAt = new Date().toISOString();
  const attempts = [];
  if (cleanGeneric) attempts.push(`openfda.generic_name:"${cleanGeneric}"`);
  if (cleanRxcui) attempts.push(`openfda.rxcui:"${cleanRxcui}"`);
  if (cleanBrand) attempts.push(`openfda.brand_name:"${cleanBrand}"`);
  if (cleanGeneric && cleanGeneric.includes(' ')) {
    attempts.push(`openfda.substance_name:"${cleanGeneric}"`);
  }

  if (attempts.length === 0) {
    return {
      ok: false,
      source: 'openFDA',
      found: false,
      labels: [],
      retrievedAt,
      error: 'لم يُمرّر اسم دواء أو RxCUI للاستعلام في openFDA.',
    };
  }

  try {
    let lastApiUrl = null;
    for (const expr of attempts) {
      const res = await queryOpenFdaUrl(expr, fetchImpl);
      lastApiUrl = res.apiUrl;
      if (res.found && res.results.length > 0) {
        const labels = res.results.map((r) => shapeLabel(r, res.apiUrl));
        const output = {
          ok: true,
          source: 'openFDA',
          issuer: 'U.S. FDA / openFDA Drug Label',
          found: true,
          labels,
          primaryLabel: labels[0],
          sourceUrl: labels[0].dailyMedUrl || res.apiUrl,
          apiUrl: res.apiUrl,
          retrievedAt,
          error: null,
        };
        if (fetchImpl === fetch) cache.set(cacheKey, { at: Date.now(), value: output });
        return output;
      }
    }

    const notFound = {
      ok: true,
      source: 'openFDA',
      issuer: 'U.S. FDA / openFDA Drug Label',
      found: false,
      labels: [],
      primaryLabel: null,
      sourceUrl: lastApiUrl,
      apiUrl: lastApiUrl,
      retrievedAt,
      error: null,
    };
    if (fetchImpl === fetch) cache.set(cacheKey, { at: Date.now(), value: notFound });
    return notFound;
  } catch (error) {
    return {
      ok: false,
      source: 'openFDA',
      issuer: 'U.S. FDA / openFDA Drug Label',
      found: false,
      labels: [],
      primaryLabel: null,
      sourceUrl: OPENFDA_LABEL_URL,
      retrievedAt,
      error: error?.name === 'TimeoutError' ? 'انتهت مهلة الاتصال بـ openFDA' : String(error?.message ?? error),
    };
  }
}

/**
 * يتحقق مما إذا كانت نشرة openFDA تذكر الدواء الآخر في أقسام التداخلات أو موانع الاستعمال أو الصندوق الأسود.
 */
export function extractInteractionEvidenceFromLabel(label, targetTerms = []) {
  if (!label?.sections || !targetTerms.length) return null;
  const { boxedWarning, contraindications, drugInteractions, warningsAndCautions } = label.sections;

  const hitsContra = extractSentencesMatching(contraindications, targetTerms, 2);
  const hitsBoxed = extractSentencesMatching(boxedWarning, targetTerms, 2);
  const hitsInteractions = extractSentencesMatching(drugInteractions, targetTerms, 3);
  const hitsWarnings = extractSentencesMatching(warningsAndCautions, targetTerms, 2);

  const allHits = [...hitsContra, ...hitsBoxed, ...hitsInteractions, ...hitsWarnings];
  if (allHits.length === 0) {
    return {
      mentioned: false,
      negated: false,
      severity: null,
      section: null,
      snippets: [],
    };
  }

  const combinedLower = allHits.join(' ').toLowerCase();
  const negated =
    /\bno\s+clinically\s+significant\s+(?:drug\s+)?interaction\b/i.test(combinedLower) ||
    /\bdid\s+not\s+(?:significantly\s+)?(?:affect|alter|interact)\b/i.test(combinedLower) ||
    /\bno\s+interaction\s+(?:was\s+)?observed\b/i.test(combinedLower);

  let severity = null;
  let section = 'drug_interactions';
  if (hitsContra.length > 0) section = 'contraindications';
  else if (hitsBoxed.length > 0) section = 'boxed_warning';
  else if (hitsInteractions.length > 0) section = 'drug_interactions';
  else section = 'warnings_and_cautions';

  if (!negated) {
    if (
      hitsContra.length > 0 ||
      /\bcontraindicated\b|\bdo\s+not\s+(?:use|coadminister|administer)\b|\bconcomitant\s+use\s+is\s+contraindicated\b/i.test(
        combinedLower,
      )
    ) {
      severity = 'contraindicated';
    } else if (
      hitsBoxed.length > 0 ||
      /\bavoid\s+(?:concomitant|coadministration|use)\b|\brhabdomyolysis\b|\bmyopathy\b|\bfatal\b|\blife-threatening\b|\bsevere\b|\bbleeding\b|\bhemorrhage\b|\bqt\s+prolongation\b|\brespiratory\s+depression\b|\bserotonin\s+syndrome\b|\bhyperkalemia\b/i.test(
        combinedLower,
      )
    ) {
      severity = 'major';
    } else if (
      /\bdose\s+(?:adjustment|reduction|limit|limitation)\b|\bincreas(?:e|es|ed)\s+(?:plasma|auc|exposure|concentration|levels)\b|\bmonitor\b/i.test(
        combinedLower,
      )
    ) {
      severity = 'moderate';
    }
  }

  return {
    mentioned: true,
    negated,
    severity,
    section,
    snippets: allHits.slice(0, 3),
    sourceUrl: label.dailyMedUrl || label.apiUrl,
    publishedDate: label.effectiveTime,
    issuer: label.issuer,
  };
}

/**
 * يستخرج التحذيرات الموثقة من النشرة: الصندوق الأسود، الجرعة، العمر، الحالة الصحية، الحساسية.
 */
export function extractClinicalWarningsFromLabel(label) {
  if (!label?.sections) return [];
  const s = label.sections;
  const warnings = [];
  const citation = {
    sourceName: 'openFDA',
    issuer: label.issuer,
    sourceUrl: label.dailyMedUrl || label.apiUrl,
    publishedDate: label.effectiveTime,
  };

  if (s.boxedWarning) {
    warnings.push({
      category: 'boxed_warning',
      categoryLabel: 'تحذير الصندوق الأسود (Boxed Warning)',
      severity: 'critical',
      originalText: s.boxedWarning.slice(0, 600),
      ...citation,
    });
  }

  if (s.contraindications) {
    const allergyHits = extractSentencesMatching(
      s.contraindications,
      ['hypersensitivity', 'allergy', 'allergic', 'anaphylaxis', 'angioedema'],
      2,
    );
    warnings.push({
      category: allergyHits.length > 0 ? 'allergy' : 'contraindication',
      categoryLabel: allergyHits.length > 0 ? 'تحذير الحساسية وموانع الاستعمال' : 'موانع الاستعمال الموثقة',
      severity: 'high',
      originalText: (allergyHits[0] || s.contraindications).slice(0, 600),
      ...citation,
    });
  }

  if (s.dosageAndAdministration) {
    const doseHits = extractSentencesMatching(
      s.dosageAndAdministration,
      ['maximum', 'not exceed', 'do not exceed', 'limit', 'initial dose', 'recommended dosage', 'renal', 'hepatic'],
      2,
    );
    if (doseHits.length > 0) {
      warnings.push({
        category: 'dose',
        categoryLabel: 'ضوابط وحدود الجرعة الموثقة',
        severity: 'moderate',
        originalText: doseHits.join(' ').slice(0, 600),
        ...citation,
      });
    }
  }

  const ageText = [s.pediatricUse, s.geriatricUse].filter(Boolean).join(' ');
  if (ageText) {
    const ageHits = extractSentencesMatching(
      ageText,
      ['safety', 'not established', 'pediatric', 'elderly', 'geriatric', 'age', 'years'],
      2,
    );
    if (ageHits.length > 0) {
      warnings.push({
        category: 'age',
        categoryLabel: 'تحذيرات العمر والفئات العمرية',
        severity: 'moderate',
        originalText: ageHits.join(' ').slice(0, 600),
        ...citation,
      });
    }
  }

  const conditionText = [s.pregnancy, s.nursingMothers, s.renalImpairment, s.hepaticImpairment, s.useInSpecificPopulations]
    .filter(Boolean)
    .join(' ');
  if (conditionText) {
    const condHits = extractSentencesMatching(
      conditionText,
      ['pregnancy', 'lactation', 'breastfeeding', 'renal', 'hepatic', 'liver', 'kidney', 'contraindicated', 'fetal'],
      2,
    );
    if (condHits.length > 0) {
      warnings.push({
        category: 'condition',
        categoryLabel: 'تحذيرات الحالة الصحية (الحمل/الرضاعة/الكلى/الكبد)',
        severity: /contraindicated|fetal\s+harm|boxed/i.test(condHits.join(' ')) ? 'high' : 'moderate',
        originalText: condHits.join(' ').slice(0, 600),
        ...citation,
      });
    }
  }

  return warnings;
}
