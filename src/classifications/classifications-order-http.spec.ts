import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ClassificationsService } from './classifications.service';

describe('Classification reorder HTTP contract', () => {
  const env = { ...process.env };
  let app: INestApplication | undefined;
  afterEach(async () => {
    if (app) await app.close();
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  it('checks authentication, roles, fixed route and DTO whitelist before forwarding the reorder', async () => {
    process.env.JWT_SECRET = 'test-only-secret-not-used-outside-this-test';
    delete process.env.RESEND_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const reorder = jest.fn().mockImplementation(async (dto) => dto);
    const { AppModule } = await import('../app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue({ worker: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', status: 'ACTIVE' }) } })
      .overrideProvider(ClassificationsService).useValue({ reorder }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const endpoint = `${await app.getUrl()}/api/admin/classifications/reorder`;
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const siteId = '00000000-0000-4000-8000-000000000100';
    const body = { categoryCode: 'DC', siteId, expectedIds: ids, ids: [...ids].reverse() };
    const send = (data: unknown, role?: string) => fetch(endpoint, {
      method: 'PATCH', body: JSON.stringify(data), headers: {
        'Content-Type': 'application/json',
        ...(role ? { Authorization: `Bearer ${app!.get(JwtService).sign({ sub: 'admin', role, siteId })}` } : {}),
      },
    });
    expect((await send(body)).status).toBe(401);
    expect((await send(body, 'SUPERVISOR')).status).toBe(403);
    expect((await send(body, 'WORKER')).status).toBe(403);
    for (const invalid of [
      { ...body, ids: [ids[0], ids[0]] }, { ...body, ids: ['bad', ids[1]] },
      { ...body, expectedIds: [] }, { ...body, categoryCode: 'DC_CHILD' },
      { ...body, siteId: 'bad-site' }, { ...body, global: 'true' }, { ...body, extra: 1 },
    ]) expect((await send(invalid, 'ADMIN')).status).toBe(400);
    expect(reorder).not.toHaveBeenCalled();
    const result = await send(body, 'ADMIN');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(body);
    const common = { categoryCode: 'DC', global: true, expectedIds: ids, ids: [...ids].reverse() };
    expect((await send(common, 'MASTER')).status).toBe(200);
    expect(reorder.mock.calls[1][0]).toMatchObject(common);
  }, 30_000);
});
