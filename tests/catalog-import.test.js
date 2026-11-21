import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PDF_INTERACTIONS,
  PDF_MEDICINES,
  buildMedicinesCsvTemplate,
  parseCatalogText,
} from '../src/catalogImport.js';

test('بيانات دليل PharmaGuard PDF تحتوي 25 دواءً و15 تداخلًا دوائيًا كاملة', () => {
  assert.equal(PDF_MEDICINES.length, 25);
  assert.equal(PDF_INTERACTIONS.length, 15);
  assert.equal(PDF_MEDICINES[0].name, 'Panadol Advance');
  assert.equal(PDF_MEDICINES[24].name, 'Lyrica');
  assert.match(PDF_INTERACTIONS[0].drugA, /Warfarin/);
  assert.match(PDF_INTERACTIONS[0].drugB, /Aspirin/);
});

test('محلّل الاستيراد يقرأ CSV للأدوية برؤوس عربية وإنجليزية', () => {
  const csv = [
    'الاسم التجاري,الاسم العلمي,الشكل,التركيز,حد إعادة الطلب',
    'Panadol Advance,Paracetamol,أقراص,500 مجم,12',
    'Brufen,Ibuprofen,أقراص,400 مجم,8',
  ].join('\n');

  const parsed = parseCatalogText(csv);
  assert.equal(parsed.medicines.length, 2);
  assert.equal(parsed.interactions.length, 0);
  assert.equal(parsed.medicines[0].name, 'Panadol Advance');
  assert.equal(parsed.medicines[0].scientificName, 'Paracetamol');
  assert.equal(parsed.medicines[0].reorderLevel, 12);
});

test('محلّل الاستيراد يقرأ CSV وJSON للتداخلات الدوائية وقالب CSV', () => {
  const template = buildMedicinesCsvTemplate();
  const fromTemplate = parseCatalogText(template);
  assert.equal(fromTemplate.medicines.length, 1);

  const json = JSON.stringify({
    interactions: [{ drugA: 'Warfarin', drugB: 'Aspirin', severity: 'critical', description: 'نزيف' }],
  });
  const parsed = parseCatalogText(json);
  assert.equal(parsed.interactions.length, 1);
  assert.equal(parsed.interactions[0].drugA, 'Warfarin');
  assert.equal(parsed.interactions[0].severity, 'critical');
});
