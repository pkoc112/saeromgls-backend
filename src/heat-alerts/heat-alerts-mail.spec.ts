import { Logger } from '@nestjs/common';
import { HeatAlertsService } from './heat-alerts.service';

jest.mock('@sentry/node', () => ({ captureMessage: jest.fn() }));

describe('Heat alert mail routing', () => {
  let prisma: any;
  let mail: any;
  let service: HeatAlertsService;
  const dto = {
    workerId: 'worker-a', workerName: 'Worker', siteId: 'site-a', result: 'rest' as const,
    symptoms: ['dizziness'], wbgt: 32, temp: 34, humidity: 70, slot: 'AM' as const,
    reportedAt: '2026-09-08T00:00:00Z',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    prisma = {
      heatCheckAlert: { create: jest.fn().mockResolvedValue({ id: 'alert-1' }) },
      site: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Site A' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'site-a', name: 'Site A' }]),
      },
      subscription: { findFirst: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    };
    mail = {
      isConfigured: jest.fn().mockReturnValue(true),
      resolveRecipients: jest.fn().mockResolvedValue(['heat@example.com', 'second@example.com']),
      masterEmail: jest.fn().mockReturnValue('master@example.com'),
      sendMail: jest.fn().mockResolvedValue({ ok: true, id: 'mail-1' }),
    };
    service = new HeatAlertsService(prisma, mail);
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses the heat event recipients, site name and MASTER CC', async () => {
    await expect(service.create(dto)).resolves.toEqual({ success: true, id: 'alert-1', emailSent: true });
    expect(mail.resolveRecipients).toHaveBeenCalledWith('site-a', 'heat');
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: ['heat@example.com', 'second@example.com'], cc: ['master@example.com'], subject: expect.stringContaining('[Site A]'),
    }));
  });

  it('falls back only to MASTER when no site recipients exist, without duplicate CC', async () => {
    mail.resolveRecipients.mockResolvedValue([]);
    await service.create({ ...dto, siteId: undefined });
    expect(mail.resolveRecipients).toHaveBeenCalledWith(null, 'heat');
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ['master@example.com'] }));
    expect(mail.sendMail.mock.calls[0][0].cc).toBeUndefined();
  });

  it.each(['unconfigured', 'rejected', 'exception'])('preserves safety records on mail %s', async (mode) => {
    if (mode === 'unconfigured') mail.isConfigured.mockReturnValue(false);
    if (mode === 'rejected') mail.sendMail.mockResolvedValue({ ok: false, error: 'rejected' });
    if (mode === 'exception') mail.sendMail.mockRejectedValue(new Error('timeout'));
    await expect(service.create(dto)).resolves.toEqual({ success: true, id: 'alert-1', emailSent: false });
    expect(prisma.heatCheckAlert.create).toHaveBeenCalledTimes(1);
    if (mode === 'unconfigured') expect(mail.sendMail).not.toHaveBeenCalled();
  });

  function mockForecast() {
    jest.spyOn(service, 'getSiteConfig').mockResolvedValue({
      latitude: 35, longitude: 128, coordsResolved: true, workStartHour: 6, workEndHour: 19,
    });
    jest.spyOn(service as any, 'fetchHourlyForecast').mockResolvedValue([
      { time: '2026-09-08T13:00', hour: 13, temp: 34, humidity: 70, wbgt: 32 },
    ]);
  }

  it('routes forecasts through the same hub and counts only accepted emails', async () => {
    mockForecast();
    mail.sendMail.mockResolvedValue({ ok: false, error: 'rejected' });
    const result = await service.runHeatForecastNotices();
    expect(result.sent).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining('rejected')]);
    expect(mail.resolveRecipients).toHaveBeenCalledWith('site-a', 'heat');
    expect(mail.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ['heat@example.com', 'second@example.com'], cc: ['master@example.com'] }));
  });

  it('continues to the next site after one mail is rejected', async () => {
    mockForecast();
    prisma.site.findMany.mockResolvedValue([{ id: 'site-a', name: 'Site A' }, { id: 'site-b', name: 'Site B' }]);
    mail.sendMail.mockResolvedValueOnce({ ok: false, error: 'rejected' }).mockResolvedValueOnce({ ok: true });
    const result = await service.runHeatForecastNotices();
    expect(result.sent).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(mail.resolveRecipients).toHaveBeenNthCalledWith(2, 'site-b', 'heat');
  });

  it('skips weather and site queries when no mail key exists', async () => {
    mail.isConfigured.mockReturnValue(false);
    const result = await service.runHeatForecastNotices();
    expect(result.sent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(prisma.site.findMany).not.toHaveBeenCalled();
  });

  it('still skips sites with missing coordinates or inactive subscriptions', async () => {
    mockForecast();
    prisma.site.findMany.mockResolvedValue([{ id: 'site-a', name: 'Site A' }, { id: 'site-b', name: 'Site B' }]);
    prisma.subscription.findFirst.mockResolvedValueOnce({ status: 'SUSPENDED' }).mockResolvedValueOnce(null);
    (service.getSiteConfig as jest.Mock).mockResolvedValue({ coordsResolved: false });
    await expect(service.runHeatForecastNotices()).resolves.toEqual({ sent: 0, skipped: 2, errors: [] });
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});
