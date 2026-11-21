/**
 * قاعدة بيانات الأدوية والتداخلات المستخرجة من ملف PDF المرجعي المرفق (PharmaGuard AI)
 * مع محلّل CSV وJSON لاستيراد أي ملفات جداول أخرى داخل المنصة.
 */

export const PDF_MEDICINES = Object.freeze([
  { name: 'Panadol Advance', scientificName: 'Paracetamol (الباراسيتامول)', form: 'أقراص', strength: '500 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Brufen', scientificName: 'Ibuprofen (الإيبوبروفين)', form: 'أقراص / شراب', strength: '400 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Voltaren', scientificName: 'Diclofenac (الديكلوفيناك)', form: 'أقراص', strength: '50 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Tramal', scientificName: 'Tramadol (الترامادول) [مقيد]', form: 'كبسولات', strength: '50 مجم', unit: 'علبة', reorderLevel: 5 },
  { name: 'Coumadin', scientificName: 'Warfarin (الوارفارين)', form: 'أقراص', strength: '2 مجم / 5 مجم', unit: 'علبة', reorderLevel: 5 },
  { name: 'Aspirin Protect', scientificName: 'Aspirin (الأسبرين)', form: 'أقراص مغلفة معويًا', strength: '100 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Plavix', scientificName: 'Clopidogrel (الكلوبيدوجريل)', form: 'أقراص', strength: '75 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Clexane', scientificName: 'Enoxaparin (الإينوكسابارين)', form: 'حقن معبأة', strength: '40 مجم / 60 مجم', unit: 'حقنة', reorderLevel: 6 },
  { name: 'Zestril', scientificName: 'Lisinopril (الليزينوبريل)', form: 'أقراص', strength: '10 مجم / 20 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Cozaar', scientificName: 'Losartan (اللوسارتان)', form: 'أقراص', strength: '50 مجم / 100 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Norvasc', scientificName: 'Amlodipine (الأملوديبين)', form: 'أقراص', strength: '5 مجم / 10 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Concor', scientificName: 'Bisoprolol (البيسوبرولول)', form: 'أقراص', strength: '5 مجم / 10 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Lipitor', scientificName: 'Atorvastatin (الأتورفاستاتين)', form: 'أقراص', strength: '20 مجم / 40 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Lanoxin', scientificName: 'Digoxin (الديجوكسين)', form: 'أقراص', strength: '0.25 مجم', unit: 'علبة', reorderLevel: 5 },
  { name: 'Amoxil', scientificName: 'Amoxicillin (الأموكسيسيلين)', form: 'كبسولات / معلق', strength: '500 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Augmentin', scientificName: 'Amoxicillin/Clavulanate (أموكسيسيلين + كلافولانيك)', form: 'أقراص / معلق', strength: '1 جم / 457 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Zithromax', scientificName: 'Azithromycin (الأزيثروميسين)', form: 'أقراص / معلق', strength: '500 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Cipro', scientificName: 'Ciprofloxacin (السيبروفلوكساسين)', form: 'أقراص', strength: '500 مجم / 750 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Flagyl', scientificName: 'Metronidazole (الميترونيدازول)', form: 'أقراص / معلق', strength: '500 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Glucophage', scientificName: 'Metformin (الميتفورمين)', form: 'أقراص', strength: '500 / 850 / 1000 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Amaryl', scientificName: 'Glimepiride (الجليميبيريد)', form: 'أقراص', strength: '2 مجم / 4 مجم', unit: 'علبة', reorderLevel: 8 },
  { name: 'Losec', scientificName: 'Omeprazole (الأوميبرازول)', form: 'كبسولات', strength: '20 مجم / 40 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Pantozol', scientificName: 'Pantoprazole (البانتوبرازول)', form: 'أقراص', strength: '40 مجم', unit: 'علبة', reorderLevel: 10 },
  { name: 'Ventolin', scientificName: 'Salbutamol (السالبوتامول)', form: 'بخاخ استنشاق', strength: '100 مكجم', unit: 'عبوة', reorderLevel: 8 },
  { name: 'Lyrica', scientificName: 'Pregabalin (البريجابالين) [مقيد]', form: 'كبسولات', strength: '75 مجم / 150 مجم', unit: 'علبة', reorderLevel: 5 },
]);

