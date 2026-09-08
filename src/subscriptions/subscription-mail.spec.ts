import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SubscriptionsService } from './subscriptions.service';

describe('Subscription mail cadence', () => {
  let prisma: any;
  let mail: any;
  let service: SubscriptionsService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-07T18:00:00Z')); // Tuesday 03:00 KST
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    prisma = { subscription: { findMany: jest.fn() }, plan: { findMany: jest.fn().mockResolvedValue([]) } };
    mail = {
      resolveRecipients: jest.fn().mockResolvedValue(['site@example.com']),
      sendMail: jest.fn().mockResolvedValue({ ok: true }),
      masterEmail: jest.fn().mockReturnValue('master@example.com'),
    };
    service = new SubscriptionsService(prisma, mail);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function candidate(daysLeft: number) {
    const end = new Date(Date.now() + daysLeft * 86400_000);
    return {
      id: 'sub-a', siteId: 'site-a', status: 'TRIAL', trialEndsAt: end, currentPeriodEnd: end,
      site: { id: 'site-a', name: 'Site A', code: 'A', isActive: true, parentSiteId: null },
      plan: { name: 'Basic', code: 'BASIC', priceMonthly: 10000, maxWorkers: 30 },
    };
  }

  it.each([7, 3, 1])('retains tenant trial notice D-%i on non-digest days', async (days) => {
    prisma.subscription.findMany.mockResolvedValue([candidate(days)]);
    await expect(service.notifyUpcomingExpirations()).resolves.toEqual({ sent: 1, skipped: 0, errors: [] });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ['site@example.com'] }));
    expect(mail.sendMail).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'master@example.com' }));
  });

  it.each([
    ['2026-09-06T14:59:59Z', false], // Sunday KST
    ['2026-09-06T15:00:00Z', true],  // Monday KST, still Sunday UTC
    ['2026-09-06T18:00:00Z', true],  // actual subscription cron
    ['2026-09-07T14:59:59Z', true],
    ['2026-09-07T15:00:00Z', false], // Tuesday KST, still Monday UTC
  ])('uses KST Monday for the weekly MASTER digest at %s', async (now, expected) => {
    jest.setSystemTime(new Date(now));
    prisma.subscription.findMany.mockResolvedValue([candidate(2)]);
    const result = await service.notifyUpcomingExpirations();
    expect(result.sent).toBe(expected ? 1 : 0);
    expect(mail.sendMail).toHaveBeenCalledTimes(expected ? 1 : 0);
    if (expected) expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'master@example.com' }));
  });

  it('does not call a missing recipient list a successful delivery', async () => {
    prisma.subscription.findMany.mockResolvedValue([candidate(1)]);
    mail.resolveRecipients.mockResolvedValue([]);
    await expect(service.notifyUpcomingExpirations()).resolves.toEqual({ sent: 0, skipped: 1, errors: [] });
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('reports provider rejection rather than counting it as sent', async () => {
    prisma.subscription.findMany.mockResolvedValue([candidate(1)]);
    mail.sendMail.mockResolvedValue({ ok: false, error: 'rejected' });
    const result = await service.notifyUpcomingExpirations();
    expect(result.sent).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining('rejected')]);
  });

  it('keeps the Vercel schedules aligned with the requested KST times', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '../../vercel.json'), 'utf8'));
    const schedule = (path: string) => config.crons.find((cron: { path: string }) => cron.path === `/api/cron/${path}`).schedule;
    expect(config.outputDirectory).toBe('public');
    expect(schedule('ops-digest')).toBe('30 0 * * *');
    expect(schedule('heat-forecast-notice')).toBe('0 21 * * *');
    expect(schedule('evening-notices')).toBe('0 11 * * *');
    expect(schedule('weekly-summary')).toBe('0 15 * * 0');
  });
});
