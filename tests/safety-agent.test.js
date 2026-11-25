import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBilingualDrugInput } from '../server/safety/bilingual.js';
import { CLINICAL_DISCLAIMER, SAFETY_CLASSIFICATION } from '../server/safety/constants.js';
import { clearRxNormCache } from '../server/safety/sources/rxnorm.js';
import { clearOpenFdaCache } from '../server/safety/sources/openfda.js';
import { clearDailyMedCache } from '../server/safety/sources/dailymed.js';
import { clearPubMedCache } from '../server/safety/sources/pubmed.js';
import {
  classifySourceReliability,
  getSearchEngineConfigStatus,
  probeSearchEngines,
  sanitizeEngineError,
  searchMedicalWeb,
  validateSafePublicUrl,
} from '../server/safety/sources/openserp.js';
import { interactionsFor } from '../server/routes/agent.js';
import { getSourcesTelemetry } from '../server/safety/sources/index.js';
import { buildResearchPlan } from '../server/safety/researchAgent.js';
import { analyzeDrugPair, analyzeSingleMedicine } from '../server/safety/analyzer.js';
import { inspectSafetyStorageCompatibility } from '../server/safety/storageCompat.js';
import {
  __resetSafetyWorkerForTests,
  enqueueSafetyTask,
  executeSafetyResearchTask,
  getSafetyStatusForPharmacy,
  notifySafetyMedicineChange,
} from '../server/safety/worker.js';

function resetAllCaches() {
  clearRxNormCache();
  clearOpenFdaCache();
  clearDailyMedCache();
  clearPubMedCache();
}

// 1) اختبار التطبيع العربي والإنجليزي واستخراج التركيز والشكل الدوائي
test('1. التطبيع ثنائي اللغة يقرأ الأسماء العربية والإنجليزية والتركيز والشكل دون تشويه', () => {
  const arMed = normalizeBilingualDrugInput({
    name: 'زوكور 20 مجم أقراص',
    scientificName: 'سيمفاستاتين',
  });
  assert.equal(arMed.primaryQueryEn, 'simvastatin');
  assert.equal(arMed.dosageForm, 'tablet');
  assert.ok(arMed.strength?.includes('20'));
  assert.ok(arMed.arabicTerms.includes('سيمفاستاتين'));

  const arMacrolide = normalizeBilingualDrugInput('كلاريثروميسين 500mg Film-Coated Tablets');
  assert.equal(arMacrolide.primaryQueryEn, 'clarithromycin');
  assert.equal(arMacrolide.dosageForm, 'tablet');
  assert.equal(arMacrolide.strength, '500mg');
});

// 2) الاختبار الحقيقي المباشر (Live APIs): Simvastatin + Clarithromycin عبر RxNorm + openFDA + DailyMed + PubMed
test('2. التحقق الحي من المصادر الرسمية الأصلية: Simvastatin + Clarithromycin', async () => {
  resetAllCaches();
  const result = await analyzeDrugPair(
    { id: 'sim-1', name: 'سيمفاستاتين', scientificName: 'Simvastatin' },
    { id: 'cla-1', name: 'كلاريثروميسين', scientificName: 'Clarithromycin' },
  );

  assert.equal(result.medicineA.primaryIngredient.toLowerCase(), 'simvastatin');
  assert.equal(result.medicineB.primaryIngredient.toLowerCase(), 'clarithromycin');
  assert.equal(result.classification.code, SAFETY_CLASSIFICATION.DOCUMENTED_INTERACTION.code);
  assert.equal(result.classification.label, 'تداخل دوائي موثق بمصدر موثوق');
  assert.ok(['contraindicated', 'major', 'critical'].includes(result.documentedSeverity));
  assert.ok(result.evidences.length >= 2, 'يجب أن تؤكد أكثر من جهة رسمية وجود التداخل');

  const hasFda = result.evidences.some((e) => e.sourceName === 'openFDA' && e.sourceUrl?.includes('dailymed'));
  const hasPubMed = result.evidences.some((e) => e.sourceName === 'PubMed' && e.sourceUrl?.includes('pubmed.ncbi.nlm.nih.gov'));
  assert.equal(hasFda, true, 'يجب أن يعيد دليل openFDA رابط النشرة الرسمية');
  assert.equal(hasPubMed, true, 'يجب أن يعيد PubMed بحثًا موثقًا');
  assert.ok(result.clinicalWarnings.length > 0, 'يجب استخراج تحذيرات الجرعة/الحالة/الحساسية الموثقة');
  assert.equal(result.disclaimer, CLINICAL_DISCLAIMER);
  assert.ok(result.researchTrace?.plan?.goal);
  assert.ok(result.researchTrace?.roundsExecuted >= 1);
  assert.ok(Array.isArray(result.evidenceGroups?.official));
  assert.ok(Array.isArray(result.evidenceGroups?.literature));
  assert.ok(Array.isArray(result.evidenceGroups?.webSearch));
});

// 3) اختبار اسمين تجاريين مختلفين لنفس المادة الفعالة (Live RxNorm)
test('3. كشف تطابق المادة الفعالة بين اسمين تجاريين مختلفين (Zocor و Simvastatin)', async () => {
  resetAllCaches();
  const result = await analyzeDrugPair(
    { id: 'brand-1', name: 'Zocor 20mg' },
    { id: 'brand-2', name: 'Simvastatin 40mg' },
  );

  assert.equal(result.sameActiveIngredient, true);
  assert.equal(result.sharedIngredient.toLowerCase(), 'simvastatin');
  assert.equal(result.classification.code, SAFETY_CLASSIFICATION.DOCUMENTED_WARNING.code);
  assert.ok(result.arabicSummary.includes('تطابق في المادة الفعالة'));
});

