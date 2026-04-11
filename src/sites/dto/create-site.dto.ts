import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

export class CreateSiteDto {
  @ApiProperty({ description: '사업장명', example: '인천 물류센터' })
  @IsString()
  @IsNotEmpty({ message: '사업장명을 입력해주세요' })
  @MinLength(2, { message: '사업장명은 2자 이상이어야 합니다' })
  @MaxLength(100, { message: '사업장명은 100자 이하여야 합니다' })
  name: string;

  @ApiProperty({ description: '사업장 코드 (대문자)', example: 'INCHEON' })
  @IsString()
  @IsNotEmpty({ message: '코드를 입력해주세요' })
  @MinLength(2, { message: '코드는 2자 이상이어야 합니다' })
  @MaxLength(20, { message: '코드는 20자 이하여야 합니다' })
  @Matches(/^[A-Z0-9_]+$/, {
    message: '코드는 대문자, 숫자, 밑줄(_)만 사용 가능합니다',
  })
  code: string;

  @ApiProperty({ description: '상위 사업장 ID (서브 사업장 생성 시)', required: false })
  @IsUUID('4', { message: '유효하지 않은 사업장 ID입니다' })
  @IsOptional()
  parentSiteId?: string;
}
