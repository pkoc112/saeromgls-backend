import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMobileDiagnosticDto } from './create-mobile-diagnostic.dto';

describe('CreateMobileDiagnosticDto', () => {
  it('accepts sync_dropped diagnostics emitted by the mobile sync store', async () => {
    const dto = plainToInstance(CreateMobileDiagnosticDto, {
      screen: 'settings',
      errorType: 'sync_dropped',
      errorMessage: '동기화 실패 항목 폐기',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects unsupported diagnostic types', async () => {
    const dto = plainToInstance(CreateMobileDiagnosticDto, {
      screen: 'settings',
      errorType: 'unsupported',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'errorType')).toBe(true);
  });
});