export const PDF_INTERACTIONS = Object.freeze([
  {
    drugA: 'Coumadin (Warfarin - الوارفارين)',
    drugB: 'Aspirin (الأسبرين)',
    severity: 'critical',
    description:
      'تآزر قوي يضاعف خطر النزيف الداخلي والنزيف الهضمي والدماغي عبر تثبيط التخثر والصفيحات معًا. التوصية: منع الجمع تلقائيًا ما لم توجد توصية قلبية لصمام ميكانيكي مع مراقبة لصيقة لـ INR.',
    source: 'PharmaGuard AI PDF (DDI-001)',
  },
  {
    drugA: 'Coumadin (Warfarin - الوارفارين)',
    drugB: 'Brufen (Ibuprofen - الإيبوبروفين)',
    severity: 'critical',
    description:
      'إزاحة الوارفارين من بروتينات البلازما وتآكل الغشاء المخاطي للمعدة مما يسبب نزيفًا معويًا حادًا. التوصية: منع الجمع واستبدال الإيبوبروفين بالباراسيتامول (Panadol) كخيار آمن لتسكين الألم.',
    source: 'PharmaGuard AI PDF (DDI-002)',
  },
  {
    drugA: 'Coumadin (Warfarin - الوارفارين)',
    drugB: 'Cipro (Ciprofloxacin - السيبروفلوكساسين)',
    severity: 'critical',
    description:
      'تثبيط إنزيمات الكبد CYP1A2 وCYP3A4 مما يرفع تركيز الوارفارين في الدم ومعدل INR بشكل مفاجئ وخطير. التوصية: اقتراح مضاد حيوي بديل أو خفض جرعة الوارفارين وفحص INR كل 48 ساعة.',
    source: 'PharmaGuard AI PDF (DDI-003)',
  },
  {
    drugA: 'Zestril (Lisinopril - الليزينوبريل)',
    drugB: 'Cozaar (Losartan - اللوسارتان)',
    severity: 'critical',
    description:
      'ازدواجية تثبيط نظام الرينين-أنجيوتنسين (RAAS) تسبب فرط بوتاسيوم الدم، هبوط الضغط، وفشلًا كلويًا حادًا. التوصية: حظر الازدواجية والاكتفاء بفئة واحدة (ACEi أو ARB).',
    source: 'PharmaGuard AI PDF (DDI-004)',
  },
  {
    drugA: 'Tramal (Tramadol - الترامادول)',
    drugB: 'Lyrica (Pregabalin - البريجابالين)',
    severity: 'critical',
    description:
      'تآزر المثبطات العصبية المركزية يؤدي لهبوط تنفسي حاد، فقدان وعي، وارتفاع خطر التجاوز. التوصية: منع صرف الجرعات المرتفعة وإلزامية مراجعة الطبيب المعالج وتوثيق التجاوز.',
    source: 'PharmaGuard AI PDF (DDI-005)',
  },
  {
    drugA: 'Lanoxin (Digoxin - الديجوكسين)',
    drugB: 'Zithromax (Azithromycin - الأزيثروميسين)',
    severity: 'critical',
    description:
      'تثبيط البكتيريا المعوية المسؤولة عن استقلاب الديجوكسين مما يرفع مستواه بالدم ويسبب سمية قلبية. التوصية: اختيار مضاد حيوي بديل أو مراقبة مستوى الديجوكسين بالدم وعلامات التسمم.',
    source: 'PharmaGuard AI PDF (DDI-006)',
  },
  {
    drugA: 'Plavix (Clopidogrel - الكلوبيدوجريل)',
    drugB: 'Losec (Omeprazole - الأوميبرازول)',
    severity: 'moderate',
    description:
      'الأوميبرازول يثبط إنزيم CYP2C19 اللازم لتنشيط الكلوبيدوجريل مما يضعف الحماية من الجلطات القلبية. التوصية: استبدال Losec بدواء Pantozol (البانتوبرازول) لعدم تداخله مع الإنزيم.',
    source: 'PharmaGuard AI PDF (DDI-007)',
  },
  {
    drugA: 'Zestril (Lisinopril - الليزينوبريل)',
    drugB: 'Brufen (Ibuprofen - الإيبوبروفين)',
    severity: 'moderate',
    description:
      'تثبيط البروستاغلاندين الكلوي يضعف مفعول خفض الضغط ويزيد خطر القصور الكلوي الحاد. التوصية: تقليل مدة استخدام المسكن لأقصر فترة ومراقبة ضغط الدم ووظائف الكلى.',
    source: 'PharmaGuard AI PDF (DDI-008)',
  },
  {
    drugA: 'Aspirin (الأسبرين)',
    drugB: 'Brufen (Ibuprofen - الإيبوبروفين)',
    severity: 'moderate',
    description:
      'تنافس الإيبوبروفين على مستقبل COX-1 يعطل التأثير الوقائي للأسبرين المانع لتجلط الصفيحات. التوصية: تناول الأسبرين قبل الإيبوبروفين بـ 30 دقيقة على الأقل أو بعده بـ 8 ساعات.',
    source: 'PharmaGuard AI PDF (DDI-009)',
  },
  {
    drugA: 'Glucophage (Metformin - الميتفورمين)',
    drugB: 'Cipro (Ciprofloxacin - السيبروفلوكساسين)',
    severity: 'moderate',
    description:
      'اضطراب الإطراح الكلوي للميتفورمين قد يسبب تذبذب سكر الدم ويزيد احتمالية الحماض اللبني. التوصية: توجيه المريض بقياس السكر بانتظام ومراقبة أعراض الحماض اللبني.',
    source: 'PharmaGuard AI PDF (DDI-010)',
  },
  {
    drugA: 'Amaryl (Glimepiride - الجليميبيريد)',
    drugB: 'Cipro (Ciprofloxacin - السيبروفلوكساسين)',
    severity: 'moderate',
    description:
      'الفلوروكينولونات تحفز إفراز الأنسولين من البنكرياس مما يرفع خطر نوبات هبوط السكر الحاد. التوصية: تنبيه المريض لأعراض انخفاض السكر وحمل مصدر سكري سريع المفعول.',
    source: 'PharmaGuard AI PDF (DDI-011)',
  },
  {
    drugA: 'Lipitor (Atorvastatin - الأتورفاستاتين)',
    drugB: 'Zithromax (Azithromycin - الأزيثروميسين)',
    severity: 'moderate',
    description:
      'زيادة تركيز الأتورفاستاتين في البلازما مما يرفع احتمالية حدوث اعتلال وألم في العضلات. التوصية: تنبيه المريض للإبلاغ الفوري عن أي ألم أو ضعف عضلي غير مبرر.',
    source: 'PharmaGuard AI PDF (DDI-012)',
  },
  {
    drugA: 'Concor (Bisoprolol - البيسوبرولول)',
    drugB: 'Norvasc (Amlodipine - الأملوديبين)',
    severity: 'moderate',
    description:
      'تأثير تآزري خافض للضغط قد يؤدي لهبوط ضغط الدم الانتصابي وبطء ملحوظ في ضربات القلب. التوصية: متابعة ضغط الدم ومعدل النبض وتعديل الجرعات عند ظهور دوخة.',
    source: 'PharmaGuard AI PDF (DDI-013)',
  },
  {
    drugA: 'Ventolin (Salbutamol - السالبوتامول)',
    drugB: 'Concor (Bisoprolol - البيسوبرولول)',
    severity: 'moderate',
    description:
      'تضاد دوائي مباشر يقلل فعالية موسع القصبات وقد يحفز تشنجًا في الشعب الهوائية. التوصية: تجنب حاصرات بيتا في مرضى الربو الشديد والمراقبة اللصيقة للتنفس.',
    source: 'PharmaGuard AI PDF (DDI-014)',
  },
  {
    drugA: 'Coumadin (Warfarin - الوارفارين)',
    drugB: 'Amoxil (Amoxicillin - الأموكسيسيلين)',
    severity: 'mild',
    description:
      'تقليل البكتيريا المعوية المنتجة لفيتامين K مما يرفع فعالية الوارفارين وقراءة INR بشكل طفيف. التوصية: فحص قراءة INR بعد إنهاء كورس المضاد الحيوي دون تعديل مسبق للجرعة.',
    source: 'PharmaGuard AI PDF (DDI-015)',
  },
]);

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === ';') && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

