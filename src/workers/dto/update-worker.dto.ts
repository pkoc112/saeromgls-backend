import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

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
}
