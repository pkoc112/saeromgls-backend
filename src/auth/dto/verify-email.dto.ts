import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length } from 'class-validator';

/**
 * 이메일 인증 확인 DTO
 * 인증 코드 검증
 */
export class VerifyEmailDto {
  @ApiProperty({
    description: '인증할 이메일 주소',
    example: 'user@example.com',
  })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다' })
  email: string;

  @ApiProperty({
    description: '6자리 인증 코드',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @Length(6, 6, { message: '인증 코드는 6자리여야 합니다' })
  code: string;
}
