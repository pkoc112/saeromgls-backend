import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  IsIn,
  Min,
} from 'class-validator';

export class EndDockSessionDto {
  @ApiProperty({
    description: '총 수량',
    example: 300,
    default: 0,
  })
  @IsInt({ message: '총 수량은 정수여야 합니다' })
  @Min(0)
  @IsOptional()
  totalQuantity?: number;

  @ApiProperty({
    description: '랩핑 포함 여부',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  wrapIncluded?: boolean;

  @ApiProperty({
    description: '랩핑 수준',
    enum: ['NONE', 'LIGHT', 'MEDIUM', 'HEAVY'],
    required: false,
  })
  @IsIn(['NONE', 'LIGHT', 'MEDIUM', 'HEAVY'], { message: '랩핑 수준은 NONE, LIGHT, MEDIUM, HEAVY 중 하나여야 합니다' })
  @IsOptional()
  wrapLevel?: string;

  @ApiProperty({
    description: '비고',
    required: false,
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
