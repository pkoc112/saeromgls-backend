import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 관리자 로그인: 사번 + PIN 검증
   * ADMIN 또는 SUPERVISOR 역할만 허용
   */
  async validateAdmin(employeeCode: string, pin: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { employeeCode },
      select: { id: true, name: true, employeeCode: true, pin: true, role: true, status: true },
    });

    if (!worker) {
      throw new UnauthorizedException('사번 또는 PIN이 올바르지 않습니다');
    }

    if (worker.status !== 'ACTIVE') {
      throw new UnauthorizedException('비활성화된 계정입니다');
    }

    // 관리자/반장만 웹 대시보드 로그인 가능
    if (worker.role !== 'ADMIN' && worker.role !== 'SUPERVISOR') {
      throw new UnauthorizedException('관리자 또는 반장만 로그인할 수 있습니다');
    }

    const isPinValid = await bcrypt.compare(pin, worker.pin);
    if (!isPinValid) {
      throw new UnauthorizedException('사번 또는 PIN이 올바르지 않습니다');
    }

    this.logger.log(`Admin login: ${worker.employeeCode} (${worker.role})`);

    const token = this.generateToken(worker.id, worker.role, worker.employeeCode);
    return {
      access_token: token.accessToken,
      user: {
        id: worker.id,
        name: worker.name,
        role: worker.role.toLowerCase(),
        email: worker.employeeCode,
      },
    };
  }

  /**
   * 모바일 PIN 로그인: 작업자 ID + PIN 검증
   * 모든 활성 작업자 로그인 가능
   */
  async validatePin(workerId: string, pin: string) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, name: true, employeeCode: true, pin: true, role: true, status: true },
    });

    if (!worker) {
      throw new UnauthorizedException('작업자를 찾을 수 없습니다');
    }

    if (worker.status !== 'ACTIVE') {
      throw new UnauthorizedException('비활성화된 계정입니다');
    }

    const isPinValid = await bcrypt.compare(pin, worker.pin);
    if (!isPinValid) {
      throw new UnauthorizedException('PIN이 올바르지 않습니다');
    }

    this.logger.log(`Mobile login: ${worker.employeeCode} (${worker.role})`);

    return {
      ...this.generateToken(worker.id, worker.role, worker.employeeCode),
      worker: {
        id: worker.id,
        name: worker.name,
        employeeCode: worker.employeeCode,
        role: worker.role,
      },
    };
  }

  /**
   * JWT 토큰 생성
   */
  private generateToken(workerId: string, role: string, employeeCode: string) {
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: workerId,
      role: role as JwtPayload['role'],
      employeeCode,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      tokenType: 'Bearer' as const,
    };
  }
}
