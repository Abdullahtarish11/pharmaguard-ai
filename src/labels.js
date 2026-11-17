export const ROLE_LABELS = {
  owner: 'مالك الصيدلية',
  pharmacist: 'صيدلي',
  inventory_manager: 'مسؤول المخزون',
};

export const SELF_REGISTER_ROLES = [
  { value: 'pharmacist', label: 'صيدلي', hint: 'وصف دوائي، تفاعلات، وصفات' },
  { value: 'inventory_manager', label: 'مسؤول المخزون', hint: 'دفعات، حركات، تنبيهات نقص' },
];

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? 'غير محدد';
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ar', { dateStyle: 'medium', timeStyle: 'short' });
}
