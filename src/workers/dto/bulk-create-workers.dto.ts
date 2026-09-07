import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** 일괄 등록 허용 역할 (MASTER는 일괄 생성 불가) */
export const BULK_WORKER_ROLES = ['WORKER', 'SUPERVISOR', 'ADMIN'] as const;
export type BulkWorkerRole = (typeof BULK_WORKER_ROLES)[number];

/** 일괄 등록 최대 행 수 */
export const BULK_WORKERS_MAX_ROWS = 100;

/**
 * 일괄 등록 행 DTO
 * - pin: WORKER는 생략 시 서버가 난수 4자리 생성(응답에 평문 1회 반환), SUPERVISOR/ADMIN은 필수
 * - 빈 문자열 pin은 Length 검증에 걸리므로 프론트는 미입력 시 키 자체를 생략해야 함
 */
export class BulkCreateWorkerRowDto {
  @ApiProperty({ description: '작업자 이름', example: '홍길동' })
  @IsString()
  @IsNotEmpty({ message: '이름을 입력해주세요' })
  @Length(1, 100, { message: '이름은 1~100자여야 합니다' })
  name: string;

  @ApiProperty({
    description: '사번 (센터 접두어가 설정돼 있으면 자동 적용, 전역 고유)',
    example: 'WRK002',
  })
  @IsString()
  @IsNotEmpty({ message: '사번을 입력해주세요' })
  @Length(1, 50, { message: '사번은 1~50자여야 합니다' })
  employeeCode: string;

  @ApiProperty({
    description: '역할 (기본: WORKER). ADMIN 행은 MASTER 호출자만 생성 가능',
    enum: BULK_WORKER_ROLES,
    default: 'WORKER',
    required: false,
  })
  @IsIn(BULK_WORKER_ROLES, { message: '역할은 WORKER, SUPERVISOR, ADMIN 중 하나여야 합니다' })
  @IsOptional()
  role?: BulkWorkerRole;

  @ApiProperty({
    description: 'PIN (4~20자). WORKER는 생략 시 난수 4자리 자동 생성, SUPERVISOR/ADMIN은 필수',
    example: '1234',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Length(4, 20, { message: 'PIN은 4~20자여야 합니다' })
  pin?: string;
}

/**
 * 작업자 일괄 등록 DTO (POST /admin/workers/bulk)
 * - rows: 1~100행
 * - siteId: MASTER 전용 (ADMIN은 JWT siteId 강제)
 */
export class BulkCreateWorkersDto {
  @ApiProperty({
    description: `등록할 작업자 행 목록 (최대 ${BULK_WORKERS_MAX_ROWS}행)`,
    type: [BulkCreateWorkerRowDto],
  })
  @IsArray({ message: 'rows는 배열이어야 합니다' })
  @ArrayMinSize(1, { message: '등록할 행이 없습니다' })
  @ArrayMaxSize(BULK_WORKERS_MAX_ROWS, {
    message: `한 번에 최대 ${BULK_WORKERS_MAX_ROWS}행까지 등록할 수 있습니다`,
  })
  @ValidateNested({ each: true })
  @Type(() => BulkCreateWorkerRowDto)
  rows: BulkCreateWorkerRowDto[];

  @ApiProperty({
    description: '소속 사업장 ID (MASTER 전용 — ADMIN은 자기 사업장 자동 배정)',
    required: false,
  })
  @IsUUID('4', { message: '올바른 사업장 ID를 입력해주세요' })
  @IsOptional()
  siteId?: string;
}
