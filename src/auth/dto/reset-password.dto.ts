import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: '이메일', example: 'user@example.com', required: false })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다' })
  @IsOptional()
  email?: string;

  @ApiProperty({ description: '사번', example: 'WRK101' })
  @IsString()
  @IsNotEmpty({ message: '사번을 입력해주세요' })
  employeeCode: string;

  @ApiProperty({ description: '새 비밀번호', example: 'newpass1234' })
  @IsString()
  @MinLength(8, { message: '비밀번호는 최소 8자 이상이어야 합니다' })
  newPassword: string;
}