// 4) اختبار دواء غير موجود في قاعدة البيانات + عدم قول "آمن" أبدًا
test('4. دواء غير موجود في المصادر يُصنف "معلومات غير كافية للحكم" ولا يعرض كلمة "آمن" وحدها', async () => {
  resetAllCaches();
  const result = await analyzeDrugPair(
    { name: 'XyzUnknownDrug999111' },
    { name: 'Simvastatin' },
  );

  assert.equal(result.classification.code, SAFETY_CLASSIFICATION.INSUFFICIENT_INFO.code);
  assert.equal(result.classification.label, 'معلومات غير كافية للحكم');
  assert.ok(!/^\s*آمن\s*$/.test(result.arabicSummary));
  assert.equal(result.researchTrace.reSearchTriggered, true);
  assert.ok(result.researchTrace.roundsExecuted >= 2);
});

// 5) اختبار فشل الوصول للمصادر + تعارض المصادر + جولة التحقق من التعارض
test('5. تعامل المحلل مع تعطل المصادر وتعارض المصادر وتشغيل جولة حسم التعارض', async () => {
  const failingFetch = async () => {
    throw new Error('ECONNREFUSED upstream');
  };
  const failed = await analyzeDrugPair({ name: 'Simvastatin' }, { name: 'Clarithromycin' }, { fetchImpl: failingFetch });
  assert.equal(failed.classification.code, SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED.code);
  assert.equal(failed.classification.label, 'فشل الوصول إلى المصدر');

  // محاكاة تعارض مصادر: openFDA يوثق تداخلًا شديدًا بينما DailyMed يقول no clinically significant interaction
  let pubmedCalls = 0;
  const conflictFetch = async (url) => {
    const u = String(url);
    if (u.includes('rxnav.nlm.nih.gov')) {
      const isOne = u.toLowerCase().includes('drugone') || u.includes('/1001');
      const name = isOne ? 'DrugOne' : 'DrugTwo';
      const rxcui = isOne ? '1001' : '1002';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          idGroup: { rxnormId: [rxcui] },
          properties: { rxcui, name, tty: 'IN' },
          relatedGroup: { conceptGroup: [] },
        }),
      };
    }
    if (u.includes('api.fda.gov')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              set_id: 'set-1',
              effective_time: '20260115',
              openfda: { brand_name: ['DrugOne'], generic_name: ['DrugOne'] },
              drug_interactions: ['Concomitant use with DrugTwo is contraindicated due to severe toxicity.'],
            },
          ],
        }),
      };
    }
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('spls.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ setid: 'dm-1', title: 'DrugOne', published_date: '2026-01-20' }] }),
      };
    }
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('.xml')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<section><code code="34073-7"/>DrugTwo did not affect levels and no clinically significant interaction was observed.</section>',
      };
    }
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      pubmedCalls += 1;
      return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const conflicted = await analyzeDrugPair(
    { name: 'DrugOne' },
    { name: 'DrugTwo' },
    { fetchImpl: conflictFetch },
  );
  assert.equal(conflicted.classification.code, SAFETY_CLASSIFICATION.SOURCE_CONFLICT.code);
  assert.equal(conflicted.classification.label, 'تعارض بين المصادر');
  assert.equal(conflicted.researchTrace.reSearchTriggered, true);
  assert.ok(pubmedCalls >= 2, 'يجب أن يعيد الوكيل البحث في PubMed أثناء جولة التعارض');
  assert.ok(conflicted.researchTrace.rounds.some((r) => r.phase.includes('تعارض')));

  const cleanSingle = await analyzeSingleMedicine({ name: 'NonExistentTestMedZZZ' }, { fetchImpl: failingFetch });
  assert.equal(cleanSingle.classification.code, SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED.code);
});

// 6) اختبار OpenSERP + SearXNG fallback + استخراج الصفحة الأصلية + SSRF + عدم اعتماد الويب العام
test('6. محرك البحث OpenSERP/SearXNG يرتب الموثوقية، يستخرج الصفحة الأصلية، ويحجب الروابط الداخلية', async () => {
  const localBlock = await validateSafePublicUrl('http://127.0.0.1:8080/admin', { resolveDns: false });
  assert.equal(localBlock.safe, false);
  const metaBlock = await validateSafePublicUrl('http://169.254.169.254/latest/meta-data', { resolveDns: false });
  assert.equal(metaBlock.safe, false);

  const generalTier = classifySourceReliability('https://random-blog.example/drugs');
  assert.equal(generalTier.clinicallyCertified, false);
  const fdaTier = classifySourceReliability('https://www.fda.gov/drugs/safety');
  assert.equal(fdaTier.clinicallyCertified, true);

  const statusUnconfigured = getSearchEngineConfigStatus({ openserpUrl: '', searxngUrl: '   ' });
  assert.equal(statusUnconfigured.configured, false);
  assert.equal(statusUnconfigured.status, 'not_configured');
  assert.equal(statusUnconfigured.statusLabel, 'غير مُعد');
  assert.equal(statusUnconfigured.mode, 'official_sources_only');

  const unconfigured = await searchMedicalWeb(
    { queries: ['simvastatin clarithromycin'] },
    { openserpUrl: '', searxngUrl: '   ' },
  );
  assert.equal(unconfigured.ok, true);
  assert.equal(unconfigured.skipped, true);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.status, 'not_configured');
  assert.equal(unconfigured.statusLabel, 'غير مُعد');
  assert.equal(unconfigured.error, null);
  assert.deepEqual(unconfigured.results, []);

  const mockWebFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://openserp.test')) {
      throw new Error('OpenSERP down');
    }
    if (u.startsWith('https://searxng.test')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'Random Blog', url: 'https://blog.example.com/post', content: 'snippet' },
            { title: 'SFDA Drug Safety', url: 'https://www.sfda.gov.sa/en/warnings/simvastatin', content: 'official warning' },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '<html><head><title>SFDA Official Warning</title></head><body><p>Simvastatin clarithromycin contraindicated.</p></body></html>',
    };
  };

  const searchRes = await searchMedicalWeb(
    { queries: ['simvastatin clarithromycin'], maxPagesToFetch: 2 },
    { openserpUrl: 'https://openserp.test', searxngUrl: 'https://searxng.test', fetchImpl: mockWebFetch, resolveDns: false },
  );
  assert.equal(searchRes.ok, true);
  assert.equal(searchRes.engineUsed, 'SearXNG');
  assert.equal(searchRes.results[0].tier, 'official_authority');
  assert.equal(searchRes.results[0].pageExtracted, true);
  assert.equal(searchRes.results[1].clinicallyCertified, false);
  assert.ok(searchRes.results[1].nonAuthoritativeNotice);
});

