import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class WorkEventDto {
  @ApiPropertyOptional({ description: '기기에서 작업 동작을 수행한 시각 (시간대 포함 ISO 8601)' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: '작업 시각 형식이 올바르지 않습니다' })
  occurredAt?: string;

  @ApiPropertyOptional({ description: '재전송 중복 방지용 작업 이벤트 UUID' })
  @IsOptional()
  @IsUUID('4', { message: '작업 이벤트 ID 형식이 올바르지 않습니다' })
  eventId?: string;
}
