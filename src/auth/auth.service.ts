import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { RegisterDto } from './dto/register.dto';
import { encryptWorkerPII, decryptWorkerPII } from '../common/utils/pii.util';
import { maskEmail } from '../common/utils/pii-mask';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** 로그인 실패 시 잠금 기준 */
  private readonly MAX_FAILED_ATTEMPTS = 5;
  /** 잠금 지속 시간 (밀리초, 30분) */
  private readonly LOCKOUT_DURATION_MS = 30 * 60 * 1000;

  /** 메모리 기반 이메일 인증 코드 저장소 (email -> { code, expiresAt }) */
  // 검증코드: DB 저장 (서버리스 호환 — 인메모리 Map은 요청마다 초기화될 수 있음)

  private readonly resend: Resend | null;
  private readonly fromEmail: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {
    // Resend 초기화 (API 키가 없으면 null — 개발 환경 허용)
    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
    } else {
      this.resend = null;
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn('RESEND_API_KEY 미설정 — 운영 환경에서 이메일 발송 불가');
      }
    }
    this.fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@sae-work.com';
    if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET required in production');
    }
  }

  // ──────────────────────────────────────────────
  // 회원가입 (이메일/비밀번호 기반)
  // ──────────────────────────────────────────────
  async register(dto: RegisterDto) {
    // 이용약관 동의 확인
    if (!dto.agreedToTerms || !dto.agreedToPrivacy) {
      throw new BadRequestException(
        '이용약관 및 개인정보처리방침에 동의해야 합니다',
      );
    }

    // 이메일 중복 확인
    const existing = await this.prisma.worker.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new BadRequestException('이미 사용 중인 이메일입니다');
    }

    // 비밀번호 해시
    const passwordHash = await bcrypt.hash(dto.password, 10);

    // ── 분기 A: 사번 연결 모드 (기존 작업자에 이메일 연결) ──
    if (dto.employeeCode) {
      const target = await this.prisma.worker.findUnique({
        where: { employeeCode: dto.employeeCode },
        include: { site: { select: { name: true } } },
      });
      if (!target) {
        throw new BadRequestException('유효하지 않은 사번입니다');
      }
      if (target.email) {
        throw new BadRequestException('이미 계정이 연결된 사번입니다');
      }

      // 경쟁 조건 방지: email이 null인 경우만 업데이트
      // Phase 1: phone 암호화 (email 암호화는 검색 인덱스 마이그레이션 후 Phase 2에서 진행)
      const encryptedPhone = dto.phone
        ? encryptWorkerPII({ phone: dto.phone }).phone
        : undefined;
      const result = await this.prisma.worker.updateMany({
        where: { employeeCode: dto.employeeCode, email: null },
        data: {
          email: dto.email,
          passwordHash,
          ...(encryptedPhone && { phone: encryptedPhone }),
        },
      });
      if (result.count === 0) {
        throw new BadRequestException('이미 계정이 연결된 사번입니다');
      }

      // 업데이트된 워커 조회
      const worker = await this.prisma.worker.findUnique({
        where: { employeeCode: dto.employeeCode },
      });

      // UserConsent 기록
      await this.prisma.userConsent.createMany({
        data: [
          { workerId: worker!.id, consentType: 'TOS', version: '1.0' },
          { workerId: worker!.id, consentType: 'PRIVACY', version: '1.0' },
        ],
      });

      this.logger.log(
        `Employee linked: ${dto.employeeCode} (${target.role})`,
      );

      const token = await this.generateToken(
        worker!.id,
        worker!.role,
        worker!.employeeCode,
        worker!.siteId ?? undefined,
      );

      return {
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        user: {
          id: worker!.id,
          name: worker!.name,
          email: worker!.email,
          role: worker!.role.toLowerCase(),
          siteId: worker!.siteId,
          siteName: target.site?.name || null,
          employeeCode: worker!.employeeCode,
        },
      };
    }

    // ── 분기 B: 신규 가입 (기존 흐름) ──
    if (!dto.name || dto.name.trim().length < 2) {
      throw new BadRequestException('이름은 최소 2자 이상이어야 합니다');
    }
    if (!dto.phone || dto.phone.length < 10) {
      throw new BadRequestException('전화번호는 최소 10자리여야 합니다');
    }

    // 사업장 매칭 (siteCode)
    let siteId: string | null = null;
    if (dto.siteCode) {
      const site = await this.prisma.site.findUnique({
        where: { code: dto.siteCode },
      });
      if (site) {
        siteId = site.id;
      }
    }

    // 고유 사번 생성 (이메일 기반 + 랜덤 접미사로 충돌 방지)
    const employeeCode = `EM-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // 랜덤 6자리 PIN 생성 (보안: 고정값 000000 대신)
    const randomPin = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedPin = await bcrypt.hash(randomPin, 10);

    // 작업자 생성
    // Phase 1: phone 암호화 (email 암호화는 검색 인덱스 마이그레이션 후 Phase 2에서 진행)
    const encryptedData = encryptWorkerPII({ phone: dto.phone });
    const worker = await this.prisma.worker.create({
      data: {
        name: dto.name,
        email: dto.email,
        phone: encryptedData.phone as string,
        passwordHash,
        employeeCode,
        pin: hashedPin,
        role: 'WORKER',
        status: 'ACTIVE',
        siteId,
      },
    });

    // UserConsent 기록
    await this.prisma.userConsent.createMany({
      data: [
        { workerId: worker.id, consentType: 'TOS', version: '1.0' },
        { workerId: worker.id, consentType: 'PRIVACY', version: '1.0' },
      ],
    });

    this.logger.log(`New user registered: ${maskEmail(dto.email)}`);

    const token = await this.generateToken(
      worker.id,
      worker.role,
      worker.employeeCode,
      siteId ?? undefined,
    );

    return {
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      user: {
        id: worker.id,
        name: worker.name,
        email: worker.email,
        role: worker.role.toLowerCase(),
        siteId: worker.siteId,
        employeeCode: worker.employeeCode,
        pin: randomPin, // 최초 1회만 반환 — 사용자가 메모해야 함
      },
    };
  }

  // ──────────────────────────────────────────────
  // 이메일/비밀번호 로그인 검증
  // ──────────────────────────────────────────────
  async validateEmailPassword(
    email: string,
    password: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const worker = await this.prisma.worker.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        employeeCode: true,
        passwordHash: true,
        role: true,
        status: true,
        siteId: true,
        site: { select: { name: true, code: true } },
      },
    });

    if (!worker) {
      throw new UnauthorizedException('등록되지 않은 이메일입니다');
    }
    if (!worker.passwordHash) {
      throw new UnauthorizedException('비밀번호가 설정되지 않은 계정입니다. 비밀번호 재설정을 해주세요.');
    }

    // 계정 잠금 확인
    const isLocked = await this.checkAccountLocked(worker.id);
    if (isLocked) {
      throw new UnauthorizedException(
        '로그인 시도가 너무 많습니다. 30분 후에 다시 시도해 주세요.',
      );
    }

    if (worker.status !== 'ACTIVE') {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException('비활성화된 계정입니다');
    }

    // WORKER 역할은 웹 로그인 차단 (모바일 앱 전용)
    if (worker.role === 'WORKER') {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException(
        '작업자 계정은 모바일 앱에서만 사용 가능합니다. 웹 접근이 필요하면 관리자에게 역할 변경을 요청하세요.',
      );
    }

    const isValid = await bcrypt.compare(password, worker.passwordHash);
    if (!isValid) {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException('비밀번호가 올바르지 않습니다');
    }

    // 성공 기록
    await this.recordLoginHistory(worker.id, true, ipAddress, userAgent);
    this.logger.log(`Email login: ${maskEmail(email)} (${worker.role})`);
    return worker;
  }

  // ──────────────────────────────────────────────
  // Refresh Token으로 새 Access Token 발급
  // ──────────────────────────────────────────────
  async refreshAccessToken(refreshToken: string) {
    try {
      if (false) {
        throw new Error('JWT_REFRESH_SECRET 또는 JWT_SECRET 환경변수가 필요합니다');
      }
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.getRefreshSecret(),
      });

      // DB에서 토큰 유효성 확인 (순환 + 재사용 차단)
      const storedToken = await this.prisma.refreshToken.findUnique({
        where: { token: refreshToken },
      });

      if (!storedToken) {
        throw new UnauthorizedException(
          '로그인 유효 기간이 종료되었습니다. 다시 로그인해주세요.',
        );
      }

      if (storedToken.revokedAt) {
        // 이미 사용된 토큰 재사용 시도 → 해당 패밀리 전체 무효화 (탈취 의심)
        await this.prisma.refreshToken.updateMany({
          where: { family: storedToken.family, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.warn(`Refresh token replay detected! Family ${storedToken.family} revoked.`);
        throw new UnauthorizedException('보안 위협이 감지되었습니다. 다시 로그인해주세요.');
      }

      // 현재 토큰 사용 처리 (revoke)
      if (storedToken.expiresAt <= new Date()) {
        await this.prisma.refreshToken.update({
          where: { id: storedToken.id },
          data: { revokedAt: new Date() },
        });
        throw new UnauthorizedException(
          '리프레시 토큰이 만료되었습니다. 다시 로그인해주세요.',
        );
      }

      await this.prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });

      const worker = await this.prisma.worker.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          employeeCode: true,
          status: true,
          siteId: true,
        },
      });

      if (!worker || worker.status !== 'ACTIVE') {
        throw new UnauthorizedException('유효하지 않은 토큰입니다');
      }

      const token = await this.generateToken(
        worker.id,
        worker.role,
        worker.employeeCode,
        worker.siteId ?? undefined,
        storedToken.family,
      );

      // 새 토큰에 같은 family 부여 (토큰 체인 추적)
      return {
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException(
        '리프레시 토큰이 만료되었거나 유효하지 않습니다',
      );
    }
  }

  // ──────────────────────────────────────────────
  // 비밀번호 재설정
  // ──────────────────────────────────────────────
  async resetPassword(
    email: string,
    employeeCode: string,
    verificationCode: string,
    newPassword: string,
  ) {
    const worker = await this.prisma.worker.findUnique({
      where: { email },
    });

    if (!worker) {
      throw new NotFoundException('해당 이메일로 등록된 계정이 없습니다');
    }

    if (worker.employeeCode !== employeeCode) {
      throw new BadRequestException('사번 정보가 일치하지 않습니다');
    }

    await this.consumeVerificationCode(email, verificationCode);
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.worker.update({
        where: { id: worker.id },
        data: {
          passwordHash,
          emailVerified: true,
        },
      }),
      this.prisma.refreshToken.deleteMany({
        where: { workerId: worker.id },
      }),
    ]);

    this.logger.log(`Password reset for: ${maskEmail(email)}`);
    return { message: '비밀번호가 성공적으로 재설정되었습니다' };
  }

  // ──────────────────────────────────────────────
  // 이메일 중복 확인
  // ──────────────────────────────────────────────
  async checkEmailAvailable(email: string): Promise<boolean> {
    const worker = await this.prisma.worker.findUnique({
      where: { email },
      select: { id: true },
    });
    return !worker;
  }

  // ──────────────────────────────────────────────
  // 이메일 인증 코드 발급 (DB 저장 — 서버리스 호환)
  // ──────────────────────────────────────────────
  async sendVerificationCode(email: string) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10분

    // 기존 코드 삭제 후 새로 저장
    await this.prisma.verificationCode.deleteMany({ where: { email } });
    await this.prisma.verificationCode.create({
      data: { email, code, expiresAt },
    });

    // ── 이메일 발송 (Resend) ──────────────────────────────────
    if (this.resend) {
      try {
        const { error } = await this.resend.emails.send({
          from: `새롬 GLS <${this.fromEmail}>`,
          to: [email],
          subject: `[새롬 GLS] 이메일 인증 코드: ${code}`,
          html: `
            <div style="font-family:'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto;padding:32px">
              <h2 style="color:#191F28;margin-bottom:8px">새롬 GLS 인증 코드</h2>
              <p style="color:#4E5968;font-size:14px;margin-bottom:24px">
                아래 인증 코드를 입력해주세요. 코드는 10분 동안 유효합니다.
              </p>
              <div style="background:#F2F3F5;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
                <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#191F28">${code}</span>
              </div>
              <p style="color:#8B95A1;font-size:12px">
                본인이 요청하지 않았다면 이 메일을 무시해주세요.
              </p>
            </div>
          `,
        });

        if (error) {
          this.logger.error(`Resend 발송 실패: ${JSON.stringify(error)}`);
          // 발송 실패해도 코드는 이미 DB에 저장됨 — 재시도 가능
        } else {
          this.logger.log(`인증 코드 이메일 발송 완료: ${maskEmail(email)}`);
        }
      } catch (err) {
        this.logger.error(`Resend 예외: ${err}`);
      }
    } else {
      this.logger.log(`[DEV] 인증 코드 ${code} → ${maskEmail(email)} (Resend 미설정, 이메일 미발송)`);
    }

    return {
      message: '인증 코드가 발송되었습니다',
      // 개발 환경에서만 코드 직접 반환 (운영에서는 이메일로만 수신)
      ...(process.env.NODE_ENV !== 'production' && { code }),
    };
  }

  // ──────────────────────────────────────────────
  // 이메일 인증 코드 확인
  // ──────────────────────────────────────────────
  async verifyEmail(email: string, code: string) {
    const stored = await this.prisma.verificationCode.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    if (!stored) {
      throw new BadRequestException('인증 코드가 발급되지 않았습니다');
    }

    if (new Date() > stored.expiresAt) {
      await this.prisma.verificationCode.deleteMany({ where: { email } });
      throw new BadRequestException('인증 코드가 만료되었습니다');
    }

    if (stored.code !== code) {
      throw new BadRequestException('인증 코드가 올바르지 않습니다');
    }

    await this.prisma.verificationCode.deleteMany({ where: { email } });

    // 이미 가입된 사용자가 있으면 emailVerified 업데이트
    const worker = await this.prisma.worker.findUnique({
      where: { email },
    });
    if (worker) {
      await this.prisma.worker.update({
        where: { id: worker.id },
        data: { emailVerified: true },
      });
    }

    return { verified: true, message: '이메일 인증이 완료되었습니다' };
  }

  // ──────────────────────────────────────────────
  // 내 정보 조회 (site 관계 포함)
  // ──────────────────────────────────────────────
  async getMe(workerId: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        employeeCode: true,
        role: true,
        status: true,
        siteId: true,
        emailVerified: true,
        createdAt: true,
        site: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
    });

    if (!worker) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    // Phase 1: phone 복호화 (암호화되지 않은 기존 데이터도 안전하게 처리)
    return decryptWorkerPII(worker as Record<string, unknown>) as typeof worker;
  }

  // ──────────────────────────────────────────────
  // 내 정보 수정 (이름, 전화번호, 비밀번호 변경)
  // ──────────────────────────────────────────────
  async updateMe(
    workerId: string,
    dto: {
      name?: string;
      phone?: string;
      currentPassword?: string;
      newPassword?: string;
    },
  ) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
    });

    if (!worker) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    const updateData: Record<string, unknown> = {};

    if (dto.name) {
      updateData.name = dto.name;
    }

    if (dto.phone) {
      // Phase 1: phone 암호화 (email 암호화는 검색 인덱스 마이그레이션 후 Phase 2에서 진행)
      const encrypted = encryptWorkerPII({ phone: dto.phone });
      updateData.phone = encrypted.phone;
    }

    // 비밀번호 변경
    if (dto.newPassword) {
      if (!dto.currentPassword) {
        throw new BadRequestException(
          '현재 비밀번호를 입력해야 합니다',
        );
      }

      if (!worker.passwordHash) {
        throw new BadRequestException(
          '비밀번호가 설정되지 않은 계정입니다',
        );
      }

      const isValid = await bcrypt.compare(
        dto.currentPassword,
        worker.passwordHash,
      );
      if (!isValid) {
        throw new BadRequestException('현재 비밀번호가 올바르지 않습니다');
      }

      updateData.passwordHash = await bcrypt.hash(dto.newPassword, 10);
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('수정할 정보가 없습니다');
    }

    const updated = await this.prisma.worker.update({
      where: { id: workerId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        employeeCode: true,
        role: true,
      },
    });

    // Phase 1: phone 복호화 후 응답
    const decrypted = decryptWorkerPII(updated as Record<string, unknown>) as typeof updated;
    this.logger.log(`User updated: ${workerId}`);
    return { message: '정보가 수정되었습니다', user: decrypted };
  }

  // ──────────────────────────────────────────────
  // 계정 탈퇴 (MASTER 제외, 비활성화 처리)
  // ──────────────────────────────────────────────
  async deleteAccount(workerId: string, password: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
    });

    if (!worker) {
      throw new NotFoundException('사용자를 찾을 수 없습니다');
    }

    if (worker.role === 'MASTER') {
      throw new BadRequestException('마스터 계정은 탈퇴할 수 없습니다');
    }

    if (!worker.passwordHash) {
      throw new BadRequestException(
        '비밀번호가 설정되지 않은 계정입니다',
      );
    }

    const isValid = await bcrypt.compare(password, worker.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('비밀번호가 올바르지 않습니다');
    }

    await this.prisma.worker.update({
      where: { id: workerId },
      data: { status: 'INACTIVE', email: null },
    });

    this.logger.log(`Account deactivated: ${workerId}`);
    return { message: '계정이 탈퇴 처리되었습니다' };
  }

  // ──────────────────────────────────────────────
  // 관리자 로그인: 사번 + PIN 검증
  // MASTER, ADMIN, SUPERVISOR 역할 허용
  // ──────────────────────────────────────────────
  async validateAdmin(
    employeeCode: string,
    pin: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const worker = await this.prisma.worker.findUnique({
      where: { employeeCode },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        pin: true,
        role: true,
        status: true,
        siteId: true,
      },
    });

    if (!worker) {
      throw new UnauthorizedException('등록되지 않은 사번입니다');
    }

    // 계정 잠금 확인
    const isLocked = await this.checkAccountLocked(worker.id);
    if (isLocked) {
      throw new UnauthorizedException(
        '로그인 시도가 너무 많습니다. 30분 후에 다시 시도해 주세요.',
      );
    }

    if (worker.status !== 'ACTIVE') {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException('비활성화된 계정입니다');
    }

    // 마스터/관리자/반장만 웹 대시보드 로그인 가능
    if (!['MASTER', 'ADMIN', 'SUPERVISOR'].includes(worker.role)) {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException(
        '관리자 이상 권한만 로그인할 수 있습니다',
      );
    }

    const isPinValid = await bcrypt.compare(pin, worker.pin);
    if (!isPinValid) {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException('PIN이 올바르지 않습니다');
    }

    // 성공 기록
    await this.recordLoginHistory(worker.id, true, ipAddress, userAgent);
    this.logger.log(`Admin login: ${worker.employeeCode} (${worker.role})`);

    const token = await this.generateToken(
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
        email: worker.employeeCode,
      },
    };
  }

  // ──────────────────────────────────────────────
  // 모바일 PIN 로그인: 작업자 ID + PIN 검증
  // 모든 활성 작업자 로그인 가능
  // ──────────────────────────────────────────────
  async validatePin(
    workerId: string,
    pin: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        pin: true,
        role: true,
        status: true,
        siteId: true,
      },
    });

    if (!worker) {
      throw new UnauthorizedException('작업자를 찾을 수 없습니다');
    }

    // 계정 잠금 확인
    const isLocked = await this.checkAccountLocked(worker.id);
    if (isLocked) {
      throw new UnauthorizedException(
        '로그인 시도가 너무 많습니다. 30분 후에 다시 시도해 주세요.',
      );
    }

    if (worker.status !== 'ACTIVE') {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException('비활성화된 계정입니다');
    }

    const isPinValid = await bcrypt.compare(pin, worker.pin);
    if (!isPinValid) {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException('PIN이 올바르지 않습니다');
    }

    // 성공 기록
    await this.recordLoginHistory(worker.id, true, ipAddress, userAgent);
    this.logger.log(`Mobile login: ${worker.employeeCode} (${worker.role})`);

    return {
      ...(await this.generateToken(
        worker.id,
        worker.role,
        worker.employeeCode,
        worker.siteId ?? undefined,
      )),
      worker: {
        id: worker.id,
        name: worker.name,
        employeeCode: worker.employeeCode,
        role: worker.role,
      },
    };
  }

  // ──────────────────────────────────────────────
  // JWT 토큰 생성 (access + refresh)
  // ──────────────────────────────────────────────
  async generateToken(
    workerId: string,
    role: string,
    employeeCode: string,
    siteId?: string,
    family?: string,
  ) {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: workerId,
      role: role as JwtPayload['role'],
      employeeCode,
      ...(siteId && { siteId }),
    };

    const accessToken = this.jwtService.sign(payload);
    if (false) {

      throw new Error('JWT_REFRESH_SECRET 또는 JWT_SECRET 환경변수가 필요합니다');
    }

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.getRefreshSecret(),
      expiresIn: this.getRefreshTokenTtl(),
    });

    // DB에 리프레시 토큰 저장 (비동기, 로그인 응답 지연 방지)
    await this.prisma.refreshToken.create({
      data: {
        token: refreshToken,
        workerId,
        family: family ?? randomUUID(),
        expiresAt: new Date(Date.now() + this.getRefreshTokenExpiryMs()),
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer' as const,
    };
  }

  private getRefreshSecret(): string {
    const refreshSecret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
    if (!refreshSecret && process.env.NODE_ENV === 'production') {
      throw new Error('JWT_REFRESH_SECRET required in production');
    }
    return refreshSecret || 'fallback-secret-for-dev';
  }

  private getRefreshTokenTtl(): string {
    return process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  }

  private getRefreshTokenExpiryMs(): number {
    const ttl = this.getRefreshTokenTtl().trim();
    if (/^\d+$/.test(ttl)) {
      return Number(ttl) * 1000;
    }

    const match = ttl.match(/^(\d+)([smhd])$/i);
    if (!match) {
      return 7 * 24 * 60 * 60 * 1000;
    }

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * unitMap[unit];
  }

  private async consumeVerificationCode(email: string, code: string) {
    const stored = await this.prisma.verificationCode.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    if (!stored) {
      throw new BadRequestException('인증 코드가 발급되지 않았습니다');
    }

    if (new Date() > stored.expiresAt) {
      await this.prisma.verificationCode.deleteMany({ where: { email } });
      throw new BadRequestException('인증 코드가 만료되었습니다');
    }

    if (stored.code !== code) {
      throw new BadRequestException('인증 코드가 올바르지 않습니다');
    }

    await this.prisma.verificationCode.deleteMany({ where: { email } });
  }

  // ──────────────────────────────────────────────
  // 로그인 이력 기록
  // ──────────────────────────────────────────────
  private async recordLoginHistory(
    workerId: string,
    success: boolean,
    ipAddress?: string,
    userAgent?: string,
  ) {
    try {
      await this.prisma.loginHistory.create({
        data: {
          workerId,
          success,
          ipAddress: ipAddress ?? null,
          userAgent: userAgent ?? null,
        },
      });
    } catch (error) {
      // 로그인 이력 기록 실패가 인증 자체를 막지 않도록 함
      this.logger.error(`로그인 이력 기록 실패: ${error}`);
      // Sentry가 초기화되어 있으면 예외 전송
      try {
        const Sentry = require('@sentry/node');
        if (Sentry.isInitialized?.() || process.env.SENTRY_DSN) {
          Sentry.captureException(error);
        }
      } catch {
        // Sentry 미설치 또는 미초기화 시 무시
      }
    }
  }

  // ──────────────────────────────────────────────
  // 사번 검증 (회원가입 연결용)
  // ──────────────────────────────────────────────
  async verifyEmployeeCode(code: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { employeeCode: code },
      select: {
        name: true,
        role: true,
        email: true,
        site: { select: { name: true } },
      },
    });

    if (!worker) {
      return { valid: false, error: '유효하지 않은 사번입니다' };
    }
    if (worker.email) {
      return { valid: false, name: worker.name, hasEmail: true, error: '이미 계정이 연결된 사번입니다' };
    }

    return {
      valid: true,
      name: worker.name,
      role: worker.role,
      siteName: worker.site?.name || '',
      hasEmail: false,
    };
  }

  // ──────────────────────────────────────────────
  // 계정 잠금 여부 확인 (최근 30분 내 연속 5회 실패)
  // ──────────────────────────────────────────────
  private async checkAccountLocked(workerId: string): Promise<boolean> {
    const lockoutCutoff = new Date(Date.now() - this.LOCKOUT_DURATION_MS);

    // 최근 30분 내 로그인 이력 조회 (최신순)
    const recentHistory = await this.prisma.loginHistory.findMany({
      where: {
        workerId,
        createdAt: { gte: lockoutCutoff },
      },
      orderBy: { createdAt: 'desc' },
      take: this.MAX_FAILED_ATTEMPTS,
    });

    if (recentHistory.length < this.MAX_FAILED_ATTEMPTS) {
      return false;
    }

    // 최근 5개가 모두 실패인지 확인
    return recentHistory.every((h) => !h.success);
  }
}