// 7) اختبار التشغيل التلقائي عند إضافة دواء + الفحص الدوري + منع التكرار + طابور الإعادة
test('7. العامل الخلفي يشغل الفحص عند إضافة دواء، يمنع التكرار، ويسجل النتائج دون تعديل DB', async () => {
  __resetSafetyWorkerForTests();

  const dedup1 = notifySafetyMedicineChange('ph-1', 'إضافة دواء جديد', 'm1');
  const dedup2 = enqueueSafetyTask({ pharmacyId: 'ph-1', trigger: 'reactive', targetMedicineId: 'm1', force: false });
  assert.equal(dedup1.queued, true);
  assert.equal(dedup2.deduplicated, true);

  const mockAdmin = {
    from(table) {
      const payload =
        table === 'medicines'
          ? {
              data: [
                { id: 'm1', name: 'Simvastatin 20mg', scientific_name: 'Simvastatin', pharmacy_id: 'ph-1', is_active: true },
                { id: 'm2', name: 'Clarithromycin 500mg', scientific_name: 'Clarithromycin', pharmacy_id: 'ph-1', is_active: true },
              ],
              error: null,
            }
          : { data: [], error: null };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        limit() { return chain; },
        then(onFulfilled, onRejected) {
          return Promise.resolve(payload).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };

  const mockColumns = async () => ({
    schemaOk: true,
    medicines: {
      id: 'id',
      name: 'name',
      scientificName: 'scientific_name',
      pharmacy: 'pharmacy_id',
      isActive: 'is_active',
    },
    interactions: { id: 'id', drugA: 'drug_a', drugB: 'drug_b', severity: 'severity', description: 'description', source: 'source_name' },
    tables: { medicines: { columns: [] }, agent_runs: { columns: [] }, reports: { columns: [] }, inventory_alerts: { columns: [] } },
  });

  const mockMedicalFetch = async (url) => {
    const u = String(url);
    if (u.includes('rxnav.nlm.nih.gov')) {
      const isSim = u.toLowerCase().includes('simvastatin') || u.includes('/36567/');
      const rxcui = isSim ? '36567' : '21212';
      const name = isSim ? 'simvastatin' : 'clarithromycin';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          idGroup: { rxnormId: [rxcui] },
          properties: { rxcui, name, tty: 'IN' },
          relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [{ rxcui, name }] }] },
        }),
      };
    }
    if (u.includes('api.fda.gov')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              set_id: 'set-sim',
              effective_time: '20260226',
              openfda: { generic_name: ['SIMVASTATIN'] },
              contraindications: ['Concomitant administration of strong CYP3A4 inhibitors (e.g., clarithromycin) is contraindicated.'],
              drug_interactions: ['Clarithromycin increases simvastatin levels and risk of myopathy/rhabdomyolysis.'],
            },
          ],
        }),
      };
    }
    if (u.includes('dailymed.nlm.nih.gov')) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const run1 = await executeSafetyResearchTask(
    { pharmacyId: 'ph-1', trigger: 'reactive', reason: 'إضافة دواء', targetMedicineId: 'm1', force: true },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: mockMedicalFetch },
  );
  assert.equal(run1.skipped, false);
  assert.equal(run1.medicinesAnalyzed, 2);
  assert.equal(run1.pairsChecked, 1);
  assert.equal(run1.persistence.skippedReason, 'condition_7_verification_required');

  const run2 = await executeSafetyResearchTask(
    { pharmacyId: 'ph-1', trigger: 'reactive', reason: 'إعادة مطابقة', targetMedicineId: 'm1', force: false },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: mockMedicalFetch },
  );
  assert.equal(run2.skipped, true);
  assert.equal(run2.reason, 'unchanged_inventory_deduplicated');

  const status = getSafetyStatusForPharmacy('ph-1');
  assert.equal(status.pharmacy.counts.documented_interaction, 1);
  assert.equal(status.pharmacy.pairFindings[0].classification.code, 'documented_interaction');
  assert.ok(status.pharmacy.pairFindings[0].researchTrace?.roundsExecuted >= 1);
});

