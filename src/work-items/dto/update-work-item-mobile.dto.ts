import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

/** 비고(memo) 본문 최대 길이 — 앱이 pauseHistory JSON 째로 보내도 추출한 memo 기준으로 서비스에서 검사 */
export const MOBILE_NOTES_MEMO_MAX_LENGTH = 500;

/**
 * 모바일(태블릿) 작업 수정 DTO
 * - '현황' 기록을 길게 눌러 → 관리자 PIN 통과 → 수정 시트에서 전송
 * - 모든 필드 선택 — 보낸 필드만 반영. whitelist ValidationPipe 라 미선언 필드는 조용히 제거됨
 * - 시작/종료 시각 수정은 관리자 웹(UpdateWorkItemDto) 전용 — 태블릿에서는 허용하지 않음
 * - 앱 구버전 호환: 시작 작업자/공동작업자를 startedByWorkerId / participantWorkerIds 로 보내는 번들이 있어
 *   두 이름을 별칭으로 선언 (미선언 시 운영 ValidationPipe 가 조용히 제거 → 작업자 변경 무음 유실).
 *   서비스(updateFromMobile)가 workerId / coWorkerIds 로 정규화하며 둘 다 오면 정식 이름 우선
 */
export class UpdateWorkItemMobileDto {
  @ApiProperty({ description: 'verify-pin에서 발급한 해당 작업 수정 승인값', required: true })
  @IsString({ message: '앱을 업데이트한 뒤 관리자 PIN을 다시 확인해주세요' })
  @MaxLength(2048, { message: '관리자 확인값이 올바르지 않습니다' })
  adminApproval?: string;

  @ApiProperty({
    description: '납품처(분류) ID — 같은 사업장(또는 전역) 활성 분류만',
    required: false,
  })
  @IsUUID('4', { message: '올바른 분류 ID 형식이 아닙니다' })
  @IsOptional()
  classificationId?: string;

  @ApiProperty({
    description: '물량 (CBM)',
    example: 12.5,
    required: false,
  })
  @IsNumber({}, { message: '물량은 숫자여야 합니다' })
  @Min(0, { message: '물량은 0 이상이어야 합니다' })
  // 현장 1건당 CBM 상한 — Create/End/Update DTO 와 동일한 defense-in-depth
  @Max(99999, { message: '물량이 허용 범위를 초과했습니다 (최대 99,999 CBM)' })
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '수량',
    example: 25,
    required: false,
  })
  @IsInt({ message: '수량은 정수여야 합니다' })
  @Min(0, { message: '수량은 0 이상이어야 합니다' })
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description:
      '비고 memo 평문 (빈 문자열이면 비고 삭제). 앱이 이미 병합한 {"pauseHistory":[...],"memo":"..."} JSON 을 보내면 memo 만 추출',
    required: false,
  })
  @IsString({ message: '비고는 문자열이어야 합니다' })
  // pauseHistory JSON 째로 오는 경우를 통과시키기 위한 남용 방지 상한 — memo 500자 검사는 서비스가 추출 후 수행
  @MaxLength(10000, { message: '비고 데이터가 허용 범위를 초과했습니다' })
  @IsOptional()
  notes?: string;

  @ApiProperty({
    description: '시작 작업자 교체 — 같은 사업장 현장 작업자(관리 역할·키오스크 제외)만',
    required: false,
  })
  @IsUUID('4', { message: '올바른 작업자 ID 형식이 아닙니다' })
  @IsOptional()
  workerId?: string;

  @ApiProperty({
    description: '공동작업자 ID 목록 (전체 교체 — 빈 배열이면 모두 해제)',
    type: [String],
    required: false,
  })
  @IsArray({ message: '공동작업자 목록 형식이 올바르지 않습니다' })
  @IsUUID('4', { each: true, message: '공동작업자 ID 형식이 올바르지 않습니다' })
  @IsOptional()
  coWorkerIds?: string[];

  @ApiProperty({
    description: 'workerId 의 별칭 (앱 구버전 호환) — 둘 다 오면 workerId 우선',
    required: false,
  })
  @IsUUID('4', { message: '올바른 작업자 ID 형식이 아닙니다' })
  @IsOptional()
  startedByWorkerId?: string;

  @ApiProperty({
    description: 'coWorkerIds 의 별칭 (앱 구버전 호환) — 둘 다 오면 coWorkerIds 우선',
    type: [String],
    required: false,
  })
  @IsArray({ message: '공동작업자 목록 형식이 올바르지 않습니다' })
  @IsUUID('4', { each: true, message: '공동작업자 ID 형식이 올바르지 않습니다' })
  @IsOptional()
  participantWorkerIds?: string[];

  @ApiProperty({
    description: '수정 사유 (감사 로그) — 없으면 "태블릿에서 수정"',
    required: false,
  })
  @IsString({ message: '사유는 문자열이어야 합니다' })
  @MaxLength(200, { message: '사유는 200자 이하로 입력해주세요' })
  @IsOptional()
  reason?: string;

  @ApiProperty({
    description:
      '구버전 호환 필드. 실제 수정자는 서버가 검증한 승인값으로 결정',
    required: false,
  })
  @IsUUID('4', { message: '올바른 관리자 ID 형식이 아닙니다' })
  @IsOptional()
  actorWorkerId?: string;
}
