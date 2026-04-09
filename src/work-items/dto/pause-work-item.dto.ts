import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

/**
 * 작업 중간마감 (일시정지) DTO
 */
export class PauseWorkItemDto {
  @ApiProperty({
    description: '중간마감 처리하는 작업자 ID',
    example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  })
  @IsUUID('4', { message: '올바른 작업자 ID 형식이 아닙니다' })
  @IsNotEmpty({ message: '작업자 ID를 입력해주세요' })
  pausedByWorkerId: string;
}
