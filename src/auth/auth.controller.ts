import { Controller, Post, Get, Patch, Body, Param, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
// Throttle removed - ThrottlerModule not registered in AppModule
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 관리자 웹 대시보드 로그인
   */
  @Post('admin/auth/login')

  @HttpCode(HttpStatus.OK)
  @ApiTags('Admin Auth')
  @ApiOperation({ summary: '관리자 로그인' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'JWT 토큰 반환' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async adminLogin(@Body() dto: LoginDto) {
    return this.authService.validateAdmin(dto.employeeCode, dto.pin);
  }

  /**
   * 모바일 앱 PIN 로그인
   */
  @Post('mobile/auth/pin-login')

  @HttpCode(HttpStatus.OK)
  @ApiTags('Mobile Auth')
  @ApiOperation({ summary: '모바일 PIN 로그인' })
  @ApiBody({ type: PinLoginDto })
  @ApiResponse({ status: 200, description: 'JWT 토큰 + 작업자 정보 반환' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async pinLogin(@Body() dto: PinLoginDto) {
    return this.authService.validatePin(dto.workerId, dto.pin);
  }

  /**
   * 토큰 갱신
   */
  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '토큰 갱신' })
  @ApiResponse({ status: 200, description: '새 토큰 반환' })
  async refreshToken(@Body() dto: { refreshToken: string }) {
    return this.authService.refreshAccessToken(dto.refreshToken);
  }

  /**
   * 회원가입
   */
  @Post('auth/register')

  @HttpCode(HttpStatus.CREATED)
  @ApiTags('Auth')
  @ApiOperation({ summary: '회원가입' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: 201, description: '회원가입 성공' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /**
   * 이메일/비밀번호 로그인
   */
  @Post('auth/email-login')

  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 로그인' })
  @ApiResponse({ status: 200, description: 'JWT 토큰 + 사용자 정보 반환' })
  async emailLogin(@Body() dto: { email: string; password: string }) {
    const worker = await this.authService.validateEmailPassword(dto.email, dto.password);
    const token = this.authService.generateToken(worker.id, worker.role, worker.employeeCode, worker.siteId ?? undefined);
    return {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      user: {
        id: worker.id,
        name: worker.name,
        role: worker.role.toLowerCase(),
        email: worker.email,
        siteId: worker.siteId,
      },
    };
  }

  /**
   * 비밀번호 재설정
   */
  @Post('auth/reset-password')

  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '비밀번호 재설정' })
  async resetPassword(@Body() dto: { email: string; employeeCode: string; newPassword: string }) {
    return this.authService.resetPassword(dto.email, dto.employeeCode, dto.newPassword);
  }

  /**
   * 이메일 중복 확인
   */
  @Get('auth/check-email/:email')
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 중복 확인' })
  async checkEmail(@Param('email') email: string) {
    const available = await this.authService.checkEmailAvailable(email);
    return { available };
  }

  /**
   * 이메일 인증 코드 발급
   */
  @Post('auth/send-verification')

  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 인증 코드 발급' })
  async sendVerification(@Body() dto: { email: string }) {
    return this.authService.sendVerificationCode(dto.email);
  }

  /**
   * 이메일 인증 확인
   */
  @Post('auth/verify-email')

  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 인증 확인' })
  async verifyEmail(@Body() dto: { email: string; code: string }) {
    return this.authService.verifyEmail(dto.email, dto.code);
  }

  /**
   * 내 정보 조회
   */
  @Get('auth/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiTags('Auth')
  @ApiOperation({ summary: '내 정보 조회' })
  async getMe(@CurrentUser('sub') workerId: string) {
    return this.authService.getMe(workerId);
  }

  /**
   * 내 정보 수정
   */
  @Patch('auth/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '내 정보 수정' })
  async updateMe(
    @CurrentUser('sub') workerId: string,
    @Body() dto: { name?: string; phone?: string; currentPassword?: string; newPassword?: string },
  ) {
    return this.authService.updateMe(workerId, dto);
  }

  /**
   * 계정 탈퇴
   */
  @Post('auth/delete-account')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '계정 탈퇴' })
  async deleteAccount(
    @CurrentUser('sub') workerId: string,
    @Body() dto: { password: string },
  ) {
    return this.authService.deleteAccount(workerId, dto.password);
  }
}
