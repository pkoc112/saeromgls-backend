import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';

export class QueryInboundDto {
  @ApiProperty({ description: '페이지 번호', required: false, default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiProperty({ description: '페이지당 항목 수', required: false, default: 20 })
  @IsInt()
  @Min(1)
  @Max(200, { message: '한 번에 최대 200건까지 조회 가능합니다' })
  @IsOptional()
  limit?: number;

  @ApiProperty({
    description: '상태 필터',
    enum: ['PENDING', 'APPROVED', 'REJECTED'],
    required: false,
  })
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  @IsOptional()
  status?: string;

  @ApiProperty({ description: '조회 시작 날짜', required: false, example: '2026-04-01' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiProperty({ description: '조회 종료 날짜', required: false, example: '2026-04-13' })
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiProperty({ description: '사업장 ID 필터', required: false })
  @IsString()
  @IsOptional()
  siteId?: string;
}