const MEDICINE_HEADER_MAP = {
  name: 'name',
  medicine_name: 'name',
  trade_name: 'name',
  drug_name: 'name',
  'الاسم التجاري': 'name',
  'اسم الدواء': 'name',
  'الدواء': 'name',
  scientificname: 'scientificName',
  scientific_name: 'scientificName',
  generic_name: 'scientificName',
  active_ingredient: 'scientificName',
  'الاسم العلمي': 'scientificName',
  'المادة الفعالة': 'scientificName',
  form: 'form',
  dosage_form: 'form',
  'الشكل': 'form',
  'الشكل الصيدلاني': 'form',
  strength: 'strength',
  dose: 'strength',
  'التركيز': 'strength',
  barcode: 'barcode',
  sku: 'barcode',
  'الباركود': 'barcode',
  unit: 'unit',
  'الوحدة': 'unit',
  reorderlevel: 'reorderLevel',
  reorder_level: 'reorderLevel',
  min_stock: 'reorderLevel',
  'حد إعادة الطلب': 'reorderLevel',
};

const INTERACTION_HEADER_MAP = {
  druga: 'drugA',
  drug_a: 'drugA',
  medicine_a: 'drugA',
  drug1: 'drugA',
  'الدواء الأول': 'drugA',
  'الدواء 1': 'drugA',
  drugb: 'drugB',
  drug_b: 'drugB',
  medicine_b: 'drugB',
  drug2: 'drugB',
  'الدواء الثاني': 'drugB',
  'الدواء 2': 'drugB',
  severity: 'severity',
  level: 'severity',
  risk: 'severity',
  'الخطورة': 'severity',
  'الشدة': 'severity',
  description: 'description',
  details: 'description',
  effect: 'description',
  notes: 'description',
  'الوصف': 'description',
  'التأثير السريري': 'description',
  source: 'source',
  reference: 'source',
  'المصدر': 'source',
};

function normalizeMedicineRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name =
    raw.name ?? raw.medicine_name ?? raw.trade_name ?? raw.drug_name ?? raw['الاسم التجاري'] ?? raw['اسم الدواء'];
  if (!name || String(name).trim().length < 2) return null;
  const reorderRaw = raw.reorderLevel ?? raw.reorder_level ?? raw.min_stock ?? raw['حد إعادة الطلب'];
  const reorderNum = reorderRaw !== undefined && reorderRaw !== null && reorderRaw !== '' ? Number(reorderRaw) : undefined;
  return {
    name: String(name).trim(),
    scientificName: String(
      raw.scientificName ?? raw.scientific_name ?? raw.active_ingredient ?? raw['الاسم العلمي'] ?? raw['المادة الفعالة'] ?? '',
    ).trim() || undefined,
    form: String(raw.form ?? raw.dosage_form ?? raw['الشكل'] ?? raw['الشكل الصيدلاني'] ?? '').trim() || undefined,
    strength: String(raw.strength ?? raw.dose ?? raw['التركيز'] ?? '').trim() || undefined,
    barcode: String(raw.barcode ?? raw.sku ?? raw['الباركود'] ?? '').trim() || undefined,
    unit: String(raw.unit ?? raw['الوحدة'] ?? '').trim() || undefined,
    reorderLevel: Number.isFinite(reorderNum) && reorderNum >= 0 ? Math.trunc(reorderNum) : undefined,
  };
}

function normalizeInteractionRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const drugA = raw.drugA ?? raw.drug_a ?? raw.medicine_a ?? raw.drug1 ?? raw['الدواء الأول'];
  const drugB = raw.drugB ?? raw.drug_b ?? raw.medicine_b ?? raw.drug2 ?? raw['الدواء الثاني'];
  if (!drugA || !drugB || !String(drugA).trim() || !String(drugB).trim()) return null;
  return {
    drugA: String(drugA).trim(),
    drugB: String(drugB).trim(),
    severity: String(raw.severity ?? raw.level ?? raw.risk ?? raw['الخطورة'] ?? raw['الشدة'] ?? 'moderate').trim(),
    description:
      String(raw.description ?? raw.details ?? raw.effect ?? raw['الوصف'] ?? raw['التأثير السريري'] ?? '').trim() || undefined,
    source: String(raw.source ?? raw.reference ?? raw['المصدر'] ?? '').trim() || undefined,
  };
}

/**
 * يحلل نص CSV أو JSON إلى قوائم أدوية وتداخلات جاهزة للاستيراد.
 */
export function parseCatalogText(rawText, defaultKind = 'medicines') {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { medicines: [], interactions: [] };

  if (text.startsWith('{') || text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      if (defaultKind === 'interactions') {
        return {
          medicines: [],
          interactions: parsed.map(normalizeInteractionRecord).filter(Boolean),
        };
      }
      return {
        medicines: parsed.map(normalizeMedicineRecord).filter(Boolean),
        interactions: [],
      };
    }
    return {
      medicines: Array.isArray(parsed.medicines)
        ? parsed.medicines.map(normalizeMedicineRecord).filter(Boolean)
        : [],
      interactions: Array.isArray(parsed.interactions)
        ? parsed.interactions.map(normalizeInteractionRecord).filter(Boolean)
        : [],
    };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return { medicines: [], interactions: [] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const lowerHeaders = headers.map((h) => h.toLowerCase());
  const looksLikeInteractions = lowerHeaders.some((h) => INTERACTION_HEADER_MAP[h] === 'drugA');
  const map = looksLikeInteractions ? INTERACTION_HEADER_MAP : MEDICINE_HEADER_MAP;

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const record = {};
    headers.forEach((header, idx) => {
      const key = map[header.toLowerCase()] ?? map[header] ?? header;
      if (cells[idx] !== undefined && cells[idx] !== '') {
        record[key] = cells[idx];
      }
    });
    rows.push(record);
  }

  if (looksLikeInteractions) {
    return {
      medicines: [],
      interactions: rows.map(normalizeInteractionRecord).filter(Boolean),
    };
  }
  return {
    medicines: rows.map(normalizeMedicineRecord).filter(Boolean),
    interactions: [],
  };
}

export function buildMedicinesCsvTemplate() {
  return [
    'name,scientific_name,form,strength,barcode,unit,reorder_level',
    'Panadol Advance,Paracetamol (الباراسيتامول),أقراص,500 مجم,,علبة,10',
  ].join('\n');
}
