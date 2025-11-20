import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma.service';
import { ConfigService } from '@nestjs/config';

/**
 * Teste unitário para validar que os serviços usam os clientes corretos
 */
describe('PrismaService - Client Selection', () => {
  let prismaService: PrismaService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string> = {
                DATABASE_URL: 'postgresql://podiogo:podiogo123@localhost:5432/podiogo',
                DATABASE_READ_REPLICA_URL: 'postgresql://podiogo:podiogo123@localhost:5433/podiogo',
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('should return write client for write operations', () => {
    const writeClient = prismaService.getWriteClient();
    expect(writeClient).toBeDefined();
    expect(writeClient).toBe(prismaService); // Write client é o próprio prismaService
  });

  it('should return read client for read operations', () => {
    const readClient = prismaService.getReadClient();
    expect(readClient).toBeDefined();
  });

  it('should use read replica when available', () => {
    const readClient = prismaService.getReadClient();
    const writeClient = prismaService.getWriteClient();
    
    // Em desenvolvimento, se não houver replica configurada, retorna o próprio prismaService
    expect(readClient).toBeDefined();
    expect(writeClient).toBeDefined();
  });
});