// 8) اختبار فحص توافق التخزين (الشرط #7) لجداول agent_runs و reports و inventory_alerts
test('8. فحص توافق التخزين يعرض الأعمدة والأنواع والقيود لـ agent_runs وreports وinventory_alerts دون تعديل', () => {
  const compat = inspectSafetyStorageCompatibility({
    schema: {
      ok: true,
      tables: {
        agent_runs: {
          columns: [
            { name: 'id', type: 'uuid', required: true, primaryKey: true },
            { name: 'agent_type', type: 'text', required: false },
            { name: 'prompt', type: 'text', required: true },
            { name: 'answer', type: 'text', required: false },
            { name: 'status', type: 'text', required: false },
            { name: 'pharmacy_id', type: 'uuid', required: false, foreignKey: true },
          ],
        },
        reports: {
          columns: [
            { name: 'id', type: 'uuid', required: true, primaryKey: true },
            { name: 'report_type', type: 'text', required: false },
            { name: 'title', type: 'text', required: true },
            { name: 'payload', type: 'jsonb', required: false },
            { name: 'pharmacy_id', type: 'uuid', required: false },
          ],
        },
        inventory_alerts: {
          columns: [
            { name: 'id', type: 'uuid', required: true, primaryKey: true },
            { name: 'alert_type', type: 'alert_type_enum', required: true, enumValues: ['low_stock', 'expired_batch'] },
            { name: 'severity', type: 'text', required: false },
            { name: 'message', type: 'text', required: true },
            { name: 'pharmacy_id', type: 'uuid', required: false },
          ],
        },
      },
    },
    agentRuns: { id: 'id', agentType: 'agent_type', prompt: 'prompt', answer: 'answer', status: 'status', pharmacy: 'pharmacy_id' },
    reports: { id: 'id', type: 'report_type', title: 'title', payload: 'payload', pharmacy: 'pharmacy_id' },
    alerts: { id: 'id', type: 'alert_type', severity: 'severity', message: 'message', pharmacy: 'pharmacy_id' },
  });

  assert.equal(compat.ok, true);
  assert.equal(compat.allCompatible, true);
  assert.equal(compat.tables.length, 3);
  const alertsTable = compat.tables.find((t) => t.table === 'inventory_alerts');
  assert.ok(alertsTable.notes.some((n) => n.includes('drug_interaction')));
  assert.ok(compat.sqlInspectionQuery.includes('pg_constraint'));
});

// 9) اختبار محاكاة الخطة المستقلة واستدراك الاسم المجهول عبر OpenSERP (/v1/mega/search) -> RxNorm
test('9. [محاكاة] الوكيل يبني خطة، يكتشف المادة الفعالة من بوابة رسمية عبر OpenSERP (/v1) ويعيد البحث في RxNorm وopenFDA', async () => {
  const plan = buildResearchPlan({
    mode: 'pair',
    medicineA: { name: 'دواء إقليمي غير مسجل' },
    medicineB: { name: 'Clarithromycin' },
    openserpUrl: 'https://openserp.mock',
    searxngUrl: 'https://searxng.mock',
    localInteractionsCount: 2,
  });
  assert.equal(plan.languageProfile.code, 'bilingual');
  assert.ok(plan.plannedTools.some((t) => t.id === 'web_search'));
  assert.ok(plan.plannedTools.some((t) => t.id === 'local_db'));

  const adaptiveFetch = async (url) => {
    const u = String(url);
    if (u.includes('rxnav.nlm.nih.gov')) {
      if (u.toLowerCase().includes('atorvastatin') || u.includes('/83367')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            idGroup: { rxnormId: ['83367'] },
            properties: { rxcui: '83367', name: 'atorvastatin', tty: 'IN' },
            relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [{ rxcui: '83367', name: 'atorvastatin' }] }] },
          }),
        };
      }
      if (u.toLowerCase().includes('clarithromycin') || u.includes('/21212')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            idGroup: { rxnormId: ['21212'] },
            properties: { rxcui: '21212', name: 'clarithromycin', tty: 'IN' },
            relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [{ rxcui: '21212', name: 'clarithromycin' }] }] },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ idGroup: {}, approximateGroup: { candidate: [] } }) };
    }
    if (u.startsWith('https://openserp.mock/mega/search')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.startsWith('https://openserp.mock/v1/mega/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { title: 'SFDA Drug Monograph', url: 'https://www.sfda.gov.sa/en/drugs/localbrand', description: 'SFDA record' },
          ],
        }),
      };
    }
    if (u.startsWith('https://www.sfda.gov.sa/')) {
      return {
        ok: true,
        status: 200,
        text: async () => '<html><title>SFDA LocalBrand</title><body>Active ingredient: atorvastatin 20mg film-coated tablet.</body></html>',
      };
    }
    if (u.includes('api.fda.gov')) {
      if (u.toLowerCase().includes('atorvastatin')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                set_id: 'fda-ator',
                effective_time: '20260301',
                openfda: { generic_name: ['ATORVASTATIN'] },
                drug_interactions: ['Clarithromycin significantly increases atorvastatin plasma levels and risk of myopathy.'],
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    if (u.includes('dailymed.nlm.nih.gov')) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const result = await analyzeDrugPair(
    { name: 'LocalBrandX' },
    { name: 'Clarithromycin' },
    {
      fetchImpl: adaptiveFetch,
      openserpUrl: 'https://openserp.mock',
      searxngUrl: 'https://searxng.mock',
      resolveDns: false,
    },
  );

  assert.equal(result.medicineA.primaryIngredient.toLowerCase(), 'atorvastatin');
  assert.equal(result.classification.code, SAFETY_CLASSIFICATION.DOCUMENTED_INTERACTION.code);
  assert.equal(result.researchTrace.reSearchTriggered, true);
  assert.ok(result.evidenceGroups.official.length >= 1);
});

// 10) اختبار محاكاة فحص الجاهزية الحية لمحركات البحث (probeSearchEngines)
test('10. [محاكاة] فحص الجاهزية probeSearchEngines يميز بدقة بين غير مُعد ومتصل ومتعثر', async () => {
  const unconf = await probeSearchEngines({ openserpUrl: '', searxngUrl: '' });
  assert.equal(unconf.tested, false);
  assert.equal(unconf.status, 'not_configured');
  assert.equal(unconf.statusLabel, 'غير مُعد');

  const mixedProbe = await probeSearchEngines({
    openserpUrl: 'https://openserp.mock',
    searxngUrl: 'https://searxng.mock',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://openserp.mock')) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ results: [{ title: 'OK', url: 'https://www.fda.gov/aspirin' }] }) };
    },
  });
  assert.equal(mixedProbe.tested, true);
  assert.equal(mixedProbe.primary.reachable, false);
  assert.equal(mixedProbe.fallback.reachable, true);
  assert.equal(mixedProbe.status, 'connected');
});

