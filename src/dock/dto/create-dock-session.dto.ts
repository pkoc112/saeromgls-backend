import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsIn,
  IsArray,
} from 'class-validator';

export class CreateDockSessionDto {
  @ApiProperty({
    description: '작업 유형',
    enum: ['LOAD', 'UNLOAD'],
    default: 'LOAD',
  })
  @IsIn(['LOAD', 'UNLOAD'], { message: '작업 유형은 LOAD 또는 UNLOAD여야 합니다' })
  @IsNotEmpty({ message: '작업 유형을 입력해주세요' })
  actionType: string;

  @ApiProperty({
    description: '도크 번호',
    required: false,
    example: 'D-01',
  })
  @IsString()
  @IsOptional()
  dockNumber?: string;

  @ApiProperty({
    description: '차량 번호',
    required: false,
    example: '12가 3456',
  })
  @IsString()
  @IsOptional()
  vehicleNumber?: string;

  @ApiProperty({
    description: '참여 작업자 ID 목록',
    type: [String],
    required: false,
  })
  @IsArray()
  @IsUUID('4', { each: true, message: '참여 작업자 ID 형식이 올바르지 않습니다' })
  @IsOptional()
  participantWorkerIds?: string[];
}
