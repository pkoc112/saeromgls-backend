import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClassificationsService } from './classifications.service';
import { ClassificationsController } from './classifications.controller';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const site = id(100);
const user = { sub: 'admin', role: 'ADMIN', siteId: site } as JwtPayload;
const row = (n: number, name: string, sortOrder = 99, siteId: string | null = site, code = `DC_${n}`) =>
  ({ id: id(n), code, displayName: `[DC] ${name}`, sortOrder, siteId, isActive: true });
const request = (expectedIds = [id(1), id(2), id(3)]) =>
  ({ categoryCode: 'DC', siteId: site, expectedIds, ids: [id(2), id(1), id(3)] });

function setup(initial = [row(3, '다'), row(2, '나'), row(1, '가')], failAt = 0) {
  let records = structuredClone(initial);
  let writes = 0;
  const find = (list: typeof records, where: any) => list.filter((item) =>
    item.siteId === where.siteId && item.isActive === where.isActive && item.code.startsWith(where.code.startsWith));
  const prisma = {
    $transaction: jest.fn(async (action: any, _options?: unknown) => {
      const draft = structuredClone(records);
      const result = await action({ classification: {
        findMany: jest.fn(async ({ where }) => find(draft, where)),
        update: jest.fn(async ({ where, data }) => {
          writes++;
          if (writes === failAt) throw new Error('write failed');
          Object.assign(draft.find((item) => item.id === where.id)!, data);
        }),
      } });
      records = draft;
      return result;
    }),
  };
  return { service: new ClassificationsService(prisma as any), prisma, records: () => records, writes: () => writes };
}

describe('Classification order', () => {
  it('normalizes duplicate positions atomically and preserves other sites/categories/common rows', async () => {
    const untouched = [row(4, '다른 센터', 9, id(101)), row(5, '공통', 8, null), row(6, '다른 분류', 7, site, 'CVS_6'), { ...row(7, '비활성'), isActive: false }];
    const test = setup([row(1, '가'), row(2, '나'), row(3, '다'), ...untouched]);
    await test.service.reorder(request(), user);
    expect(test.records().slice(0, 3).map((item) => item.sortOrder)).toEqual([1, 0, 2]);
    expect(test.records().slice(3)).toEqual(untouched);
    expect(test.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable', timeout: 15_000 });
  });
  it('writes only changed positions after normalization', async () => {
    const test = setup([row(1, '가', 0), row(2, '나', 1), row(3, '다', 2)]);
    await test.service.reorder(request(), user);
    expect(test.writes()).toBe(2);
  });
  it('requires a literal category prefix even if the database returns broader string matches', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { $transaction: async (action: any) => action({ classification: {
      findMany: async () => [row(1, '가'), row(2, '나'), row(3, '다'), row(4, '다른 분류', 0, site, 'DCX_4')], update,
    } }) };
    await new ClassificationsService(prisma as any).reorder(request(), user);
    expect(update.mock.calls.map(([args]) => args.where.id)).toEqual([id(2), id(1), id(3)]);
  });
  it('rolls back every position if a later write fails', async () => {
    const rows = [row(1, '가'), row(2, '나'), row(3, '다')];
    const test = setup(rows, 2);
    await expect(test.service.reorder(request(), user)).rejects.toThrow('write failed');
    expect(test.records()).toEqual(rows);
  });
  it.each([
    ['stale order', [id(2), id(1), id(3)]],
    ['missing sibling', [id(1), id(2)]],
    ['foreign sibling', [id(1), id(2), id(9)]],
  ])('rejects %s before writing', async (_, expectedIds) => {
    const test = setup();
    await expect(test.service.reorder(request(expectedIds), user)).rejects.toBeInstanceOf(ConflictException);
    expect(test.writes()).toBe(0);
  });
  it.each([[id(1), id(1), id(3)], [id(1), id(2), id(9)], [id(1), id(2)]])('rejects malformed target order %j', async (...ids) => {
    const test = setup();
    await expect(test.service.reorder({ ...request(), ids }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(test.writes()).toBe(0);
  });
  it('rejects a forged site and a site-less administrator before opening a transaction', async () => {
    const test = setup();
    await expect(test.service.reorder({ ...request(), siteId: id(101) }, user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(test.service.reorder(request(), { ...user, siteId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
    expect(test.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('requires an explicit scope for MASTER and blocks supervisor writes', async () => {
    const test = setup();
    await expect(test.service.reorder({ ...request(), siteId: undefined }, { ...user, role: 'MASTER' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(test.service.reorder(request(), { ...user, role: 'SUPERVISOR' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(test.prisma.$transaction).not.toHaveBeenCalled();
  });
  it('only MASTER may explicitly reorder common rows, without a site override', async () => {
    const test = setup([row(1, '가', 99, null), row(2, '나', 99, null), row(3, '다', 99, null)]);
    const common = { ...request(), siteId: undefined, global: true };
    await expect(test.service.reorder(common, user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(test.service.reorder({ ...common, siteId: site }, { ...user, role: 'MASTER' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(test.writes()).toBe(0);
    await test.service.reorder(common, { ...user, role: 'master' as any });
    expect(test.records().map((item) => item.sortOrder)).toEqual([1, 0, 2]);
  });
  it('returns a retryable conflict for concurrent database writes', async () => {
    const test = setup();
    test.prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }));
    await expect(test.service.reorder(request(), user)).rejects.toBeInstanceOf(ConflictException);
  });
  it('mobile read uses the same ordering and the authenticated site', async () => {
    const prisma = { classification: { findMany: jest.fn().mockResolvedValue([row(3, '다', 0), row(2, '가', 1), row(1, '가', 1)]) }, tenantSettings: { findFirst: jest.fn().mockResolvedValue(null) } };
    const controller = new ClassificationsController(new ClassificationsService(prisma as any));
    const result = await controller.findActiveForMobile(user);
    expect(result.map((item) => item.id)).toEqual([id(3), id(1), id(2)]);
    expect(prisma.classification.findMany.mock.calls[0][0].where).toEqual({ isActive: true, OR: [{ siteId: site }, { siteId: null }] });
    expect(() => controller.findActiveForMobile(user, id(101))).toThrow(ForbiddenException);
    expect(() => controller.findActiveForMobile({ ...user, siteId: undefined })).toThrow(ForbiddenException);
  });
});
