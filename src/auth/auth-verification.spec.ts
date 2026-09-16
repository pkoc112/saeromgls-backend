import { BadRequestException, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * 인증코드 이메일 정규화 · 빈 값 거부
 * - where: { email: undefined } 가 Prisma 에 전달되면 deleteMany 가 전체 삭제가 되므로
 *   빈 값은 DB 접근 전에 반드시 400 으로 끊겨야 한다.
 * - 발급(sendVerificationCode) / 확인(verifyEmail) / 재설정(resetPassword) 모두
 *   trim + 소문자 정규화된 같은 키를 써야 2단계에서 '계정 없음'이 나지 않는다.
 */
describe('Auth verification email normalization', () => {
  let prisma: any;
  let mail: any;
  let service: AuthService;
  const NORMALIZED = 'user@example.com';
  const MIXED = '  User@Example.COM ';
  const VALID_CODE = { id: 'code-1', code: '123456', expiresAt: new Date(Date.now() + 60_000) };
  const EMPTY_INPUTS: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
  ];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    prisma = {
      verificationCode: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'code-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      worker: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    mail = { isConfigured: jest.fn().mockReturnValue(true), sendMail: jest.fn().mockResolvedValue({ ok: true, id: 'mail-1' }) };
    service = new AuthService(prisma, {} as any, mail);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sendVerificationCode', () => {
    it('stores, sends and deletes with the trimmed lower-cased email', async () => {
      await service.sendVerificationCode(MIXED);
      expect(prisma.verificationCode.deleteMany).toHaveBeenCalledWith({ where: { email: NORMALIZED } });
      expect(prisma.verificationCode.create.mock.calls[0][0].data.email).toBe(NORMALIZED);
      expect(mail.sendMail.mock.calls[0][0].to).toEqual([NORMALIZED]);
    });

    it.each(EMPTY_INPUTS)('rejects %s before touching the code table', async (_label, input) => {
      await expect(service.sendVerificationCode(input as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.verificationCode.deleteMany).not.toHaveBeenCalled();
      expect(prisma.verificationCode.create).not.toHaveBeenCalled();
      expect(mail.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('looks up, deletes and marks the worker with the normalized email', async () => {
      prisma.verificationCode.findFirst.mockResolvedValue(VALID_CODE);
      prisma.worker.findUnique.mockResolvedValue({ id: 'worker-1' });
      const result = await service.verifyEmail(MIXED, '123456');
      expect(result).toMatchObject({ verified: true });
      expect(prisma.verificationCode.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: NORMALIZED } }));
      expect(prisma.verificationCode.deleteMany).toHaveBeenCalledWith({ where: { email: NORMALIZED } });
      expect(prisma.worker.findUnique).toHaveBeenCalledWith({ where: { email: NORMALIZED } });
    });

    it('deletes an expired code only for the normalized email', async () => {
      prisma.verificationCode.findFirst.mockResolvedValue({ ...VALID_CODE, expiresAt: new Date(Date.now() - 1) });
      await expect(service.verifyEmail(MIXED, '123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.verificationCode.deleteMany).toHaveBeenCalledWith({ where: { email: NORMALIZED } });
    });

    it.each(EMPTY_INPUTS)('rejects %s before querying', async (_label, input) => {
      await expect(service.verifyEmail(input as any, '123456')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.verificationCode.findFirst).not.toHaveBeenCalled();
      expect(prisma.verificationCode.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('uses the normalized email for the account lookup and code consumption', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'worker-1', employeeCode: 'WRK101' });
      prisma.verificationCode.findFirst.mockResolvedValue(VALID_CODE);
      await service.resetPassword(MIXED, 'WRK101', '123456', 'newpass1234');
      expect(prisma.worker.findUnique).toHaveBeenCalledWith({ where: { email: NORMALIZED } });
      expect(prisma.verificationCode.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: NORMALIZED } }));
      expect(prisma.verificationCode.deleteMany).toHaveBeenCalledWith({ where: { email: NORMALIZED } });
    });

    it.each(EMPTY_INPUTS)('rejects %s before the account lookup', async (_label, input) => {
      await expect(service.resetPassword(input as any, 'WRK101', '123456', 'newpass1234')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(prisma.verificationCode.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('never passes a non-string email to any verification-code query', async () => {
    prisma.verificationCode.findFirst.mockResolvedValue(VALID_CODE);
    await service.sendVerificationCode(MIXED);
    await service.verifyEmail(MIXED, '123456');
    for (const method of ['deleteMany', 'create', 'findFirst'] as const) {
      expect(prisma.verificationCode[method]).toHaveBeenCalled();
      for (const [arg] of prisma.verificationCode[method].mock.calls) {
        expect(typeof (arg.where?.email ?? arg.data?.email)).toBe('string');
      }
    }
  });
});
