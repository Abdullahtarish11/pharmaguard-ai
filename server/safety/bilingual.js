/**
 * طبقة التطبيع اللغوي والدوائي الثنائية (العربية والإنجليزية):
 * - قراءة الاسم التجاري والعلمي واستخراج المادة الفعالة والتركيز والشكل الدوائي.
 * - تحويل المصطلحات الدوائية العربية الشائعة إلى أسمائها العلمية الدولية (INN) للبحث الموحد،
 *   دون تشويه أو ترجمة آلية غير دقيقة.
 */

const ARABIC_TO_INN = Object.freeze({
  // قلبية ومميعات وخافضات دهون
  سيمفاستاتين: 'simvastatin',
  سمفاستاتين: 'simvastatin',
  زوكور: 'simvastatin',
  أتورفاستاتين: 'atorvastatin',
  اتورفاستاتين: 'atorvastatin',
  ليبيتور: 'atorvastatin',
  روزوفاستاتين: 'rosuvastatin',
  كريستور: 'rosuvastatin',
  وارفارين: 'warfarin',
  الوارفارين: 'warfarin',
  كومادين: 'warfarin',
  أسبرين: 'aspirin',
  اسبرين: 'aspirin',
  أسبيرين: 'aspirin',
  اسبيرين: 'aspirin',
  كلوبيدوجريل: 'clopidogrel',
  كلوبيدوغريل: 'clopidogrel',
  بلافيكس: 'clopidogrel',
  ريفاروكسابان: 'rivaroxaban',
  زاريلتو: 'rivaroxaban',
  أبيكسابان: 'apixaban',
  إليكويس: 'apixaban',
  دابيغاتران: 'dabigatran',
  ديجوكسين: 'digoxin',
  لانوكسين: 'digoxin',
  أميودارون: 'amiodarone',
  كوردارون: 'amiodarone',
  أملوديبين: 'amlodipine',
  املوديبين: 'amlodipine',
  نورفاسك: 'amlodipine',
  ليسينوبريل: 'lisinopril',
  إينالابريل: 'enalapril',
  كابتوبريل: 'captopril',
  لوسارتان: 'losartan',
  لوزارتان: 'losartan',
  فالسارتان: 'valsartan',
  بيسوبرولول: 'bisoprolol',
  كونكور: 'bisoprolol',
  أتينولول: 'atenolol',
  تينورمين: 'atenolol',
  ميتوبرولول: 'metoprolol',
  كارفيديلول: 'carvedilol',
  فيوروسيميد: 'furosemide',
  فروسيميد: 'furosemide',
  لازيكس: 'furosemide',
  سبيرونولاكتون: 'spironolactone',
  ألداكتون: 'spironolactone',
  نيتروجليسرين: 'nitroglycerin',
  أيزوسوربيد: 'isosorbide',
  ديلتيازيم: 'diltiazem',
  فيراباميل: 'verapamil',

  // مضادات حيوية وفطرية
  كلاريثروميسين: 'clarithromycin',
  كلاريثرومايسين: 'clarithromycin',
  كلاسيد: 'clarithromycin',
  بياكسين: 'clarithromycin',
  أزيثروميسين: 'azithromycin',
  ازيثروميسين: 'azithromycin',
  زيثروماكس: 'azithromycin',
  إريثروميسين: 'erythromycin',
  اريثروميسين: 'erythromycin',
  أموكسيسيلين: 'amoxicillin',
  اموكسيسيلين: 'amoxicillin',
  أوجمنتين: 'amoxicillin clavulanate',
  اوغمنتين: 'amoxicillin clavulanate',
  سيبروفلوكساسين: 'ciprofloxacin',
  سيبرو: 'ciprofloxacin',
  ليفوفلوكساسين: 'levofloxacin',
  دوكسيسيكلين: 'doxycycline',
  تتراسيكلين: 'tetracycline',
  ميترونيدازول: 'metronidazole',
  فلاجيل: 'metronidazole',
  سيفترياكسون: 'ceftriaxone',
  سيفاليكسين: 'cephalexin',
  سيفوروكسيم: 'cefuroxime',
  فانكومايسين: 'vancomycin',
  جنتاميسين: 'gentamicin',
  أميكاسين: 'amikacin',
  ريفامبيسين: 'rifampin',
  ريفامبين: 'rifampin',
  أيزونيازيد: 'isoniazid',
  فلوكونازول: 'fluconazole',
  ديفلوكان: 'fluconazole',
  كيتوكونازول: 'ketoconazole',
  إيتراكونازول: 'itraconazole',
  تريميثوبريم: 'trimethoprim',
  باكتريم: 'sulfamethoxazole trimethoprim',

  // مسكنات ومضادات التهاب وستريرويدات
  باراسيتامول: 'acetaminophen',
  أسيتامينوفين: 'acetaminophen',
  بنادول: 'acetaminophen',
  بانادول: 'acetaminophen',
  تايلينول: 'acetaminophen',
  فيفادول: 'acetaminophen',
  إيبوبروفين: 'ibuprofen',
  ايبوبروفين: 'ibuprofen',
  بروفين: 'ibuprofen',
  ديكلوفيناك: 'diclofenac',
  فولتارين: 'diclofenac',
  نابروكسين: 'naproxen',
  سيليكوكسيب: 'celecoxib',
  سيليبريكس: 'celecoxib',
  ميلوكسيكام: 'meloxicam',
  ترامادول: 'tramadol',
  مورفين: 'morphine',
  كودايين: 'codeine',
  بريدنيزولون: 'prednisolone',
  بريدنيزون: 'prednisone',
  ديكساميثازون: 'dexamethasone',
  هيدروكورتيزون: 'hydrocortisone',

  // سكري وغدد وجهاز هضمي
  ميتفورمين: 'metformin',
  جلوكوفاج: 'metformin',
  غلوكوفاج: 'metformin',
  غليبنكلاميد: 'glyburide',
  جليميبيريد: 'glimepiride',
  أماريل: 'glimepiride',
  إنسولين: 'insulin',
  انسولين: 'insulin',
  ليفوثيروكسين: 'levothyroxine',
  ثايروكسين: 'levothyroxine',
  يوثيروكس: 'levothyroxine',
  أوميبرازول: 'omeprazole',
  اوميبرازول: 'omeprazole',
  لوسيك: 'omeprazole',
  إيزوميبرازول: 'esomeprazole',
  نيكسيوم: 'esomeprazole',
  بانتوبرازول: 'pantoprazole',
  فاموتيدين: 'famotidine',
  أوندانسيترون: 'ondansetron',
  ميتوكلوبراميد: 'metoclopramide',

  // عصبية ونفسية ومناعية وغيرها
  كاربامازيبين: 'carbamazepine',
  تيغريتول: 'carbamazepine',
  فينيتوين: 'phenytoin',
  ديباكين: 'valproic acid',
  فالبروات: 'valproic acid',
  لاموتريجين: 'lamotrigine',
  ليثيوم: 'lithium',
  فلوكستين: 'fluoxetine',
  بروزاك: 'fluoxetine',
  سيرترالين: 'sertraline',
  زولوفت: 'sertraline',
  إسيتالوبرام: 'escitalopram',
  سيبراليكس: 'escitalopram',
  أميتريبتيلين: 'amitriptyline',
  هالوبيريدول: 'haloperidol',
  ريسبيريدون: 'risperidone',
  ديازيبام: 'diazepam',
  ألبرازولام: 'alprazolam',
  لورازيبام: 'lorazepam',
  ميثوتريكسات: 'methotrexate',
  سيكلوسبورين: 'cyclosporine',
  تاكروليموس: 'tacrolimus',
  ألوبيورينول: 'allopurinol',
  كولشيسين: 'colchicine',
  سيلدينافيل: 'sildenafil',
  فياجرا: 'sildenafil',
  تادالافيل: 'tadalafil',
  ثيوفيلين: 'theophylline',
  ألبوتيرول: 'albuterol',
  سالبوتامول: 'albuterol',
  فنتولين: 'albuterol',
  لوراتادين: 'loratadine',
  سيتيريزين: 'cetirizine',
  ديفينهيدرامين: 'diphenhydramine',
  حديد: 'iron',
  كالسيوم: 'calcium',
});