// 11) [محاكاة] إزالة استدعاءات RxNorm وopenFDA وDailyMed المكررة في worker.js
test('11. [محاكاة] worker.js يعيد استخدام الهوية والنشرات دون استدعاءات مكررة لـ RxNorm/openFDA/DailyMed', async () => {
  __resetSafetyWorkerForTests();

  const counts = { rxnormLookups: 0, rxnormHttp: 0, openfda: 0, dailymedList: 0, dailymedXml: 0, pubmed: 0 };
  const mockAdmin = {
    from(table) {
      const payload =
        table === 'medicines'
          ? {
              data: [
                { id: 'm1', name: 'Simvastatin 20mg', scientific_name: 'Simvastatin', pharmacy_id: 'ph-dedup', is_active: true },
                { id: 'm2', name: 'Clarithromycin 500mg', scientific_name: 'Clarithromycin', pharmacy_id: 'ph-dedup', is_active: true },
              ],
              error: null,
            }
          : { data: [], error: null };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        limit() { return chain; },
        then(onFulfilled, onRejected) {
          return Promise.resolve(payload).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };

  const mockColumns = async () => ({
    schemaOk: true,
    medicines: { id: 'id', name: 'name', scientificName: 'scientific_name', pharmacy: 'pharmacy_id', isActive: 'is_active' },
    interactions: { id: 'id', drugA: 'drug_a', drugB: 'drug_b', severity: 'severity', description: 'description', source: 'source_name', pharmacy: 'pharmacy_id' },
    tables: { medicines: { columns: [] }, agent_runs: { columns: [] }, reports: { columns: [] }, inventory_alerts: { columns: [] } },
  });

  const countingFetch = async (url) => {
    const u = String(url);
    if (u.includes('rxnav.nlm.nih.gov')) {
      counts.rxnormHttp += 1;
      if (u.includes('/rxcui.json')) counts.rxnormLookups += 1;
      const isSim = u.toLowerCase().includes('simvastatin') || u.includes('/36567/');
      const rxcui = isSim ? '36567' : '21212';
      const name = isSim ? 'simvastatin' : 'clarithromycin';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          idGroup: { rxnormId: [rxcui] },
          properties: { rxcui, name, tty: 'IN' },
          relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [{ rxcui, name }] }] },
        }),
      };
    }
    if (u.includes('api.fda.gov')) {
      counts.openfda += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              set_id: 'fda-1',
              effective_time: '20260301',
              openfda: { generic_name: ['SIMVASTATIN'] },
              contraindications: ['Concomitant clarithromycin is contraindicated.'],
              drug_interactions: ['Clarithromycin increases simvastatin exposure.'],
            },
          ],
        }),
      };
    }
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('spls.json')) {
      counts.dailymedList += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ setid: 'dm-sim-1', title: 'Simvastatin', published_date: '2026-03-01' }] }),
      };
    }
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('.xml')) {
      counts.dailymedXml += 1;
      return { ok: true, status: 200, text: async () => '<section><code code="34073-7"/>No details.</section>' };
    }
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      counts.pubmed += 1;
      return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const res = await executeSafetyResearchTask(
    { pharmacyId: 'ph-dedup', trigger: 'periodic', force: true },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: countingFetch },
  );

  assert.equal(res.medicinesAnalyzed, 2);
  assert.equal(res.pairsChecked, 1);
  assert.equal(counts.rxnormLookups, 2, 'RxNorm rxcui.json يجب أن يُستدعى مرة واحدة لكل دواء دون تكرار');
  assert.equal(counts.rxnormHttp, 6, 'إجمالي طلبات RxNorm لدوائين هو 6 فقط (3 لكل دواء) دون تكرار في analyzeDrugPair');
  assert.equal(counts.openfda, 2, 'openFDA يجب أن يُستدعى مرة واحدة لكل دواء دون تكرار عند فحص الزوج');
  assert.equal(counts.dailymedList, 2, 'DailyMed spls.json يجب أن يُستدعى مرة واحدة لكل دواء فقط');
  assert.equal(counts.dailymedXml, 0, 'لا يجب جلب DailyMed XML الكامل عندما تكفي نشرة openFDA الموثقة');
});

