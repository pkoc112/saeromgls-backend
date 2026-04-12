import { IsString, IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';
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
