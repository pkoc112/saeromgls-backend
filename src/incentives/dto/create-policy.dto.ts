import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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

export class CreatePolicyDto {
  @ApiProperty({
    description: '정책 이름',
    example: '2026년 4월 출고 인센티브 정책',
  })
  @IsString()
  @IsNotEmpty({ message: '정책 이름을 입력해주세요' })
  name: string;

  @ApiProperty({
    description: '직무 트랙',
    enum: INCENTIVE_TRACKS,
  })
  @IsIn(INCENTIVE_TRACKS, { message: '유효한 직무 트랙을 선택해주세요' })
  @IsNotEmpty({ message: '직무 트랙을 선택해주세요' })
  track: string;

  @ApiProperty({
    description: '가중치 (JSON 문자열)',
    example: '{"performance":60,"reliability":25,"teamwork":15}',
  })
  @IsString()
  @IsNotEmpty({ message: '가중치를 입력해주세요' })
  weights: string;

  @ApiProperty({
    description: '트랙별 세부 가중치 (JSON 문자열)',
    required: false,
  })
  @IsString()
  @IsOptional()
  details?: string;

  @ApiProperty({
    description: '정책 설명',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;
}
