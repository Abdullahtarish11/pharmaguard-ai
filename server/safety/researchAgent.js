/**
 * نواة التخطيط الذاتي وحلقة البحث التكرارية لوكيل سلامة الأدوية (safety_agent):
 * - حتمية وقائمة على القواعد الصيدلانية والمنهجية البحثية دون استخدام Gemini API أو أي نموذج مدفوع.
 * - تبني خطة بحث صريحة قبل التنفيذ (الهدف، ملف اللغة، الأدوات المختارة، معايير التوقف).
 * - تنفّذ دورة بحث من 1 إلى 3 جولات:
 *   * الجولة 1: التحقق الأساسي عبر المصادر الرسمية الأربعة (RxNorm، openFDA، DailyMed، PubMed) + قاعدة الصيدلية.
 *   * الجولة 2 (استدراك النقص تلقائيًا): تفكيك الأدوية المركبة، محاولات RxNorm/openFDA/DailyMed البديلة،
 *     توسيع استعلام PubMed، وعند تفعيل OpenSERP/SearXNG البحث في البوابات الرسمية (SFDA/FDA/EMA) لاستخلاص المادة الفعالة.
 *   * الجولة 3 (التحقق من التعارض): فحص DailyMed SPL XML كاملًا عند نقصه، وبحث PubMed السريري المركز،
 *     ومقارنة المصادر دون إخفاء التعارض الحقيقي.
 * - تفصل صراحةً بين الأدلة الطبية الرسمية، الأبحاث العلمية المحكّمة، ونتائج محركات البحث العامة.
 */

import { normalizeBilingualDrugInput } from './bilingual.js';
import { SAFETY_CLASSIFICATION } from './constants.js';
import { lookupRxNorm } from './sources/rxnorm.js';
import {
  extractClinicalWarningsFromLabel,
  extractInteractionEvidenceFromLabel,
  fetchOpenFdaLabel,
} from './sources/openfda.js';
import { extractInteractionFromDailyMed, fetchDailyMedSpl } from './sources/dailymed.js';
import { searchPubMedInteraction } from './sources/pubmed.js';
import { getSearchEngineConfigStatus, sanitizeEngineError, searchMedicalWeb } from './sources/openserp.js';
import {
  fetchDrugMonographs,
  fetchPairLiterature,
  resolveMedicineIdentity,
} from './sources/index.js';

const MAX_RESEARCH_ROUNDS = 3;

function detectLanguageProfile(identities = []) {
  let hasAr = false;
  let hasEn = false;
  for (const id of identities) {
    if ((id?.arabicTerms?.length ?? 0) > 0) hasAr = true;
    if ((id?.englishCandidates?.length ?? 0) > 0) hasEn = true;
  }
  if (hasAr && hasEn) return { code: 'bilingual', label: 'ثنائي اللغة (عربي + إنجليزي)' };
  if (hasAr) return { code: 'ar', label: 'عربي (مع التوحيد العلمي)' };
  return { code: 'en', label: 'إنجليزي / علمي' };
}

function buildWebQueriesForMedicine(identity) {
  const queries = [];
  const ar = identity?.arabicTerms?.[0];
  const en = identity?.primaryIngredient || identity?.englishCandidates?.[0] || identity?.originalName;
  if (ar) {
    queries.push(`${ar} المادة الفعالة OR نشرة الدواء site:sfda.gov.sa OR site:jfda.jo OR site:edaegypt.gov.eg`);
    queries.push(`${ar} active ingredient composition`);
  }
  if (en) {
    queries.push(`"${en}" drug label warnings site:fda.gov OR site:dailymed.nlm.nih.gov OR site:sfda.gov.sa`);
  }
  return [...new Set(queries)].slice(0, 3);
}

function buildWebQueriesForPair(identityA, identityB) {
  const queries = [];
  const termA = identityA?.primaryIngredient || identityA?.englishCandidates?.[0] || identityA?.originalName;
  const termB = identityB?.primaryIngredient || identityB?.englishCandidates?.[0] || identityB?.originalName;
  if (termA && termB) {
    queries.push(`"${termA}" "${termB}" drug interaction site:fda.gov OR site:dailymed.nlm.nih.gov OR site:sfda.gov.sa OR site:ema.europa.eu`);
    queries.push(`${termA} ${termB} تداخل دوائي OR تحذير`);
  }
  const arA = identityA?.arabicTerms?.[0];
  const arB = identityB?.arabicTerms?.[0];
  if (arA && arB) {
    queries.push(`${arA} ${arB} تداخل دوائي`);
  }
  return [...new Set(queries)].slice(0, 4);
}

function filterUnseenQueries(queries = [], executedWebQueries = null) {
  const unique = [...new Set(queries.map((q) => String(q ?? '').trim()).filter(Boolean))];
  if (!executedWebQueries) return unique;
  const unseen = [];
  for (const q of unique) {
    const key = q.toLowerCase();
    if (executedWebQueries.has(key)) continue;
    unseen.push(q);
  }
  return unseen;
}

function mergeWebResults(existing = [], incoming = []) {
  const byUrl = new Map();
  for (const item of [...existing, ...incoming]) {
    if (!item?.url) continue;
    const prev = byUrl.get(item.url);
    if (!prev || (!prev.pageExtracted && item.pageExtracted)) {
      byUrl.set(item.url, item);
    }
  }
  return [...byUrl.values()].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || String(b.snippet ?? '').length - String(a.snippet ?? '').length,
  );
}

/**
 * يستخلص مرشحات مواد فعالة إنجليزية محتملة من نص صفحة مصدر رسمي أو محكم،
 * ويُعاد اختبارها عبر RxNorm قبل قبولها (لا تُقبل أبدًا من ويب عام غير موثوق).
 */
function extractCandidateIngredientsFromWebResults(webRes, existingIdentity) {
  const results = Array.isArray(webRes?.results) ? webRes.results : [];
  const trustedTexts = results
    .filter((r) => r.clinicallyCertified && (r.pageText || r.snippet))
    .map((r) => `${r.pageTitle || ''} ${r.pageText || r.snippet || ''}`)
    .join(' ');

  if (!trustedTexts) return [];

  const existingSet = new Set(
    [
      existingIdentity?.originalName,
      existingIdentity?.primaryIngredient,
      ...(existingIdentity?.englishCandidates ?? []),
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase()),
  );

  // البحث عن أنماط صريحة مثل "active ingredient: X" أو "generic name: X" أو كلمات دوائية لاتينية واضحة
  const candidates = [];
  const pattern = /(?:active\s+ingredient|generic\s+name|substance|composition|contains)\s*[:\-]\s*([A-Za-z][A-Za-z0-9\s\-]{2,40})/gi;
  let match;
  while ((match = pattern.exec(trustedTexts)) !== null) {
    const cleaned = normalizeBilingualDrugInput(match[1]).primaryQueryEn;
    if (cleaned && cleaned.length >= 4 && !existingSet.has(cleaned.toLowerCase())) {
      candidates.push(cleaned);
      existingSet.add(cleaned.toLowerCase());
    }
  }
  return candidates.slice(0, 3);
}