const FORM_PATTERNS = [
  { pattern: /\b(?:film[- ]coated\s+)?tablets?\b|\btabs?\b|أقراص|قرص/i, label: 'tablet' },
  { pattern: /\bcapsules?\b|\bcaps?\b|كبسولات|كبسولة|كبسول/i, label: 'capsule' },
  { pattern: /\bsyrup\b|شراب/i, label: 'syrup' },
  { pattern: /\bsuspension\b|\bsusp\b|معلق/i, label: 'suspension' },
  { pattern: /\binjection\b|\binj\b|\bampoules?\b|\bvials?\b|حقن|حقنة|أمبول/i, label: 'injection' },
  { pattern: /\bsolution\b|محلول/i, label: 'solution' },
  { pattern: /\bdrops?\b|قطرة|قطرات/i, label: 'drops' },
  { pattern: /\bcream\b|كريم/i, label: 'cream' },
  { pattern: /\bointment\b|مرهم/i, label: 'ointment' },
  { pattern: /\bgel\b|جل/i, label: 'gel' },
  { pattern: /\bspray\b|بخاخ/i, label: 'spray' },
  { pattern: /\bsuppositor(?:y|ies)\b|لبوس|تحاميل/i, label: 'suppository' },
  { pattern: /\bpatch(?:es)?\b|لصقة/i, label: 'patch' },
  { pattern: /\bsachets?\b|أكياس|فوار/i, label: 'sachet' },
];

