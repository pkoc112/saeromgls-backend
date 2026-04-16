import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
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

  @IsOptional()
  @IsObject()
  extra?: Record<string, unknown>;
}
