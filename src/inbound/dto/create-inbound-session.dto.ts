import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsInt,
  IsNumber,
  IsIn,
  IsArray,
  IsDateString,
  Min,
} from 'class-validator';

export class CreateInboundSessionDto {
  @ApiProperty({
    description: '입고 날짜',
    example: '2026-04-13',
  })
  @IsDateString({}, { message: '올바른 날짜 형식이 아닙니다 (YYYY-MM-DD)' })
  @IsNotEmpty({ message: '입고 날짜를 입력해주세요' })
  sessionDate: string;

  @ApiProperty({
    description: '근무 시간대',
    enum: ['AM', 'PM', 'FULL'],
    default: 'AM',
  })
  @IsIn(['AM', 'PM', 'FULL'], { message: '근무 시간대는 AM, PM, FULL 중 하나여야 합니다' })
  @IsOptional()
  shift?: string;

  @ApiProperty({
    description: '공급업체명',
    required: false,
    example: '(주)새롬물류',
  })
  @IsString()
  @IsOptional()
  supplierName?: string;

  @ApiProperty({
    description: '총 수량',
    example: 500,
    default: 0,
  })
  @IsInt({ message: '총 수량은 정수여야 합니다' })
  @Min(0)
  @IsOptional()
  totalQuantity?: number;

  @ApiProperty({
    description: '총 물량 (CBM)',
    example: 120.5,
    default: 0,
  })
  @IsNumber({}, { message: '총 물량은 숫자여야 합니다' })
  @Min(0)
  @IsOptional()
  totalVolume?: number;

  @ApiProperty({
    description: '품목 수',
    example: 15,
    default: 0,
  })
  @IsInt({ message: '품목 수는 정수여야 합니다' })
  @Min(0)
  @IsOptional()
  itemCount?: number;

  @ApiProperty({
    description: '참여 작업자 ID 목록',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsUUID('4', { each: true, message: '참여 작업자 ID 형식이 올바르지 않습니다' })
  @IsOptional()
  participantWorkerIds?: string[];

  @ApiProperty({
    description: '비고',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
