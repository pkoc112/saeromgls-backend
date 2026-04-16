import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: '이메일', example: 'user@example.com' })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다' })
  @IsNotEmpty({ message: '이메일을 입력해 주세요' })
  email: string;

  @ApiProperty({ description: '사번', example: 'WRK101' })
  @IsString()
  @IsNotEmpty({ message: '사번을 입력해 주세요' })
  employeeCode: string;

  @ApiProperty({ description: '이메일 인증 코드', example: '123456' })
  @IsString()
  @Length(6, 6, { message: '인증 코드는 6자리로 입력해 주세요' })
  verificationCode: string;

  @ApiProperty({ description: '새 비밀번호', example: 'newpass1234' })
  @IsString()
  @MinLength(8, { message: '비밀번호는 최소 8자 이상이어야 합니다' })
  newPassword: string;
}
