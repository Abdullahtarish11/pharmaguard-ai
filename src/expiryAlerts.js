/**
 * تنسيق وفرز تنبيهات الصلاحية التلقائية للعرض في الصفحة الرئيسية حسب الشدة:
 * - expired (شدة عالية / أحمر): منتهية الصلاحية ويُمنع صرفها.
 * - critical (شدة متوسطة / برتقالي): حرجة تنتهي خلال ≤ 30 يومًا.
 * - warning (شدة منخفضة / أصفر): قريبة الانتهاء خلال 31 – 90 يومًا.
 */

const LEVEL_ORDER = { expired: 0, critical: 1, warning: 2 };

export const EXPIRY_SEVERITY_META = Object.freeze({
  expired: {
    level: 'expired',
    severity: 'high',
    label: 'منتهي الصلاحية',
    action: 'سحب وإتلاف فوري — يُمنع الصرف',
  },
  critical: {
    level: 'critical',
    severity: 'medium',
    label: 'حرج (≤ 30 يومًا)',
    action: 'أولوية صرف عاجلة (FEFO)',
  },
  warning: {
    level: 'warning',
    severity: 'low',
    label: 'قريب (31 – 90 يومًا)',
    action: 'متابعة الصرف المبكر',
  },
});

export function buildExpiryAlertItems({ summary, alerts = [] } = {}) {
  const byBatch = new Map();

  for (const alert of Array.isArray(alerts) ? alerts : []) {
    if (alert?.type !== 'expired_batch' || alert.resolved) continue;
    const id = String(alert.batchId ?? alert.key ?? `${alert.medicineId}:${alert.batchNumber}`);
    byBatch.set(id, {
      id,
      batchId: alert.batchId ?? null,
      medicineId: alert.medicineId ?? null,
      medicineName: alert.medicineName || 'دواء غير مسمّى',
      batchNumber: alert.batchNumber ?? 'بدون رقم',
      quantity: Number(alert.units ?? 0),
      expiryDate: alert.expiryDate ?? null,
      daysToExpiry: alert.daysToExpiry ?? null,
      level: 'expired',
      severity: 'high',
    });
  }

  for (const row of Array.isArray(summary?.expiring) ? summary.expiring : []) {
    const level = row?.bucket === 'critical' ? 'critical' : 'warning';
    const severity = level === 'critical' ? 'medium' : 'low';
    const id = String(row.batchId ?? `${row.medicineId}:${row.batchNumber}:${row.expiryDate}`);
    const existing = byBatch.get(id);
    if (existing && LEVEL_ORDER[existing.level] <= LEVEL_ORDER[level]) continue;

    byBatch.set(id, {
      id,
      batchId: row.batchId ?? null,
      medicineId: row.medicineId ?? null,
      medicineName: row.medicineName || 'دواء غير مسمّى',
      batchNumber: row.batchNumber ?? 'بدون رقم',
      quantity: Number(row.quantity ?? 0),
      expiryDate: row.expiryDate ?? null,
      daysToExpiry: row.daysToExpiry ?? null,
      level,
      severity,
    });
  }

  const items = [...byBatch.values()].sort((a, b) => {
    const lvlDiff = (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9);
    if (lvlDiff !== 0) return lvlDiff;
    const daysA = typeof a.daysToExpiry === 'number' ? a.daysToExpiry : 9999;
    const daysB = typeof b.daysToExpiry === 'number' ? b.daysToExpiry : 9999;
    if (daysA !== daysB) return daysA - daysB;
    return String(a.expiryDate ?? '').localeCompare(String(b.expiryDate ?? ''));
  });

  const counts = {
    expired: items.filter((item) => item.level === 'expired').length,
    critical: items.filter((item) => item.level === 'critical').length,
    warning: items.filter((item) => item.level === 'warning').length,
    total: items.length,
  };

  return { items, counts };
}
