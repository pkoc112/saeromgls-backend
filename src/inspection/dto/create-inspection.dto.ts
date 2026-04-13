import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsInt,
  IsIn,
  Min,
} from 'class-validator';

export class CreateInspectionDto {
  @ApiProperty({
    description: '검수 대상 작업 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 작업 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '대상 작업 ID를 입력해주세요' })
  sourceWorkItemId: string;

  @ApiProperty({
    description: '검수 결과',
    enum: ['PASS', 'ISSUE', 'RECHECK'],
    default: 'PASS',
  })
  @IsIn(['PASS', 'ISSUE', 'RECHECK'], { message: '검수 결과는 PASS, ISSUE, RECHECK 중 하나여야 합니다' })
  @IsNotEmpty({ message: '검수 결과를 입력해주세요' })
  result: string;

  @ApiProperty({
    description: '이슈 유형 (결과가 ISSUE일 때)',
    required: false,
    example: 'MISLABEL',
  })
  @IsString()
  @IsOptional()
  issueType?: string;

  @ApiProperty({
    description: '검수 수량',
    example: 100,
    default: 0,
  })
  @IsInt({ message: '검수 수량은 정수여야 합니다' })
  @Min(0)
  @IsOptional()
  quantityChecked?: number;

  @ApiProperty({
    description: '불량 수량',
    example: 3,
    default: 0,
  })
  @IsInt({ message: '불량 수량은 정수여야 합니다' })
  @Min(0)
  @IsOptional()
  quantityDefect?: number;

  @ApiProperty({
    description: '비고',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