// 12) [محاكاة] تمرير بيانات DailyMed إلى analyzeDrugPair وجلب XML عند الحاجة الفعلية فقط
test('12. [محاكاة] analyzeDrugPair يجلب DailyMed XML عبر setId عند غياب دليل openFDA ولا يجلبه عند تطابق المادة الفعالة', async () => {
  let splListCalls = 0;
  let splXmlCalls = 0;

  const lazyXmlFetch = async (url) => {
    const u = String(url);
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('spls.json')) {
      splListCalls += 1;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('/spls/dm-alpha.xml')) {
      splXmlCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<section><code code="34073-7"/>Concomitant DrugBeta is contraindicated due to severe toxicity.</section>',
      };
    }
    if (u.includes('dailymed.nlm.nih.gov') && u.includes('.xml')) {
      splXmlCalls += 1;
      return { ok: true, status: 200, text: async () => '<section></section>' };
    }
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const preResolvedA = {
    medicineId: 'a1',
    originalName: 'DrugAlpha',
    originalScientificName: 'DrugAlpha',
    englishCandidates: ['drugalpha'],
    arabicTerms: [],
    rxnorm: { ok: true, matched: true, rxcui: '101', canonicalName: 'drugalpha' },
    activeIngredients: ['drugalpha'],
    primaryIngredient: 'drugalpha',
    searchTerms: ['drugalpha'],
  };
  const preResolvedB = {
    medicineId: 'b1',
    originalName: 'DrugBeta',
    originalScientificName: 'DrugBeta',
    englishCandidates: ['drugbeta'],
    arabicTerms: [],
    rxnorm: { ok: true, matched: true, rxcui: '202', canonicalName: 'drugbeta' },
    activeIngredients: ['drugbeta'],
    primaryIngredient: 'drugbeta',
    searchTerms: ['drugbeta'],
  };
  const preMonographsA = {
    openfda: { ok: true, found: false, primaryLabel: null },
    dailymed: {
      ok: true,
      found: true,
      setId: 'dm-alpha',
      title: 'DrugAlpha SPL',
      publishedDate: '2026-02-01',
      sourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=dm-alpha',
      sections: null,
    },
  };
  const preMonographsB = {
    openfda: { ok: true, found: true, primaryLabel: { drugInteractions: [], contraindications: [], boxedWarning: [], warnings: [] } },
    dailymed: {
      ok: true,
      found: true,
      setId: 'dm-beta',
      title: 'DrugBeta SPL',
      publishedDate: '2026-02-01',
      sourceUrl: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=dm-beta',
      sections: { drugInteractions: '' },
    },
  };

  const pairRes = await analyzeDrugPair(
    { id: 'a1', name: 'DrugAlpha' },
    { id: 'b1', name: 'DrugBeta' },
    {
      fetchImpl: lazyXmlFetch,
      preResolvedA,
      preResolvedB,
      preMonographsA,
      preMonographsB,
    },
  );

  assert.equal(splListCalls, 0, 'لا يجب تكرار البحث في spls.json عندما يكون setId معروفًا مسبقًا');
  assert.equal(splXmlCalls, 1, 'يجب جلب ملف XML الكامل عبر setId عند الحاجة الفعلية للتحقق');
  assert.equal(pairRes.classification.code, SAFETY_CLASSIFICATION.DOCUMENTED_INTERACTION.code);
  assert.ok(pairRes.evidences.some((e) => e.sourceName === 'DailyMed'));
  assert.equal(pairRes.researchTrace.reSearchTriggered, true);

  // الحالة ب: نفس المادة الفعالة -> لا حاجة لجلب DailyMed XML الكامل
  splXmlCalls = 0;
  const sameRes = await analyzeDrugPair(
    { id: 'z1', name: 'BrandOne' },
    { id: 'z2', name: 'BrandTwo' },
    {
      fetchImpl: lazyXmlFetch,
      preResolvedA,
      preResolvedB: { ...preResolvedA, medicineId: 'z2', originalName: 'BrandTwo' },
      preMonographsA,
      preMonographsB: preMonographsA,
    },
  );
  assert.equal(sameRes.sameActiveIngredient, true);
  assert.equal(splXmlCalls, 0, 'لا يجب تنزيل DailyMed XML عند تطابق المادة الفعالة');
});

// 13) [محاكاة] researchTrace يسجل البحث التكميلي ويمنع تكرار استعلامات الويب
test('13. [محاكاة] researchTrace يسجل جولة البحث التكميلي ويمنع تكرار استعلامات الويب', async () => {
  const seenQueries = [];
  const webTraceFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://openserp.mock/mega/search')) {
      const parsed = new URL(u);
      seenQueries.push(parsed.searchParams.get('text'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'SFDA Warning', url: 'https://www.sfda.gov.sa/en/drugs/simvastatin', description: 'Simvastatin warning' },
          ],
        }),
      };
    }
    if (u.startsWith('https://www.sfda.gov.sa/')) {
      return { ok: true, status: 200, text: async () => '<title>SFDA</title><p>Simvastatin clarithromycin warning</p>' };
    }
    if (u.includes('eutils.ncbi.nlm.nih.gov')) {
      return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '1', idlist: ['12345'] }, result: { uids: ['12345'], 12345: { title: 'Interaction study', pubdate: '2025' } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const preA = {
    medicineId: '1',
    originalName: 'Simvastatin',
    englishCandidates: ['simvastatin'],
    arabicTerms: ['سيمفاستاتين'],
    rxnorm: { ok: true, matched: true, rxcui: '36567', canonicalName: 'simvastatin' },
    activeIngredients: ['simvastatin'],
    primaryIngredient: 'simvastatin',
    searchTerms: ['simvastatin'],
  };
  const preB = {
    medicineId: '2',
    originalName: 'Clarithromycin',
    englishCandidates: ['clarithromycin'],
    arabicTerms: ['كلاريثروميسين'],
    rxnorm: { ok: true, matched: true, rxcui: '21212', canonicalName: 'clarithromycin' },
    activeIngredients: ['clarithromycin'],
    primaryIngredient: 'clarithromycin',
    searchTerms: ['clarithromycin'],
  };
  const monoA = {
    openfda: {
      ok: true,
      found: true,
      primaryLabel: { contraindications: ['Clarithromycin is contraindicated.'], drugInteractions: [], boxedWarning: [], warnings: [] },
    },
    dailymed: { ok: true, found: true, setId: 'dm-1', sections: { drugInteractions: 'Clarithromycin is contraindicated.' } },
  };
  const monoB = {
    openfda: { ok: true, found: true, primaryLabel: { contraindications: [], drugInteractions: [], boxedWarning: [], warnings: [] } },
    dailymed: { ok: true, found: true, setId: 'dm-2', sections: { drugInteractions: '' } },
  };

  const res = await analyzeDrugPair(
    { name: 'Simvastatin' },
    { name: 'Clarithromycin' },
    {
      fetchImpl: webTraceFetch,
      preResolvedA: preA,
      preResolvedB: preB,
      preMonographsA: monoA,
      preMonographsB: monoB,
      includeWebSearch: true,
      openserpUrl: 'https://openserp.mock',
      resolveDns: false,
    },
  );

  assert.equal(res.researchTrace.roundsExecuted, 2);
  assert.equal(res.researchTrace.reSearchTriggered, false);
  assert.ok(res.researchTrace.rounds[1].phase.includes('جولة تكميلية'));
  assert.ok(seenQueries.length > 0);
  assert.equal(seenQueries.length, new Set(seenQueries.map((q) => q.toLowerCase())).size, 'يجب منع تكرار نفس الاستعلام');
});

