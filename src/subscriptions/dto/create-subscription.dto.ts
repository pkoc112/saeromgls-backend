import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StartTrialDto {
  @ApiProperty({
    description: '무료 체험을 시작할 사업장 ID',
    example: 'uuid-site-id',
  })
  @IsString()
  siteId: string;

  @ApiProperty({
    description: '플랜 코드 (기본: BASIC)',
    example: 'BASIC',
    required: false,
    enum: ['BASIC', 'PRO'],
  })
  @IsOptional()
  @IsIn(['BASIC', 'PRO'])
  planCode?: string;
}
