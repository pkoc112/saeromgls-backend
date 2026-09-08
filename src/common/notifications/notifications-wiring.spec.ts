import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { HeatAlertsService } from '../../heat-alerts/heat-alerts.service';
import { NotificationsService } from './notifications.service';

describe('Mail module wiring', () => {
  const env = { ...process.env };
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('boots the full module graph and returns HTTP 503 without touching the DB when mail is unconfigured', async () => {
    process.env.JWT_SECRET = 'test-only-secret-not-used-outside-this-test';
    delete process.env.RESEND_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const prisma = { verificationCode: { create: jest.fn(), deleteMany: jest.fn() } };
    const { AppModule } = await import('../../app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    expect(app.get(AuthService)).toBeDefined();
    expect(app.get(HeatAlertsService)).toBeDefined();
    expect(app.get(NotificationsService).isConfigured()).toBe(false);
    const response = await fetch(`${await app.getUrl()}/api/auth/send-verification`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ message: '메일 발송이 설정되지 않았습니다. 관리자에게 문의해주세요' });
    expect(prisma.verificationCode.create).not.toHaveBeenCalled();
    expect(prisma.verificationCode.deleteMany).not.toHaveBeenCalled();
  }, 30_000);
});
