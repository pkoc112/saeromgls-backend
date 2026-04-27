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
    description: '역할 (MASTER는 별도 절차 — 일반 update에서 거부)',
    enum: ['MASTER', 'ADMIN', 'SUPERVISOR', 'WORKER'],
    required: false,
  })
  // MASTER 포함하여 거부 안 됨 (UI 드롭다운에 MASTER 표시되므로 백엔드도 통과시킴)
  // 단, MASTER 승격은 service 레벨에서 별도 검증 필요 (현재는 controller에서 차단됨)
  @IsIn(['MASTER', 'ADMIN', 'SUPERVISOR', 'WORKER'])
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
    description: '직무 트랙 (신 4트랙 + 구 5트랙 호환)',
    enum: ['OUTBOUND', 'INBOUND_DOCK', 'INSPECTION', 'MANAGER', 'OUTBOUND_RANKED', 'INBOUND_SUPPORT', 'INSPECTION_GOAL', 'DOCK_WRAP_GOAL', 'MANAGER_OPS'],
    required: false,
  })
  @IsIn(['OUTBOUND', 'INBOUND_DOCK', 'INSPECTION', 'MANAGER', 'OUTBOUND_RANKED', 'INBOUND_SUPPORT', 'INSPECTION_GOAL', 'DOCK_WRAP_GOAL', 'MANAGER_OPS'])
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
