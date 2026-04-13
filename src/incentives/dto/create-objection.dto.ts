import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateObjectionDto {
  @ApiProperty({
    description: '점수 항목 ID (선택)',
    required: false,
  })
  @IsUUID('4', { message: '올바른 점수 항목 ID 형식이 아닙니다' })
  @IsOptional()
  scoreEntryId?: string;

  @ApiProperty({
    description: '대상 월 (YYYY-MM)',
    example: '2026-04',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: '월 형식은 YYYY-MM이어야 합니다' })
  @IsNotEmpty({ message: '대상 월을 입력해주세요' })
  month: string;

  @ApiProperty({
    description: '이의 사유',
    example: '근무 기록 누락으로 인한 점수 오류',
  })
  @IsString()
  @IsNotEmpty({ message: '이의 사유를 입력해주세요' })
  reason: string;
}