function splitCompoundCandidates(identity) {
  const raw = [
    identity?.primaryIngredient,
    identity?.originalScientificName,
    identity?.originalName,
    ...(identity?.englishCandidates ?? []),
  ]
    .filter(Boolean)
    .join(' ');

  const normalized = normalizeBilingualDrugInput(raw);
  const parts = new Set();
  for (const cand of normalized.englishCandidates) {
    const tokens = cand.split(/[\s/+]+/).map((t) => t.trim()).filter((t) => t.length >= 4);
    if (tokens.length > 1) {
      for (const tok of tokens) parts.add(tok);
    }
  }
  return [...parts].slice(0, 3);
}

/**
 * يبني خطة البحث الذاتية قبل تشغيل الأدوات.
 */
export function buildResearchPlan({
  mode = 'pair',
  medicineA,
  medicineB = null,
  openserpUrl = '',
  searxngUrl = '',
  localInteractionsCount = 0,
}) {
  const normA = normalizeBilingualDrugInput(medicineA);
  const normB = medicineB ? normalizeBilingualDrugInput(medicineB) : null;
  const languageProfile = detectLanguageProfile(normB ? [normA, normB] : [normA]);
  const searchEngineStatus = getSearchEngineConfigStatus({ openserpUrl, searxngUrl });

  const plannedTools = [
    {
      id: 'rxnorm',
      name: 'RxNorm (NLM)',
      category: 'official',
      priority: 1,
      purpose: 'توحيد الأسماء العلمية والتجارية واستخلاص معرف RxCUI والمواد الفعالة.',
    },
    {
      id: 'openfda',
      name: 'openFDA Drug Labels',
      category: 'official',
      priority: 2,
      purpose: 'فحص نشرات FDA الرسمية وموانع الاستعمال والصندوق الأسود وتحذيرات الجرعة والعمر.',
    },
    {
      id: 'dailymed',
      name: 'DailyMed SPL XML',
      category: 'official',
      priority: 3,
      purpose: 'التحقق المستقل من أقسام LOINC في النشرة الدوائية الرسمية.',
    },
  ];

  if (mode === 'pair') {
    plannedTools.push({
      id: 'pubmed',
      name: 'PubMed (NCBI)',
      category: 'literature',
      priority: 4,
      purpose: 'فحص الأبحاث السريرية المحكّمة الداعمة أو النافية للتداخل.',
    });
    if (localInteractionsCount > 0) {
      plannedTools.push({
        id: 'local_db',
        name: 'جدول drug_interactions المحلي',
        category: 'local',
        priority: 4,
        purpose: 'مطابقة التداخلات المسجّلة داخل الصيدلية.',
      });
    }
  }

  if (searchEngineStatus.configured) {
    plannedTools.push({
      id: 'web_search',
      name: searchEngineStatus.primary.configured ? 'OpenSERP (أساسي) ← SearXNG (احتياطي)' : 'SearXNG',
      category: 'web_search',
      priority: 5,
      purpose: 'بحث ويب طبي عربي/إنجليزي في البوابات الرسمية عند الحاجة لاستدراك النقص أو التعارض (غير معتمد تلقائيًا).',
    });
  }

  return {
    mode,
    goal:
      mode === 'pair'
        ? `تحقق متعدد المصادر من التداخل الدوائي والتحذيرات بين «${normA.originalName || 'الدواء الأول'}» و«${normB?.originalName || 'الدواء الثاني'}»`
        : `توحيد هوية الدواء «${normA.originalName || 'الدواء'}» واستخراج تحذيراته الرسمية`,
    languageProfile,
    maxRounds: MAX_RESEARCH_ROUNDS,
    webSearchConfigured: searchEngineStatus.configured,
    webSearchStatusLabel: searchEngineStatus.statusLabel,
    plannedTools,
    stoppingCriteria: [
      'تطابق الهوية وتوفر نشرات رسمية واضحة دون تعارض، أو',
      'إتمام جولة استدراك النقص وجولة التحقق من التعارض ضمن الحد الأقصى للجولات (3 جولات).',
    ],
  };
}

function summarizeDirection(ev) {
  if (!ev || !ev.mentioned) return 'none';
  if (ev.negated) return 'negated';
  return 'positive';
}

function severityWeight(sev) {
  const s = String(sev ?? '').toLowerCase();
  if (['contraindicated', 'critical', 'boxed'].includes(s)) return 0;
  if (['high', 'major', 'severe'].includes(s)) return 1;
  if (['moderate', 'medium'].includes(s)) return 2;
  if (['minor', 'low', 'mild'].includes(s)) return 3;
  return 4;
}

const SEVERITY_ARABIC = Object.freeze({
  contraindicated: 'ممنوع الجمع بينهما (Contraindicated)',
  critical: 'حرج (صندوق أسود / شديد الخطورة)',
  high: 'عالي الخطورة (Major)',
  major: 'شديد (Major)',
  moderate: 'متوسط (Moderate)',
  minor: 'طفيف (Minor)',
});

function buildPairArabicSummary({ medALabel, medBLabel, classification, documentedSeverity, evidences, sameIngredient }) {
  if (sameIngredient) {
    return `تطابق في المادة الفعالة (${sameIngredient}) بين اسمين تجاريين مختلفين: «${medALabel}» و«${medBLabel}». الجمع بينهما يرفع خطر تضاعف الجرعة دون مبرر سريري.`;
  }

  const sevLabel = documentedSeverity ? (SEVERITY_ARABIC[documentedSeverity] ?? documentedSeverity) : 'غير محددة في المصدر';
  const sourcesNames = [...new Set(evidences.map((e) => e.sourceName))];

  if (classification.code === SAFETY_CLASSIFICATION.DOCUMENTED_INTERACTION.code) {
    return `تم رصد تداخل دوائي موثق بين «${medALabel}» و«${medBLabel}» عبر ${sourcesNames.join(' و')} — درجة الخطورة الموثقة: ${sevLabel}.`;
  }
  if (classification.code === SAFETY_CLASSIFICATION.SOURCE_CONFLICT.code) {
    return `وُجد تعارض بين المصادر بشأن التداخل بين «${medALabel}» و«${medBLabel}» (${sourcesNames.join(' مقابل ')}). يلزم التحقق اليدوي من النشرة الأصلية.`;
  }
  if (classification.code === SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED.code) {
    return `تعذر إتمام التحقق بين «${medALabel}» و«${medBLabel}» بسبب فشل الوصول إلى أحد المصادر الطبية الرسمية أو كلها.`;
  }
  if (classification.code === SAFETY_CLASSIFICATION.INSUFFICIENT_INFO.code) {
    return `المعلومات المتاحة لا تكفي للحكم على التداخل بين «${medALabel}» و«${medBLabel}» (أحد الدواءين غير مطابق أو تنقصه نشرة رسمية).`;
  }
  return `لم يُعثر على تداخل موثق بين «${medALabel}» و«${medBLabel}» في المصادر المفحوصة (${sourcesNames.join('، ') || 'المصادر الرسمية'}). هذا لا يعني أن الجمع «آمن» سريريًا.`;
}

