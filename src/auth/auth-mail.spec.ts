import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('Auth mail delivery', () => {
  let prisma: any;
  let mail: any;
  let service: AuthService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    prisma = {
      verificationCode: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'code-this-request' }),
      },
      worker: { findUnique: jest.fn().mockResolvedValue(null) },
      adminInvite: { create: jest.fn(), deleteMany: jest.fn() },
      adminActivityLog: { create: jest.fn() },
    };
    mail = { isConfigured: jest.fn().mockReturnValue(true), sendMail: jest.fn().mockResolvedValue({ ok: true, id: 'mail-1' }) };
    service = new AuthService(prisma, {} as any, mail);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns 503 before changing codes when mail is not configured', async () => {
    mail.isConfigured.mockReturnValue(false);
    await expect(service.sendVerificationCode('a@example.com')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.verificationCode.create).not.toHaveBeenCalled();
    expect(prisma.verificationCode.deleteMany).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('succeeds only after acceptance and keeps the code out of subject, response and logs', async () => {
    const result = await service.sendVerificationCode('a@example.com');
    const { code, expiresAt } = prisma.verificationCode.create.mock.calls[0][0].data;
    expect(code).toMatch(/^[1-9]\d{5}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(mail.sendMail.mock.calls[0][0].html).toContain(code);
    expect(mail.sendMail.mock.calls[0][0].subject).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain(code);
    for (const method of ['log', 'warn', 'error'] as const) {
      expect(JSON.stringify((Logger.prototype[method] as jest.Mock).mock.calls)).not.toContain(code);
    }
    expect(prisma.verificationCode.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each(['rejection', 'exception'])('fails visibly and deletes only this request code on %s', async (mode) => {
    if (mode === 'rejection') mail.sendMail.mockResolvedValue({ ok: false, error: 'rejected' });
    else mail.sendMail.mockRejectedValue(new Error('timeout'));
    await expect(service.sendVerificationCode('a@example.com')).rejects.toMatchObject({ status: 503 });
    expect(prisma.verificationCode.deleteMany).toHaveBeenLastCalledWith({ where: { id: 'code-this-request' } });
  });

  it('still returns a mail failure if failed-code cleanup also fails', async () => {
    mail.sendMail.mockResolvedValue({ ok: false });
    prisma.verificationCode.deleteMany.mockResolvedValueOnce({ count: 0 }).mockRejectedValueOnce(new Error('storage error'));
    await expect(service.sendVerificationCode('a@example.com')).rejects.toMatchObject({ status: 503 });
  });

  it.each([true, false])('preserves the invite URL and reports actual mail acceptance: %s', async (accepted) => {
    mail.sendMail.mockResolvedValue({ ok: accepted });
    const result = await service.createAdminInvite(
      { email: 'a@example.com', name: 'Admin', siteId: 'site-a' },
      { sub: 'master', role: 'MASTER' } as any,
    );
    expect(result).toMatchObject({ emailSent: accepted, inviteUrl: expect.stringContaining('/accept-invite?token=') });
    expect(prisma.adminInvite.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ siteId: 'site-a' }) }));
  });

  it('supports manual invite links without mail configuration', async () => {
    mail.isConfigured.mockReturnValue(false);
    const result = await service.createAdminInvite({ email: 'a@example.com', name: 'Admin' }, { sub: 'admin', role: 'ADMIN', siteId: 'site-a' } as any);
    expect(result.emailSent).toBe(false);
    expect(result.inviteUrl).toContain('/accept-invite?token=');
    expect(mail.sendMail).not.toHaveBeenCalled();
  });
});
