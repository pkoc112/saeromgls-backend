import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class ReorderClassificationsDto {
  @IsString()
  @Length(1, 50)
  @Matches(/^[^_]+$/)
  categoryCode: string;

  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsBoolean()
  global?: boolean;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  expectedIds: string[];
}
