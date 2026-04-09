import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 관리자 로그인 DTO
 * 사번 + PIN으로 JWT 토큰 발급
 */
export class LoginDto {
  @ApiProperty({
    description: '사번 (Employee Code)',
    example: 'ADM001',
  })
  @IsString()
  @IsNotEmpty({ message: '사번을 입력해주세요' })
  employeeCode: string;

  @ApiProperty({
    description: 'PIN 번호',
    example: '0000',
  })
  @IsString()
  @IsNotEmpty({ message: 'PIN을 입력해주세요' })
  pin: string;
}
