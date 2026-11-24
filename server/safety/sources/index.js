/**
 * الطبقة الموحدة للوصول إلى المصادر الطبية الرسمية والبحثية:
 * الأولوية:
 * 1) RxNorm (توحيد الأسماء والمواد الفعالة)
 * 2) openFDA (نشرات الأدوية والتحذيرات والتداخلات)
 * 3) DailyMed (النشرات الرسمية SPL XML)
 * 4) PubMed (الأبحاث العلمية المحكّمة)
 * 5) OpenSERP / SearXNG (عند تفعيله — للبحث العام والعربي/الإنجليزي وبوابات SFDA/JFDA/EDA/SBDMA)
 *
 * المصادر المستبعدة صراحة:
 * - DDInter (ترخيص غير تجاري CC BY-NC-SA 4.0)
 * - DrugBank (قاعدة مدفوعة)
 */

import { normalizeBilingualDrugInput } from '../bilingual.js';
import { EXCLUDED_SOURCES, REGIONAL_AUTHORITY_PORTALS } from '../constants.js';
import { lookupRxNorm } from './rxnorm.js';
import { fetchOpenFdaLabel } from './openfda.js';
import { fetchDailyMedSpl } from './dailymed.js';
import { searchPubMedInteraction } from './pubmed.js';
import { getSearchEngineConfigStatus, searchMedicalWeb } from './openserp.js';

const sourceHealth = {
  rxnorm: { id: 'rxnorm', name: 'RxNorm (NLM)', status: 'ready', lastSuccessAt: null, lastError: null, requests: 0, failures: 0 },
  openfda: { id: 'openfda', name: 'openFDA Drug Labels', status: 'ready', lastSuccessAt: null, lastError: null, requests: 0, failures: 0 },
  dailymed: { id: 'dailymed', name: 'DailyMed SPL (NLM)', status: 'ready', lastSuccessAt: null, lastError: null, requests: 0, failures: 0 },
  pubmed: { id: 'pubmed', name: 'PubMed (NCBI E-utilities)', status: 'ready', lastSuccessAt: null, lastError: null, requests: 0, failures: 0 },
};

function trackSourceResult(sourceKey, res) {
  const entry = sourceHealth[sourceKey];
  if (!entry) return;
  entry.requests += 1;
  if (res?.ok) {
    entry.status = 'connected';
    entry.lastSuccessAt = new Date().toISOString();
    entry.lastError = null;
  } else {
    entry.failures += 1;
    entry.status = 'degraded';
    entry.lastError = res?.error ?? 'تعذر الوصول للمصدر';
  }
}

export function getSourcesTelemetry() {
  const searchEngine = getSearchEngineConfigStatus();
  return {
    officialSources: Object.values(sourceHealth).map((s) => ({ ...s })),
    searchEngine,
    regionalPortals: REGIONAL_AUTHORITY_PORTALS.map((portal) => ({
      ...portal,
      status: searchEngine.configured ? 'via_search_engine' : 'requires_openserp',
    })),
    excludedSources: EXCLUDED_SOURCES,
    aiModelsUsed: 'none (بدون Gemini أو أي نموذج مدفوع)',
  };
}

/**
 * يوحّد هوية دواء واحد (من الاسم التجاري والعلمي العربي/الإنجليزي) عبر RxNorm،
 * مع استخراج مواده الفعالة والتركيز والشكل الدوائي.
 */
