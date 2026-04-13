import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateScoreRunDto {
  @ApiProperty({
    description: '정책 버전 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 정책 버전 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '정책 버전 ID를 입력해주세요' })
  policyVersionId: string;

  @ApiProperty({
    description: '대상 월 (YYYY-MM)',
    example: '2026-04',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: '월 형식은 YYYY-MM이어야 합니다' })
  @IsNotEmpty({ message: '대상 월을 입력해주세요' })
  month: string;
}
