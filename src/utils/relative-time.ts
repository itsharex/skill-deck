/**
 * 将时间戳格式化为相对时间的 i18n key + params。
 * 返回 { key, params } 供 t(key, params) 使用。
 */
export function formatRelativeTime(timestamp: number): { key: string; params?: Record<string, number> } {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) {
    return { key: 'settings.update.justNow' };
  }
  if (diffMinutes < 60) {
    return { key: 'settings.update.minutesAgo', params: { count: diffMinutes } };
  }
  if (diffHours < 24) {
    return { key: 'settings.update.hoursAgo', params: { count: diffHours } };
  }
  if (diffHours < 48) {
    return { key: 'settings.update.yesterday' };
  }
  return { key: 'settings.update.daysAgo', params: { count: diffDays } };
}
