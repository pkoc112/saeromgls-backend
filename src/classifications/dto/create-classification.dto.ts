import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

export class CreateClassificationDto {
  @ApiProperty({
    description: '분류 코드 (고유)',
    example: 'MART',
  })
  @IsString()
  @IsNotEmpty({ message: '분류 코드를 입력해주세요' })
  @Length(1, 50)
  code: string;

  @ApiProperty({
    description: '표시 이름',
    example: 'MART (대형마트)',
  })
  @IsString()
  @IsNotEmpty({ message: '표시 이름을 입력해주세요' })
  @Length(1, 100)
  displayName: string;

  @ApiProperty({
    description: '정렬 순서',
    example: 4,
    required: false,
    default: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiProperty({
    description: '활성 여부',
    required: false,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({
    description: '사업장 ID (MASTER만 지정, ADMIN은 자동)',
    required: false,
  })
  @IsUUID('4')
  @IsOptional()
  siteId?: string;
}
