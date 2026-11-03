import { describe, expect, it } from 'vitest';
import { cronMatches, isValidCron } from '../src/cron';

describe('cron', () => {
  it('accepts five-field expressions and rejects the rest', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 9 * * 1-5')).toBe(true);
    expect(isValidCron('0 9 * * 1,3,5')).toBe(true);
    expect(isValidCron('nope')).toBe(false);
    expect(isValidCron('* * *')).toBe(false);
    expect(isValidCron('60 * * * *')).toBe(false);
  });

  it('matches minute steps, weekdays and a fixed hour', () => {
    const mondayNine = new Date(2026, 10, 2, 9, 0, 30);
    expect(mondayNine.getDay()).toBe(1);
    expect(cronMatches('0 9 * * 1-5', mondayNine)).toBe(true);
    expect(cronMatches('0 9 * * 0', mondayNine)).toBe(false);
    expect(cronMatches('*/15 * * * *', new Date(2026, 10, 3, 12, 45, 0))).toBe(
      true,
    );
    expect(cronMatches('*/15 * * * *', new Date(2026, 10, 3, 12, 46, 0))).toBe(
      false,
    );
    expect(cronMatches('0 0 * * 7', new Date(2026, 10, 1, 0, 0, 0))).toBe(true);
  });
});
