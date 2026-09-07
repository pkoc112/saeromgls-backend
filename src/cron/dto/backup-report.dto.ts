import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * #49 DB 백업 heartbeat 보고 — GitHub Actions db-backup.yml 이 성공/실패 스텝에서 POST.
 * 전역 ValidationPipe(whitelist + forbidNonWhitelisted) 적용 → 정의된 필드만 허용.
 */
export class BackupReportDto {
  @ApiProperty({ description: '백업 결과', enum: ['success', 'failure'] })
  @IsIn(['success', 'failure'])
  status!: 'success' | 'failure';

  @ApiProperty({ description: '백업 시작 시각 (ISO 8601)', required: false })
  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  @ApiProperty({ description: '백업 종료 시각 (ISO 8601)', required: false })
  @IsOptional()
  @IsISO8601()
  finishedAt?: string;

  @ApiProperty({ description: '백업 파일 크기 (bytes)', required: false, example: 1048576 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiProperty({ description: '메모 (실행 번호/URL/오류 요약 등)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
