import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class BulkWorkItemsDto {
  @ApiProperty({
    description: '일괄 처리할 작업 UUID 목록 (최대 100건)',
    type: [String],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray({ message: '작업 ID 목록이 필요합니다' })
  @ArrayMinSize(1, { message: '작업을 1건 이상 선택해주세요' })
  @ArrayMaxSize(100, { message: '한 번에 최대 100건까지 처리할 수 있습니다' })
  @ArrayUnique({ message: '중복된 작업 ID가 포함되어 있습니다' })
  @IsUUID('4', { each: true, message: '올바르지 않은 작업 ID가 포함되어 있습니다' })
  ids: string[];

  @ApiProperty({
    description: '일괄 처리 사유 (2~200자)',
    example: '퇴근 후 미종료 작업 일괄 정리',
    minLength: 2,
    maxLength: 200,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: '처리 사유를 입력해주세요' })
  @Length(2, 200, { message: '처리 사유는 2자 이상 200자 이하로 입력해주세요' })
  reason: string;
}
