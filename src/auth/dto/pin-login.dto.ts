import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsUUID, Matches, Length } from 'class-validator';

/**
 * 모바일 PIN 로그인 DTO
 * 작업자 ID + PIN으로 간편 인증
 */
export class PinLoginDto {
  @ApiProperty({
    description: '작업자 ID (UUID)',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  // P1-17: UUID 형식 검증
  @IsUUID('4', { message: '올바른 작업자 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '작업자 ID를 입력해주세요' })
  workerId: string;

  @ApiProperty({
    description: 'PIN 번호 (4~8자리 숫자)',
    example: '2222',
    minLength: 4,
    maxLength: 8,
  })
  // P1-17: PIN은 4~8자리 숫자만 허용 (브루트포스 방어에 유리한 길이 강제)
  @IsString()
  @IsNotEmpty({ message: 'PIN을 입력해주세요' })
  @Length(4, 8, { message: 'PIN은 4~8자리여야 합니다' })
  @Matches(/^\d+$/, { message: 'PIN은 숫자만 입력 가능합니다' })
  pin: string;

  @ApiProperty({
    description: '기기 식별자',
    required: false,
    example: 'device-abc-123',
  })
  @IsString()
  @IsOptional()
  @Length(1, 128)
  deviceId?: string;
}
