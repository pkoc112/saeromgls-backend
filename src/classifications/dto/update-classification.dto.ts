import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class UpdateClassificationDto {
  @ApiProperty({
    description: '분류 코드',
    example: 'MART',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Length(1, 50)
  code?: string;

  @ApiProperty({
    description: '표시 이름',
    example: 'MART (대형마트)',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Length(1, 100)
  displayName?: string;

  @ApiProperty({
    description: '정렬 순서',
    example: 4,
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiProperty({
    description: '활성 여부',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