// 14) [محاكاة] حجب الروابط غير الآمنة وإخفاء عناوين الخوادم الداخلية عن الأخطاء وresearchTrace وtelemetry
test('14. [محاكاة] تصفية روابط OpenSERP/SearXNG وإخفاء العناوين الداخلية من الأخطاء وresearchTrace وtelemetry', async () => {
  const internalOpenSerp = 'http://user:pass@10.20.30.40:7000';
  const internalSearx = 'http://searx-internal.local:8080';

  const maliciousFetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://openserp.public.test')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'XSS', url: 'javascript:alert(1)', description: 'bad' },
            { title: 'Loopback', url: 'http://127.0.0.1:8080/secret', description: 'bad' },
            { title: 'Meta', url: 'http://169.254.169.254/latest/meta-data', description: 'bad' },
            { title: 'Private LAN', url: 'http://10.0.0.9/admin', description: 'bad' },
            { title: 'FDA Safe', url: 'https://www.fda.gov/drugs/safe-alert', description: 'valid' },
          ],
        }),
      };
    }
    if (u.startsWith('https://www.fda.gov/')) {
      return { ok: true, status: 200, text: async () => '<title>FDA Safe</title><p>Official label</p>' };
    }
    throw new Error(`connect ECONNREFUSED 10.20.30.40:7000 at ${internalOpenSerp}`);
  };

  const webRes = await searchMedicalWeb(
    { queries: ['aspirin'] },
    { openserpUrl: 'https://openserp.public.test', fetchImpl: maliciousFetch, resolveDns: false },
  );
  assert.equal(webRes.results.length, 1);
  assert.equal(webRes.results[0].url, 'https://www.fda.gov/drugs/safe-alert');

  const probeRes = await probeSearchEngines({
    openserpUrl: internalOpenSerp,
    searxngUrl: internalSearx,
    fetchImpl: async (url) => {
      throw new Error(`request to ${url} failed: connect ECONNREFUSED 10.20.30.40:7000`);
    },
  });
  const sanitizedMsg = sanitizeEngineError(
    new Error(`ECONNREFUSED ${internalOpenSerp} 10.20.30.40:7000`),
    [internalOpenSerp, internalSearx],
  );
  assert.equal(sanitizedMsg.includes('10.20.30.40'), false);
  assert.equal(sanitizedMsg.includes('7000'), false);
  assert.equal(sanitizedMsg.includes('secret'), false);
  assert.equal(JSON.stringify(probeRes).includes('10.20.30.40'), false);
  assert.equal(JSON.stringify(probeRes).includes('searx-internal.local'), false);
  assert.equal(JSON.stringify(getSourcesTelemetry(probeRes)).includes('10.20.30.40'), false);

  const pairWithFailingEngine = await analyzeDrugPair(
    { name: 'Simvastatin' },
    { name: 'Clarithromycin' },
    {
      openserpUrl: internalOpenSerp,
      searxngUrl: internalSearx,
      includeWebSearch: true,
      resolveDns: false,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.startsWith(internalOpenSerp) || u.startsWith(internalSearx)) {
          throw new Error(`connect ECONNREFUSED ${u}`);
        }
        if (u.includes('rxnav.nlm.nih.gov')) {
          return { ok: true, status: 200, json: async () => ({ idGroup: {} }) };
        }
        if (u.includes('api.fda.gov')) {
          return { ok: true, status: 200, json: async () => ({ results: [{ openfda: { generic_name: ['TEST'] }, drug_interactions: ['Clarithromycin interaction'] }] }) };
        }
        if (u.includes('dailymed.nlm.nih.gov')) {
          return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
        if (u.includes('eutils.ncbi.nlm.nih.gov')) {
          return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    },
  );
  const traceStr = JSON.stringify(pairWithFailingEngine.researchTrace);
  assert.equal(traceStr.includes('10.20.30.40'), false);
  assert.equal(traceStr.includes('user:pass'), false);
  assert.equal(traceStr.includes('searx-internal.local'), false);
});

