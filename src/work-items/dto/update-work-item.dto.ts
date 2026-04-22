import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsNumber,
  IsInt,
  IsDateString,
  Min,
  Max,
} from 'class-validator';

/**
 * 관리자 작업 수정 DTO
 * 수정 사유가 필수 (감사 로그에 기록)
 */
export class UpdateWorkItemDto {
  @ApiProperty({
    description: '분류 ID',
    required: false,
  })
  @IsUUID('4')
  @IsOptional()
  classificationId?: string;

  @ApiProperty({
    description: '물량',
    example: 200.5,
    required: false,
  })
  @IsNumber()
  @Min(0)
  @Max(99999, { message: '물량이 허용 범위를 초과했습니다 (최대 99,999 CBM)' })
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '수량',
    example: 25,
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '비고',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({
    description: '작업 시작 시간 (ISO 8601)',
    example: '2026-04-10T17:00:00+09:00',
    required: false,
  })
  @IsDateString({}, { message: '올바른 날짜 형식이 아닙니다 (ISO 8601)' })
  @IsOptional()
  startedAt?: string;

  @ApiProperty({
    description: '작업 종료 시간 (ISO 8601)',
    example: '2026-04-10T18:30:00+09:00',
    required: false,
  })
  @IsDateString({}, { message: '올바른 날짜 형식이 아닙니다 (ISO 8601)' })
  @IsOptional()
  endedAt?: string;

  @ApiProperty({
    description: '수정 사유 (필수)',
    example: '물량 오입력 수정',
  })
  @IsString()
  @IsNotEmpty({ message: '수정 사유를 입력해주세요' })
  reason: string;
}

/**
 * 작업 무효화 DTO
 */
export class VoidWorkItemDto {
  @ApiProperty({
    description: '무효화 사유 (필수)',
    example: '잘못 생성된 작업 건',
  })
  @IsString()
  @IsNotEmpty({ message: '무효화 사유를 입력해주세요' })
  reason: string;
}

/**
 * 반장 강제 종료 DTO
 */
export class ForceEndWorkItemDto {
  @ApiProperty({
    description: '최종 물량',
    required: false,
  })
  @IsNumber()
  @Min(0)
  @Max(99999, { message: '물량이 허용 범위를 초과했습니다 (최대 99,999 CBM)' })
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '최종 수량',
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '강제 종료 사유',
    example: '작업자 퇴근으로 인한 강제 종료',
  })
  @IsString()
  @IsNotEmpty({ message: '강제 종료 사유를 입력해주세요' })
  reason: string;
}
