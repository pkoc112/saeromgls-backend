import { IsString, IsOptional, IsIn } from 'class-validator';

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
