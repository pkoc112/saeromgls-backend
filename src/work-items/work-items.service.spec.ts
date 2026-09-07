import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkItemsService } from './work-items.service';

describe('WorkItemsService bulk operations', () => {
  const requester = {
    sub: '00000000-0000-4000-8000-000000000099',
    role: 'ADMIN',
    siteId: '00000000-0000-4000-8000-000000000088',
  } as any;

  function makeService() {
    return new WorkItemsService({} as any, {} as any);
  }

  it('validates every target before force-ending any item', async () => {
    const service = makeService();
    const ownership = jest
      .spyOn(service as any, 'assertSiteOwnership')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ForbiddenException('다른 사업장의 작업은 접근할 수 없습니다'));
    const forceEnd = jest.spyOn(service, 'forceEnd').mockResolvedValue({} as any);

    await expect(
      service.bulkForceEnd(
        {
          ids: [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
          ],
          reason: '퇴근 작업 정리',
        },
        requester.sub,
        undefined,
        undefined,
        requester,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(ownership).toHaveBeenCalledTimes(2);
    expect(forceEnd).not.toHaveBeenCalled();
  });

  it('returns business-state failures as skipped items', async () => {
    const service = makeService();
    jest.spyOn(service as any, 'assertSiteOwnership').mockResolvedValue(undefined);
    jest
      .spyOn(service, 'forceEnd')
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new BadRequestException('활성 상태가 아닙니다'));

    const result = await service.bulkForceEnd(
      {
        ids: [
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
        ],
        reason: '퇴근 작업 정리',
      },
      requester.sub,
      undefined,
      undefined,
      requester,
    );

    expect(result).toEqual({
      done: ['00000000-0000-4000-8000-000000000001'],
      skipped: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          reason: '활성 상태가 아닙니다',
        },
      ],
    });
  });

  it('returns a target deleted before processing as skipped', async () => {
    const service = makeService();
    jest
      .spyOn(service as any, 'assertSiteOwnership')
      .mockRejectedValueOnce(new NotFoundException('작업을 찾을 수 없습니다'));
    jest
      .spyOn(service, 'forceEnd')
      .mockRejectedValueOnce(new NotFoundException('작업을 찾을 수 없습니다'));

    const id = '00000000-0000-4000-8000-000000000001';
    const result = await service.bulkForceEnd(
      { ids: [id], reason: '삭제 경쟁 처리' },
      requester.sub,
      undefined,
      undefined,
      requester,
    );

    expect(result).toEqual({
      done: [],
      skipped: [{ id, reason: '작업을 찾을 수 없습니다' }],
    });
  });

  it('uses the existing audited void operation for every selected item', async () => {
    const service = makeService();
    jest.spyOn(service as any, 'assertSiteOwnership').mockResolvedValue(undefined);
    const voidWorkItem = jest.spyOn(service, 'voidWorkItem').mockResolvedValue({} as any);
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];

    const result = await service.bulkVoid(
      { ids, reason: '중복 작업 정리' },
      requester.sub,
      '127.0.0.1',
      'jest',
      requester,
    );

    expect(result).toEqual({ done: ids, skipped: [] });
    expect(voidWorkItem).toHaveBeenCalledTimes(2);
    expect(voidWorkItem).toHaveBeenNthCalledWith(
      1,
      ids[0],
      { reason: '중복 작업 정리' },
      requester.sub,
      '127.0.0.1',
      'jest',
      requester,
    );
  });
});
