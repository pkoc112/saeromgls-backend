import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateHeatAlertDto {
  @ApiProperty({ description: '작업자 ID (Worker UUID)' })
  @IsString()
  workerId!: string;

  @ApiProperty({ description: '작업자 이름' })
  @IsString()
  workerName!: string;

  @ApiProperty({ description: '사업장 ID', required: false })
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiProperty({ description: '체크 결과', enum: ['symptoms', 'rest'] })
  @IsIn(['symptoms', 'rest'])
  result!: 'symptoms' | 'rest';

  @ApiProperty({
    description: '체크된 증상 ID 배열',
    example: ['dizziness', 'headache'],
    isArray: true,
  })
  @IsArray()
  @IsString({ each: true })
  symptoms!: string[];

  @ApiProperty({ description: 'WBGT 값 (°C)', example: 32.5 })
  @IsNumber()
  @Min(0)
  @Max(60)
  wbgt!: number;

  @ApiProperty({ description: '기온 (°C)', example: 34.2 })
  @IsNumber()
  @Min(-30)
  @Max(60)
  temp!: number;

  @ApiProperty({ description: '습도 (%)', example: 68 })
  @IsInt()
  @Min(0)
  @Max(100)
  humidity!: number;

  @ApiProperty({ description: '오전/오후 슬롯', enum: ['AM', 'PM'] })
  @IsIn(['AM', 'PM'])
  slot!: 'AM' | 'PM';

  @ApiProperty({ description: '모바일에서 보고한 시각 (ISO)' })
  @IsString()
  reportedAt!: string;
}
