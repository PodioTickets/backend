import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

describe('AuthService - Performance Tests', () => {
  let service: AuthService;
  let jwtService: JwtService;
  let configService: ConfigService;
  let prisma: PrismaService;

  const mockJwtService = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true));
    jest.spyOn(bcrypt, 'hash').mockImplementation(() => Promise.resolve('hashedPassword'));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('High Concurrency - User Authentication', () => {
    const mockUser = {
      id: 'user-id',
      email: 'test@example.com',
      password: 'hashedPassword',
      isActive: true,
      firstName: 'John',
      lastName: 'Doe',
      documentNumber: '12345678901',
      role: 'USER',
    };

    beforeEach(() => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockJwtService.sign.mockReturnValue('access-token');
      mockConfigService.get.mockReturnValue('refresh-secret');
      jest.spyOn(service as any, 'createRefreshToken').mockResolvedValue('refresh-token');
    });

    it('should handle 2000 concurrent login attempts efficiently', async () => {
      const concurrentRequests = 2000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        const user = {
          ...mockUser,
          id: `user-${i}`,
          email: `user${i}@example.com`,
        };
        return service.login(user).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(5000);
      expect(throughput).toBeGreaterThan(200);

      console.log(`✅ Processed ${concurrentRequests} concurrent login attempts:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 10000);

    it('should handle 5000 concurrent user validation requests efficiently', async () => {
      const concurrentRequests = 5000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, (_, i) => {
        return service
          .validateUser(`user${i}@example.com`, 'password')
          .catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(8000);
      expect(throughput).toBeGreaterThan(300);

      console.log(`✅ Processed ${concurrentRequests} concurrent user validations:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 12000);
  });

  describe('High Concurrency - Token Refresh', () => {
    const refreshTokenDto = {
      refreshToken: 'valid-refresh-token',
    };

    const mockDecoded = {
      sub: 'user-id',
      email: 'test@example.com',
    };

    const mockUser = {
      id: 'user-id',
      email: 'test@example.com',
      firstName: 'John',
      lastName: 'Doe',
      isActive: true,
      role: 'USER',
    };

    beforeEach(() => {
      mockJwtService.verify.mockReturnValue(mockDecoded);
      mockJwtService.sign.mockReturnValue('new-access-token');
      mockConfigService.get.mockReturnValue('refresh-secret');
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      jest.spyOn(service as any, 'createRefreshToken').mockResolvedValue('new-refresh-token');
    });

    it('should handle 3000 concurrent token refresh requests efficiently', async () => {
      const concurrentRequests = 3000;
      const startTime = Date.now();

      const promises = Array.from({ length: concurrentRequests }, () => {
        return service.refreshToken(refreshTokenDto).catch((error) => ({ error }));
      });

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const duration = endTime - startTime;

      const successful = results.filter((r) => !r.error).length;
      const throughput = (concurrentRequests / duration) * 1000;

      expect(successful).toBeGreaterThan(0);
      expect(duration).toBeLessThan(6000);
      expect(throughput).toBeGreaterThan(250);

      console.log(`✅ Processed ${concurrentRequests} concurrent token refresh requests:`);
      console.log(`   - Successful: ${successful}`);
      console.log(`   - Duration: ${duration}ms`);
      console.log(`   - Throughput: ${throughput.toFixed(2)} req/s`);
    }, 10000);
  });
});
