import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: '리프레시 토큰' })
  @IsString()
  @IsNotEmpty({ message: '리프레시 토큰이 필요합니다' })
  refreshToken: string;
}
