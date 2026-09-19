import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/**
 * 키오스크 관리 동작 PIN 확인 DTO (#26)
 * 로그인된 태블릿에서 로그아웃/캐시 초기화/기록 삭제 등 관리 동작 직전에
 * "사이트 내 관리자 중 하나의 PIN"을 확인한다. 토큰 재발급 없음.
 */
export class VerifyPinDto {
  @ApiProperty({
    description: '관리자 PIN (4~20자)',
    example: '1234',
    minLength: 4,
    maxLength: 20,
  })
  @IsString()
  @IsNotEmpty({ message: 'PIN을 입력해주세요' })
  @Length(4, 20, { message: 'PIN은 4~20자여야 합니다' })
  pin: string;

  @ApiPropertyOptional({ description: '수정을 승인할 작업 ID. 다른 관리 동작은 생략' })
  @IsOptional()
  @IsUUID('4', { message: '올바른 작업 ID 형식이 아닙니다' })
  editWorkItemId?: string;
}
