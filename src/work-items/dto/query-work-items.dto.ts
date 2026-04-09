import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsInt, Min } from 'class-validator';

/**
 * 관리자 작업 목록 조회 쿼리 DTO
 * 상태, 분류, 작업자, 날짜 범위 필터 지원
 */
export class QueryWorkItemsDto {
  @ApiProperty({
    description: '페이지 번호',
    required: false,
    default: 1,
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiProperty({
    description: '페이지당 항목 수',
    required: false,
    default: 20,
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;

  @ApiProperty({
    description: '작업 상태 필터',
    enum: ['ACTIVE', 'PAUSED', 'ENDED', 'VOID'],
    required: false,
  })
  @IsIn(['ACTIVE', 'PAUSED', 'ENDED', 'VOID'])
  @IsOptional()
  status?: string;

  @ApiProperty({
    description: '분류 ID 필터',
    required: false,
  })
  @IsString()
  @IsOptional()
  classificationId?: string;

  @ApiProperty({
    description: '작업자 ID 필터 (시작 작업자)',
    required: false,
  })
  @IsString()
  @IsOptional()
  workerId?: string;

  @ApiProperty({
    description: '조회 시작 날짜 (ISO 8601)',
    required: false,
    example: '2026-04-01',
  })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiProperty({
    description: '조회 종료 날짜 (ISO 8601)',
    required: false,
    example: '2026-04-09',
  })
  @IsDateString()
  @IsOptional()
  to?: string;
}
