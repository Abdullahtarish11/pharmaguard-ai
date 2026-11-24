/**
 * محرك التحليل متعدد المصادر لوكيل سلامة الأدوية:
 * - يوحّد أسماء الأدوية عبر RxNorm.
 * - يكشف تطابق المادة الفعالة رغم اختلاف الأسماء التجارية.
 * - يقارن الأدلة من openFDA وDailyMed وPubMed وجدول drug_interactions المحلي.
 * - يستخرج تحذيرات الجرعة والعمر والحالة الصحية والحساسية.
 * - يصنّف كل فحص ضمن التصنيفات الستة المعتمدة فقط، دون اختلاق ودون قول «آمن».
 */

import { CLINICAL_DISCLAIMER, SAFETY_CLASSIFICATION } from './constants.js';
import {
  extractClinicalWarningsFromLabel,
  extractInteractionEvidenceFromLabel,
} from './sources/openfda.js';
import { extractInteractionFromDailyMed } from './sources/dailymed.js';
import {
  fetchDrugMonographs,
  fetchPairLiterature,
  resolveMedicineIdentity,
} from './sources/index.js';

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

function summarizePairDirection(ev) {
  if (!ev || !ev.mentioned) return 'none';
  if (ev.negated) return 'negated';
  return 'positive';
}

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
 * يحلل دواءً واحدًا من حيث: توحيد الهوية، التركيز/الشكل، وتحذيرات الجرعة/العمر/الحالة/الحساسية.
 */
