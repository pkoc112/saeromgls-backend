import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

/**
 * 모바일 PIN 로그인 DTO
 * 작업자 ID + PIN으로 간편 인증
 */
export class PinLoginDto {
  @ApiProperty({
    description: '작업자 ID (UUID)',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsString()
  @IsNotEmpty({ message: '작업자 ID를 입력해주세요' })
  workerId: string;

  @ApiProperty({
    description: 'PIN 번호 (4자리)',
    example: '2222',
  })
  @IsString()
  @IsNotEmpty({ message: 'PIN을 입력해주세요' })
  pin: string;

  @ApiProperty({
    description: '기기 식별자',
    required: false,
    example: 'device-abc-123',
  })
  @IsString()
  @IsOptional()
  deviceId?: string;
}
