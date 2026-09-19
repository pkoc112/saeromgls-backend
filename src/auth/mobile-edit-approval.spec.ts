import { ForbiddenException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { WorkItemsController } from '../work-items/work-items.controller';
import { UpdateWorkItemMobileDto } from '../work-items/dto/update-work-item-mobile.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const workId = '00000000-0000-4000-8000-000000000001';
const user: JwtPayload = { sub: 'tablet-a', siteId: 'site-a', role: 'SUPERVISOR', employeeCode: 'A-KIOSK' };
const secret = 'test-only-mobile-edit-approval-secret-32-chars';
const originalSecret = process.env.JWT_SECRET;

describe('mobile record edit approval', () => {
  let service: AuthService;
  let jwt: JwtService;
  let prisma: any;
  let actor: any;
  let workItems: any;
  let controller: WorkItemsController;

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    actor = { id: 'admin-a', siteId: 'site-a', role: 'ADMIN', status: 'ACTIVE', name: '관리자', pin: bcrypt.hashSync('123456', 4) };
    prisma = { worker: { findMany: jest.fn(async () => [actor]), findUnique: jest.fn(async () => actor) } };
    jwt = new JwtService({ secret });
    service = new AuthService(prisma, jwt, {} as any);
    jest.spyOn(service as any, 'checkAccountLocked').mockResolvedValue(false);
    jest.spyOn(service as any, 'recordLoginHistory').mockResolvedValue(undefined);
    workItems = { updateFromMobile: jest.fn().mockResolvedValue({ id: workId }) };
    controller = new WorkItemsController(workItems, service);
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });
  const issue = async (auth: AuthService) => (await auth.verifyAdminPin(user, '123456', undefined, undefined, workId)).adminApproval!;

  it('issues a scoped approval only after a correct PIN', async () => {
    await expect(service.verifyAdminPin(user, 'wrong', undefined, undefined, workId)).rejects.toBeInstanceOf(UnauthorizedException);
    const token = await issue(service);
    await expect(service.verifyMobileEditApproval(user, workId, token)).resolves.toBe('admin-a');
    const payload = jwt.decode(token);
    expect(payload.exp - payload.iat).toBe(600);
    expect(payload).not.toHaveProperty('pin');
  });
  it('keeps non-edit PIN callers compatible without issuing an edit credential', async () => {
    expect(await service.verifyAdminPin(user, '123456')).toEqual({ ok: true, name: '관리자', role: 'ADMIN' });
  });
  it.each([undefined, '', 'not-a-token'])('refuses missing or malformed approval %s before any mutation', async (adminApproval) => {
    await expect(controller.updateWorkItemMobile(workId, { quantity: 9, adminApproval }, { headers: {}, socket: {} } as any, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(workItems.updateFromMobile).not.toHaveBeenCalled();
  });
  it('rejects another tablet, site, or record even with a valid approval', async () => {
    const token = await issue(service);
    for (const [caller, id] of [[{ ...user, sub: 'tablet-b' }, workId], [{ ...user, siteId: 'site-b' }, workId], [user, 'other-work']] as const) {
      await expect(service.verifyMobileEditApproval(caller, id, token)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it('rejects tampered and expired approvals', async () => {
    const token = await issue(service);
    await expect(service.verifyMobileEditApproval(user, workId, `${token.slice(0, -8)}tampered`)).rejects.toBeInstanceOf(ForbiddenException);
    jest.useFakeTimers({ now: Date.now() + 601_000 });
    await expect(service.verifyMobileEditApproval(user, workId, token)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('cannot exchange access tokens and edit approvals', async () => {
    const token = await issue(service);
    await expect(jwt.verifyAsync(token)).rejects.toThrow();
    const access = await jwt.signAsync({ ...user, workItemId: workId, actorWorkerId: actor.id }, { audience: 'mobile-work-item-edit' });
    await expect(service.verifyMobileEditApproval(user, workId, access)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each([{ status: 'INACTIVE' }, { role: 'WORKER' }, { siteId: 'site-b' }])('revokes approval after administrator changes: %j', async (change) => {
    const token = await issue(service);
    Object.assign(actor, change);
    await expect(service.verifyMobileEditApproval(user, workId, token)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('uses the verified administrator, never the supplied audit actor', async () => {
    const token = await issue(service);
    await controller.updateWorkItemMobile(workId, { quantity: 9, actorWorkerId: 'spoofed', adminApproval: token }, { headers: {}, socket: {} } as any, user);
    expect(workItems.updateFromMobile.mock.calls[0][1].actorWorkerId).toBe('admin-a');
  });
  it('preserves approval fields through the actual whitelist validation policy', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const adminApproval = await issue(service);
    expect(await pipe.transform({ quantity: 9, adminApproval, ignored: true }, { type: 'body', metatype: UpdateWorkItemMobileDto })).toEqual({ quantity: 9, adminApproval });
    expect(await pipe.transform({ pin: '123456', editWorkItemId: workId }, { type: 'body', metatype: VerifyPinDto })).toEqual({ pin: '123456', editWorkItemId: workId });
    await expect(pipe.transform({ quantity: 9 }, { type: 'body', metatype: UpdateWorkItemMobileDto })).rejects.toThrow();
  });
});
