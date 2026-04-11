import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

/**
 * 이메일 인증 요청 DTO
 * 인증 코드 발송 (1차: 응답으로 반환)
 */
export class SendVerificationDto {
  @ApiProperty({
    description: '인증할 이메일 주소',
    example: 'user@example.com',
  })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다' })
  email: string;
}
