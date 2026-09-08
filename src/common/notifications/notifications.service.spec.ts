import { Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));

describe('NotificationsService', () => {
  const env = { ...process.env };
  let prisma: any;
  let service: NotificationsService;
  const mail = { to: 'a@example.com', subject: 'test', html: '<p>test</p>' };

  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    mockSend.mockReset().mockResolvedValue({ data: { id: 'mail-1' }, error: null });
    prisma = {
      tenantSettings: { findFirst: jest.fn().mockResolvedValue(null) },
      worker: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new NotificationsService(prisma);
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('does not report success or contact the provider without a key', async () => {
    delete process.env.RESEND_API_KEY;
    service = new NotificationsService(prisma);
    expect(service.isConfigured()).toBe(false);
    await expect(service.sendMail(mail)).resolves.toEqual({ ok: false, error: 'no-api-key' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('deduplicates recipients and removes To addresses from CC', async () => {
    await expect(service.sendMail({ ...mail, to: ['A@example.com', 'a@example.com'], cc: 'a@example.com; b@example.com' }))
      .resolves.toEqual({ ok: true, id: 'mail-1' });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@example.com'], cc: ['b@example.com'] }));
  });

  it('rejects empty recipients before contacting the provider', async () => {
    await expect(service.sendMail({ ...mail, to: [] })).resolves.toEqual({ ok: false, error: 'no-recipients' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: null, error: { message: 'rejected' } }, 'rejected'],
    [{ data: null, error: null }, 'missing-message-id'],
  ])('does not accept an unsuccessful provider response', async (response, error) => {
    mockSend.mockResolvedValue(response);
    await expect(service.sendMail(mail)).resolves.toEqual({ ok: false, error });
  });

  it('returns failure when the provider throws', async () => {
    mockSend.mockRejectedValue(new Error('timeout'));
    await expect(service.sendMail(mail)).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it.each([
    [{ notifications: { heat: ['heat@example.com'], default: ['default@example.com'] }, alertEmail: 'old@example.com' }, ['heat@example.com']],
    [{ notifications: { heat: [], default: 'default@example.com' }, alertEmail: 'old@example.com' }, ['default@example.com']],
    [{ alertEmail: 'old@example.com; Second@example.com' }, ['old@example.com', 'second@example.com']],
  ])('respects event, default and legacy recipient priority', async (settings, expected) => {
    prisma.tenantSettings.findFirst.mockResolvedValue({ settings: JSON.stringify(settings) });
    await expect(service.resolveRecipients('site-a', 'heat')).resolves.toEqual(expected);
    expect(prisma.tenantSettings.findFirst).toHaveBeenCalledWith({ where: { siteId: 'site-a' }, select: { settings: true } });
    expect(prisma.worker.findMany).not.toHaveBeenCalled();
  });

  it('falls back only to verified active managers from the requested site', async () => {
    prisma.worker.findMany.mockResolvedValue([{ email: 'admin@example.com' }]);
    await expect(service.resolveRecipients('site-b', 'heat')).resolves.toEqual(['admin@example.com']);
    expect(prisma.worker.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      siteId: 'site-b', status: 'ACTIVE', role: { in: ['ADMIN', 'SUPERVISOR'] }, emailVerified: true, email: { not: null },
    } }));
  });

  it('does not read any other site or add MASTER when settings are absent', async () => {
    await expect(service.resolveRecipients(null, 'heat')).resolves.toEqual([]);
    expect(prisma.tenantSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.worker.findMany).not.toHaveBeenCalled();
    await expect(service.resolveRecipients('empty-site', 'subscription')).resolves.toEqual([]);
  });

  it('keeps the same site scope when its settings cannot be read', async () => {
    prisma.tenantSettings.findFirst.mockRejectedValue(new Error('unavailable'));
    await expect(service.resolveRecipients('site-a', 'heat')).resolves.toEqual([]);
    expect(prisma.worker.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ siteId: 'site-a' }) }));
  });
});