export async function analyzeSingleMedicine(medicine, { fetchImpl = fetch } = {}) {
  const identity = await resolveMedicineIdentity(medicine, { fetchImpl });
  const monographs = await fetchDrugMonographs(identity, { fetchImpl, includeDailyMedXml: true });

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
    medicine: {
      id: identity.medicineId,
      name: identity.originalName,
      scientificName: identity.originalScientificName,
      strength: identity.strength,
      dosageForm: identity.dosageForm,
    },
    identity,
    monographs: {
      openfdaFound: Boolean(monographs.openfda?.found),
      openfdaError: monographs.openfda?.error ?? null,
      openfdaDate: monographs.openfda?.primaryLabel?.effectiveTime ?? null,
      openfdaUrl: monographs.openfda?.sourceUrl ?? null,
      dailymedFound: Boolean(monographs.dailymed?.found),
      dailymedError: monographs.dailymed?.error ?? null,
      dailymedDate: monographs.dailymed?.publishedDate ?? null,
      dailymedUrl: monographs.dailymed?.sourceUrl ?? null,
    },
    classification: status,
    warnings,
    disclaimer: CLINICAL_DISCLAIMER,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * يحلل زوج دوائين عبر جميع المصادر الطبية المجانية الرسمية (+ OpenSERP عند ضبطه) وجدول drug_interactions المحلي.
 */
export async function analyzeDrugPair(
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
  } = {},
) {
  const [identityA, identityB] = await Promise.all([
    preResolvedA ?? resolveMedicineIdentity(medicineA, { fetchImpl }),
    preResolvedB ?? resolveMedicineIdentity(medicineB, { fetchImpl }),
  ]);

  const labelA = identityA.originalName || identityA.primaryIngredient || 'الدواء الأول';
  const labelB = identityB.originalName || identityB.primaryIngredient || 'الدواء الثاني';

  // فحص تطابق المادة الفعالة بين اسمين تجاريين مختلفين
  const setA = new Set((identityA.activeIngredients ?? []).map((x) => x.toLowerCase()));
  const setB = new Set((identityB.activeIngredients ?? []).map((x) => x.toLowerCase()));
  const sharedIngredient = (identityB.activeIngredients ?? []).find((x) => setA.has(x.toLowerCase())) ?? null;
  const distinctIngredientsA = (identityA.activeIngredients ?? []).filter((x) => !setB.has(x.toLowerCase()));
  const distinctIngredientsB = (identityB.activeIngredients ?? []).filter((x) => !setA.has(x.toLowerCase()));
  const isPureSameActiveIngredient =
    Boolean(sharedIngredient) && distinctIngredientsA.length === 0 && distinctIngredientsB.length === 0;

  const [monographsA, monographsB, literature] = await Promise.all([
    preMonographsA ?? fetchDrugMonographs(identityA, { fetchImpl, includeDailyMedXml: true }),
    preMonographsB ?? fetchDrugMonographs(identityB, { fetchImpl, includeDailyMedXml: true }),
    isPureSameActiveIngredient
      ? Promise.resolve({ pubmed: { ok: true, articles: [], evidenceDirection: 'none', totalCount: 0 }, webSearch: null })
      : fetchPairLiterature(identityA, identityB, { fetchImpl, includeWebSearch, openserpUrl, searxngUrl }),
  ]);

  const evidences = [];
  const sourceErrors = [];
  const checkedOfficialSources = [];

  if (identityA.rxnorm?.ok && identityB.rxnorm?.ok) checkedOfficialSources.push('RxNorm');
  else sourceErrors.push({ source: 'RxNorm', error: identityA.rxnorm?.error || identityB.rxnorm?.error });

  // مصطلحات البحث المقابل تستثني المادة المشتركة حتى لا تطابق النشرة اسم الدواء نفسه
  const sharedLower = new Set(
    (identityA.activeIngredients ?? [])
      .filter((x) => setB.has(x.toLowerCase()))
      .map((x) => x.toLowerCase()),
  );
  const crossTermsForB = (identityB.searchTerms ?? []).filter((t) => !sharedLower.has(t.toLowerCase()));
  const crossTermsForA = (identityA.searchTerms ?? []).filter((t) => !sharedLower.has(t.toLowerCase()));

  // 1) openFDA: فحص نشرة أ بحثًا عن ب + نشرة ب بحثًا عن أ
  const fdaOkCount = (monographsA.openfda?.ok ? 1 : 0) + (monographsB.openfda?.ok ? 1 : 0);
  if (fdaOkCount > 0) checkedOfficialSources.push('openFDA');
  if (!monographsA.openfda?.ok) sourceErrors.push({ source: 'openFDA (A)', error: monographsA.openfda?.error });
  if (!monographsB.openfda?.ok) sourceErrors.push({ source: 'openFDA (B)', error: monographsB.openfda?.error });

  const fdaEvA = !isPureSameActiveIngredient && monographsA.openfda?.found && crossTermsForB.length > 0
    ? extractInteractionEvidenceFromLabel(monographsA.openfda.primaryLabel, crossTermsForB)
    : null;
  const fdaEvB = !isPureSameActiveIngredient && monographsB.openfda?.found && crossTermsForA.length > 0
    ? extractInteractionEvidenceFromLabel(monographsB.openfda.primaryLabel, crossTermsForA)
    : null;

  for (const [ev, dirLabel] of [
    [fdaEvA, `${labelA} → ${labelB}`],
    [fdaEvB, `${labelB} → ${labelA}`],
  ]) {
    if (ev?.mentioned) {
      evidences.push({
        sourceName: 'openFDA',
        direction: summarizePairDirection(ev),
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

  // 2) DailyMed SPL XML: فحص مستقل من النشرات الرسمية
  const dmOkCount = (monographsA.dailymed?.ok ? 1 : 0) + (monographsB.dailymed?.ok ? 1 : 0);
  if (dmOkCount > 0) checkedOfficialSources.push('DailyMed');
  if (!monographsA.dailymed?.ok) sourceErrors.push({ source: 'DailyMed (A)', error: monographsA.dailymed?.error });
  if (!monographsB.dailymed?.ok) sourceErrors.push({ source: 'DailyMed (B)', error: monographsB.dailymed?.error });

  const dmEvA = !isPureSameActiveIngredient && monographsA.dailymed?.found && crossTermsForB.length > 0
    ? extractInteractionFromDailyMed(monographsA.dailymed, crossTermsForB)
    : null;
  const dmEvB = !isPureSameActiveIngredient && monographsB.dailymed?.found && crossTermsForA.length > 0
    ? extractInteractionFromDailyMed(monographsB.dailymed, crossTermsForA)
    : null;

  for (const [ev, dirLabel] of [
    [dmEvA, `${labelA} → ${labelB}`],
    [dmEvB, `${labelB} → ${labelA}`],
  ]) {
    if (ev?.mentioned) {
      evidences.push({
        sourceName: 'DailyMed',
        direction: summarizePairDirection(ev),
        severity: ev.severity,
        originalText: ev.snippets.join(' | '),
        sourceUrl: ev.sourceUrl,
        publishedDate: ev.publishedDate,
        issuer: ev.issuer,
        note: dirLabel,
      });
    }
  }

  // عند تطابق المادة الفعالة بين اسمين تجاريين مختلفين، نضيف دليل RxNorm الموثق
  if (sharedIngredient && identityA.rxnorm?.matched && identityB.rxnorm?.matched) {
    evidences.push({
      sourceName: 'RxNorm',
      direction: 'warning',
      severity: 'moderate',
      originalText: `Both "${labelA}" (RxCUI ${identityA.rxnorm.rxcui}) and "${labelB}" (RxCUI ${identityB.rxnorm.rxcui}) resolve to active ingredient "${sharedIngredient}".`,
      sourceUrl: identityA.rxnorm.sourceUrl,
      publishedDate: null,
      issuer: 'U.S. National Library of Medicine (RxNorm)',
    });
  }

  // 3) PubMed: أبحاث علمية محكمة
  if (literature.pubmed?.ok) {
    checkedOfficialSources.push('PubMed');
    if (literature.pubmed.articles?.length > 0 && literature.pubmed.evidenceDirection !== 'none') {
      const top = literature.pubmed.articles[0];
      evidences.push({
        sourceName: 'PubMed',
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

  // 4) قاعدة drug_interactions المحلية بالصيدلية
  const localMatches = findMatchingLocalInteractions(identityA, identityB, localInteractions);
  for (const row of localMatches) {
    evidences.push({
      sourceName: row.source ? `جدول الصيدلية (${row.source})` : 'جدول drug_interactions المحلي',
      direction: 'positive',
      severity: row.severity ?? null,
      originalText: row.description || `${row.drugA} + ${row.drugB}`,
      sourceUrl: null,
      publishedDate: null,
      issuer: row.source || 'قاعدة الصيدلية المحلية',
    });
  }

  // 5) بحث الويب المفتوح (OpenSERP/SearXNG) إن فُعّل — لا يُعتمد تلقائيًا كدليل طبي بمفرده
  const webFindings = literature.webSearch?.results ?? [];

  // 6) التصنيف الدقيق وفق الحالات الست الصارمة
  const positiveEvidences = evidences.filter((e) => e.direction === 'positive');
  const negatedEvidences = evidences.filter((e) => e.direction === 'negated');
  const mixedEvidences = evidences.filter((e) => e.direction === 'mixed');

  const bothHaveSomeOfficialMonograph =
    (monographsA.openfda?.found || monographsA.dailymed?.found) &&
    (monographsB.openfda?.found || monographsB.dailymed?.found);

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

  // شدة التداخل تؤخذ حصريًا من الأدلة الموثقة دون تخمين
  const severities = positiveEvidences.map((e) => e.severity).filter(Boolean);
  severities.sort((a, b) => severityWeight(a) - severityWeight(b));
  const documentedSeverity = severities[0] ?? (sharedIngredient ? 'moderate' : null);

  // استخراج تحذيرات الجرعة/العمر/الحالة/الحساسية للدوائين
  const singleWarnings = [
    ...(monographsA.openfda?.primaryLabel ? extractClinicalWarningsFromLabel(monographsA.openfda.primaryLabel).map((w) => ({ ...w, medicine: labelA })) : []),
    ...(monographsB.openfda?.primaryLabel ? extractClinicalWarningsFromLabel(monographsB.openfda.primaryLabel).map((w) => ({ ...w, medicine: labelB })) : []),
  ];

  const arabicSummary = buildPairArabicSummary({
    medALabel: labelA,
    medBLabel: labelB,
    classification,
    documentedSeverity,
    evidences: evidences.length > 0 ? evidences : checkedOfficialSources.map((s) => ({ sourceName: s })),
    sameIngredient: sharedIngredient,
  });

  return {
    pairKey: [identityA.primaryIngredient || labelA, identityB.primaryIngredient || labelB]
      .map((s) => String(s).toLowerCase())
      .sort()
      .join('::'),
    medicineA: {
      id: identityA.medicineId,
      name: labelA,
      scientificName: identityA.originalScientificName,
      primaryIngredient: identityA.primaryIngredient,
      rxcui: identityA.rxnorm?.rxcui ?? null,
    },
    medicineB: {
      id: identityB.medicineId,
      name: labelB,
      scientificName: identityB.originalScientificName,
      primaryIngredient: identityB.primaryIngredient,
      rxcui: identityB.rxnorm?.rxcui ?? null,
    },
    sameActiveIngredient: Boolean(sharedIngredient),
    sharedIngredient,
    classification,
    documentedSeverity,
    arabicSummary,
    evidences,
    clinicalWarnings: singleWarnings.slice(0, 8),
    webSearchResults: webFindings.slice(0, 5),
    checkedOfficialSources: [...new Set(checkedOfficialSources)],
    sourceErrors,
    disclaimer: CLINICAL_DISCLAIMER,
    checkedAt: new Date().toISOString(),
  };
}
