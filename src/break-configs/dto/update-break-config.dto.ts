import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreateBreakConfigDto } from './create-break-config.dto';

export class UpdateBreakConfigDto extends PartialType(CreateBreakConfigDto) {
  @ApiProperty({ description: '활성 여부', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