// 15) [محاكاة] تدوير الفحص الدوري عبر الدورات لأكثر من 20 دواء و12 زوجًا + شمول targetMedicineId بعد الفهرس 20
test('15. [محاكاة] الفحص الدوري يدوّر نافذة الـ20 دواء والـ12 زوجًا عبر الدورات ويفحص targetMedicineId بعد الفهرس 20', async () => {
  __resetSafetyWorkerForTests();

  const meds22 = Array.from({ length: 22 }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return {
      id: `med-${num}`,
      name: `TestDrug${num}`,
      scientific_name: `TestDrug${num}`,
      pharmacy_id: 'ph-big',
      is_active: true,
    };
  });

  const mockAdmin = {
    from(table) {
      const payload = table === 'medicines' ? { data: meds22, error: null } : { data: [], error: null };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        limit() { return chain; },
        then(onFulfilled, onRejected) {
          return Promise.resolve(payload).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
  const mockColumns = async () => ({
    schemaOk: true,
    medicines: { id: 'id', name: 'name', scientificName: 'scientific_name', pharmacy: 'pharmacy_id', isActive: 'is_active' },
    interactions: { id: 'id', drugA: 'drug_a', drugB: 'drug_b', severity: 'severity', description: 'description', source: 'source_name', pharmacy: 'pharmacy_id' },
    tables: { medicines: { columns: [] }, agent_runs: { columns: [] }, reports: { columns: [] }, inventory_alerts: { columns: [] } },
  });
  const fastFetch = async (url) => {
    const u = String(url);
    if (u.includes('rxnav.nlm.nih.gov')) return { ok: true, status: 200, json: async () => ({ idGroup: {} }) };
    if (u.includes('api.fda.gov')) return { ok: true, status: 200, json: async () => ({ results: [] }) };
    if (u.includes('dailymed.nlm.nih.gov')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (u.includes('eutils.ncbi.nlm.nih.gov')) return { ok: true, status: 200, json: async () => ({ esearchresult: { count: '0', idlist: [] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const c1 = await executeSafetyResearchTask(
    { pharmacyId: 'ph-big', trigger: 'periodic', force: true },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: fastFetch },
  );
  assert.equal(c1.pairsChecked, 12);
  assert.equal(c1.coverage.totalMedicinesInInventory, 22);
  assert.equal(c1.coverage.totalPossiblePairs, 231);
  assert.equal(c1.coverage.nextMedicineOffset, 20);
  assert.equal(c1.coverage.nextPairOffset, 12);
  assert.equal(c1.coverage.cyclesForFullPairCoverage, 20);

  const c2 = await executeSafetyResearchTask(
    { pharmacyId: 'ph-big', trigger: 'periodic', force: true },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: fastFetch },
  );
  assert.equal(c2.pairsChecked, 12);
  assert.equal(c2.coverage.nextMedicineOffset, 18); // (20 + 20) % 22
  assert.equal(c2.coverage.nextPairOffset, 24);

  const reactive22 = await executeSafetyResearchTask(
    { pharmacyId: 'ph-big', trigger: 'reactive', targetMedicineId: 'med-22', force: true },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: fastFetch },
  );
  assert.equal(reactive22.pairsChecked, 12);
  const status = getSafetyStatusForPharmacy('ph-big');
  assert.ok(
    status.pharmacy.pairFindings.some((f) => f.medicineA.id === 'med-22' || f.medicineB.id === 'med-22'),
    'يجب فحص الدواء المستهدف med-22 حتى لو كان موقعه بعد الفهرس 20',
  );
});

// 16) [محاكاة] عزل pharmacy_id في interactionsFor وworker لمنع تسرب بيانات الصيدليات
test('16. [محاكاة] عزل pharmacy_id يمنع تسرّب صفوف drug_interactions أو medicines بين الصيدليات', async () => {
  const recordedCalls = [];
  const sampleRows = [
    { id: '1', drug_a: 'Simvastatin', drug_b: 'Clarithromycin', severity: 'major', pharmacy_id: 'ph-1' },
    { id: '2', drug_a: 'Simvastatin', drug_b: 'Clarithromycin', severity: 'minor', pharmacy_id: 'ph-2' },
    { id: '3', drug_a: 'Simvastatin', drug_b: 'Clarithromycin', severity: 'contraindicated', pharmacy_id: null },
  ];

  const mockAdmin = {
    from() {
      const chain = {
        select() { return chain; },
        limit() { return chain; },
        or(expr) { recordedCalls.push({ op: 'or', expr }); return chain; },
        is(col, val) { recordedCalls.push({ op: 'is', col, val }); return chain; },
        eq(col, val) { recordedCalls.push({ op: 'eq', col, val }); return chain; },
        then(onFulfilled, onRejected) {
          return Promise.resolve({ data: sampleRows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };

  const cols = {
    interactions: {
      id: 'id',
      drugA: 'drug_a',
      drugB: 'drug_b',
      severity: 'severity',
      description: 'description',
      source: 'source_name',
      pharmacy: 'pharmacy_id',
    },
    tables: { drug_interactions: { columns: [] } },
  };

  const ph1Res = await interactionsFor(mockAdmin, cols, 'Simvastatin Clarithromycin', [], [], { pharmacyId: 'ph-1' });
  assert.ok(recordedCalls.some((c) => c.op === 'or' && c.expr === 'pharmacy_id.eq.ph-1,pharmacy_id.is.null'));
  assert.equal(ph1Res.rows.length, 2, 'يجب استبعاد صفوف ph-2 والاحتفاظ بصفوف ph-1 والعامة فقط');
  assert.equal(ph1Res.rows.some((r) => r.severity === 'minor'), false);

  recordedCalls.length = 0;
  const unscopedRes = await interactionsFor(mockAdmin, cols, 'Simvastatin Clarithromycin', [], [], { pharmacyId: null });
  assert.ok(recordedCalls.some((c) => c.op === 'is' && c.col === 'pharmacy_id' && c.val === null));
  assert.equal(unscopedRes.rows.length, 1);
  assert.equal(unscopedRes.rows[0].severity, 'contraindicated');

  __resetSafetyWorkerForTests();
  const leakTestAdmin = {
    from() {
      const chain = {
        select() { return chain; },
        limit() { return chain; },
        or() { return chain; },
        is() { return chain; },
        eq() { return chain; },
        then(onFulfilled, onRejected) {
          return Promise.resolve({
            data: [{ id: 'm-other', name: 'Warfarin', pharmacy_id: 'ph-2', is_active: true }],
            error: null,
          }).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
  const workerNoPharmacy = await executeSafetyResearchTask(
    { pharmacyId: null, trigger: 'manual', force: true },
    {
      getAdmin: () => leakTestAdmin,
      inventoryColumns: async () => ({
        schemaOk: true,
        medicines: { id: 'id', name: 'name', pharmacy: 'pharmacy_id', isActive: 'is_active' },
        interactions: { id: 'id', drugA: 'drug_a', drugB: 'drug_b', pharmacy: 'pharmacy_id' },
        tables: { medicines: { columns: [] } },
      }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    },
  );
  assert.equal(workerNoPharmacy.medicinesAnalyzed, 0, 'يجب ألا يقرأ العامل أدوية أي صيدلية عند غياب pharmacyId مع وجود عمود الصيدلية');
});

