import { activeWorkSegments, breakOverlapMs, calcNetWorkMinutes, loadBreakConfigResolver, netMinutesOfSegments } from './net-work-minutes';

const date = (time: string) => new Date(`2026-09-08T${time}+09:00`);
const lunch = { startHour: 12, startMin: 0, endHour: 13, endMin: 0 };
const notes = (pairs: Array<[string, string?]>) => JSON.stringify({ pauseHistory: pairs.map(([p, r]) => ({ pausedAt: date(p).toISOString(), resumedAt: r ? date(r).toISOString() : undefined })) });

describe('Net work time interval contract', () => {
  it('does not subtract overlapping pause and break twice', () => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), notes([['12:00', '13:00']]), [lunch])).toBe(120);
  });
  it('subtracts scheduled breaks even without pauses', () => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), null, [lunch])).toBe(120);
  });
  it('subtracts only the union of partial overlapping pauses and breaks', () => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), notes([['11:30', '12:30'], ['12:15', '13:15']]), [lunch])).toBe(75);
  });
  it('merges duplicate pause intervals and clips them to the work interval', () => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), notes([['10:00', '11:30'], ['10:00', '11:30'], ['13:30', '15:00']]))).toBe(120);
  });
  it('merges duplicate and overlapping break settings', () => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), null, [lunch, lunch, { ...lunch, startMin: 30, endMin: 30 }])).toBe(90);
  });
  it('uses the provided end for an open pause, not the current clock', () => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), notes([['12:00']]), [lunch])).toBe(60);
  });
  it.each(['not-json', '{"pauseHistory":null}', '{"pauseHistory":[null,{"pausedAt":"bad"}]}'])('ignores malformed pause history: %s', (history) => {
    expect(calcNetWorkMinutes(date('11:00'), date('14:00'), history, [lunch])).toBe(120);
  });
  it('merges concurrent work for a person before rounding', () => {
    const segments = [
      ...activeWorkSegments(date('11:00').getTime(), date('14:00').getTime(), notes([['12:00', '13:00']])),
      ...activeWorkSegments(date('13:00').getTime(), date('15:00').getTime(), null),
    ];
    expect(netMinutesOfSegments(segments, [lunch])).toBe(180);
  });
  it('rounds once after summing short segments', () => {
    const base = date('11:00').getTime();
    expect(netMinutesOfSegments([[base, base + 20_000], [base + 40_000, base + 60_000]])).toBe(1);
  });
  it('uses KST daily breaks across midnight regardless of machine timezone', () => {
    expect(calcNetWorkMinutes(new Date('2026-09-07T23:00:00+09:00'), date('01:00'), null,
      [{ startHour: 0, startMin: 0, endHour: 0, endMin: 30 }])).toBe(90);
  });
  it('does not loop on invalid or unbounded time ranges', () => {
    expect(breakOverlapMs(0, Infinity, [lunch])).toBe(0);
    expect(calcNetWorkMinutes(new Date('bad'), date('14:00'), null, [lunch])).toBe(0);
    expect(calcNetWorkMinutes(date('14:00'), date('11:00'), null, [lunch])).toBe(0);
  });
  it('loads only requested sites plus legacy globals with no other-site fallback', async () => {
    const prisma = { breakConfig: { findMany: jest.fn().mockResolvedValue([
      { ...lunch, siteId: 'site-a' }, { ...lunch, startHour: 10, endHour: 11, siteId: null },
    ]) } };
    const resolver = await loadBreakConfigResolver(prisma as any, ['site-a', 'site-a']);
    expect(prisma.breakConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      isActive: true, OR: [{ siteId: null }, { siteId: { in: ['site-a'] } }],
    } }));
    expect(resolver.forSite('site-a')).toEqual([lunch]);
    expect(resolver.forSite(null)[0].startHour).toBe(10);
    expect(resolver.forSite('site-without-config')[0].startHour).toBe(10);
  });
});
