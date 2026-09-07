import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * 센터 설정 복제 요청 (#27) — POST /admin/sites/:id/clone-settings
 *
 * `:id` 가 대상(복제 받을) 사업장, `sourceSiteId` 가 소스(복제해 올) 사업장.
 * 복제 범위: 분류(Classification) · 휴게시간(BreakConfig) · 테넌트 설정(운영시간/키오스크/화면보호기/입력모드).
 * 좌표·알림이메일·사번접두어·알림·공지 등 센터 고유 값은 복제하지 않는다.
 */
export class CloneSettingsDto {
  @ApiProperty({ description: '설정을 복사해 올 소스 사업장 UUID', format: 'uuid' })
  @IsUUID('4', { message: '유효하지 않은 소스 사업장 ID입니다' })
  sourceSiteId: string;

  @ApiProperty({
    description:
      '하위 납품처 분류(code 에 언더스코어 포함, 예: COUPANG_DAEGU) 포함 여부. false 면 최상위 분류만 복제',
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'includeChildren 은 true/false 여야 합니다' })
  includeChildren?: boolean;
}
