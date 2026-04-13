import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class UpdateWorkerDto {
  @ApiProperty({
    description: '작업자 이름',
    example: '홍길동',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Length(1, 100)
  name?: string;

  @ApiProperty({
    description: '사번 (고유)',
    example: 'WRK002',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Length(1, 50)
  employeeCode?: string;

  @ApiProperty({
    description: '새 PIN 번호 (4자리 이상)',
    example: '5678',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Length(4, 20)
  pin?: string;

  @ApiProperty({
    description: '역할',
    enum: ['ADMIN', 'SUPERVISOR', 'WORKER'],
    required: false,
  })
  @IsIn(['ADMIN', 'SUPERVISOR', 'WORKER'])
  @IsOptional()
  role?: string;

  @ApiProperty({
    description: '상태',
    enum: ['ACTIVE', 'INACTIVE'],
    required: false,
  })
  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: string;

  @ApiProperty({
    description: '직무 트랙',
    enum: ['OUTBOUND_RANKED', 'INBOUND_SUPPORT', 'INSPECTION_GOAL', 'DOCK_WRAP_GOAL', 'MANAGER_OPS'],
    required: false,
  })
  @IsIn(['OUTBOUND_RANKED', 'INBOUND_SUPPORT', 'INSPECTION_GOAL', 'DOCK_WRAP_GOAL', 'MANAGER_OPS'])
  @IsOptional()
  jobTrack?: string;

  @ApiProperty({
    description: '소속 사업장 ID',
    required: false,
  })
  @IsUUID('4', { message: '올바른 사업장 ID를 입력해주세요' })
  @IsOptional()
  siteId?: string;

  @ApiProperty({
    description: '모바일 작업자 선택 화면 노출 여부',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  mobileVisible?: boolean;
}
