import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CreateSiteDto } from './create-site.dto';

export class UpdateSiteDto extends PartialType(CreateSiteDto) {
  @ApiProperty({ description: '활성 여부', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
