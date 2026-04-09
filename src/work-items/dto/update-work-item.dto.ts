import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsNumber,
  IsInt,
  Min,
} from 'class-validator';

/**
 * 관리자 작업 수정 DTO
 * 수정 사유가 필수 (감사 로그에 기록)
 */
export class UpdateWorkItemDto {
  @ApiProperty({
    description: '분류 ID',
    required: false,
  })
  @IsUUID('4')
  @IsOptional()
  classificationId?: string;

  @ApiProperty({
    description: '물량',
    example: 200.5,
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '수량',
    example: 25,
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '비고',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({
    description: '수정 사유 (필수)',
    example: '물량 오입력 수정',
  })
  @IsString()
  @IsNotEmpty({ message: '수정 사유를 입력해주세요' })
  reason: string;
}

/**
 * 작업 무효화 DTO
 */
export class VoidWorkItemDto {
  @ApiProperty({
    description: '무효화 사유 (필수)',
    example: '잘못 생성된 작업 건',
  })
  @IsString()
  @IsNotEmpty({ message: '무효화 사유를 입력해주세요' })
  reason: string;
}

/**
 * 반장 강제 종료 DTO
 */
export class ForceEndWorkItemDto {
  @ApiProperty({
    description: '최종 물량',
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '최종 수량',
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '강제 종료 사유',
    example: '작업자 퇴근으로 인한 강제 종료',
  })
  @IsString()
  @IsNotEmpty({ message: '강제 종료 사유를 입력해주세요' })
  reason: string;
}
