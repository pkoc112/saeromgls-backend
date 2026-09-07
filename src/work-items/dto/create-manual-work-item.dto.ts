import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsNumber,
  IsInt,
  IsArray,
  IsDateString,
  Length,
  Min,
  Max,
} from 'class-validator';

/**
 * 관리자 작업 기록 수기 등록 DTO (#35)
 * - 이미 끝난 작업을 웹에서 사후 등록 (상태 ENDED 로 생성)
 * - 사유 필수 (감사 로그 MANUAL_CREATE 에 기록)
 */
export class CreateManualWorkItemDto {
  @ApiProperty({
    description: '작업 시작 작업자 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 작업자 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '작업자를 선택해주세요' })
  startedByWorkerId: string;

  @ApiProperty({
    description: '분류 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 분류 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '분류를 선택해주세요' })
  classificationId: string;

  @ApiProperty({
    description: '작업 시작 시간 (ISO 8601)',
    example: '2026-09-07T09:00:00+09:00',
  })
  @IsDateString({}, { message: '시작 시간 형식이 올바르지 않습니다 (ISO 8601)' })
  @IsNotEmpty({ message: '시작 시간을 입력해주세요' })
  startedAt: string;

  @ApiProperty({
    description: '작업 종료 시간 (ISO 8601) — 시작 시간 이후, 현재 시각 이전',
    example: '2026-09-07T11:30:00+09:00',
  })
  @IsDateString({}, { message: '종료 시간 형식이 올바르지 않습니다 (ISO 8601)' })
  @IsNotEmpty({ message: '종료 시간을 입력해주세요' })
  endedAt: string;

  @ApiProperty({
    description: '물량 (CBM, 소수점 2자리)',
    example: 150.5,
    required: false,
    default: 0,
  })
  @IsNumber({}, { message: '물량은 숫자여야 합니다' })
  @Min(0, { message: '물량은 0 이상이어야 합니다' })
  @Max(99999, { message: '물량이 허용 범위를 초과했습니다 (최대 99,999 CBM)' })
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '수량 (BOX)',
    example: 10,
    required: false,
    default: 0,
  })
  @IsInt({ message: '수량은 정수여야 합니다' })
  @Min(0, { message: '수량은 0 이상이어야 합니다' })
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '참여 작업자 ID 목록 (시작 작업자 제외)',
    type: [String],
    required: false,
    example: [],
  })
  @IsArray({ message: '참여 작업자 목록 형식이 올바르지 않습니다' })
  @IsUUID('4', { each: true, message: '참여 작업자 ID 형식이 올바르지 않습니다' })
  @IsOptional()
  participantWorkerIds?: string[];

  @ApiProperty({
    description: '수기 등록 사유 (필수, 2~200자)',
    example: '태블릿 고장으로 현장 기록 누락',
    minLength: 2,
    maxLength: 200,
  })
  @IsString({ message: '사유는 문자열이어야 합니다' })
  @IsNotEmpty({ message: '수기 등록 사유를 입력해주세요' })
  @Length(2, 200, { message: '사유는 2자 이상 200자 이하로 입력해주세요' })
  reason: string;
}
