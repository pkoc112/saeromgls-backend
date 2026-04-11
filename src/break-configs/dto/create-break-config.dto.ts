import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class CreateBreakConfigDto {
  @ApiProperty({ description: '휴게시간 라벨', example: '점심시간' })
  @IsString()
  @IsNotEmpty({ message: '라벨을 입력해주세요' })
  label: string;

  @ApiProperty({ description: '시작 시 (0-23)', example: 12 })
  @IsInt()
  @Min(0)
  @Max(23)
  startHour: number;

  @ApiProperty({ description: '시작 분 (0-59)', example: 0 })
  @IsInt()
  @Min(0)
  @Max(59)
  startMin: number;

  @ApiProperty({ description: '종료 시 (0-23)', example: 13 })
  @IsInt()
  @Min(0)
  @Max(23)
  endHour: number;

  @ApiProperty({ description: '종료 분 (0-59)', example: 0 })
  @IsInt()
  @Min(0)
  @Max(59)
  endMin: number;

  @ApiProperty({ description: '현장 ID (없으면 전역 설정)', required: false })
  @IsUUID()
  @IsOptional()
  siteId?: string;
}
