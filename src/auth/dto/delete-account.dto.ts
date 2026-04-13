import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DeleteAccountDto {
  @ApiProperty({ description: '확인용 비밀번호' })
  @IsString()
  @IsNotEmpty({ message: '비밀번호를 입력해주세요' })
  password: string;
}
