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
  searchMedicalWeb,
  validateSafePublicUrl,
} from '../server/safety/sources/openserp.js';
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
});

// 5) اختبار فشل الوصول للمصادر + تعارض المصادر + عدم توفر تداخل مع عدم قول "آمن"
test('5. تعامل المحلل مع تعطل المصادر وتعارض المصادر وعدم العثور على تداخل', async () => {
  const failingFetch = async () => {
    throw new Error('ECONNREFUSED upstream');
  };
  const failed = await analyzeDrugPair({ name: 'Simvastatin' }, { name: 'Clarithromycin' }, { fetchImpl: failingFetch });
  assert.equal(failed.classification.code, SAFETY_CLASSIFICATION.SOURCE_ACCESS_FAILED.code);
  assert.equal(failed.classification.label, 'فشل الوصول إلى المصدر');

  // محاكاة تعارض مصادر: openFDA يوثق تداخلًا شديدًا بينما DailyMed يقول no clinically significant interaction
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

  // محاكاة عدم العثور على تداخل مع عدم إعلان الأمان
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

  // تشغيل متكرر على نفس قائمة الأدوية بدون تغيير يُمنع تكراره تلقائيًا
  const run2 = await executeSafetyResearchTask(
    { pharmacyId: 'ph-1', trigger: 'reactive', reason: 'إعادة مطابقة', targetMedicineId: 'm1', force: false },
    { getAdmin: () => mockAdmin, inventoryColumns: mockColumns, fetchImpl: mockMedicalFetch },
  );
  assert.equal(run2.skipped, true);
  assert.equal(run2.reason, 'unchanged_inventory_deduplicated');

  const status = getSafetyStatusForPharmacy('ph-1');
  assert.equal(status.pharmacy.counts.documented_interaction, 1);
  assert.equal(status.pharmacy.pairFindings[0].classification.code, 'documented_interaction');
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
