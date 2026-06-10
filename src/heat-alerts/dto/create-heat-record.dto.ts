import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * 시간별 체감온도(WBGT) 기록 보고 DTO
 * - 모바일 앱이 날씨 갱신 시 시간당 1회 전송
 * - wbgt/level은 앱이 화면에 표시하는 값과 동일 (heat-utils 간이식 + KOSHA 5단계)
 */
export class CreateHeatRecordDto {
  @ApiProperty({ description: 'WBGT 값 (°C) — 앱 표시 체감온도', example: 27.4 })
  @IsNumber()
  @Min(0)
  @Max(60)
  wbgt!: number;

  @ApiProperty({ description: '기온 (°C)', example: 26 })
  @IsNumber()
  @Min(-30)
  @Max(60)
  temp!: number;

  @ApiProperty({ description: '습도 (%)', example: 54 })
  @IsInt()
  @Min(0)
  @Max(100)
  humidity!: number;

  @ApiProperty({
    description: 'KOSHA 5단계 폭염 단계',
    enum: ['normal', 'attention', 'caution', 'warning', 'danger'],
  })
  @IsIn(['normal', 'attention', 'caution', 'warning', 'danger'])
  level!: string;

  @ApiProperty({ description: '사업장 ID (JWT siteId 없을 때 fallback)', required: false })
  @IsOptional()
  @IsString()
  siteId?: string;
}