function findMatchingLocalInteractions(identityA, identityB, localRows = []) {
  if (!Array.isArray(localRows) || localRows.length === 0) return [];
  const termsA = identityA?.searchTerms ?? [];
  const termsB = identityB?.searchTerms ?? [];
  const matchesTerm = (text, terms) => {
    const lower = String(text ?? '').toLowerCase();
    return Boolean(lower && terms.some((t) => lower.includes(t)));
  };

  return localRows.filter((row) => {
    const aMatchesA = matchesTerm(row.drugA, termsA) && matchesTerm(row.drugB, termsB);
    const aMatchesB = matchesTerm(row.drugA, termsB) && matchesTerm(row.drugB, termsA);
    return aMatchesA || aMatchesB;
  });
}

/**
 * يقيّم حالة الأدلة بعد كل جولة ويقرر إن كان هناك نقص أو تعارض يستدعي إعادة البحث.
 */
function collectPairSignals({
  identityA,
  identityB,
  monographsA,
  monographsB,
  literature,
  localInteractions,
}) {
  const labelA = identityA.originalName || identityA.primaryIngredient || 'الدواء الأول';
  const labelB = identityB.originalName || identityB.primaryIngredient || 'الدواء الثاني';

  const setA = new Set((identityA.activeIngredients ?? []).map((x) => x.toLowerCase()));
  const setB = new Set((identityB.activeIngredients ?? []).map((x) => x.toLowerCase()));
  const sharedIngredient = (identityB.activeIngredients ?? []).find((x) => setA.has(x.toLowerCase())) ?? null;
  const distinctIngredientsA = (identityA.activeIngredients ?? []).filter((x) => !setB.has(x.toLowerCase()));
  const distinctIngredientsB = (identityB.activeIngredients ?? []).filter((x) => !setA.has(x.toLowerCase()));
  const isPureSameActiveIngredient =
    Boolean(sharedIngredient) && distinctIngredientsA.length === 0 && distinctIngredientsB.length === 0;

  const sharedLower = new Set(
    (identityA.activeIngredients ?? []).filter((x) => setB.has(x.toLowerCase())).map((x) => x.toLowerCase()),
  );
  const crossTermsForB = (identityB.searchTerms ?? []).filter((t) => !sharedLower.has(t.toLowerCase()));
  const crossTermsForA = (identityA.searchTerms ?? []).filter((t) => !sharedLower.has(t.toLowerCase()));

  const officialEvidences = [];
  const literatureEvidences = [];
  const localEvidences = [];
  const sourceErrors = [];
  const checkedOfficialSources = [];

  if (identityA.rxnorm?.ok && identityB.rxnorm?.ok) checkedOfficialSources.push('RxNorm');
  else if (!identityA.rxnorm?.ok || !identityB.rxnorm?.ok) {
    sourceErrors.push({ source: 'RxNorm', error: identityA.rxnorm?.error || identityB.rxnorm?.error });
  }

  const fdaOkCount = (monographsA.openfda?.ok ? 1 : 0) + (monographsB.openfda?.ok ? 1 : 0);
  if (fdaOkCount > 0) checkedOfficialSources.push('openFDA');
  if (!monographsA.openfda?.ok) sourceErrors.push({ source: 'openFDA (A)', error: monographsA.openfda?.error });
  if (!monographsB.openfda?.ok) sourceErrors.push({ source: 'openFDA (B)', error: monographsB.openfda?.error });

  const fdaEvA =
    !isPureSameActiveIngredient && monographsA.openfda?.found && crossTermsForB.length > 0
      ? extractInteractionEvidenceFromLabel(monographsA.openfda.primaryLabel, crossTermsForB)
      : null;
  const fdaEvB =
    !isPureSameActiveIngredient && monographsB.openfda?.found && crossTermsForA.length > 0
      ? extractInteractionEvidenceFromLabel(monographsB.openfda.primaryLabel, crossTermsForA)
      : null;

  for (const [ev, dirLabel] of [
    [fdaEvA, `${labelA} → ${labelB}`],
    [fdaEvB, `${labelB} → ${labelA}`],
  ]) {
    if (ev?.mentioned) {
      officialEvidences.push({
        sourceName: 'openFDA',
        evidenceCategory: 'official_authority',
        direction: summarizeDirection(ev),
        section: ev.section,
        severity: ev.severity,
        originalText: ev.snippets.join(' | '),
        sourceUrl: ev.sourceUrl,
        publishedDate: ev.publishedDate,
        issuer: ev.issuer,
        note: dirLabel,
      });
    }
  }

  const dmOkCount = (monographsA.dailymed?.ok ? 1 : 0) + (monographsB.dailymed?.ok ? 1 : 0);
  if (dmOkCount > 0) checkedOfficialSources.push('DailyMed');
  if (!monographsA.dailymed?.ok) sourceErrors.push({ source: 'DailyMed (A)', error: monographsA.dailymed?.error });
  if (!monographsB.dailymed?.ok) sourceErrors.push({ source: 'DailyMed (B)', error: monographsB.dailymed?.error });

  const dmEvA =
    !isPureSameActiveIngredient && monographsA.dailymed?.found && crossTermsForB.length > 0
      ? extractInteractionFromDailyMed(monographsA.dailymed, crossTermsForB)
      : null;
  const dmEvB =
    !isPureSameActiveIngredient && monographsB.dailymed?.found && crossTermsForA.length > 0
      ? extractInteractionFromDailyMed(monographsB.dailymed, crossTermsForA)
      : null;

  for (const [ev, dirLabel] of [
    [dmEvA, `${labelA} → ${labelB}`],
    [dmEvB, `${labelB} → ${labelA}`],
  ]) {
    if (ev?.mentioned) {
      officialEvidences.push({
        sourceName: 'DailyMed',
        evidenceCategory: 'official_authority',
        direction: summarizeDirection(ev),
        severity: ev.severity,
        originalText: ev.snippets.join(' | '),
        sourceUrl: ev.sourceUrl,
        publishedDate: ev.publishedDate,
        issuer: ev.issuer,
        note: dirLabel,
      });
    }
  }

  if (sharedIngredient && identityA.rxnorm?.matched && identityB.rxnorm?.matched) {
    officialEvidences.push({
      sourceName: 'RxNorm',
      evidenceCategory: 'official_authority',
      direction: 'warning',
      severity: 'moderate',
      originalText: `Both "${labelA}" (RxCUI ${identityA.rxnorm.rxcui}) and "${labelB}" (RxCUI ${identityB.rxnorm.rxcui}) resolve to active ingredient "${sharedIngredient}".`,
      sourceUrl: identityA.rxnorm.sourceUrl,
      publishedDate: null,
      issuer: 'U.S. National Library of Medicine (RxNorm)',
    });
  }

  if (literature.pubmed?.ok) {
    checkedOfficialSources.push('PubMed');
    if (literature.pubmed.articles?.length > 0 && literature.pubmed.evidenceDirection !== 'none') {
      const top = literature.pubmed.articles[0];
      literatureEvidences.push({
        sourceName: 'PubMed',
        evidenceCategory: 'peer_reviewed_literature',
        direction:
          literature.pubmed.evidenceDirection === 'supports_interaction'
            ? 'positive'
            : literature.pubmed.evidenceDirection === 'reports_no_interaction'
              ? 'negated'
              : 'mixed',
        severity: null,
        originalText: top.abstractExcerpt || top.title,
        title: top.title,
        sourceUrl: top.sourceUrl,
        publishedDate: top.publishedDate,
        issuer: top.journal,
        totalMatches: literature.pubmed.totalCount,
      });
    }
  } else if (literature.pubmed?.error) {
    sourceErrors.push({ source: 'PubMed', error: literature.pubmed.error });
  }

  const localMatches = findMatchingLocalInteractions(identityA, identityB, localInteractions);
  for (const row of localMatches) {
    localEvidences.push({
      sourceName: row.source ? `جدول الصيدلية (${row.source})` : 'جدول drug_interactions المحلي',
      evidenceCategory: 'local_database',
      direction: 'positive',
      severity: row.severity ?? null,
      originalText: row.description || `${row.drugA} + ${row.drugB}`,
      sourceUrl: null,
      publishedDate: null,
      issuer: row.source || 'قاعدة الصيدلية المحلية',
    });
  }

  const evidences = [...officialEvidences, ...literatureEvidences, ...localEvidences];
  const positiveEvidences = evidences.filter((e) => e.direction === 'positive');
  const negatedEvidences = evidences.filter((e) => e.direction === 'negated');
  const mixedEvidences = evidences.filter((e) => e.direction === 'mixed');

  const medAHasMonograph = Boolean(monographsA.openfda?.found || monographsA.dailymed?.found);
  const medBHasMonograph = Boolean(monographsB.openfda?.found || monographsB.dailymed?.found);
  const bothHaveSomeOfficialMonograph = medAHasMonograph && medBHasMonograph;

  let classification;
  if (positiveEvidences.length > 0 && (negatedEvidences.length > 0 || mixedEvidences.length > 0)) {
    classification = SAFETY_CLASSIFICATION.SOURCE_CONFLICT;
  } else if (positiveEvidences.length > 0) {
    classification = SAFETY_CLASSIFICATION.DOCUMENTED_INTERACTION;
  } else if (sharedIngredient) {
    classification = SAFETY_CLASSIFICATION.DOCUMENTED_WARNING;
  } else if (sourceErrors.length > 0 && checkedOfficialSources.length === 0) {
    classification = SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED;
  } else if (sourceErrors.length >= 2 && !bothHaveSomeOfficialMonograph) {
    classification = SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED;
  } else if (!bothHaveSomeOfficialMonograph && negatedEvidences.length === 0) {
    classification = SAFETY_CLASSIFICATION.INSUFFICIENT_INFO;
  } else {
    classification = SAFETY_CLASSIFICATION.NO_INTERACTION_FOUND;
  }

  return {
    labelA,
    labelB,
    sharedIngredient,
    isPureSameActiveIngredient,
    medAHasMonograph,
    medBHasMonograph,
    bothHaveSomeOfficialMonograph,
    officialEvidences,
    literatureEvidences,
    localEvidences,
    evidences,
    positiveEvidences,
    negatedEvidences,
    mixedEvidences,
    checkedOfficialSources: [...new Set(checkedOfficialSources)],
    sourceErrors,
    classification,
  };
}

