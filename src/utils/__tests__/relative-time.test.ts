import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelativeTime } from '../relative-time';

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns justNow for < 1 minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T12:00:30Z'));
    const result = formatRelativeTime(new Date('2026-02-28T12:00:00Z').getTime());
    expect(result.key).toBe('settings.update.justNow');
    expect(result.params).toBeUndefined();
  });

  it('returns minutesAgo for 1-59 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T12:05:00Z'));
    const result = formatRelativeTime(new Date('2026-02-28T12:00:00Z').getTime());
    expect(result.key).toBe('settings.update.minutesAgo');
    expect(result.params).toEqual({ count: 5 });
  });

  it('returns hoursAgo for 1-23 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T15:00:00Z'));
    const result = formatRelativeTime(new Date('2026-02-28T12:00:00Z').getTime());
    expect(result.key).toBe('settings.update.hoursAgo');
    expect(result.params).toEqual({ count: 3 });
  });

  it('returns yesterday for 24-47 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const result = formatRelativeTime(new Date('2026-02-28T12:00:00Z').getTime());
    expect(result.key).toBe('settings.update.yesterday');
    expect(result.params).toBeUndefined();
  });

  it('returns daysAgo for 2+ days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
    const result = formatRelativeTime(new Date('2026-02-28T12:00:00Z').getTime());
    expect(result.key).toBe('settings.update.daysAgo');
    expect(result.params).toEqual({ count: 5 });
  });
});
