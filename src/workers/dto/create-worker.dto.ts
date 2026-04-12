import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateWorkerDto {
  @ApiProperty({
    description: '작업자 이름',
    example: '홍길동',
  })
  @IsString()
  @IsNotEmpty({ message: '이름을 입력해주세요' })
  @Length(1, 100)
  name: string;

  @ApiProperty({
    description: '사번 (고유)',
    example: 'WRK002',
  })
  @IsString()
  @IsNotEmpty({ message: '사번을 입력해주세요' })
  @Length(1, 50)
  employeeCode: string;

  @ApiProperty({
    description: 'PIN 번호 (4자리 이상)',
    example: '1234',
  })
  @IsString()
  @IsNotEmpty({ message: 'PIN을 입력해주세요' })
  @Length(4, 20)
  pin: string;

  @ApiProperty({
    description: '역할',
    enum: ['ADMIN', 'SUPERVISOR', 'WORKER'],
    default: 'WORKER',
    required: false,
  })
  @IsIn(['ADMIN', 'SUPERVISOR', 'WORKER'])
  @IsOptional()
  role?: string;

  @ApiProperty({
    description: '상태',
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE',
    required: false,
  })
  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: string;

  @ApiProperty({
    description: '소속 사업장 ID (MASTER는 지정 가능, ADMIN은 자동 배정)',
    required: false,
  })
  @IsUUID('4', { message: '올바른 사업장 ID를 입력해주세요' })
  @IsOptional()
  siteId?: string;
}
