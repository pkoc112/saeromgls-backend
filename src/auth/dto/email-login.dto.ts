import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class EmailLoginDto {
  @ApiProperty({ description: '이메일', example: 'user@example.com' })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다' })
  email: string;

  @ApiProperty({ description: '비밀번호', example: 'password123' })
  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력해주세요' })
  @MinLength(1)
  password: string;
}