const NOISE_WORDS = new Set([
  'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps',
  'syrup', 'suspension', 'susp', 'injection', 'inj', 'ampoule', 'amp', 'vial',
  'cream', 'ointment', 'gel', 'drops', 'spray', 'patch', 'sachet', 'suppository',
  'oral', 'solution', 'film', 'coated', 'extended', 'release', 'sr', 'xr', 'er',
  'cr', 'mr', 'dr', 'forte', 'extra', 'plus', 'advance', 'retard',
  'mg', 'mcg', 'ug', 'ml', 'gm', 'g', 'kg', 'iu', 'meq', 'pct',
  'hydrochloride', 'hcl', 'sodium', 'potassium', 'calcium', 'maleate',
  'sulfate', 'citrate', 'tartrate', 'besylate', 'mesylate', 'fumarate', 'phosphate',
  'قرص', 'أقراص', 'اقراص', 'كبسول', 'كبسولة', 'كبسولات', 'شراب', 'معلق',
  'حقنة', 'حقن', 'أمبول', 'امبول', 'كريم', 'مرهم', 'جل', 'قطرة', 'قطرات',
  'بخاخ', 'لبوس', 'تحاميل', 'فوار', 'محلول', 'مجم', 'ملجم', 'ملغ', 'مل', 'جم',
  'مع', 'من', 'في', 'دواء',
]);

function stripArabicAl(word) {
  return word.startsWith('ال') && word.length > 4 ? word.slice(2) : word;
}

export function extractStrength(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+(?:[.,]\d+)?\s*(?:mg|mcg|ug|ml|g|gm|iu|%|مجم|ملجم|ملغ|جم|وحدة)(?:\s*\/\s*\d*(?:[.,]\d+)?\s*(?:ml|mg|g|مل))?)/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

export function extractDosageForm(text) {
  if (!text) return null;
  const str = String(text);
  for (const entry of FORM_PATTERNS) {
    if (entry.pattern.test(str)) return entry.label;
  }
  return null;
}

export function cleanDrugPhrase(raw) {
  if (!raw) return '';
  const withoutParens = String(raw).replace(/[()[\]{}]/g, ' ');
  const tokens = withoutParens
    .split(/[\s/+،,;:\-–—]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const kept = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (/^\d+(?:[.,]\d+)?(?:mg|mcg|ug|ml|g|gm|iu|%)?$/i.test(lower)) continue;
    if (/^\d+(?:[.,]\d+)?$/.test(lower)) continue;
    if (NOISE_WORDS.has(lower)) continue;
    kept.push(token);
  }
  return kept.join(' ').trim();
}

/**
 * يستخرج المرشحات الإنجليزية والعربية النظيفة لاسم دواء أو وصفه التجاري والعلمي.
 */
export function normalizeBilingualDrugInput(medicineOrText) {
  const obj =
    typeof medicineOrText === 'string'
      ? { name: medicineOrText, scientificName: null, strength: null, form: null }
      : medicineOrText ?? {};

  const rawName = String(obj.name ?? '').trim();
  const rawScientific = String(obj.scientificName ?? '').trim();
  const combinedRaw = [rawName, rawScientific].filter(Boolean).join(' ');

  const detectedStrength = obj.strength || extractStrength(combinedRaw);
  const detectedForm = obj.form || extractDosageForm(combinedRaw);

  const englishCandidates = [];
  const arabicTerms = [];
  const seenEn = new Set();
  const seenAr = new Set();

  const pushEnglish = (value) => {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v || v.length < 2 || seenEn.has(v)) return;
    seenEn.add(v);
    englishCandidates.push(v);
  };

  const pushArabic = (value) => {
    const v = String(value ?? '').trim();
    if (!v || v.length < 2 || seenAr.has(v)) return;
    seenAr.add(v);
    arabicTerms.push(v);
  };

  // الأولوية للاسم العلمي ثم التجاري عند استخلاص مصطلح البحث
  for (const sourceText of [rawScientific, rawName]) {
    if (!sourceText) continue;

    // 1) مطابقة المقاطع اللاتينية الكاملة داخل النص
    const latinSegments = sourceText.match(/[A-Za-z][A-Za-z0-9\s\-+]{1,60}/g) ?? [];
    for (const seg of latinSegments) {
      const cleaned = cleanDrugPhrase(seg);
      if (cleaned) pushEnglish(cleaned);
      // الكلمات المفردة الإنجليزية إن كان الاسم مركبًا
      for (const word of cleaned.split(/\s+/)) {
        if (word.length >= 3 && !NOISE_WORDS.has(word.toLowerCase())) {
          pushEnglish(word);
        }
      }
    }

    // 2) مطابقة الكلمات العربية وترجمتها العلمية عند توفرها في القاموس
    const arabicWords = sourceText.match(/[\u0600-\u06FF]+/g) ?? [];
    for (const word of arabicWords) {
      if (NOISE_WORDS.has(word)) continue;
      pushArabic(word);
      const stripped = stripArabicAl(word);
      const mapped = ARABIC_TO_INN[word] ?? ARABIC_TO_INN[stripped] ?? null;
      if (mapped) {
        pushEnglish(mapped);
      }
    }
  }

  return {
    originalName: rawName || null,
    originalScientificName: rawScientific || null,
    strength: detectedStrength || null,
    dosageForm: detectedForm || null,
    englishCandidates,
    arabicTerms,
    primaryQueryEn: englishCandidates[0] ?? null,
    primaryQueryAr: arabicTerms[0] ?? null,
  };
}

export function listSupportedArabicMappings() {
  return { ...ARABIC_TO_INN };
}
