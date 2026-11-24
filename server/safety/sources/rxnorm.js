/**
 * موصل RxNorm الرسمي (U.S. National Library of Medicine):
 * - توحيد أسماء الأدوية والمواد الفعالة والأسماء التجارية.
 * - كشف تطابق المادة الفعالة (IN / PIN / MIN) رغم اختلاف الأسماء التجارية.
 * - مجاني بدون مفتاح API (الحد الموصى به ≤ 20 طلب/ثانية).
 */

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const CACHE_TTL_MS = 12 * 3600_000;
const REQUEST_TIMEOUT_MS = 8_000;
const cache = new Map();

async function fetchJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PharmaGuardAI/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const err = new Error(`RxNorm HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function normalizeCacheKey(term) {
  return String(term ?? '').trim().toLowerCase();
}

export function clearRxNormCache() {
  cache.clear();
}

/**
 * يستعلم عن دواء (اسم علمي أو تجاري) في RxNorm ويعيد المعرف والمواد الفعالة.
 */
export async function lookupRxNorm(term, { fetchImpl = fetch } = {}) {
  const clean = String(term ?? '').trim();
  if (!clean) {
    return {
      ok: false,
      source: 'RxNorm',
      issuer: 'U.S. National Library of Medicine (RxNorm)',
      matched: false,
      error: 'اسم الدواء فارغ.',
      retrievedAt: new Date().toISOString(),
    };
  }

  const key = normalizeCacheKey(clean);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && fetchImpl === fetch) {
    return cached.value;
  }

  const retrievedAt = new Date().toISOString();
  const exactUrl = `${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(clean)}&search=2`;

  try {
    let rxcui = null;
    let matchType = null;
    let sourceUrl = exactUrl;

    const exactData = await fetchJson(exactUrl, fetchImpl);
    const exactIds = exactData?.idGroup?.rxnormId ?? [];
    if (Array.isArray(exactIds) && exactIds.length > 0) {
      rxcui = String(exactIds[0]);
      matchType = 'exact';
    } else {
      const approxUrl = `${RXNORM_BASE}/approximateTerm.json?term=${encodeURIComponent(clean)}&maxEntries=5`;
      const approxData = await fetchJson(approxUrl, fetchImpl);
      const candidates = approxData?.approximateGroup?.candidate ?? [];
      const best = Array.isArray(candidates) ? candidates[0] : null;
      if (best?.rxcui && Number(best.score ?? 0) >= 50) {
        rxcui = String(best.rxcui);
        matchType = 'approximate';
        sourceUrl = approxUrl;
      }
    }

    if (!rxcui) {
      const miss = {
        ok: true,
        source: 'RxNorm',
        issuer: 'U.S. National Library of Medicine (RxNorm)',
        matched: false,
        query: clean,
        rxcui: null,
        canonicalName: null,
        tty: null,
        activeIngredients: [],
        brandNames: [],
        sourceUrl: exactUrl,
        retrievedAt,
        error: null,
      };
      if (fetchImpl === fetch) cache.set(key, { at: Date.now(), value: miss });
      return miss;
    }

    const propsUrl = `${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/properties.json`;
    const relatedUrl = `${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN+PIN+BN`;

    const [propsRes, relatedRes] = await Promise.allSettled([
      fetchJson(propsUrl, fetchImpl),
      fetchJson(relatedUrl, fetchImpl),
    ]);

    const props = propsRes.status === 'fulfilled' ? propsRes.value?.properties ?? null : null;
    const propsTty = String(props?.tty ?? '').toUpperCase();
    const conceptGroups =
      relatedRes.status === 'fulfilled'
        ? relatedRes.value?.relatedGroup?.conceptGroup ?? []
        : [];

    const ingredients = [];
    const ingredientSeen = new Set();
    const brands = [];
    const brandSeen = new Set();

    // إذا كان المفهوم نفسه مادة فعالة مفردة (IN أو PIN)، فمادته الفعالة هي نفسها دون خلطها بالمركبات
    if (['IN', 'PIN', 'MIN'].includes(propsTty)) {
      const ingName = String(props?.name ?? clean).trim();
      if (ingName) {
        ingredientSeen.add(ingName.toLowerCase());
        ingredients.push({ rxcui, name: ingName, tty: propsTty });
      }
    }

    for (const group of Array.isArray(conceptGroups) ? conceptGroups : []) {
      const tty = String(group?.tty ?? '').toUpperCase();
      const concepts = Array.isArray(group?.conceptProperties) ? group.conceptProperties : [];
      for (const item of concepts) {
        const name = String(item?.name ?? '').trim();
        const id = item?.rxcui ? String(item.rxcui) : null;
        if (!name) continue;
        // إذا كان المفهوم الأساسي IN فلا نضيف مواد أخرى من related حتى لا تدخل تراكيب ثنائية
        if ((tty === 'IN' || tty === 'PIN') && !['IN', 'PIN'].includes(propsTty)) {
          const k = name.toLowerCase();
          if (!ingredientSeen.has(k)) {
            ingredientSeen.add(k);
            ingredients.push({ rxcui: id, name, tty });
          }
        } else if (tty === 'BN') {
          const k = name.toLowerCase();
          if (!brandSeen.has(k)) {
            brandSeen.add(k);
            brands.push({ rxcui: id, name });
          }
        }
      }
    }

    // في حال رجع PIN/MIN دون IN، نعطي الأولوية لـ IN في القائمة
    ingredients.sort((a, b) => {
      const rank = (t) => (t === 'IN' ? 0 : t === 'MIN' ? 1 : 2);
      return rank(a.tty) - rank(b.tty);
    });

    const result = {
      ok: true,
      source: 'RxNorm',
      issuer: 'U.S. National Library of Medicine (RxNorm)',
      matched: true,
      matchType,
      query: clean,
      rxcui,
      canonicalName: props?.name ?? clean,
      tty: props?.tty ?? null,
      activeIngredients: ingredients,
      primaryIngredient: ingredients[0]?.name ?? (props?.tty === 'IN' ? props.name : null),
      brandNames: brands.slice(0, 12),
      sourceUrl: `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/properties.json`,
      lookupUrl: sourceUrl,
      retrievedAt,
      error: null,
    };

    if (fetchImpl === fetch) cache.set(key, { at: Date.now(), value: result });
    return result;
  } catch (error) {
    return {
      ok: false,
      source: 'RxNorm',
      issuer: 'U.S. National Library of Medicine (RxNorm)',
      matched: false,
      query: clean,
      rxcui: null,
      canonicalName: null,
      tty: null,
      activeIngredients: [],
      brandNames: [],
      sourceUrl: exactUrl,
      retrievedAt,
      error: error?.name === 'TimeoutError' ? 'انتهت مهلة الاتصال بـ RxNorm' : String(error?.message ?? error),
    };
  }
}