/**
 * محاولة استدراك لهوية دواء واحد ونشراته عند النقص.
 */
async function recoverSingleMedicineGap(
  identity,
  monographs,
  {
    fetchImpl,
    openserpUrl,
    searxngUrl,
    resolveDns = true,
    fetchDailyMedXmlIfMissing = true,
    executedWebQueries = null,
  },
) {
  const actions = [];
  let updatedIdentity = identity;
  let updatedMonographs = monographs;
  let webFindings = [];
  let webSearchMeta = null;

  const needsIdentityRecovery = !updatedIdentity.rxnorm?.matched;
  const needsMonographRecovery = !updatedMonographs.openfda?.found && !updatedMonographs.dailymed?.found;

  // 1) تفكيك المركّبات إن وُجدت (مثال: amoxicillin clavulanate -> amoxicillin)
  if (needsIdentityRecovery || needsMonographRecovery) {
    const parts = splitCompoundCandidates(updatedIdentity);
    for (const part of parts) {
      const rxTry = await lookupRxNorm(part, { fetchImpl });
      if (rxTry?.ok && rxTry.matched) {
        actions.push(`تفكيك المركب وتوحيد «${part}» عبر RxNorm (${rxTry.rxcui})`);
        const mergedIngredients = [
          ...new Set([
            ...(updatedIdentity.activeIngredients ?? []),
            ...(rxTry.activeIngredients ?? []).map((x) => x.name),
            rxTry.canonicalName,
          ].filter(Boolean)),
        ];
        updatedIdentity = {
          ...updatedIdentity,
          rxnorm: updatedIdentity.rxnorm?.matched ? updatedIdentity.rxnorm : { ...rxTry },
          activeIngredients: mergedIngredients,
          primaryIngredient: updatedIdentity.rxnorm?.matched
            ? updatedIdentity.primaryIngredient
            : rxTry.primaryIngredient || rxTry.canonicalName || part,
          searchTerms: [...new Set([...(updatedIdentity.searchTerms ?? []), part.toLowerCase()])],
        };
        break;
      }
    }
  }

  // 2) إعادة محاولة openFDA / DailyMed عند غياب النشرة أو الحاجة إلى XML الكامل
  const needsDmXml =
    !updatedMonographs.dailymed?.found ||
    (fetchDailyMedXmlIfMissing && updatedMonographs.dailymed?.found && !updatedMonographs.dailymed?.sections);

  if (!updatedMonographs.openfda?.found || needsDmXml) {
    const altName =
      updatedIdentity.primaryIngredient ||
      updatedIdentity.activeIngredients?.[0] ||
      updatedIdentity.englishCandidates?.[0] ||
      updatedIdentity.originalName;

    if (!updatedMonographs.openfda?.found && altName) {
      const retryFda = await fetchOpenFdaLabel(
        {
          rxcui: updatedIdentity.rxnorm?.rxcui ?? null,
          genericName: altName,
          brandName: updatedIdentity.originalName,
        },
        { fetchImpl },
      );
      if (retryFda?.found) {
        updatedMonographs = { ...updatedMonographs, openfda: retryFda };
        actions.push(`استدراك نشرة openFDA عبر «${altName}»`);
      }
    }

    if (needsDmXml) {
      const knownSetId = updatedMonographs.dailymed?.found ? updatedMonographs.dailymed?.setId ?? null : null;
      const retryDm = await fetchDailyMedSpl(
        {
          drugName: altName,
          rxcui: updatedIdentity.rxnorm?.rxcui ?? null,
          setId: knownSetId,
          knownMeta: knownSetId ? updatedMonographs.dailymed : null,
          fetchXml: true,
        },
        { fetchImpl },
      );
      if (retryDm?.found && (retryDm.sections || !updatedMonographs.dailymed?.found)) {
        updatedMonographs = { ...updatedMonographs, dailymed: retryDm };
        actions.push(
          knownSetId
            ? `قراءة نص DailyMed SPL XML الكامل للوثيقة (${knownSetId})`
            : `استدراك نشرة DailyMed SPL XML عبر «${altName}»`,
        );
      }
    }
  }

  // 3) إذا ما زال النقص قائمًا وكان OpenSERP/SearXNG مُعدًا، استشارة الويب الرسمي لاكتشاف المادة الفعالة
  if (
    (!updatedIdentity.rxnorm?.matched || (!updatedMonographs.openfda?.found && !updatedMonographs.dailymed?.found)) &&
    (openserpUrl || searxngUrl)
  ) {
    const queries = filterUnseenQueries(buildWebQueriesForMedicine(updatedIdentity), executedWebQueries);
    if (queries.length > 0) {
      if (executedWebQueries) {
        for (const q of queries) executedWebQueries.add(q.toLowerCase());
      }
      const webRes = await searchMedicalWeb(
        { queries, fetchOriginalPages: true, maxPagesToFetch: 2 },
        { openserpUrl, searxngUrl, fetchImpl, resolveDns },
      );
      webSearchMeta = webRes;
      if (webRes?.ok && webRes.results?.length > 0) {
        webFindings = webRes.results;
        actions.push(`استشارة ${webRes.engineUsed} (${webRes.results.length} نتيجة ويب للتحقق)`);
        const candidateNames = !updatedIdentity.rxnorm?.matched
          ? extractCandidateIngredientsFromWebResults(webRes, updatedIdentity)
          : [];
        for (const cand of candidateNames) {
          const rxWeb = await lookupRxNorm(cand, { fetchImpl });
          if (rxWeb?.ok && rxWeb.matched) {
            actions.push(`تأكيد مادة فعالة مكتشفة «${cand}» عبر RxNorm (${rxWeb.rxcui})`);
            updatedIdentity = {
              ...updatedIdentity,
              rxnorm: { ...rxWeb },
              primaryIngredient: rxWeb.primaryIngredient || rxWeb.canonicalName || cand,
              activeIngredients: [...new Set([cand, ...(rxWeb.activeIngredients ?? []).map((x) => x.name)])],
              searchTerms: [...new Set([...(updatedIdentity.searchTerms ?? []), cand.toLowerCase()])],
            };
            const refreshed = await fetchDrugMonographs(updatedIdentity, {
              fetchImpl,
              includeDailyMedXml: fetchDailyMedXmlIfMissing,
            });
            if (refreshed.openfda?.found) updatedMonographs.openfda = refreshed.openfda;
            if (refreshed.dailymed?.found) updatedMonographs.dailymed = refreshed.dailymed;
            break;
          }
        }
      } else if (webRes && !webRes.ok) {
        actions.push(`تعذر استشارة محرك البحث: ${sanitizeEngineError(webRes.error, [openserpUrl, searxngUrl])}`);
      }
    }
  }

  return {
    identity: updatedIdentity,
    monographs: updatedMonographs,
    webFindings,
    webSearchMeta,
    actions,
  };
}

