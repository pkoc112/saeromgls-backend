import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateSiteFromTemplateDto {
  @IsString()
  templateId: string;

  @IsString()
  siteName: string;

  @IsString()
  siteCode: string;
}

export class CreateSupportCaseDto {
  @IsString()
  siteId: string;

  @IsOptional()
  @IsString()
  reporterId?: string;

  @IsOptional()
  @IsIn(['P1', 'P2', 'P3'])
  severity?: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class ResolveSupportCaseDto {
  @IsString()
  resolution: string;
}

export class GenerateUsageSnapshotDto {
  @IsString()
  siteId: string;

  @IsString()
  month: string; // "2026-04"
}

export class StartOnboardingRunDto {
  @IsString()
  siteId: string;
}

export class UpdateOnboardingRunDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  step?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  totalSteps?: number;

  @IsOptional()
  @IsIn(['IN_PROGRESS', 'COMPLETED'])
  status?: string;

  @IsOptional()
  @IsBoolean()
  markStepComplete?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpsertTenantSettingsDto {
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  workStartHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  workEndHour?: number;

  @IsOptional()
  @IsBoolean()
  kioskMode?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  autoScreensaverSeconds?: number;

  @IsOptional()
  @IsString()
  noticeMessage?: string;

  // 센터별 날씨/폭염 좌표 (이전엔 DTO 누락으로 whitelist에서 제거되어 저장 안 됨)
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  // 폭염 알림 수신 이메일 (센터별)
  @IsOptional()
  @IsString()
  alertEmail?: string;

  // 작업자 사번 접두어 (예: "DH" → 저장 시 "DH-001"). 센터 간 사번 충돌 방지.
  @IsOptional()
  @IsString()
  @MaxLength(6)
  @Matches(/^[A-Za-z0-9]*$/, { message: '사번 접두어는 영문/숫자만 가능합니다' })
  workerCodePrefix?: string;

  // 인센티브 정책 (정액 계산기) — 중첩 객체, 저장만 통과시킴
  @IsOptional()
  @IsObject()
  incentive?: Record<string, unknown>;

  // 분류(카테고리)별 입력모드 — { [카테고리코드]: 'CBM' | 'QUANTITY' | 'BOTH' }. 미설정 시 BOTH.
  @IsOptional()
  @IsObject()
  classificationModes?: Record<string, string>;

  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown>;
}
