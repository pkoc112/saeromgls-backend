import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { randomUUID, randomBytes, randomInt, createHash, createHmac } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { NotificationsService } from '../common/notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { RegisterDto } from './dto/register.dto';
import { encryptWorkerPII, decryptWorkerPII } from '../common/utils/pii.util';
import { maskEmail } from '../common/utils/pii-mask';
import { resolveSiteId } from '../common/utils/site-scope';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** 로그인 실패 시 잠금 기준 */
  private readonly MAX_FAILED_ATTEMPTS = 5;
  /** 잠금 지속 시간 (밀리초, 30분) */
  private readonly LOCKOUT_DURATION_MS = 30 * 60 * 1000;

  /** 메모리 기반 이메일 인증 코드 저장소 (email -> { code, expiresAt }) */
  // 검증코드: DB 저장 (서버리스 호환 — 인메모리 Map은 요청마다 초기화될 수 있음)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly notifications: NotificationsService,
  ) {
    // JWT 시크릿 강제 검증 (프로덕션 + 길이)
    const jwtSecret = process.env.JWT_SECRET;
    if (process.env.NODE_ENV === 'production') {
      if (!jwtSecret) {
        throw new Error('JWT_SECRET required in production');
      }
      if (jwtSecret.length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters in production');
      }
    } else if (jwtSecret && jwtSecret.length < 16) {
      this.logger.warn('JWT_SECRET이 너무 짧습니다(16자 미만). 개발용으로만 사용하세요.');
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

      // UserConsent 기록 (국외이전 동의도 함께 기록 — 수신 시점에만 추가)
      const consentRows: { workerId: string; consentType: string; version: string }[] = [
        { workerId: worker!.id, consentType: 'TOS', version: '1.0' },
        { workerId: worker!.id, consentType: 'PRIVACY', version: '1.0' },
      ];
      if (dto.agreedToOverseas) {
        consentRows.push({ workerId: worker!.id, consentType: 'OVERSEAS_TRANSFER', version: '1.0' });
      }
      await this.prisma.userConsent.createMany({ data: consentRows });

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

    // P1-18: 작업자 + UserConsent 트랜잭션으로 묶기 (consent 없는 계정 방지)
    const encryptedData = encryptWorkerPII({ phone: dto.phone });
    const worker = await this.prisma.$transaction(async (tx) => {
      const w = await tx.worker.create({
        data: {
          name: dto.name || dto.email.split('@')[0],
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
      const consentRows: { workerId: string; consentType: string; version: string }[] = [
        { workerId: w.id, consentType: 'TOS', version: '1.0' },
        { workerId: w.id, consentType: 'PRIVACY', version: '1.0' },
      ];
      if (dto.agreedToOverseas) {
        consentRows.push({ workerId: w.id, consentType: 'OVERSEAS_TRANSFER', version: '1.0' });
      }
      await tx.userConsent.createMany({ data: consentRows });
      return w;
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

    // ★ Enumeration 방어: 이메일 미존재/비밀번호 미설정/비밀번호 오류 모두
    // 동일한 메시지로 통일하여 계정 존재 여부를 알 수 없게 함.
    const GENERIC_AUTH_FAILURE = '이메일 또는 비밀번호가 올바르지 않습니다';

    if (!worker) {
      throw new UnauthorizedException(GENERIC_AUTH_FAILURE);
    }
    if (!worker.passwordHash) {
      // 비밀번호 미설정도 동일 메시지 (직접 안내는 비밀번호 재설정 화면에서)
      throw new UnauthorizedException(GENERIC_AUTH_FAILURE);
    }

    // 계정 잠금 확인 — 잠금 안내는 보안 vs UX 트레이드오프상 노출 유지(편의)
    const isLocked = await this.checkAccountLocked(worker.id);
    if (isLocked) {
      throw new UnauthorizedException(
        '로그인 시도가 너무 많습니다. 30분 후에 다시 시도해 주세요.',
      );
    }

    if (worker.status !== 'ACTIVE') {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      // 비활성 계정도 동일 메시지로 enumeration 방어
      throw new UnauthorizedException(GENERIC_AUTH_FAILURE);
    }

    // WORKER 역할은 웹 로그인 차단 — 명확한 안내 유지 (UX 우선, 이미 비밀번호 통과 가정)
    const isValid = await bcrypt.compare(password, worker.passwordHash);
    if (!isValid) {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException(GENERIC_AUTH_FAILURE);
    }

    if (worker.role === 'WORKER') {
      await this.recordLoginHistory(worker.id, false, ipAddress, userAgent);
      throw new UnauthorizedException(
        '작업자 계정은 모바일 앱에서만 사용 가능합니다. 웹 접근이 필요하면 관리자에게 역할 변경을 요청하세요.',
      );
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
        // 2026-06-04: graceful rotation — 동시 요청(race) 구분.
        // 모바일이 여러 화면에서 동시에 401 → 거의 동시에 같은 refresh token으로
        // refresh 시도. single-flight가 있어도 화면 포커스/마운트 타이밍에 따라
        // 짧은 간격으로 2번 올 수 있음. revoke된 지 GRACE_MS 이내면 정상적인
        // 동시 요청으로 보고 family 무효화(강제 로그아웃) 대신 새 토큰을 발급한다.
        // 진짜 탈취(오래 전 revoke된 토큰 재사용)만 family 무효화.
        const GRACE_MS = 90 * 1000; // 90초
        const revokedAgo = Date.now() - storedToken.revokedAt.getTime();
        if (revokedAgo <= GRACE_MS) {
          // 동시 요청 — family의 가장 최근 유효 토큰 발급 흐름으로 진행.
          // (아래 일반 흐름과 동일하게 새 토큰 생성. 이 토큰은 이미 revoke됐으므로
          //  추가 revoke 없이 바로 새 토큰만 발급)
          const worker = await this.prisma.worker.findUnique({
            where: { id: payload.sub },
            select: { id: true, role: true, employeeCode: true, status: true, siteId: true },
          });
          if (!worker || worker.status !== 'ACTIVE') {
            throw new UnauthorizedException('유효하지 않은 토큰입니다');
          }
          const token = await this.generateToken(
            worker.id, worker.role, worker.employeeCode,
            worker.siteId ?? undefined, storedToken.family,
          );
          this.logger.log(`Graceful rotation (동시 요청, ${Math.round(revokedAgo / 1000)}s ago) — family ${storedToken.family.slice(0, 8)}`);
          return {
            access_token: token.accessToken,
            refresh_token: token.refreshToken,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
          };
        }
        // GRACE 초과 = 진짜 재사용 의심 → 패밀리 전체 무효화 (탈취 방어)
        await this.prisma.refreshToken.updateMany({
          where: { family: storedToken.family, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.warn(`Refresh token replay detected! Family ${storedToken.family} revoked. (revoked ${Math.round(revokedAgo / 1000)}s ago)`);
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
      if (err instanceof Error && ['TokenExpiredError', 'JsonWebTokenError', 'NotBeforeError'].includes(err.name)) {
        throw new UnauthorizedException('리프레시 토큰이 만료되었거나 유효하지 않습니다');
      }
      // Database/infrastructure failures are not evidence of an expired session.
      throw err;
    }
  }

  // ──────────────────────────────────────────────
  // 비밀번호 재설정
  // ──────────────────────────────────────────────
  async resetPassword(
    rawEmail: string,
    employeeCode: string,
    verificationCode: string,
    newPassword: string,
  ) {
    // 인증코드 발급 시와 동일하게 정규화 — 대소문자 차이로 '계정 없음'이 나지 않도록
    const email = this.normalizeVerificationEmail(rawEmail);
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
  // 관리자 초대 / 첫 로그인 (P0: PIN 평문 수동전달 대체)
  // ──────────────────────────────────────────────

  private hashInviteToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * 관리자/반장 초대 생성 — 일회용 토큰 링크 반환 (평문 토큰은 1회만, DB엔 해시만)
   * 권한: MASTER=임의 사업장, ADMIN=자기 사업장만. 대상 역할은 ADMIN/SUPERVISOR만(권한상승 방지).
   */
  async createAdminInvite(
    dto: { email: string; name: string; role?: string; siteId?: string },
    inviter: JwtPayload,
  ) {
    const email = dto.email?.trim().toLowerCase();
    const name = dto.name?.trim();
    if (!email || !name) throw new BadRequestException('이메일과 이름은 필수입니다');

    const role = (dto.role || 'ADMIN').toUpperCase();
    if (!['ADMIN', 'SUPERVISOR'].includes(role)) {
      throw new BadRequestException('초대 가능한 역할은 ADMIN 또는 SUPERVISOR입니다');
    }

    let siteId: string | null;
    if (inviter.role === 'MASTER') {
      siteId = dto.siteId ?? null;
    } else if (inviter.role === 'ADMIN') {
      if (dto.siteId && dto.siteId !== inviter.siteId) {
        throw new BadRequestException('자신의 사업장으로만 초대할 수 있습니다');
      }
      siteId = inviter.siteId ?? null;
    } else {
      throw new BadRequestException('관리자 초대 권한이 없습니다');
    }

    const existing = await this.prisma.worker.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('이미 가입된 이메일입니다');

    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashInviteToken(token);
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72h

    // 같은 이메일의 미수락 초대는 정리 (재초대 시 최신만 유효)
    await this.prisma.adminInvite.deleteMany({ where: { email, acceptedAt: null } });
    await this.prisma.adminInvite.create({
      data: { email, name, role, siteId, tokenHash, expiresAt, createdBy: inviter.sub },
    });

    // 감사 로그 (DB) — 누가 어느 사업장에 어떤 역할을 초대했는지 추적 (개통 분석 P2)
    try {
      await this.prisma.adminActivityLog.create({
        data: {
          actorWorkerId: inviter.sub,
          actionType: 'ADMIN_INVITE',
          targetType: 'WORKER',
          targetId: email,
          metadata: JSON.stringify({ email, name, role, siteId }),
        },
      });
    } catch (err) {
      this.logger.warn(`초대 감사로그 기록 실패: ${err}`);
    }

    const baseUrl = process.env.WEB_BASE_URL || 'https://sae-work.com';
    const inviteUrl = `${baseUrl}/accept-invite?token=${token}`;

    // 초대 메일 자동 발송 (Resend) — 실패해도 inviteUrl은 반환되어 수동 전달 가능 (개통 분석 P1-7)
    let emailSent = false;
    if (this.notifications.isConfigured()) {
      try {
        const roleKo = role === 'SUPERVISOR' ? '현장 반장' : '관리자';
        const safeName = name.replace(/[<>&"]/g, (c) =>
          ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
        );
        const delivery = await this.notifications.sendMail({
          to: [email],
          subject: `[새롬 GLS] ${roleKo} 초대 — 계정 설정을 완료해주세요`,
          html: `
            <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
              <h2 style="color:#0F172A;margin:0 0 8px;">새롬 GLS ${roleKo} 초대</h2>
              <p style="color:#475569;font-size:14px;line-height:1.6;">
                ${safeName}님, 새롬 GLS 작업현황 공유 시스템 <b>${roleKo}</b>로 초대되었습니다.<br>
                아래 버튼을 눌러 비밀번호를 설정하면 계정이 활성화됩니다.
              </p>
              <a href="${inviteUrl}" style="display:inline-block;margin:18px 0;background:#2C6FB0;color:#fff;
                text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;font-size:15px;">
                계정 설정하기
              </a>
              <p style="color:#94A3B8;font-size:12px;line-height:1.6;">
                이 링크는 <b>72시간</b> 후 만료됩니다. 버튼이 안 되면 아래 주소를 복사해 접속하세요:<br>
                <span style="color:#64748B;word-break:break-all;">${inviteUrl}</span>
              </p>
              <p style="color:#CBD5E1;font-size:11px;margin-top:24px;text-align:center;">
                본 메일을 요청하지 않으셨다면 무시하셔도 됩니다. — 새롬 GLS
              </p>
            </div>
          `,
        });
        emailSent = delivery.ok;
      } catch (err) {
        this.logger.error(`초대 메일 예외: ${err}`);
      }
    } else {
      this.logger.warn('메일 미설정 — 초대 링크를 직접 전달해야 합니다');
    }

    this.logger.log(`Admin invite created: ${maskEmail(email)} (${role})`);
    return { inviteUrl, email, name, role, expiresAt, emailSent };
  }

  /** 초대 토큰 조회 (수락 페이지용 — 만료/사용 검증) */
  async getAdminInvite(token: string) {
    if (!token) throw new BadRequestException('토큰이 필요합니다');
    const invite = await this.prisma.adminInvite.findFirst({
      where: { tokenHash: this.hashInviteToken(token) },
    });
    if (!invite) throw new NotFoundException('유효하지 않은 초대입니다');
    if (invite.acceptedAt) throw new BadRequestException('이미 사용된 초대입니다');
    if (invite.expiresAt < new Date()) throw new BadRequestException('만료된 초대입니다');
    let siteName: string | null = null;
    if (invite.siteId) {
      const site = await this.prisma.site.findUnique({
        where: { id: invite.siteId },
        select: { name: true },
      });
      siteName = site?.name ?? null;
    }
    return { email: invite.email, name: invite.name, role: invite.role, siteName };
  }

  /** 초대 수락 — 비밀번호 설정 → 계정 생성 + 로그인 토큰 반환 */
  async acceptAdminInvite(token: string, password: string) {
    if (!token || !password) throw new BadRequestException('토큰과 비밀번호가 필요합니다');
    if (password.length < 8) throw new BadRequestException('비밀번호는 8자 이상이어야 합니다');

    const invite = await this.prisma.adminInvite.findFirst({
      where: { tokenHash: this.hashInviteToken(token) },
    });
    if (!invite) throw new NotFoundException('유효하지 않은 초대입니다');
    if (invite.acceptedAt) throw new BadRequestException('이미 사용된 초대입니다');
    if (invite.expiresAt < new Date()) throw new BadRequestException('만료된 초대입니다');

    const dup = await this.prisma.worker.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('이미 가입된 이메일입니다');

    const passwordHash = await bcrypt.hash(password, 10);
    // pin은 스키마상 필수지만 관리자는 PIN 로그인 미사용 → 랜덤 미사용값 해시
    const pinHash = await bcrypt.hash(randomBytes(8).toString('hex'), 10);

    // 고유 사번 생성 (충돌 시 재시도)
    const prefix = invite.role === 'SUPERVISOR' ? 'SUP' : 'ADM';
    let employeeCode = '';
    for (let i = 0; i < 5; i++) {
      const cand = `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
        .toString(36)
        .slice(2, 5)
        .toUpperCase()}`;
      const ex = await this.prisma.worker.findUnique({
        where: { employeeCode: cand },
        select: { id: true },
      });
      if (!ex) {
        employeeCode = cand;
        break;
      }
    }
    if (!employeeCode) throw new BadRequestException('사번 생성 실패 — 다시 시도해주세요');

    const worker = await this.prisma.worker.create({
      data: {
        name: invite.name,
        email: invite.email,
        employeeCode,
        pin: pinHash,
        passwordHash,
        role: invite.role,
        status: 'ACTIVE',
        emailVerified: true,
        ...(invite.siteId && { siteId: invite.siteId }),
      },
      select: {
        id: true,
        name: true,
        role: true,
        email: true,
        employeeCode: true,
        siteId: true,
      },
    });

    await this.prisma.adminInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    const tok = await this.generateToken(
      worker.id,
      worker.role,
      worker.employeeCode,
      worker.siteId ?? undefined,
    );
    this.logger.log(
      `Admin invite accepted: ${maskEmail(invite.email)} → ${worker.employeeCode}`,
    );
    return {
      access_token: tok.accessToken,
      refresh_token: tok.refreshToken,
      user: {
        id: worker.id,
        name: worker.name,
        role: worker.role.toLowerCase(),
        email: worker.email,
        employeeCode: worker.employeeCode,
        siteId: worker.siteId,
      },
    };
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
  async sendVerificationCode(rawEmail: string) {
    // ★ 정규화·빈 값 거부를 가장 먼저 — email이 undefined면 아래 deleteMany가 조건 없는 전체 삭제가 됨
    const email = this.normalizeVerificationEmail(rawEmail);
    if (!this.notifications.isConfigured()) {
      throw new ServiceUnavailableException('메일 발송이 설정되지 않았습니다. 관리자에게 문의해주세요');
    }
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10분

    // 기존 코드 삭제 후 새로 저장
    await this.prisma.verificationCode.deleteMany({ where: { email } });
    const stored = await this.prisma.verificationCode.create({
      data: { email, code, expiresAt },
    });

    // ── 이메일 발송 (Resend) ──────────────────────────────────
    let emailSent = false;
    try {
      const delivery = await this.notifications.sendMail({
        to: [email],
        subject: '[새롬 GLS] 이메일 인증 코드',
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

      emailSent = delivery.ok;
    } catch {
      this.logger.error('인증 메일 발송 중 예외가 발생했습니다');
    }
    if (!emailSent) {
      // 동시 재요청으로 발급된 다른 코드는 삭제하지 않는다.
      try {
        await this.prisma.verificationCode.deleteMany({ where: { id: stored.id } });
      } catch {
        this.logger.error('미발송 인증 코드 정리 실패');
      }
      throw new ServiceUnavailableException('인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해주세요');
    }

    return {
      message: '인증 코드가 발송되었습니다',
      // ★ 코드는 응답 body에 절대 포함하지 않음 (preview/staging 노출 위험).
    };
  }

  // ──────────────────────────────────────────────
  // 이메일 인증 코드 확인
  // ──────────────────────────────────────────────
  async verifyEmail(rawEmail: string, code: string) {
    const email = this.normalizeVerificationEmail(rawEmail);
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
        // ★ 사업장 격리: 웹 admin 로그인에서 siteId 제공 (useSiteFilter 등이 사용)
        siteId: worker.siteId ?? null,
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
        // ★ 사업장 격리: 모바일에서 siteId로 자기 사업장 작업만 조회
        siteId: worker.siteId ?? null,
      },
    };
  }

  // ──────────────────────────────────────────────
  // 키오스크 관리 동작 PIN 확인 (#26)
  // 로그인된 태블릿(JWT)에서 로그아웃/캐시 초기화/기록 삭제 직전에
  // "호출자 사이트 내 관리자(ADMIN/SUPERVISOR/MASTER) 중 하나의 PIN"과 대조.
  // 로그인 토큰은 재발급하지 않는다. 기록 수정에는 해당 기록에만 유효한 10분 승인값을 반환한다.
  //
  // 범위: resolveSiteId(user) → MASTER는 전체, 그 외 JWT siteId 강제.
  //   siteId 필터는 OR:[{siteId},{siteId:null}] 패턴(NULL 백필 전 기존 관리자 보호)
  //   + MASTER 계정은 siteId 무관 포함. 태블릿 계정(<코드>-KIOSK, SUPERVISOR)도 포함 —
  //   초대 관리자는 랜덤 PIN이라 신규 센터에서 실사용 PIN은 태블릿 계정뿐일 수 있음.
  // 잠금: 시도는 호출 계정(user.sub) 기준 LoginHistory에 기록 → 기존 5회/30분 규칙 재사용.
  // ──────────────────────────────────────────────
  async verifyAdminPin(
    user: JwtPayload,
    pin: string,
    ipAddress?: string,
    userAgent?: string,
    editWorkItemId?: string,
  ) {
    const PIN_MISMATCH = '관리자 PIN이 올바르지 않습니다';
    // LoginHistory에서 로그인 시도와 구분 가능하도록 UA에 태그
    const gateUserAgent = `pin-gate/${userAgent ?? ''}`;

    const isLocked = await this.checkAccountLocked(user.sub);
    if (isLocked) {
      throw new UnauthorizedException({
        message: 'PIN 입력 시도가 너무 많습니다. 30분 후에 다시 시도해 주세요.',
        error: 'PIN_LOCKED',
      });
    }

    // MASTER → undefined(전체), 그 외 → 자기 siteId(미배정이면 403)
    const siteId = resolveSiteId(user);

    const candidates = await this.prisma.worker.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: ['MASTER', 'ADMIN', 'SUPERVISOR'] },
        ...(siteId
          ? { OR: [{ siteId }, { siteId: null }, { role: 'MASTER' }] }
          : {}),
      },
      select: { id: true, name: true, role: true, pin: true },
      // 사이트 관리자(ADMIN) → MASTER → SUPERVISOR 순으로 대조 (알파벳 순, 조기 종료용)
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      take: 100,
    });

    let matched: { id: string; name: string; role: string } | null = null;
    for (const c of candidates) {
      if (!c.pin) continue;
      let ok = false;
      try {
        ok = await bcrypt.compare(pin, c.pin);
      } catch {
        // 해시 형식이 아닌 잔존 데이터 등 — 불일치로 간주
        ok = false;
      }
      if (ok) {
        matched = { id: c.id, name: c.name, role: c.role };
        break;
      }
    }

    if (!matched) {
      await this.recordLoginHistory(user.sub, false, ipAddress, gateUserAgent);
      throw new UnauthorizedException({ message: PIN_MISMATCH, error: 'PIN_INVALID' });
    }

    await this.recordLoginHistory(user.sub, true, ipAddress, gateUserAgent);
    this.logger.log(
      `PIN gate passed: caller=${user.employeeCode} by ${matched.role}(${matched.id.slice(0, 8)})`,
    );

    const approval = editWorkItemId ? {
      adminApproval: await this.jwtService.signAsync({
        sub: user.sub,
        siteId: user.siteId ?? null,
        workItemId: editWorkItemId,
        actorWorkerId: matched.id,
      }, {
        secret: this.mobileEditApprovalSecret(),
        algorithm: 'HS256',
        audience: 'mobile-work-item-edit',
        expiresIn: '10m',
      }),
    } : {};
    return { ok: true, role: matched.role, name: matched.name, ...approval };
  }

  // Separate signing key: an edit approval must never authenticate as an access/refresh token.
  private mobileEditApprovalSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ServiceUnavailableException('관리자 확인 설정을 확인해주세요');
    return createHmac('sha256', secret).update('mobile-work-item-edit:v1').digest('hex');
  }

  async verifyMobileEditApproval(user: JwtPayload, workItemId: string, approval?: string): Promise<string> {
    const denied = () => new ForbiddenException('관리자 확인이 없거나 만료되었습니다. PIN을 다시 확인해주세요');
    if (!approval) throw denied();
    let payload: { sub: string; siteId: string | null; workItemId: string; actorWorkerId: string };
    try {
      payload = await this.jwtService.verifyAsync(approval, {
        secret: this.mobileEditApprovalSecret(), algorithms: ['HS256'], audience: 'mobile-work-item-edit',
      });
    } catch {
      throw denied();
    }
    if (payload.sub !== user.sub || payload.siteId !== (user.siteId ?? null) || payload.workItemId !== workItemId) {
      throw denied();
    }
    const actor = await this.prisma.worker.findUnique({ where: { id: payload.actorWorkerId } });
    const role = actor?.role?.toLowerCase() ?? '';
    const siteId = resolveSiteId(user);
    if (!actor || actor.status !== 'ACTIVE' || !['master', 'admin', 'supervisor'].includes(role) ||
      (siteId && actor.siteId && actor.siteId !== siteId && role !== 'master')) {
      throw denied();
    }
    return actor.id;
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
    if (!refreshSecret) {
      throw new Error(
        'JWT_REFRESH_SECRET or JWT_SECRET is required (no fallback allowed)',
      );
    }
    if (process.env.NODE_ENV === 'production' && refreshSecret.length < 32) {
      throw new Error('Refresh secret must be at least 32 characters in production');
    }
    return refreshSecret;
  }

  private getRefreshTokenTtl(): string {
    // 2026-05-14 (Codex P2): 7d → 30d.
    // 기존 rotation 로직(refresh 사용 시마다 새 토큰 발급)이 이미 구현되어 있어
    // 활성 사용자는 사실상 영구 로그인 효과. 7일은 키오스크 장시간 운영에 부족.
    return process.env.JWT_REFRESH_EXPIRES_IN || '30d';
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

  /**
   * 인증코드 테이블 키로 쓰는 이메일 정규화 (trim + 소문자).
   * ★ 빈 값이면 즉시 거부 — where: { email: undefined }는 Prisma에서 '조건 없음'으로 해석되어
   *   deleteMany가 발급된 인증코드 전체를 지운다. 저장/조회/삭제 모두 이 값을 써야 한다.
   */
  private normalizeVerificationEmail(email: unknown): string {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalized) {
      throw new BadRequestException('이메일을 입력해 주세요');
    }
    return normalized;
  }

  private async consumeVerificationCode(rawEmail: string, code: string) {
    const email = this.normalizeVerificationEmail(rawEmail);
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
