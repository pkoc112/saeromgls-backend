import { IsString, IsOptional, IsIn, IsInt, Min, Max, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePlanDto {
  @ApiProperty({
    description: '플랜을 변경할 사업장 ID',
    example: 'uuid-site-id',
  })
  @IsString()
  siteId: string;

  @ApiProperty({
    description: '변경할 플랜 코드',
    example: 'BASIC',
    enum: ['FREE', 'BASIC', 'PRO'],
  })
  @IsIn(['FREE', 'BASIC', 'PRO'])
  planCode: string;
}

export class SiteIdDto {
  @ApiProperty({
    description: '사업장 ID',
    example: 'uuid-site-id',
  })
  @IsString()
  siteId: string;
}

export class GrantTrialDto {
  @ApiProperty({
    description: '무료 체험을 부여할 사업장 ID',
    example: 'uuid-site-id',
  })
  @IsString()
  siteId: string;

  @ApiProperty({
    description: '체험 기간 (일), 기본 14일',
    example: 14,
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class TransitionStatusDto {
  @ApiProperty({
    description: '전이할 구독 상태',
    example: 'ACTIVE',
    enum: ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'],
  })
  @IsIn(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'])
  status: string;

  @ApiProperty({
    description: '상태 전이 사유',
    example: '입금 확인 완료',
  })
  @IsString()
  @MinLength(1)
  reason: string;
}
