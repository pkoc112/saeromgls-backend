import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, IsBoolean, IsObject, MaxLength, IsIn } from 'class-validator';

export class CreateMobileDiagnosticDto {
  @ApiProperty({ description: '진단 대상 화면', example: 'classifications' })
  @IsString()
  @MaxLength(50)
  screen: string;

  @ApiProperty({
    description: '오류 유형',
    enum: ['network', 'auth', 'http_5xx', 'empty_response', 'timeout', 'unknown'],
  })
  @IsString()
  @IsIn(['network', 'auth', 'http_5xx', 'empty_response', 'timeout', 'unknown'])
  errorType: string;

  @ApiProperty({ description: '오류 메시지 (사람이 읽는 텍스트)', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  errorMessage?: string;

  @ApiProperty({ description: 'HTTP 상태 코드', required: false, example: 401 })
  @IsInt()
  @IsOptional()
  httpStatus?: number;

  @ApiProperty({ description: 'JWT 토큰 보유 여부', required: false })
  @IsBoolean()
  @IsOptional()
  hasToken?: boolean;

  @ApiProperty({ description: '토큰 발급 후 경과 시간 (분)', required: false })
  @IsInt()
  @IsOptional()
  tokenAgeMinutes?: number;

  @ApiProperty({ description: 'NetInfo isConnected', required: false })
  @IsBoolean()
  @IsOptional()
  networkOnline?: boolean;

  @ApiProperty({ description: '받은 데이터 개수 (0이면 빈 응답)', required: false })
  @IsInt()
  @IsOptional()
  payloadSize?: number;

  @ApiProperty({ description: '앱 버전 (예: 2.0.0)', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  appVersion?: string;

  @ApiProperty({ description: 'OTA runtime version', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  runtimeVersion?: string;

  @ApiProperty({ description: '플랫폼', required: false, example: 'android' })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  platform?: string;

  @ApiProperty({ description: '추가 자유 형식 컨텍스트 (currentWorker 메모리 상태 등)', required: false })
  @IsObject()
  @IsOptional()
  context?: Record<string, unknown>;
}