export async function resolveMedicineIdentity(medicine, { fetchImpl = fetch } = {}) {
  const normalized = normalizeBilingualDrugInput(medicine);
  const candidates = normalized.englishCandidates;

  let rx = null;
  let rxAccessError = null;

  for (const term of candidates.slice(0, 3)) {
    const res = await lookupRxNorm(term, { fetchImpl });
    trackSourceResult('rxnorm', res);
    if (!res.ok) {
      rxAccessError = res.error;
      continue;
    }
    if (res.matched) {
      rx = res;
      break;
    }
  }

  const activeIngredients = [];
  const seenIng = new Set();

  if (rx?.activeIngredients?.length) {
    for (const ing of rx.activeIngredients) {
      const k = ing.name.toLowerCase();
      if (!seenIng.has(k)) {
        seenIng.add(k);
        activeIngredients.push(ing.name);
      }
    }
  } else if (rx?.canonicalName) {
    activeIngredients.push(rx.canonicalName);
    seenIng.add(rx.canonicalName.toLowerCase());
  }

  // احتفظ أيضًا بالمرشح العلمي الإنجليزي إذا لم يوجد في RxNorm
  if (activeIngredients.length === 0 && normalized.primaryQueryEn) {
    activeIngredients.push(normalized.primaryQueryEn);
  }

  const primaryIngredient = activeIngredients[0] ?? normalized.primaryQueryEn ?? normalized.originalName;

  const searchTerms = [
    ...new Set(
      [
        primaryIngredient,
        ...activeIngredients,
        ...normalized.englishCandidates,
      ]
        .map((x) => String(x ?? '').trim().toLowerCase())
        .filter((x) => x.length >= 3),
    ),
  ];

  return {
    medicineId: medicine?.id != null ? String(medicine.id) : null,
    originalName: normalized.originalName,
    originalScientificName: normalized.originalScientificName,
    strength: normalized.strength,
    dosageForm: normalized.dosageForm,
    arabicTerms: normalized.arabicTerms,
    englishCandidates: normalized.englishCandidates,
    rxnorm: rx
      ? {
          ok: true,
          matched: true,
          matchType: rx.matchType,
          rxcui: rx.rxcui,
          canonicalName: rx.canonicalName,
          tty: rx.tty,
          sourceUrl: rx.sourceUrl,
          retrievedAt: rx.retrievedAt,
        }
      : {
          ok: !rxAccessError,
          matched: false,
          rxcui: null,
          canonicalName: null,
          error: rxAccessError,
        },
    activeIngredients,
    primaryIngredient,
    searchTerms,
  };
}

/**
 * يجمع أدلة التداخل والتحذيرات لدواء واحد من openFDA وDailyMed (مع إمكانية البحث المفتوح عند التفعيل).
 */
export async function fetchDrugMonographs(identity, { fetchImpl = fetch, includeDailyMedXml = true } = {}) {
  const genericName = identity?.primaryIngredient || identity?.englishCandidates?.[0] || null;
  const brandName = identity?.originalName || null;
  const rxcui = identity?.rxnorm?.rxcui || null;

  const [fdaRes, dmRes] = await Promise.all([
    fetchOpenFdaLabel({ rxcui, genericName, brandName }, { fetchImpl }),
    fetchDailyMedSpl({ drugName: genericName, rxcui, fetchXml: includeDailyMedXml }, { fetchImpl }),
  ]);

  trackSourceResult('openfda', fdaRes);
  trackSourceResult('dailymed', dmRes);

  return {
    openfda: fdaRes,
    dailymed: dmRes,
  };
}

/**
 * يبحث عن أدلة التداخل بين دوائين في PubMed (+ OpenSERP/SearXNG عند التفعيل).
 */
export async function fetchPairLiterature(
  identityA,
  identityB,
  { fetchImpl = fetch, includeWebSearch = false, openserpUrl, searxngUrl } = {},
) {
  const termA = identityA?.primaryIngredient || identityA?.englishCandidates?.[0];
  const termB = identityB?.primaryIngredient || identityB?.englishCandidates?.[0];

  let pubmedRes = {
    ok: false,
    source: 'PubMed',
    totalCount: 0,
    articles: [],
    evidenceDirection: 'unavailable',
    error: 'تعذر تحديد الاسم العلمي للبحث في PubMed.',
  };

  if (termA && termB) {
    pubmedRes = await searchPubMedInteraction(termA, termB, { fetchImpl, maxResults: 3 });
    trackSourceResult('pubmed', pubmedRes);
  }

  let webSearchRes = null;
  if (includeWebSearch && (openserpUrl || searxngUrl)) {
    const queries = [];
    if (termA && termB) {
      queries.push(`"${termA}" "${termB}" drug interaction site:fda.gov OR site:dailymed.nlm.nih.gov OR site:sfda.gov.sa`);
      queries.push(`${termA} ${termB} تداخل دوائي OR تحذير`);
    }
    if (identityA?.arabicTerms?.[0] && identityB?.arabicTerms?.[0]) {
      queries.push(`${identityA.arabicTerms[0]} ${identityB.arabicTerms[0]} تداخل دوائي`);
    }
    webSearchRes = await searchMedicalWeb(
      { queries, fetchOriginalPages: true, maxPagesToFetch: 3 },
      { openserpUrl, searxngUrl, fetchImpl },
    );
  }

  return {
    pubmed: pubmedRes,
    webSearch: webSearchRes,
  };
}
