/**
 * طبقة المخزون: اكتشاف أسماء الأعمدة الفعلية في الجداول الموجودة مسبقًا،
 * وتحويل الصفوف إلى شكل واجهة ثابت، ودوال حسابية نقية (تنبيهات وتقارير).
 *
 * لا تُنشأ جداول ولا تُفترض أسماء أعمدة: إن لم يوجد العمود نعيد null
 * ونُبلّغ الواجهة بذلك بدلًا من التخمين.
 */
import { getSchema, resolveColumn, pickPayload } from './schema.js';
import { pharmacyIdOf } from './profiles.js';

export const COLUMN_CANDIDATES = Object.freeze({
  medicines: {
    id: ['id', 'medicine_id'],
    name: ['name', 'medicine_name', 'trade_name', 'drug_name', 'title'],
    scientificName: ['scientific_name', 'generic_name', 'active_ingredient', 'ingredient'],
    form: ['form', 'dosage_form', 'type', 'category'],
    strength: ['strength', 'dose', 'concentration'],
    barcode: ['barcode', 'sku', 'code', 'product_code'],
    unit: ['unit', 'unit_of_measure', 'uom'],
    reorderLevel: ['reorder_level', 'min_stock', 'minimum_stock', 'reorder_point', 'min_quantity'],
    isActive: ['is_active', 'active', 'archived'],
    pharmacy: ['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'],
    createdAt: ['created_at', 'inserted_at'],
  },
  inventory_batches: {
    id: ['id', 'batch_id'],
    medicine: ['medicine_id', 'medicine', 'drug_id', 'medicines_id'],
    batchNumber: ['batch_number', 'lot_number', 'batch_no', 'batch', 'lot'],
    quantity: ['quantity', 'qty', 'quantity_on_hand', 'stock', 'remaining_quantity'],
    expiryDate: ['expiry_date', 'expires_at', 'expiration_date', 'expiry'],
    receivedAt: ['received_at', 'received_date', 'created_at'],
    costPrice: ['cost_price', 'purchase_price', 'unit_cost', 'cost'],
    sellingPrice: ['selling_price', 'sale_price', 'price', 'unit_price'],
    isActive: ['is_active', 'active'],
    pharmacy: ['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'],
  },
  stock_movements: {
    id: ['id', 'movement_id'],
    batch: ['batch_id', 'inventory_batch_id'],
    medicine: ['medicine_id', 'medicine', 'drug_id', 'medicines_id'],
    type: ['movement_type', 'type', 'kind', 'reason'],
    quantity: ['quantity', 'qty', 'amount', 'delta', 'change'],
    note: ['note', 'notes', 'comment', 'details'],
    user: ['user_id', 'profile_id', 'created_by', 'performed_by'],
    createdAt: ['created_at', 'moved_at', 'occurred_at', 'inserted_at'],
    pharmacy: ['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'],
  },
  inventory_alerts: {
    id: ['id', 'alert_id'],
    medicine: ['medicine_id', 'medicine', 'drug_id', 'medicines_id'],
    batch: ['batch_id', 'inventory_batch_id'],
    type: ['alert_type', 'type', 'kind'],
    severity: ['severity', 'level', 'priority'],
    message: ['message', 'description', 'title', 'text'],
    resolved: ['is_resolved', 'resolved', 'acknowledged', 'is_acknowledged'],
    createdAt: ['created_at', 'inserted_at'],
    pharmacy: ['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'],
  },
  reports: {
    id: ['id', 'report_id'],
    type: ['report_type', 'type', 'kind'],
    title: ['title', 'name'],
    payload: ['payload', 'data', 'content', 'body', 'summary'],
    user: ['user_id', 'profile_id', 'created_by'],
    createdAt: ['created_at', 'inserted_at'],
    pharmacy: ['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'],
  },
  agent_runs: {
    id: ['id', 'run_id'],
    prompt: ['prompt', 'query', 'question', 'input'],
    answer: ['answer', 'response', 'output', 'result'],
    status: ['status', 'state'],
    user: ['user_id', 'profile_id', 'created_by'],
    createdAt: ['created_at', 'inserted_at'],
    pharmacy: ['pharmacy_id', 'pharmacy', 'store_id', 'pharmacies_id'],
  },
  drug_interactions: {
    id: ['id', 'interaction_id'],
    drugA: ['drug_a', 'medicine_a', 'drug1', 'active_a', 'substance_a'],
    drugB: ['drug_b', 'medicine_b', 'drug2', 'active_b', 'substance_b'],
    severity: ['severity', 'level', 'risk'],
    description: ['description', 'details', 'effect', 'notes'],
    source: ['source', 'reference', 'source_url'],
  },
});

