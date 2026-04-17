import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const INCENTIVE_TRACKS = [
  'OUTBOUND',
  'INBOUND_DOCK',
  'INSPECTION',
  'MANAGER',
  'OUTBOUND_RANKED',
  'INBOUND_SUPPORT',
  'INSPECTION_GOAL',
  'DOCK_WRAP_GOAL',
  'MANAGER_OPS',
] as const;

export class QueryPolicyDto {
  @ApiProperty({ description: '사업장 ID 필터', required: false })
  @IsString()
  @IsOptional()
  siteId?: string;

  @ApiProperty({
    description: '상태 필터',
    enum: ['DRAFT', 'SHADOW', 'ACTIVE', 'RETIRED'],
    required: false,
  })
  @IsIn(['DRAFT', 'SHADOW', 'ACTIVE', 'RETIRED'])
  @IsOptional()
  status?: string;

  @ApiProperty({
    description: '트랙 필터',
    enum: INCENTIVE_TRACKS,
    required: false,
  })
  @IsIn(INCENTIVE_TRACKS)
  @IsOptional()
  track?: string;
}

export class QueryScoreRunDto {
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

  @ApiProperty({ description: '월 필터', required: false, example: '2026-04' })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: '월 형식은 YYYY-MM이어야 합니다' })
  @IsOptional()
  month?: string;

  @ApiProperty({ description: '사업장 ID 필터', required: false })
  @IsString()
  @IsOptional()
  siteId?: string;
}

export class QueryObjectionDto {
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
    enum: ['OPEN', 'REVIEWING', 'ACCEPTED', 'REJECTED'],
    required: false,
  })
  @IsIn(['OPEN', 'REVIEWING', 'ACCEPTED', 'REJECTED'])
  @IsOptional()
  status?: string;

  @ApiProperty({ description: '사업장 ID 필터', required: false })
  @IsString()
  @IsOptional()
  siteId?: string;
}
