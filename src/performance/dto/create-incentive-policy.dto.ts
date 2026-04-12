import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
} from 'class-validator';

export class CreateIncentivePolicyDto {
  @ApiProperty({ description: '정책 이름', example: '기본 인센티브' })
  @IsString()
  @IsNotEmpty({ message: '정책 이름을 입력해주세요' })
  name: string;

  @ApiProperty({ description: '사업장 ID' })
  @IsUUID()
  siteId: string;

  @ApiProperty({ description: '건수 가중치', example: 10, required: false })
  @IsNumber()
  @IsOptional()
  scoreWeightCount?: number;

  @ApiProperty({ description: 'CBM 가중치', example: 2, required: false })
  @IsNumber()
  @IsOptional()
  scoreWeightVolume?: number;

  @ApiProperty({ description: 'BOX 가중치', example: 0.05, required: false })
  @IsNumber()
  @IsOptional()
  scoreWeightQuantity?: number;

  @ApiProperty({ description: '보너스 기준점수 1', required: false })
  @IsNumber()
  @IsOptional()
  bonusThreshold1?: number;

  @ApiProperty({ description: '보너스 금액 1 (원)', required: false })
  @IsInt()
  @Min(0)
  @IsOptional()
  bonusAmount1?: number;

  @ApiProperty({ description: '보너스 기준점수 2', required: false })
  @IsNumber()
  @IsOptional()
  bonusThreshold2?: number;

  @ApiProperty({ description: '보너스 금액 2 (원)', required: false })
  @IsInt()
  @Min(0)
  @IsOptional()
  bonusAmount2?: number;
}