/**
 * التنفيذ المستقل لتحليل دواء مفرد (تخطيط -> جولة 1 -> جولة استدراك عند النقص -> تركيب النتيجة والأثر).
 */
export async function runAutonomousSingleResearch(
  medicine,
  {
    fetchImpl = fetch,
    openserpUrl = '',
    searxngUrl = '',
    resolveDns = true,
    preResolved = null,
    preMonographs = null,
    includeDailyMedXml = true,
  } = {},
) {
  const startedAt = Date.now();
  const plan = buildResearchPlan({ mode: 'single', medicineA: medicine, openserpUrl, searxngUrl });
  const rounds = [];
  const reSearchReasons = [];

  // الجولة 1: التحقق الأساسي من RxNorm + openFDA + DailyMed (مع إعادة استخدام أي نتائج مجلبة مسبقًا)
  const r1Start = Date.now();
  let identity = preResolved ?? (await resolveMedicineIdentity(medicine, { fetchImpl }));
  let monographs = preMonographs ?? (await fetchDrugMonographs(identity, { fetchImpl, includeDailyMedXml }));
  let webFindings = [];

  rounds.push({
    round: 1,
    phase: 'التحقق الأساسي من المصادر الرسمية',
    reason: preResolved ? 'توحيد الهوية وجلب البيانات المرجعية المعتمدة (مع إعادة استخدام ما جُلب)' : 'تنفيذ الخطة المبدئية لتوحيد الاسم وجلب النشرات المعتمدة',
    durationMs: Date.now() - r1Start,
    steps: [
      {
        tool: 'RxNorm (NLM)',
        status: identity.rxnorm?.matched ? 'matched' : identity.rxnorm?.ok ? 'miss' : 'error',
        detail: identity.rxnorm?.matched
          ? `طابق «${identity.primaryIngredient}» (RxCUI ${identity.rxnorm.rxcui})`
          : identity.rxnorm?.error || 'لم يُطابق الاسم في RxNorm',
      },
      {
        tool: 'openFDA Drug Labels',
        status: monographs.openfda?.found ? 'matched' : monographs.openfda?.ok ? 'miss' : 'error',
        detail: monographs.openfda?.found ? 'وُجدت نشرة FDA الرسمية' : monographs.openfda?.error || 'لم تُوجد نشرة',
      },
      {
        tool: 'DailyMed SPL XML',
        status: monographs.dailymed?.found ? 'matched' : monographs.dailymed?.ok ? 'miss' : 'error',
        detail: monographs.dailymed?.found
          ? monographs.dailymed.sections
            ? 'وُجدت نشرة DailyMed (XML مقروء)'
            : 'وُجدت نشرة DailyMed (بيانات وصفية — يُجلب XML عند الحاجة)'
          : monographs.dailymed?.error || 'لم تُوجد نشرة',
      },
    ],
  });

  // تقييم الحاجة لجولة استدراك (للدواء المفرد: فقط عند فقدان الهوية أو غياب كلتي النشرتين)
  const hasGap = !identity.rxnorm?.matched || (!monographs.openfda?.found && !monographs.dailymed?.found);
  if (hasGap && (monographs.openfda?.ok || monographs.dailymed?.ok || identity.rxnorm?.ok)) {
    const gapReason = !identity.rxnorm?.matched
      ? 'عدم مطابقة الاسم في RxNorm ونقص الهوية الموحدة'
      : 'غياب النشرات الرسمية في openFDA وDailyMed بالاسم المبدئي';
    reSearchReasons.push(gapReason);

    const r2Start = Date.now();
    const recovered = await recoverSingleMedicineGap(identity, monographs, {
      fetchImpl,
      openserpUrl,
      searxngUrl,
      resolveDns,
      fetchDailyMedXmlIfMissing: includeDailyMedXml,
    });
    identity = recovered.identity;
    monographs = recovered.monographs;
    webFindings = recovered.webFindings;

    rounds.push({
      round: 2,
      phase: 'جولة استدراك النقص',
      reason: gapReason,
      durationMs: Date.now() - r2Start,
      steps:
        recovered.actions.length > 0
          ? recovered.actions.map((act) => ({ tool: 'Adaptive Gap Recovery', status: 'executed', detail: act }))
          : [{ tool: 'Adaptive Gap Recovery', status: 'no_new_data', detail: 'لم تتوفر معطيات إضافية بعد محاولات الاستدراك' }],
    });
  }

  const warnings = [];
  if (monographs.openfda?.found && monographs.openfda.primaryLabel) {
    warnings.push(...extractClinicalWarningsFromLabel(monographs.openfda.primaryLabel));
  }

  let status = SAFETY_CLASSIFICATION.NO_INTERACTION_FOUND;
  if (!monographs.openfda?.ok && !monographs.dailymed?.ok) {
    status = SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED;
  } else if (warnings.length > 0) {
    status = SAFETY_CLASSIFICATION.DOCUMENTED_WARNING;
  } else if (!identity.rxnorm?.matched && !monographs.openfda?.found && !monographs.dailymed?.found) {
    status = SAFETY_CLASSIFICATION.INSUFFICIENT_INFO;
  }

  return {
    identity,
    monographs,
    warnings,
    status,
    webFindings,
    researchTrace: {
      plan,
      roundsExecuted: rounds.length,
      reSearchTriggered: rounds.length > 1,
      reSearchReasons,
      rounds,
      totalDurationMs: Date.now() - startedAt,
    },
  };
}

