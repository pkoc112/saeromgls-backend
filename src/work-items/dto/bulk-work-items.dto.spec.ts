import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BulkWorkItemsDto } from './bulk-work-items.dto';

describe('BulkWorkItemsDto', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it('keeps valid fields and trims the reason', async () => {
    const dto = plainToInstance(BulkWorkItemsDto, {
      ids: [id],
      reason: '  퇴근 작업 정리  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.reason).toBe('퇴근 작업 정리');
  });

  it('rejects duplicate or malformed ids and a short reason', async () => {
    const dto = plainToInstance(BulkWorkItemsDto, {
      ids: [id, id, 'not-a-uuid'],
      reason: ' ',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual(['ids', 'reason']);
  });
});