function resolveTable(schema, table) {
  const candidates = COLUMN_CANDIDATES[table] ?? {};
  const resolved = {};
  for (const [key, list] of Object.entries(candidates)) {
    resolved[key] = resolveColumn(schema, table, list);
  }
  return resolved;
}

/** أعمدة كل جدول مخزون، مع كاش قصير داخل getSchema. */
export async function inventoryColumns(force = false) {
  const schema = await getSchema(force);
  return {
    schema,
    schemaOk: Boolean(schema?.ok),
    tables: schema?.tables ?? {},
    medicines: resolveTable(schema, 'medicines'),
    batches: resolveTable(schema, 'inventory_batches'),
    movements: resolveTable(schema, 'stock_movements'),
    alerts: resolveTable(schema, 'inventory_alerts'),
    reports: resolveTable(schema, 'reports'),
    agentRuns: resolveTable(schema, 'agent_runs'),
    interactions: resolveTable(schema, 'drug_interactions'),
  };
}

export function hasTable(columns, table) {
  if (!columns?.schemaOk) return null;
  return Boolean(columns.tables?.[table]);
}

export function payloadFor(columns, table, desired) {
  return pickPayload(columns.schema, table, desired);
}

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function toDateOnly(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function daysUntil(dateOnly, now = new Date()) {
  if (!dateOnly) return null;
  const target = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** تصنيف الصلاحية: منتهٍ / حرج (≤30 يومًا) / قريب (≤90) / سليم. */
export function classifyExpiry(expiryDate, now = new Date()) {
  const days = daysUntil(expiryDate, now);
  if (days === null) return { bucket: 'unknown', days: null };
  if (days < 0) return { bucket: 'expired', days };
  if (days <= 30) return { bucket: 'critical', days };
  if (days <= 90) return { bucket: 'warning', days };
  return { bucket: 'ok', days };
}

export function shapeMedicine(row, cols) {
  if (!row) return null;
  return {
    id: row[cols.id] ?? null,
    name: row[cols.name] ?? null,
    scientificName: cols.scientificName ? row[cols.scientificName] ?? null : null,
    form: cols.form ? row[cols.form] ?? null : null,
    strength: cols.strength ? row[cols.strength] ?? null : null,
    barcode: cols.barcode ? row[cols.barcode] ?? null : null,
    unit: cols.unit ? row[cols.unit] ?? null : null,
    reorderLevel: cols.reorderLevel ? num(row[cols.reorderLevel], 0) : 0,
    isActive: cols.isActive ? row[cols.isActive] !== false : true,
    pharmacyId: cols.pharmacy && row[cols.pharmacy] != null ? String(row[cols.pharmacy]) : null,
    createdAt: cols.createdAt ? row[cols.createdAt] ?? null : null,
  };
}

export function shapeBatch(row, cols, now = new Date()) {
  if (!row) return null;
  const expiryDate = cols.expiryDate ? toDateOnly(row[cols.expiryDate]) : null;
  const expiry = classifyExpiry(expiryDate, now);
  return {
    id: row[cols.id] ?? null,
    medicineId: cols.medicine && row[cols.medicine] != null ? String(row[cols.medicine]) : null,
    batchNumber: cols.batchNumber ? row[cols.batchNumber] ?? null : null,
    quantity: cols.quantity ? num(row[cols.quantity], 0) : 0,
    expiryDate,
    expiryBucket: expiry.bucket,
    daysToExpiry: expiry.days,
    costPrice: cols.costPrice ? num(row[cols.costPrice], 0) : null,
    sellingPrice: cols.sellingPrice ? num(row[cols.sellingPrice], 0) : null,
    receivedAt: cols.receivedAt ? row[cols.receivedAt] ?? null : null,
    isActive: cols.isActive ? row[cols.isActive] !== false : true,
    pharmacyId: cols.pharmacy && row[cols.pharmacy] != null ? String(row[cols.pharmacy]) : null,
  };
}

export function shapeMovement(row, cols) {
  if (!row) return null;
  return {
    id: row[cols.id] ?? null,
    batchId: cols.batch && row[cols.batch] != null ? String(row[cols.batch]) : null,
    medicineId: cols.medicine && row[cols.medicine] != null ? String(row[cols.medicine]) : null,
    type: cols.type ? String(row[cols.type] ?? '').toLowerCase() || null : null,
    quantity: cols.quantity ? num(row[cols.quantity], 0) : 0,
    note: cols.note ? row[cols.note] ?? null : null,
    createdAt: cols.createdAt ? row[cols.createdAt] ?? null : null,
  };
}

export const MOVEMENT_TYPES = Object.freeze(['receive', 'dispense', 'adjust', 'write_off', 'return']);

export const MOVEMENT_TYPE_LABELS = Object.freeze({
  receive: 'استلام',
  dispense: 'صرف',
  adjust: 'تعديل',
  write_off: 'إتلاف',
  return: 'إرجاع',
  unknown: 'غير محدد',
});

/** أنواع الحركات التي تزيد الكمية (باقيها ينقصها). */
export const INCREASING_MOVEMENTS = Object.freeze(['receive', 'return', 'adjust_in', 'in']);

/** أنواع الحركات التي تنقص الكمية. */
export const DECREASING_MOVEMENTS = Object.freeze(['dispense', 'adjust', 'write_off', 'out', 'waste']);

export function movementDelta(type, quantity) {
  const qty = Math.abs(num(quantity, 0));
  return INCREASING_MOVEMENTS.includes(String(type)) ? qty : -qty;
}

function compareFefoBatch(a, b) {
  if (a.expiryDate && !b.expiryDate) return -1;
  if (!a.expiryDate && b.expiryDate) return 1;
  if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) {
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  const recA = a.receivedAt ? String(a.receivedAt) : '';
  const recB = b.receivedAt ? String(b.receivedAt) : '';
  if (recA && recB && recA !== recB) return recA < recB ? -1 : 1;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/** يرتب الدفعات الصالحة للصرف (غير المنتهية وذات كمية > 0) حسب الأقرب انتهاءً (FEFO). */
export function sortBatchesFefo(batches = [], now = new Date()) {
  return batches
    .filter((batch) => {
      if (!batch || num(batch.quantity, 0) <= 0) return false;
      const bucket = classifyExpiry(batch.expiryDate, now).bucket;
      return bucket !== 'expired';
    })
    .slice()
    .sort(compareFefoBatch);
}

/** يخطط صرف كمية محددة من الدفعات الصالحة بترتيب FEFO دون تعديل المصفوفة الأصلية. */
export function planFefoDispense(batches = [], requestedQuantity, now = new Date()) {
  const requested = num(requestedQuantity, 0);
  if (!Number.isInteger(requested) || requested <= 0) {
    return { ok: false, reason: 'invalid_quantity', available: 0, requested, allocations: [] };
  }

  const eligible = sortBatchesFefo(batches, now);
  const available = eligible.reduce((sum, batch) => sum + num(batch.quantity, 0), 0);
  if (available < requested) {
    return { ok: false, reason: 'insufficient_quantity', available, requested, allocations: [] };
  }

  let remaining = requested;
  const allocations = [];
  for (const batch of eligible) {
    if (remaining <= 0) break;
    const current = num(batch.quantity, 0);
    const take = Math.min(remaining, current);
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber ?? null,
      medicineId: batch.medicineId ?? null,
      expiryDate: batch.expiryDate ?? null,
      previousQuantity: current,
      take,
      newQuantity: current - take,
    });
    remaining -= take;
  }

  return { ok: true, available, requested, allocations };
}

/** يرجع أول دفعة صالحة للصرف تنتهي قبل الدفعة المستهدفة إن وُجدت (لإنفاذ FEFO). */
export function findFefoBlockingBatch(batches = [], targetBatch, now = new Date()) {
  if (!targetBatch?.id) return null;
  const targetMed = targetBatch.medicineId != null ? String(targetBatch.medicineId) : null;
  const sameMedicine = targetMed
    ? batches.filter((batch) => String(batch.medicineId ?? '') === targetMed)
    : batches;
  const eligible = sortBatchesFefo(sameMedicine, now);
  if (eligible.length === 0) return null;

  const earliest = eligible[0];
  if (String(earliest.id) === String(targetBatch.id)) return null;

  if (earliest.expiryDate && !targetBatch.expiryDate) return earliest;
  if (earliest.expiryDate && targetBatch.expiryDate && earliest.expiryDate < targetBatch.expiryDate) {
    return earliest;
  }
  return null;
}

/**
 * تجميع كميات الدفعات لكل دواء، وتجاهل الدفعات المنتهية في «المتاح للصرف».
 */
export function aggregateStock(batches, now = new Date()) {
  const byMedicine = new Map();
  for (const batch of batches) {
    if (!batch.medicineId) continue;
    const entry = byMedicine.get(batch.medicineId) ?? {
      medicineId: batch.medicineId,
      totalUnits: 0,
      sellableUnits: 0,
      expiredUnits: 0,
      expiringUnits: 0,
      costValue: 0,
      sellingValue: 0,
      batches: 0,
      nearestExpiry: null,
    };
    entry.totalUnits += batch.quantity;
    entry.batches += 1;
    if (batch.expiryBucket === 'expired') entry.expiredUnits += batch.quantity;
    else entry.sellableUnits += batch.quantity;
    if (batch.expiryBucket === 'critical' || batch.expiryBucket === 'warning') {
      entry.expiringUnits += batch.quantity;
    }
    entry.costValue += batch.quantity * num(batch.costPrice, 0);
    entry.sellingValue += batch.quantity * num(batch.sellingPrice, 0);
    if (batch.expiryDate && (!entry.nearestExpiry || batch.expiryDate < entry.nearestExpiry)) {
      entry.nearestExpiry = batch.expiryDate;
    }
    byMedicine.set(batch.medicineId, entry);
  }
  return byMedicine;
}

/**
 * تنبيهات محسوبة من البيانات الفعلية فقط (لا تُخترع حالات):
 * نفاد المخزون، انخفاض عن حد إعادة الطلب، انتهاء الصلاحية، وقرب الانتهاء.
 */
export function computeAlerts({ medicines = [], batches = [], now = new Date() } = {}) {
  const stock = aggregateStock(batches, now);
  const medicineNames = new Map(
    medicines.filter((m) => m?.id != null).map((m) => [String(m.id), m.name ?? null]),
  );
  const alerts = [];

  for (const medicine of medicines) {
    if (!medicine?.id) continue;
    const entry = stock.get(String(medicine.id)) ?? {
      totalUnits: 0,
      sellableUnits: 0,
      expiredUnits: 0,
      expiringUnits: 0,
      nearestExpiry: null,
    };
    const reorder = num(medicine.reorderLevel, 0);

    if (entry.sellableUnits <= 0) {
      alerts.push({
        key: `out:${medicine.id}`,
        type: 'out_of_stock',
        severity: 'high',
        medicineId: String(medicine.id),
        medicineName: medicine.name,
        units: entry.sellableUnits,
        message: `لا توجد كمية صالحة للصرف من «${medicine.name}».`,
      });
    } else if (reorder > 0 && entry.sellableUnits <= reorder) {
      alerts.push({
        key: `low:${medicine.id}`,
        type: 'low_stock',
        severity: entry.sellableUnits <= reorder / 2 ? 'high' : 'medium',
        medicineId: String(medicine.id),
        medicineName: medicine.name,
        units: entry.sellableUnits,
        reorderLevel: reorder,
        message: `الكمية المتاحة من «${medicine.name}» (${entry.sellableUnits}) عند/تحت حد إعادة الطلب (${reorder}).`,
      });
    }
  }

  for (const batch of batches) {
    const medName = batch.medicineId ? medicineNames.get(String(batch.medicineId)) ?? null : null;
    if (batch.expiryBucket === 'expired' && batch.quantity > 0) {
      alerts.push({
        key: `expired:${batch.id}`,
        type: 'expired_batch',
        severity: 'high',
        medicineId: batch.medicineId,
        medicineName: medName,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        units: batch.quantity,
        expiryDate: batch.expiryDate,
        daysToExpiry: batch.daysToExpiry,
        message: `الدفعة ${batch.batchNumber ?? batch.id} منتهية الصلاحية (${batch.expiryDate}) وبها ${batch.quantity} وحدة يجب سحبها.`,
      });
    } else if (batch.expiryBucket === 'critical' && batch.quantity > 0) {
      alerts.push({
        key: `expiring:${batch.id}`,
        type: 'expiring_soon',
        severity: 'medium',
        medicineId: batch.medicineId,
        medicineName: medName,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        units: batch.quantity,
        expiryDate: batch.expiryDate,
        daysToExpiry: batch.daysToExpiry,
        message: `الدفعة ${batch.batchNumber ?? batch.id} تنتهي خلال ${batch.daysToExpiry} يومًا (${batch.expiryDate}).`,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

/** ملخّص أرقام حقيقية من الجداول — أساس التقارير والوكيل. */
export function buildInventorySummary({ medicines = [], batches = [], movements = [] } = {}, now = new Date()) {
  const stock = aggregateStock(batches, now);
  let totalUnits = 0;
  let sellableUnits = 0;
  let expiredUnits = 0;
  let costValue = 0;
  let sellingValue = 0;

  for (const entry of stock.values()) {
    totalUnits += entry.totalUnits;
    sellableUnits += entry.sellableUnits;
    expiredUnits += entry.expiredUnits;
    costValue += entry.costValue;
    sellingValue += entry.sellingValue;
  }

  const movementsByType = {};
  for (const movement of movements) {
    const key = movement.type ?? 'unknown';
    movementsByType[key] = (movementsByType[key] ?? 0) + Math.abs(num(movement.quantity, 0));
  }

  const lowStock = medicines
    .map((medicine) => {
      const entry = stock.get(String(medicine.id));
      return {
        medicineId: String(medicine.id),
        name: medicine.name,
        units: entry?.sellableUnits ?? 0,
        reorderLevel: num(medicine.reorderLevel, 0),
      };
    })
    .filter((row) => row.reorderLevel > 0 && row.units <= row.reorderLevel)
    .sort((a, b) => a.units - b.units);

  const medicineNames = new Map(
    medicines.filter((m) => m?.id != null).map((m) => [String(m.id), m.name ?? null]),
  );

  const expiring = batches
    .filter((batch) => batch.quantity > 0 && (batch.expiryBucket === 'critical' || batch.expiryBucket === 'warning'))
    .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)))
    .slice(0, 25)
    .map((batch) => ({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      medicineId: batch.medicineId,
      medicineName: batch.medicineId ? medicineNames.get(String(batch.medicineId)) ?? null : null,
      quantity: batch.quantity,
      expiryDate: batch.expiryDate,
      daysToExpiry: batch.daysToExpiry,
      bucket: batch.expiryBucket,
    }));

  return {
    generatedAt: now.toISOString(),
    counts: {
      medicines: medicines.length,
      batches: batches.length,
      movements: movements.length,
      activeMedicines: medicines.filter((medicine) => medicine.isActive).length,
    },
    units: { total: totalUnits, sellable: sellableUnits, expired: expiredUnits },
    value: { cost: Number(costValue.toFixed(2)), selling: Number(sellingValue.toFixed(2)) },
    lowStock,
    expiring,
    movementsByType,
  };
}

/** يتحقق من أن المستخدم مرتبط بصيدلية عندما يحتوي الجدول على عمود صيدلية. */
export function requirePharmacy(columns, tableKey, profile) {
  const pharmacyColumn = columns?.[tableKey]?.pharmacy;
  const pharmacyId = pharmacyIdOf(profile);
  if (pharmacyColumn && !pharmacyId) {
    return {
      ok: false,
      status: 403,
      code: 'pharmacy_not_linked',
      message: 'حسابك غير مرتبط بصيدلية بعد. اطلب من مالك الصيدلية ربط حسابك أولًا.',
    };
  }
  return { ok: true, pharmacyId };
}

/** يحصر استعلامًا في صيدلية المستخدم عندما يكون عمود الصيدلية معروفًا. */
export function scopeToPharmacy(query, columns, tableKey, profile) {
  const pharmacyId = pharmacyIdOf(profile);
  const column = columns?.[tableKey]?.pharmacy;
  if (column && pharmacyId) return query.eq(column, pharmacyId);
  return query;
}
