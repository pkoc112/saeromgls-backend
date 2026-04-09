import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PinLoginDto } from './dto/pin-login.dto';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 관리자 웹 대시보드 로그인
   * ADMIN 또는 SUPERVISOR 역할만 가능
   */
  @Post('admin/auth/login')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Admin Auth')
  @ApiOperation({
    summary: '관리자 로그인',
    description: '사번과 PIN으로 관리자/반장 로그인. JWT 토큰 반환.',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'JWT 토큰 반환' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async adminLogin(@Body() dto: LoginDto) {
    return this.authService.validateAdmin(dto.employeeCode, dto.pin);
  }

  /**
   * 모바일 앱 PIN 로그인
   * 모든 활성 작업자 가능
   */
  @Post('mobile/auth/pin-login')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Mobile Auth')
  @ApiOperation({
    summary: '모바일 PIN 로그인',
    description: '작업자 ID와 PIN으로 모바일 간편 로그인. JWT 토큰 + 작업자 정보 반환.',
  })
  @ApiBody({ type: PinLoginDto })
  @ApiResponse({ status: 200, description: 'JWT 토큰 + 작업자 정보 반환' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async pinLogin(@Body() dto: PinLoginDto) {
    return this.authService.validatePin(dto.workerId, dto.pin);
  }
}
