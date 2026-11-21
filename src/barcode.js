/**
 * محلل الباركود القياسي وGS1 DataMatrix الخاص بالأدوية.
 * يدعم:
 * - الباركود الخطي التقليدي (EAN-13 / EAN-8 / UPC / Code-128).
 * - باركود GS1 ثنائي الأبعاد سواء بالصيغة الخام المفصولة بـ FNC1 (\u001d)
 *   أو بصيغة الأقواس المقروءة مثل (01)06291000012345(17)270831(10)LOT42.
 */

const GS = '\u001d';
const SYMBOLOGY_PREFIX_RE = /^\](d2|C1|e0|E0|Q3)/;

function parseGs1Expiry(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  if (dd === 0) {
    // في معيار GS1 يعني اليوم 00 آخر يوم في الشهر.
    dd = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  }
  const check = new Date(Date.UTC(year, mm - 1, dd));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== mm - 1 || check.getUTCDate() !== dd) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function buildBarcodeCandidates(barcode, gtin) {
  const set = new Set();
  for (const val of [barcode, gtin]) {
    const clean = String(val ?? '').trim();
    if (!clean) continue;
    set.add(clean);
    if (/^\d{14}$/.test(clean) && clean.startsWith('0')) {
      set.add(clean.slice(1));
    }
    if (/^\d{13}$/.test(clean)) {
      set.add(`0${clean}`);
    }
  }
  return [...set];
}

function parseParenthesizedGs1(cleaned) {
  const aiMap = {};
  const re = /\((\d{2,4})\)([^()]+)/g;
  let match;
  let count = 0;
  while ((match = re.exec(cleaned)) !== null) {
    aiMap[match[1]] = match[2].trim();
    count += 1;
  }
  if (count === 0 || (!aiMap['01'] && !aiMap['10'] && !aiMap['17'])) {
    return null;
  }
  const gtin = aiMap['01'] && /^\d{14}$/.test(aiMap['01']) ? aiMap['01'] : aiMap['01'] ?? null;
  const barcode = gtin && /^\d{14}$/.test(gtin) && gtin.startsWith('0') ? gtin.slice(1) : gtin ?? cleaned;
  const expiryDate = aiMap['17'] ? parseGs1Expiry(aiMap['17']) : null;
  const batchNumber = aiMap['10'] ? aiMap['10'].slice(0, 40) : null;
  return {
    raw: cleaned,
    format: 'gs1',
    barcode,
    gtin,
    batchNumber,
    expiryDate,
    candidates: buildBarcodeCandidates(barcode, gtin),
  };
}

function parseRawGs1(cleaned) {
  let cursor = 0;
  let gtin = null;
  let expiryDate = null;
  let batchNumber = null;
  let matchedAny = false;

  const readVariableUntilGs = (start) => {
    const idx = cleaned.indexOf(GS, start);
    if (idx === -1) return { value: cleaned.slice(start), next: cleaned.length };
    return { value: cleaned.slice(start, idx), next: idx + 1 };
  };

  while (cursor < cleaned.length) {
    if (cleaned[cursor] === GS) {
      cursor += 1;
      continue;
    }
    const ai2 = cleaned.slice(cursor, cursor + 2);
    if (ai2 === '01' && /^\d{14}/.test(cleaned.slice(cursor + 2, cursor + 16))) {
      gtin = cleaned.slice(cursor + 2, cursor + 16);
      cursor += 16;
      matchedAny = true;
      continue;
    }
    if (ai2 === '17' && /^\d{6}/.test(cleaned.slice(cursor + 2, cursor + 8))) {
      const parsedDate = parseGs1Expiry(cleaned.slice(cursor + 2, cursor + 8));
      if (!parsedDate) break;
      expiryDate = parsedDate;
      cursor += 8;
      matchedAny = true;
      continue;
    }
    if (ai2 === '11' && /^\d{6}/.test(cleaned.slice(cursor + 2, cursor + 8))) {
      // تاريخ الإنتاج: نتجاوزه بأمان
      cursor += 8;
      matchedAny = true;
      continue;
    }
    if (ai2 === '10') {
      const { value, next } = readVariableUntilGs(cursor + 2);
      if (value) batchNumber = value.slice(0, 40);
      cursor = next;
      matchedAny = true;
      continue;
    }
    if (ai2 === '21') {
      // الرقم التسلسلي: نتجاوزه إلى الفاصل التالي أو النهاية
      const { next } = readVariableUntilGs(cursor + 2);
      cursor = next;
      matchedAny = true;
      continue;
    }
    break;
  }

  if (!matchedAny || !gtin) return null;
  const barcode = gtin.startsWith('0') ? gtin.slice(1) : gtin;
  return {
    raw: cleaned,
    format: 'gs1',
    barcode,
    gtin,
    batchNumber,
    expiryDate,
    candidates: buildBarcodeCandidates(barcode, gtin),
  };
}

export function parseBarcodePayload(rawValue) {
  const cleaned = String(rawValue ?? '')
    .trim()
    .replace(SYMBOLOGY_PREFIX_RE, '')
    .trim();

  if (!cleaned) {
    return {
      raw: '',
      format: 'empty',
      barcode: '',
      gtin: null,
      batchNumber: null,
      expiryDate: null,
      candidates: [],
    };
  }

  if (cleaned.includes('(')) {
    const parenthesized = parseParenthesizedGs1(cleaned);
    if (parenthesized) return parenthesized;
  }

  if (cleaned.startsWith('01') && cleaned.length >= 16) {
    const rawGs1 = parseRawGs1(cleaned);
    if (rawGs1) return rawGs1;
  }

  const normalized = cleaned.replace(/[\r\n\u001d]+/g, '');
  return {
    raw: normalized,
    format: 'standard',
    barcode: normalized,
    gtin: null,
    batchNumber: null,
    expiryDate: null,
    candidates: buildBarcodeCandidates(normalized, null),
  };
}

export function findMedicineByBarcode(medicines, parsedOrCode) {
  if (!Array.isArray(medicines) || medicines.length === 0) return null;
  const parsed = typeof parsedOrCode === 'string' ? parseBarcodePayload(parsedOrCode) : parsedOrCode;
  const candidates = (parsed?.candidates ?? []).map((c) => c.toLowerCase());
  if (candidates.length === 0) return null;

  return (
    medicines.find((medicine) => {
      const code = String(medicine?.barcode ?? '').trim().toLowerCase();
      if (!code) return false;
      if (candidates.includes(code)) return true;
      if (/^\d{13}$/.test(code) && candidates.includes(`0${code}`)) return true;
      if (/^\d{14}$/.test(code) && code.startsWith('0') && candidates.includes(code.slice(1))) return true;
      return false;
    }) ?? null
  );
}

export function pickFefoBatchForMedicine(batches, medicineId) {
  if (!Array.isArray(batches) || !medicineId) return null;
  const related = batches.filter(
    (b) => String(b.medicineId) === String(medicineId) && Number(b.quantity) > 0 && b.expiryBucket !== 'expired',
  );
  if (related.length === 0) return null;
  const flagged = related.find((b) => b.isFefoNext);
  if (flagged) return flagged;
  return [...related].sort((a, b) =>
    String(a.expiryDate ?? '9999-12-31').localeCompare(String(b.expiryDate ?? '9999-12-31')),
  )[0];
}
