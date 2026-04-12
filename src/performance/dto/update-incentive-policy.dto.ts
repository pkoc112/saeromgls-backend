import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreateIncentivePolicyDto } from './create-incentive-policy.dto';

export class UpdateIncentivePolicyDto extends PartialType(CreateIncentivePolicyDto) {
  @ApiProperty({ description: '활성 여부', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
