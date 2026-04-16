import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { EmailLoginDto } from './dto/email-login.dto';
import { LoginDto } from './dto/login.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('admin/auth/login')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Admin Auth')
  @ApiOperation({ summary: '관리자 로그인' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'JWT 토큰 반환' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async adminLogin(@Body() dto: LoginDto, @Req() req: Request) {
    const ip = req.ip || req.headers['x-forwarded-for']?.toString();
    const ua = req.headers['user-agent'];
    return this.authService.validateAdmin(dto.employeeCode, dto.pin, ip, ua);
  }

  @Post('mobile/auth/pin-login')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Mobile Auth')
  @ApiOperation({ summary: '모바일 PIN 로그인' })
  @ApiBody({ type: PinLoginDto })
  @ApiResponse({ status: 200, description: 'JWT 토큰 + 작업자 정보 반환' })
  @ApiResponse({ status: 401, description: '인증 실패' })
  async pinLogin(@Body() dto: PinLoginDto, @Req() req: Request) {
    const ip = req.ip || req.headers['x-forwarded-for']?.toString();
    const ua = req.headers['user-agent'];
    return this.authService.validatePin(dto.workerId, dto.pin, ip, ua);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '토큰 갱신' })
  @ApiResponse({ status: 200, description: '새 토큰 반환' })
  async refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshAccessToken(dto.refreshToken);
  }

  @Get('auth/verify-employee-code/:code')
  @ApiTags('Auth')
  @ApiOperation({ summary: '사번 유효성 검증(회원가입 연결용)' })
  async verifyEmployeeCode(@Param('code') code: string) {
    return this.authService.verifyEmployeeCode(code);
  }

  @Post('auth/register')
  @HttpCode(HttpStatus.CREATED)
  @ApiTags('Auth')
  @ApiOperation({ summary: '회원가입(사번 연결 또는 신규 생성)' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: 201, description: '회원가입 성공' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('auth/email-login')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 로그인' })
  @ApiResponse({ status: 200, description: 'JWT 토큰 + 사용자 정보 반환' })
  async emailLogin(@Body() dto: EmailLoginDto, @Req() req: Request) {
    const ip = req.ip || req.headers['x-forwarded-for']?.toString();
    const ua = req.headers['user-agent'];
    const worker = await this.authService.validateEmailPassword(
      dto.email,
      dto.password,
      ip,
      ua,
    );
    const token = await this.authService.generateToken(
      worker.id,
      worker.role,
      worker.employeeCode,
      worker.siteId ?? undefined,
    );

    return {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      user: {
        id: worker.id,
        name: worker.name,
        role: worker.role.toLowerCase(),
        email: worker.email,
        employeeCode: worker.employeeCode,
        siteId: worker.siteId,
        siteName: worker.site?.name || null,
      },
    };
  }

  @Post('auth/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '비밀번호 재설정(이메일 인증 코드 필요)' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(
      dto.email,
      dto.employeeCode,
      dto.verificationCode,
      dto.newPassword,
    );
  }

  @Get('auth/check-email/:email')
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 중복 확인' })
  async checkEmail(@Param('email') email: string) {
    const available = await this.authService.checkEmailAvailable(email);
    return { available };
  }

  @Post('auth/send-verification')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 인증 코드 발급' })
  async sendVerification(@Body() dto: { email: string }) {
    return this.authService.sendVerificationCode(dto.email);
  }

  @Post('auth/verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '이메일 인증 확인' })
  async verifyEmail(@Body() dto: { email: string; code: string }) {
    return this.authService.verifyEmail(dto.email, dto.code);
  }

  @Get('auth/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiTags('Auth')
  @ApiOperation({ summary: '내 정보 조회' })
  async getMe(@CurrentUser('sub') workerId: string) {
    return this.authService.getMe(workerId);
  }

  @Patch('auth/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '내 정보 수정' })
  async updateMe(@CurrentUser('sub') workerId: string, @Body() dto: UpdateMeDto) {
    return this.authService.updateMe(workerId, dto);
  }

  @Post('auth/delete-account')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiTags('Auth')
  @ApiOperation({ summary: '계정 탈퇴' })
  async deleteAccount(
    @CurrentUser('sub') workerId: string,
    @Body() dto: DeleteAccountDto,
  ) {
    return this.authService.deleteAccount(workerId, dto.password);
  }
}
