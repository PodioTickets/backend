import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class AdminGuard {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) throw new UnauthorizedException('User not authenticated');
    const fullUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, isActive: true, role: true },
    });

    if (!fullUser) throw new UnauthorizedException('User not found');
    if (!fullUser.isActive) {
      throw new ForbiddenException('User account is deactivated');
    }
    if (fullUser.role !== 'ADMIN' && fullUser.role !== 'PODIOGO_STAFF') {
      throw new ForbiddenException('Admin access required');
    }
    request.adminUser = fullUser;
    return true;
  }
}