/**
 * التنفيذ المستقل لتحليل زوج دوائي (تخطيط -> جولة 1 -> جولات استدراك النقص أو حسم التعارض -> تركيب النتيجة والأثر).
 */
export async function runAutonomousPairResearch(
  medicineA,
  medicineB,
  {
    fetchImpl = fetch,
    preResolvedA = null,
    preResolvedB = null,
    preMonographsA = null,
    preMonographsB = null,
    localInteractions = [],
    includeWebSearch = false,
    openserpUrl = '',
    searxngUrl = '',
    resolveDns = true,
  } = {},
) {
  const startedAt = Date.now();
  const plan = buildResearchPlan({
    mode: 'pair',
    medicineA,
    medicineB,
    openserpUrl,
    searxngUrl,
    localInteractionsCount: localInteractions.length,
  });

  const rounds = [];
  const reSearchReasons = [];
  const webConfigured = Boolean(openserpUrl || searxngUrl);

  // الجولة 1: المصادر الرسمية الأربعة + قاعدة الصيدلية
  const r1Start = Date.now();
  let [identityA, identityB] = await Promise.all([
    preResolvedA ?? resolveMedicineIdentity(medicineA, { fetchImpl }),
    preResolvedB ?? resolveMedicineIdentity(medicineB, { fetchImpl }),
  ]);

  const setA0 = new Set((identityA.activeIngredients ?? []).map((x) => x.toLowerCase()));
  const setB0 = new Set((identityB.activeIngredients ?? []).map((x) => x.toLowerCase()));
  const shared0 = (identityB.activeIngredients ?? []).find((x) => setA0.has(x.toLowerCase())) ?? null;
  const isPureSame0 =
    Boolean(shared0) &&
    (identityA.activeIngredients ?? []).every((x) => setB0.has(x.toLowerCase())) &&
    (identityB.activeIngredients ?? []).every((x) => setA0.has(x.toLowerCase()));

  let [monographsA, monographsB, literature] = await Promise.all([
    preMonographsA ?? fetchDrugMonographs(identityA, { fetchImpl, includeDailyMedXml: true }),
    preMonographsB ?? fetchDrugMonographs(identityB, { fetchImpl, includeDailyMedXml: true }),
    isPureSame0
      ? Promise.resolve({ pubmed: { ok: true, articles: [], evidenceDirection: 'none', totalCount: 0 }, webSearch: null })
      : fetchPairLiterature(identityA, identityB, { fetchImpl, includeWebSearch: false }),
  ]);

  let signals = collectPairSignals({
    identityA,
    identityB,
    monographsA,
    monographsB,
    literature,
    localInteractions,
  });

  const r1Steps = [
    {
      tool: 'RxNorm (NLM)',
      status: identityA.rxnorm?.matched && identityB.rxnorm?.matched ? 'matched' : 'partial',
      detail: `${signals.labelA}: ${identityA.rxnorm?.matched ? identityA.primaryIngredient : 'غير مطابق'} | ${signals.labelB}: ${identityB.rxnorm?.matched ? identityB.primaryIngredient : 'غير مطابق'}`,
    },
    {
      tool: 'openFDA Drug Labels',
      status: monographsA.openfda?.found || monographsB.openfda?.found ? 'matched' : monographsA.openfda?.ok && monographsB.openfda?.ok ? 'miss' : 'error',
      detail: `نشرة أ: ${monographsA.openfda?.found ? 'متوفرة' : 'غير متوفرة'} | نشرة ب: ${monographsB.openfda?.found ? 'متوفرة' : 'غير متوفرة'}`,
    },
    {
      tool: 'DailyMed SPL XML',
      status: monographsA.dailymed?.found || monographsB.dailymed?.found ? 'matched' : 'miss',
      detail: `نشرة أ: ${monographsA.dailymed?.found ? (monographsA.dailymed.sections ? 'XML مقروء' : 'بيانات وصفية فقط') : 'غير متوفرة'} | نشرة ب: ${monographsB.dailymed?.found ? (monographsB.dailymed.sections ? 'XML مقروء' : 'بيانات وصفية فقط') : 'غير متوفرة'}`,
    },
  ];
  if (!isPureSame0) {
    r1Steps.push({
      tool: 'PubMed (NCBI)',
      status: literature.pubmed?.ok ? (literature.pubmed.articles?.length > 0 ? 'matched' : 'miss') : 'error',
      detail: literature.pubmed?.ok
        ? `عدد الأبحاث: ${literature.pubmed.totalCount ?? 0} (${literature.pubmed.evidenceDirection})`
        : literature.pubmed?.error || 'تعذر الاتصال',
    });
  }

  rounds.push({
    round: 1,
    phase: 'الجولة الأولى: الفحص الرسمي الموحد',
    reason: 'تطبيق خطة التحقق الأولية عبر المصادر الرسمية الأربعة وقاعدة الصيدلية',
    durationMs: Date.now() - r1Start,
    classificationAfterRound: signals.classification.code,
    steps: r1Steps,
  });

  let webSearchResult = null;
  let collectedWebResults = [];
  const executedWebQueries = new Set();

  const runTrackedWebSearch = async (queries, maxPagesToFetch = 3) => {
    const unseen = filterUnseenQueries(queries, executedWebQueries);
    if (unseen.length === 0) {
      return {
        ok: true,
        skipped: true,
        duplicatePrevented: true,
        configured: webConfigured,
        engineUsed: webSearchResult?.engineUsed ?? null,
        results: [],
      };
    }
    for (const q of unseen) executedWebQueries.add(q.toLowerCase());
    const res = await searchMedicalWeb(
      { queries: unseen, fetchOriginalPages: true, maxPagesToFetch },
      { openserpUrl, searxngUrl, fetchImpl, resolveDns },
    );
    webSearchResult = res;
    if (res?.results?.length) {
      collectedWebResults = mergeWebResults(collectedWebResults, res.results);
    }
    return res;
  };

  // تقييم الحاجة الفعلية لقراءة DailyMed XML الكامل (لا يُجلب بلا داعٍ إذا كفت الأدلة الرسمية أو تطابقت المادة الفعالة)
  const missingXmlA = Boolean(monographsA.dailymed?.found && !monographsA.dailymed?.sections);
  const missingXmlB = Boolean(monographsB.dailymed?.found && !monographsB.dailymed?.sections);
  const hasOpenFdaPositive = signals.positiveEvidences.some((e) => e.sourceName === 'openFDA');
  const pubmedNeedsCrossCheck = ['reports_no_interaction', 'mixed'].includes(literature.pubmed?.evidenceDirection);
  const needsDailyMedXmlForPair =
    !signals.isPureSameActiveIngredient &&
    (missingXmlA || missingXmlB) &&
    (!hasOpenFdaPositive || !monographsA.openfda?.found || !monographsB.openfda?.found || pubmedNeedsCrossCheck);

  // الجولة 2: استدراك النقص أو قراءة DailyMed XML عند الحاجة أو غياب الأدلة
  const needsGapRecovery =
    signals.classification.code === SAFETY_CLASSIFICATION.INSUFFICIENT_INFO.code ||
    (!signals.isPureSameActiveIngredient &&
      !signals.bothHaveSomeOfficialMonograph &&
      signals.classification.code !== SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED.code) ||
    needsDailyMedXmlForPair ||
    (!signals.isPureSameActiveIngredient &&
      signals.classification.code === SAFETY_CLASSIFICATION.NO_INTERACTION_FOUND.code &&
      (literature.pubmed?.totalCount ?? 0) === 0);

  if (needsGapRecovery && !signals.isPureSameActiveIngredient) {
    const gapReason =
      signals.classification.code === SAFETY_CLASSIFICATION.INSUFFICIENT_INFO.code
        ? 'نتيجة أولية غير كافية للحكم (نقص تطابق أو نشرات رسمية)'
        : !signals.bothHaveSomeOfficialMonograph
          ? 'غياب نشرة رسمية لأحد الطرفين في الجولة الأولى'
          : needsDailyMedXmlForPair
            ? 'الحاجة لقراءة نص DailyMed SPL XML الكامل للتحقق من التداخل'
            : 'خلو استعلام PubMed الصارم من نتائج — توسيع البحث عن أدلة إضافية';
    reSearchReasons.push(gapReason);

    const r2Start = Date.now();
    const r2Steps = [];

    if (
      !identityA.rxnorm?.matched ||
      !monographsA.openfda?.found ||
      !monographsA.dailymed?.found ||
      (needsDailyMedXmlForPair && missingXmlA)
    ) {
      const recA = await recoverSingleMedicineGap(identityA, monographsA, {
        fetchImpl,
        openserpUrl,
        searxngUrl,
        resolveDns,
        fetchDailyMedXmlIfMissing: needsDailyMedXmlForPair,
        executedWebQueries,
      });
      identityA = recA.identity;
      monographsA = recA.monographs;
      if (recA.webFindings?.length) collectedWebResults = mergeWebResults(collectedWebResults, recA.webFindings);
      if (recA.webSearchMeta && !webSearchResult) webSearchResult = recA.webSearchMeta;
      for (const act of recA.actions) r2Steps.push({ tool: 'استدراك الدواء الأول', status: 'executed', detail: act });
    }

    if (
      !identityB.rxnorm?.matched ||
      !monographsB.openfda?.found ||
      !monographsB.dailymed?.found ||
      (needsDailyMedXmlForPair && missingXmlB)
    ) {
      const recB = await recoverSingleMedicineGap(identityB, monographsB, {
        fetchImpl,
        openserpUrl,
        searxngUrl,
        resolveDns,
        fetchDailyMedXmlIfMissing: needsDailyMedXmlForPair,
        executedWebQueries,
      });
      identityB = recB.identity;
      monographsB = recB.monographs;
      if (recB.webFindings?.length) collectedWebResults = mergeWebResults(collectedWebResults, recB.webFindings);
      if (recB.webSearchMeta && !webSearchResult) webSearchResult = recB.webSearchMeta;
      for (const act of recB.actions) r2Steps.push({ tool: 'استدراك الدواء الثاني', status: 'executed', detail: act });
    }

    // توسيع بحث PubMed إذا لم يعد استعلام الجولة الأولى أي أبحاث
    const termA = identityA.primaryIngredient || identityA.englishCandidates?.[0];
    const termB = identityB.primaryIngredient || identityB.englishCandidates?.[0];
    if (termA && termB && (literature.pubmed?.totalCount ?? 0) === 0) {
      const broadPm = await searchPubMedInteraction(termA, termB, {
        fetchImpl,
        maxResults: 3,
        mode: 'broad',
      });
      if (broadPm?.ok && broadPm.articles?.length > 0) {
        literature = { ...literature, pubmed: broadPm };
        r2Steps.push({
          tool: 'PubMed (استعلام موسّع)',
          status: 'matched',
          detail: `استُدركت ${broadPm.totalCount} دراسة باستخدام المرادفات والحقول الموسعة (${broadPm.evidenceDirection})`,
        });
      } else {
        r2Steps.push({
          tool: 'PubMed (استعلام موسّع)',
          status: broadPm?.ok ? 'miss' : 'error',
          detail: broadPm?.ok ? 'لا توجد دراسات إضافية بعد التوسيع' : broadPm?.error || 'تعذر الاستعلام الموسع',
        });
      }
    }

    // بحث الويب الطبي عند تفعيل OpenSERP/SearXNG (إما عند طلب صريح أو أثناء استدراك النقص، دون تكرار الاستعلامات)
    if (webConfigured && (includeWebSearch || !signals.bothHaveSomeOfficialMonograph)) {
      const queries = buildWebQueriesForPair(identityA, identityB);
      const pairWebRes = await runTrackedWebSearch(queries, 3);
      if (!pairWebRes.duplicatePrevented) {
        r2Steps.push({
          tool: pairWebRes?.engineUsed || 'OpenSERP / SearXNG',
          status: pairWebRes?.ok ? 'matched' : 'error',
          detail: pairWebRes?.ok
            ? `جُلبت ${pairWebRes.results?.length ?? 0} نتيجة ويب (تُعرض مفصولة ولا تُعتمد سريريًا تلقائيًا)`
            : sanitizeEngineError(pairWebRes?.error, [openserpUrl, searxngUrl]),
        });
      }
    }

    signals = collectPairSignals({
      identityA,
      identityB,
      monographsA,
      monographsB,
      literature,
      localInteractions,
    });

    rounds.push({
      round: 2,
      phase: 'الجولة الثانية: استدراك النقص وإعادة البحث',
      reason: gapReason,
      durationMs: Date.now() - r2Start,
      classificationAfterRound: signals.classification.code,
      steps:
        r2Steps.length > 0
          ? r2Steps
          : [{ tool: 'Adaptive Gap Recovery', status: 'no_new_data', detail: 'لم تظهر معطيات جديدة قابلة للاستخراج' }],
    });
  } else if (includeWebSearch && webConfigured && !signals.isPureSameActiveIngredient) {
    // جولة تكميلية موثّقة في researchTrace عند طلب البحث الشامل لدعم المصادر الإقليمية العربية
    const rWebStart = Date.now();
    const suppReason = 'استكمال المصادر الرسمية ببحث الويب الطبي المفتوح باللغتين العربية والإنجليزية';
    const queries = buildWebQueriesForPair(identityA, identityB);
    const pairWebRes = await runTrackedWebSearch(queries, 3);
    const rWebSteps = [
      {
        tool: pairWebRes?.engineUsed || 'OpenSERP / SearXNG',
        status: pairWebRes?.duplicatePrevented ? 'executed' : pairWebRes?.ok ? 'matched' : 'error',
        detail: pairWebRes?.duplicatePrevented
          ? 'تم الاعتماد على نتائج الويب المستخرجة مسبقًا دون تكرار الاستعلام'
          : pairWebRes?.ok
            ? `جُلبت ${pairWebRes.results?.length ?? 0} نتيجة ويب تكميلية (تُعرض مفصولة ولا تُعتمد سريريًا تلقائيًا)`
            : sanitizeEngineError(pairWebRes?.error, [openserpUrl, searxngUrl]),
      },
    ];
    rounds.push({
      round: rounds.length + 1,
      phase: 'جولة تكميلية: بحث الويب الطبي المفتوح',
      reason: suppReason,
      durationMs: Date.now() - rWebStart,
      classificationAfterRound: signals.classification.code,
      steps: rWebSteps,
    });
  }

  // الجولة 3: التحقق من تعارض المصادر أو تباين النشرات
  const hasConflict = signals.classification.code === SAFETY_CLASSIFICATION.SOURCE_CONFLICT.code;
  const missingDailyMedXmlInConflict =
    hasConflict &&
    ((monographsA.dailymed?.found && !monographsA.dailymed?.sections) ||
      (monographsB.dailymed?.found && !monographsB.dailymed?.sections));

  if (hasConflict) {
    const conflictReason = 'تعارض بين المصادر المكتشفة — تنفيذ جولة تحقق سريرية وتوثيق حسم التعارض';
    reSearchReasons.push(conflictReason);

    const r3Start = Date.now();
    const r3Steps = [];

    if (missingDailyMedXmlInConflict) {
      if (monographsA.dailymed?.found && !monographsA.dailymed?.sections) {
        const dmA = await fetchDailyMedSpl(
          {
            drugName: identityA.primaryIngredient,
            rxcui: identityA.rxnorm?.rxcui,
            setId: monographsA.dailymed?.setId ?? null,
            knownMeta: monographsA.dailymed,
            fetchXml: true,
          },
          { fetchImpl },
        );
        if (dmA?.found) monographsA = { ...monographsA, dailymed: dmA };
      }
      if (monographsB.dailymed?.found && !monographsB.dailymed?.sections) {
        const dmB = await fetchDailyMedSpl(
          {
            drugName: identityB.primaryIngredient,
            rxcui: identityB.rxnorm?.rxcui,
            setId: monographsB.dailymed?.setId ?? null,
            knownMeta: monographsB.dailymed,
            fetchXml: true,
          },
          { fetchImpl },
        );
        if (dmB?.found) monographsB = { ...monographsB, dailymed: dmB };
      }
      r3Steps.push({
        tool: 'DailyMed SPL XML (كامل)',
        status: 'executed',
        detail: 'قراءة النصوص الكاملة لأقسام LOINC في نشرات DailyMed لمقارنتها مع openFDA',
      });
    }

    const termA = identityA.primaryIngredient || identityA.englishCandidates?.[0];
    const termB = identityB.primaryIngredient || identityB.englishCandidates?.[0];
    if (termA && termB) {
      const reviewPm = await searchPubMedInteraction(termA, termB, {
        fetchImpl,
        maxResults: 4,
        mode: 'clinical_review',
      });
      if (reviewPm?.ok && reviewPm.articles?.length > 0) {
        r3Steps.push({
          tool: 'PubMed (مراجعات سريرية)',
          status: 'matched',
          detail: `فُحصت ${reviewPm.articles.length} دراسة/مراجعة سريرية إضافية — الاتجاه: ${reviewPm.evidenceDirection}`,
        });
        const existingArticles = literature.pubmed?.articles ?? [];
        if (existingArticles.length === 0) {
          literature = { ...literature, pubmed: reviewPm };
        } else {
          const seenPmids = new Set(existingArticles.map((a) => String(a.pmid)));
          const mergedArticles = [...existingArticles];
          for (const art of reviewPm.articles) {
            if (!seenPmids.has(String(art.pmid))) {
              seenPmids.add(String(art.pmid));
              mergedArticles.push(art);
            }
          }
          literature = {
            ...literature,
            pubmed: {
              ...literature.pubmed,
              articles: mergedArticles.slice(0, 6),
            },
          };
        }
      } else {
        r3Steps.push({
          tool: 'PubMed (مراجعات سريرية)',
          status: reviewPm?.ok ? 'miss' : 'error',
          detail: reviewPm?.ok ? 'لم تتوفر مراجعات سريرية حاسمة إضافية' : reviewPm?.error || 'تعذر الاستعلام',
        });
      }
    }

    if (webConfigured && executedWebQueries.size === 0) {
      const queries = buildWebQueriesForPair(identityA, identityB);
      const r3Web = await runTrackedWebSearch(queries, 3);
      if (!r3Web.duplicatePrevented) {
        r3Steps.push({
          tool: r3Web?.engineUsed || 'OpenSERP / SearXNG',
          status: r3Web?.ok ? 'matched' : 'error',
          detail: r3Web?.ok
            ? `مقارنة مرجعية عبر ${r3Web.engineUsed}: ${r3Web.results?.length ?? 0} نتيجة`
            : sanitizeEngineError(r3Web?.error, [openserpUrl, searxngUrl]),
        });
      }
    }

    signals = collectPairSignals({
      identityA,
      identityB,
      monographsA,
      monographsB,
      literature,
      localInteractions,
    });

    rounds.push({
      round: rounds.length + 1,
      phase: 'الجولة الثالثة: التحقق من تعارض المصادر',
      reason: conflictReason,
      durationMs: Date.now() - r3Start,
      classificationAfterRound: signals.classification.code,
      steps: r3Steps,
    });
  }

  // حساب الشدة الموثقة والتحذيرات الفردية والملخص العربي
  const severities = signals.positiveEvidences.map((e) => e.severity).filter(Boolean);
  severities.sort((a, b) => severityWeight(a) - severityWeight(b));
  const documentedSeverity = severities[0] ?? (signals.sharedIngredient ? 'moderate' : null);

  const singleWarnings = [
    ...(monographsA.openfda?.primaryLabel
      ? extractClinicalWarningsFromLabel(monographsA.openfda.primaryLabel).map((w) => ({ ...w, medicine: signals.labelA }))
      : []),
    ...(monographsB.openfda?.primaryLabel
      ? extractClinicalWarningsFromLabel(monographsB.openfda.primaryLabel).map((w) => ({ ...w, medicine: signals.labelB }))
      : []),
  ];

  const arabicSummary = buildPairArabicSummary({
    medALabel: signals.labelA,
    medBLabel: signals.labelB,
    classification: signals.classification,
    documentedSeverity,
    evidences:
      signals.evidences.length > 0
        ? signals.evidences
        : signals.checkedOfficialSources.map((s) => ({ sourceName: s })),
    sameIngredient: signals.sharedIngredient,
  });

  const webResults = collectedWebResults.slice(0, 5);

  return {
    identityA,
    identityB,
    monographsA,
    monographsB,
    signals,
    documentedSeverity,
    singleWarnings: singleWarnings.slice(0, 8),
    arabicSummary,
    webSearch: webSearchResult,
    webResults,
    researchTrace: {
      plan,
      roundsExecuted: rounds.length,
      reSearchTriggered: reSearchReasons.length > 0,
      reSearchReasons,
      rounds,
      totalDurationMs: Date.now() - startedAt,
    },
  };
}
