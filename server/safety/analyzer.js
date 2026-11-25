/**
 * محرك التحليل متعدد المصادر لوكيل سلامة الأدوية:
 * - يوحّد أسماء الأدوية عبر RxNorm.
 * - يكشف تطابق المادة الفعالة رغم اختلاف الأسماء التجارية.
 * - يقارن الأدلة من openFDA وDailyMed وPubMed وجدول drug_interactions المحلي.
 * - يستخرج تحذيرات الجرعة والعمر والحالة الصحية والحساسية.
 * - يصنّف كل فحص ضمن التصنيفات الستة المعتمدة فقط، دون اختلاق ودون قول «آمن».
 */

import { CLINICAL_DISCLAIMER } from './constants.js';
import {
  runAutonomousPairResearch,
  runAutonomousSingleResearch,
} from './researchAgent.js';

/**
 * يحلل دواءً واحدًا من حيث: توحيد الهوية، التركيز/الشكل، وتحذيرات الجرعة/العمر/الحالة/الحساسية
 * عبر دورة البحث والتخطيط المستقلة.
 */
export async function analyzeSingleMedicine(
  medicine,
  {
    fetchImpl = fetch,
    openserpUrl = '',
    searxngUrl = '',
    resolveDns = true,
    preResolved = null,
    preMonographs = null,
    includeDailyMedXml = true,
    onResolvedState = null,
  } = {},
) {
  const res = await runAutonomousSingleResearch(medicine, {
    fetchImpl,
    openserpUrl,
    searxngUrl,
    resolveDns,
    preResolved,
    preMonographs,
    includeDailyMedXml,
  });

  const { identity, monographs, warnings, status, webFindings, researchTrace } = res;
  if (typeof onResolvedState === 'function') {
    onResolvedState({ identity, monographs });
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
    webSearchResults: (webFindings ?? []).slice(0, 5),
    researchTrace,
    disclaimer: CLINICAL_DISCLAIMER,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * يحلل زوج دوائين عبر دورة البحث والاستقصاء المستقلة فوق المصادر الرسمية الأربعة (+ OpenSERP/SearXNG عند ضبطهما) وجدول drug_interactions المحلي.
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
    resolveDns = true,
  } = {},
) {
  const res = await runAutonomousPairResearch(medicineA, medicineB, {
    fetchImpl,
    preResolvedA,
    preResolvedB,
    preMonographsA,
    preMonographsB,
    localInteractions,
    includeWebSearch,
    openserpUrl,
    searxngUrl,
    resolveDns,
  });

  const { identityA, identityB, signals, documentedSeverity, singleWarnings, arabicSummary, webResults, researchTrace } = res;

  return {
    pairKey: [identityA.primaryIngredient || signals.labelA, identityB.primaryIngredient || signals.labelB]
      .map((s) => String(s).toLowerCase())
      .sort()
      .join('::'),
    medicineA: {
      id: identityA.medicineId,
      name: signals.labelA,
      scientificName: identityA.originalScientificName,
      primaryIngredient: identityA.primaryIngredient,
      rxcui: identityA.rxnorm?.rxcui ?? null,
    },
    medicineB: {
      id: identityB.medicineId,
      name: signals.labelB,
      scientificName: identityB.originalScientificName,
      primaryIngredient: identityB.primaryIngredient,
      rxcui: identityB.rxnorm?.rxcui ?? null,
    },
    sameActiveIngredient: Boolean(signals.sharedIngredient),
    sharedIngredient: signals.sharedIngredient,
    classification: signals.classification,
    documentedSeverity,
    arabicSummary,
    evidences: signals.evidences,
    evidenceGroups: {
      official: signals.officialEvidences,
      literature: signals.literatureEvidences,
      local: signals.localEvidences,
      webSearch: webResults,
    },
    clinicalWarnings: singleWarnings,
    webSearchResults: webResults,
    checkedOfficialSources: signals.checkedOfficialSources,
    sourceErrors: signals.sourceErrors,
    researchTrace,
    disclaimer: CLINICAL_DISCLAIMER,
    checkedAt: new Date().toISOString(),
  };
}
