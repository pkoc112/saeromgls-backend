import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class BatchInspectIssueDto {
  @ApiProperty({ description: '이슈 대상 작업 UUID' })
  @IsUUID('4', { message: '올바른 작업 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '작업 ID를 입력해주세요' })
  workItemId: string;

  @ApiProperty({ description: '이슈 유형 (DEFECT 등)' })
  @IsString()
  @IsNotEmpty({ message: '이슈 유형을 입력해주세요' })
  issueType: string;

  @ApiProperty({ description: '비고', required: false })
  @IsString()
  @IsOptional()
  notes?: string;
}

/**
 * 일괄 검수 DTO (전량 검수 PASS + 이슈 개별 마킹)
 * - inspectedByWorkerId: 검수자 UUID 필수
 * - date: 검수 대상 날짜 (YYYY-MM-DD)
 * - issues: 이슈 있는 작업 목록 (없으면 모두 PASS)
 * - siteId: MASTER가 다른 사업장 일괄검수 시 필수, 일반 ADMIN은 JWT siteId 자동 적용
 */
export class BatchInspectDto {
  @ApiProperty({ description: '검수자 작업자 UUID' })
  @IsUUID('4', { message: '올바른 검수자 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '검수자 ID를 입력해주세요' })
  inspectedByWorkerId: string;

  @ApiProperty({
    description: '검수 대상 날짜 (YYYY-MM-DD, KST)',
    example: '2026-04-28',
  })
  @IsDateString({}, { message: '올바른 날짜 형식이 아닙니다 (YYYY-MM-DD)' })
  @IsNotEmpty({ message: '검수 대상 날짜를 입력해주세요' })
  date: string;

  @ApiProperty({
    description: '이슈가 있는 작업 목록 (없으면 모두 PASS 처리)',
    type: [BatchInspectIssueDto],
    required: false,
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchInspectIssueDto)
  @IsOptional()
  issues?: BatchInspectIssueDto[];

  @ApiProperty({
    description: '사업장 UUID (MASTER 전용 — 다른 사업장 일괄 검수 시)',
    required: false,
  })
  @IsUUID('4', { message: '올바른 사업장 ID 형식이 아닙니다' })
  @IsOptional()
  siteId?: string;
}
