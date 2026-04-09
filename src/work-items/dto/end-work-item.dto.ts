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

/**
 * 작업 종료 DTO
 * 종료 시 물량/수량 확정, 참여 작업자 추가 가능
 */
export class EndWorkItemDto {
  @ApiProperty({
    description: '종료 처리하는 작업자 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4')
  @IsNotEmpty({ message: '종료 작업자 ID를 입력해주세요' })
  endedByWorkerId: string;

  @ApiProperty({
    description: '최종 물량',
    example: 200.5,
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  volume?: number;

  @ApiProperty({
    description: '최종 수량',
    example: 25,
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiProperty({
    description: '참여 작업자 ID 목록 (종료 시 추가)',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsUUID('4', { each: true })
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
