/**
 * ثوابت وتصنيفات وكيل سلامة الأدوية متعدد المصادر.
 * القواعد الصارمة:
 * - عدم استخدام Gemini أو أي نموذج لغوي مدفوع.
 * - استبعاد DDInter حاليًا لترخيصه غير التجاري (CC BY-NC-SA 4.0) وDrugBank لكونه مدفوعًا.
 * - عدم عرض عبارة «آمن» أبدًا لمجرد عدم العثور على تداخل.
 */

export const SAFETY_CLASSIFICATION = Object.freeze({
  DOCUMENTED_INTERACTION: {
    code: 'documented_interaction',
    label: 'تداخل دوائي موثق بمصدر موثوق',
    rank: 0,
  },
  SOURCE_CONFLICT: {
    code: 'source_conflict',
    label: 'تعارض بين المصادر',
    rank: 1,
  },
  DOCUMENTED_WARNING: {
    code: 'documented_warning',
    label: 'تحذير دوائي موثق',
    rank: 2,
  },
  SOURCE_ACCESS_FAILED: {
    code: 'source_access_failed',
    label: 'فشل الوصول إلى المصدر',
    rank: 3,
  },
  INSUFFICIENT_INFO: {
    code: 'insufficient_information',
    label: 'معلومات غير كافية للحكم',
    rank: 4,
  },
  NO_INTERACTION_FOUND: {
    code: 'no_interaction_found',
    label: 'عدم العثور على معلومات عن التداخل',
    rank: 5,
  },
});

export const CLINICAL_DISCLAIMER =
  'تنبيه سريري: هذه النتيجة ناتجة عن تحقق آلي من مصادر طبية منشورة، ولا تُعد حكمًا طبيًا نهائيًا أو توصية علاجية؛ يبقى القرار النهائي للصيدلي أو المختص الصحي. عدم العثور على تداخل مسجّل لا يعني أن الاستخدام «آمن» سريريًا.';

export const EXCLUDED_SOURCES = Object.freeze([
  {
    id: 'ddinter',
    name: 'DDInter',
    status: 'excluded',
    reason: 'مستبعد حاليًا بسبب ترخيصه غير التجاري (CC BY-NC-SA 4.0) التزامًا بسياسة الاستخدام التجاري.',
  },
  {
    id: 'drugbank',
    name: 'DrugBank',
    status: 'excluded',
    reason: 'قاعدة بيانات تجارية مدفوعة مستبعدة لعدم توفر ترخيص.',
  },
]);

export const REGIONAL_AUTHORITY_PORTALS = Object.freeze([
  {
    id: 'sfda',
    name: 'الهيئة العامة للغذاء والدواء السعودية (SFDA)',
    domain: 'sfda.gov.sa',
    url: 'https://www.sfda.gov.sa/en/drugs-list',
    accessType: 'web_portal_only',
    note: 'لا تتوفر واجهة برمجة عامة مجانية (API)؛ يُبحث فيها عبر محرك البحث OpenSERP/SearXNG عند تفعيله.',
  },
  {
    id: 'jfda',
    name: 'المؤسسة العامة للغذاء والدواء الأردنية (JFDA)',
    domain: 'jfda.jo',
    url: 'https://www.jfda.jo',
    accessType: 'web_portal_only',
    note: 'بوابة ويب رسمية بلا API عام؛ تُفحص عبر OpenSERP/SearXNG عند التفعيل.',
  },
  {
    id: 'eda',
    name: 'هيئة الدواء المصرية (EDA)',
    domain: 'edaegypt.gov.eg',
    url: 'https://www.edaegypt.gov.eg',
    accessType: 'web_portal_only',
    note: 'بوابة ويب رسمية بلا API عام؛ تُفحص عبر OpenSERP/SearXNG عند التفعيل.',
  },
  {
    id: 'sbdma',
    name: 'الهيئة العليا للأدوية والمستلزمات الطبية (اليمن)',
    domain: 'sbdma.gov.ye',
    url: 'https://www.sbdma.gov.ye',
    accessType: 'web_portal_only',
    note: 'لا تتوفر واجهة API برمجية؛ تُفحص صفحاتها العامة عند التفعيل وإمكانية الوصول.',
  },
]);

export const OPENSERP_HOSTING_REQUIREMENTS = Object.freeze({
  primaryEngine: 'OpenSERP',
  fallbackEngine: 'SearXNG',
  licenseCost: 'مجاني ومفتوح المصدر (0 دولار رسوم ترخيص)',
  requirements: [
    'خادم أو حاوية مرافقة (Docker أو Go 1.22+ مع Chromium/Chrome للبحث غير المحدود).',
    'ذاكرة عشوائية مخصصة إضافية تُقدّر بـ 512MB–1GB لتشغيل محرك البحث.',
    'منفذ داخلي آمن يربطه متغير البيئة OPENSERP_URL (أو SEARXNG_URL كبديل).',
  ],
  runtimeNote:
    'الخادم الحالي يعمل في بيئة Node.js ولا يتضمن Docker أو Go أو Chromium، لذلك تبقى ميزة بحث الويب المفتوح معطّلة تلقائيًا (not_configured) دون التأثير على المصادر الطبية الرسمية (RxNorm وopenFDA وDailyMed وPubMed) حتى ضبط OPENSERP_URL أو SEARXNG_URL.',
});
