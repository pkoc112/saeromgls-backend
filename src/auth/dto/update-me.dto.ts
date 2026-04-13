import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateMeDto {
  @ApiProperty({ description: '이름', required: false })
  @IsString()
  @IsOptional()
  @MinLength(2, { message: '이름은 최소 2자 이상이어야 합니다' })
  @MaxLength(50)
  name?: string;

  @ApiProperty({ description: '전화번호', required: false })
  @IsString()
  @IsOptional()
  @MinLength(10)
  @MaxLength(15)
  phone?: string;

  @ApiProperty({ description: '현재 비밀번호 (비밀번호 변경 시 필수)', required: false })
  @IsString()
  @IsOptional()
  currentPassword?: string;

  @ApiProperty({ description: '새 비밀번호', required: false })
  @IsString()
  @IsOptional()
  @MinLength(8, { message: '비밀번호는 최소 8자 이상이어야 합니다' })
  newPassword?: string;
}
