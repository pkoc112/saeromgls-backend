import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsNumber,
  IsInt,
  IsArray,
  Min,
} from 'class-validator';

export class CreateWorkItemDto {
  @ApiProperty({
    description: '작업 시작 작업자 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 작업자 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '작업자 ID를 입력해주세요' })
  startedByWorkerId: string;

  @ApiProperty({
    description: '분류 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 분류 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '분류 ID를 입력해주세요' })
  classificationId: string;

  @ApiProperty({
    description: '물량 (소수점 3자리)',
    example: 150.5,
    required: false,
    default: 0,
  })
  @IsNumber({}, { message: '물량은 숫자여야 합니다' })
  @Min(0)
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '수량',
    example: 10,
    required: false,
    default: 0,
  })
  @IsInt({ message: '수량은 정수여야 합니다' })
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '참여 작업자 ID 목록',
    type: [String],
    required: false,
    example: [],
  })
  @IsArray()
  @IsUUID('4', { each: true, message: '참여 작업자 ID 형식이 올바르지 않습니다' })
  @IsOptional()
  participantWorkerIds?: string[];

  @ApiProperty({
    description: '기기 식별자',
    required: false,
    example: 'device-abc-123',
  })
  @IsString()
  @IsOptional()
  deviceId?: string;

  @ApiProperty({
    description: '비고',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({
    description: '멱등성 키 (중복 생성 방지)',
    required: false,
    example: 'req-unique-key-12345',
  })
  @IsString()
  @IsOptional()
  idempotencyKey?: string;

  @ApiProperty({
    description: '배치 ID (멀티 선택 동시 등록 시 동일 값)',
    required: false,
  })
  @IsString()
  @IsOptional()
  batchId?: string;
}
