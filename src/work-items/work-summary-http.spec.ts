import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

describe('Personal summary HTTP boundary', () => {
  const env = { ...process.env };
  let app: INestApplication | undefined;
  afterEach(async () => {
    if (app) await app.close();
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  it('requires authentication, validates worker ids and enforces site scope', async () => {
    process.env.JWT_SECRET = 'test-only-secret-not-used-outside-this-test';
    delete process.env.RESEND_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const workerId = '00000000-0000-4000-8000-000000000001';
    const prisma = {
      worker: { findUnique: jest.fn().mockImplementation(({ where }) => Promise.resolve(
        where.id === 'tablet' ? { id: 'tablet', status: 'ACTIVE', role: 'ADMIN' }
          : { id: workerId, siteId: 'site-a', role: 'WORKER' },
      )) },
      workItem: { findMany: jest.fn().mockResolvedValue([]) },
      breakConfig: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { AppModule } = await import('../app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/mobile/work-items/worker-summary/`;
    const headers = { Authorization: `Bearer ${app.get(JwtService).sign({ sub: 'tablet', role: 'ADMIN', siteId: 'site-a' })}` };
    expect((await fetch(base + workerId)).status).toBe(401);
    expect((await fetch(base + 'bad-id', { headers })).status).toBe(400);
    expect((await fetch(base + workerId + '?siteId=site-b', { headers })).status).toBe(403);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
    const response = await fetch(base + workerId, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workerId, siteId: 'site-a', count: 0, minutes: 0 });
    expect(prisma.workItem.findMany.mock.calls[0][0].where.startedByWorker).toEqual({ OR: [{ siteId: 'site-a' }, { siteId: null }] });
  }, 30_000);
});
