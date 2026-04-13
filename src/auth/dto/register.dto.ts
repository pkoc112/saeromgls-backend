import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, MinLength, MaxLength, IsBoolean, IsOptional } from 'class-validator';

/**
 * 회원가입 DTO
 * - employeeCode 없이: 신규 작업자 생성 (기존 흐름)
 * - employeeCode 있으면: 기존 작업자에 이메일/비밀번호 연결
 */
export class RegisterDto {
  @ApiProperty({
    description: '연결할 사번 (관리자가 사전 등록한 사번)',
    example: 'WRK115',
    required: false,
  })
  @IsString()
  @IsOptional()
  employeeCode?: string;

  @ApiProperty({
    description: '이름 (사번 연결 시 생략 가능)',
    example: '홍길동',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50, { message: '이름은 최대 50자까지 가능합니다' })
  name?: string;

  @ApiProperty({
    description: '이메일',
    example: 'user@example.com',
  })
  @IsEmail({}, { message: '올바른 이메일 형식이 아닙니다' })
  email: string;

  @ApiProperty({
    description: '비밀번호',
    example: 'password123',
    minLength: 8,
    maxLength: 100,
  })
  @IsString()
  @MinLength(8, { message: '비밀번호는 최소 8자 이상이어야 합니다' })
  @MaxLength(100, { message: '비밀번호는 최대 100자까지 가능합니다' })
  password: string;

  @ApiProperty({
    description: '휴대전화 번호 (사번 연결 시 선택)',
    example: '01012345678',
  })
  @IsString()
  @IsOptional()
  @MaxLength(15, { message: '전화번호는 최대 15자리까지 가능합니다' })
  phone?: string;

  @ApiProperty({
    description: '사업장 코드 (사번 연결 시 불필요)',
    example: '0001',
    required: false,
  })
  @IsString()
  @IsOptional()
  siteCode?: string;

  @ApiProperty({
    description: '이용약관 동의 여부',
    example: true,
  })
  @IsBoolean({ message: '이용약관 동의 여부를 확인해주세요' })
  agreedToTerms: boolean;

  @ApiProperty({
    description: '개인정보처리방침 동의 여부',
    example: true,
  })
  @IsBoolean({ message: '개인정보처리방침 동의 여부를 확인해주세요' })
  agreedToPrivacy: boolean;
}
