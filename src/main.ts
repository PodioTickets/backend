import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import bodyParser from 'body-parser';
import { join } from 'path';
import { useContainer } from 'class-validator';
import helmet from 'helmet';
import { SecurityHeadersInterceptor } from './common/interceptors/security-headers.interceptor';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';
import { SSRFProtectionMiddleware } from './common/middleware/ssrf-protection.middleware';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import compression from 'compression';
import passport from 'passport';
import session from 'express-session';
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { initializeSentry } from './config/sentry.config';

type RequestWithRawBody = Request & { rawBody?: Buffer };

initializeSentry();

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Confia em 1 hop de proxy (nginx/Caddy no mesmo host à frente do Node). Com isso o Express
  // resolve `req.ip` (e `req.protocol`/`secure`) a partir do PRIMEIRO IP do X-Forwarded-For —
  // ou seja, o IP REAL do cliente, não o do proxy. Sem isso, todo rate-limit/log/antifraude
  // baseado em IP colapsava todos os clientes no IP do proxy (um balde global). `1` (e NÃO
  // `true`) é deliberado: confiar cegamente no XFF de qualquer origem deixaria o cliente forjar
  // o header e furar os limites por IP. Se a topologia mudar (ex.: CDN + LB), ajustar os hops.
  app.set('trust proxy', 1);

  app.use(
    express.json({
      limit: '200mb',
      verify: (req: RequestWithRawBody, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  const configService = app.get(ConfigService);
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

  app.use(compression());
  app.use(cookieParser());

  const allowedOrigins = [
    'http://localhost:3000',
    'http://app.localhost:3000',
    "http://test890.localhost:3000",
    'https://podioticket.com.br',
    'https://www.podioticket.com.br',
    'https://app.podioticket.com.br',
    'https://test890.podioticket.com.br',
    'https://homologacao.podioticket.com.br',
    'https://homologacao.app.podioticket.com.br',
    'https://homologacao.test890.podioticket.com.br',
  ];

  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
      res.header(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,x-api-bypass,x-csrf-token,Origin,Accept,X-Requested-With,Idempotency-Key,x-session-id',
      );
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api/v1/auth', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,x-api-bypass,x-csrf-token,Origin,Accept,X-Requested-With,x-session-id',
    );
    res.header('Access-Control-Allow-Credentials', 'true');
    next();
  });

  app.use(
    session({
      secret: configService.get<string>('SESSION_SECRET', ''),
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: configService.get<string>('NODE_ENV') === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'strict',
      },
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());

  const isDev = process.env.NODE_ENV === 'development';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:', 'http:'],
          connectSrc: ["'self'", 'https:', 'wss:'],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: false,
    }),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || isDev) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-api-bypass',
      'x-csrf-token',
      'Origin',
      'Accept',
      'X-Requested-With',
      'Idempotency-Key',
      // Telemetria de atividade (UserActivityLog) — sem ele o preflight do
      // browser bloqueia TODA request do front (que envia o header sempre)
      'x-session-id',
    ],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (
      isDev ||
      req.path.startsWith('/uploads/') ||
      req.path.startsWith('/api/v1/auth') ||
      req.path.startsWith('/api/v1/upload') ||
      req.path.startsWith('/api/v1/payments/sandbox/') ||
      // Webhook da Cielo é server-to-server, SEM header Origin — não pode ser
      // bloqueado pelo guard de origem (a autenticidade é validada via assinatura
      // cielo-signature no handler). Sem esta isenção, a Cielo recebe 403 e o
      // pagamento PIX nunca é confirmado.
      req.path === '/api/v1/payments/webhook' ||
      req.headers['x-api-bypass'] ===
      configService.get<string>('API_BYPASS_SECRET')
    ) {
      if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      } else {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.header(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,x-api-bypass,x-csrf-token,Origin,Accept,X-Requested-With,Idempotency-Key,x-session-id',
      );
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Max-Age', '86400');

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      return next();
    }

    if (!origin || !allowedOrigins.includes(origin)) {
      return res.status(403).json({
        statusCode: 403,
        message: 'Access Forbidden - Origin not allowed',
      });
    }

    res.header('Access-Control-Allow-Origin', origin);
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  if (isDev) {
    const config = new DocumentBuilder()
      .setTitle('PodioTickets API')
      .setDescription(`API documentation for PodioTickets`)
      .setVersion('1.0')
      .addBearerAuth()
      .addServer('http://localhost:3333')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    const swaggerOptions = {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: false,
        showExtensions: true,
        showCommonExtensions: true,
        requestInterceptor: (req) => {
          req.withCredentials = true;
          return req;
        },
        responseInterceptor: (res) => {
          return res;
        },
      },
      customSiteTitle: 'PodioTickets API Docs',
    };

    SwaggerModule.setup('api', app, document, swaggerOptions);
  }

  app.use('/api/v1/upload', bodyParser.raw({ limit: '200mb' }));
  const concurrencyLimiter = new ConcurrencyLimiterMiddleware();
  app.use(concurrencyLimiter.use.bind(concurrencyLimiter));

  app.use(
    new SSRFProtectionMiddleware().use.bind(new SSRFProtectionMiddleware()),
  );

  const uploadsPath = join(process.cwd(), 'uploads');
  app.use(
    '/uploads',
    express.static(uploadsPath, {
      maxAge: '30d',
      etag: true,
      lastModified: true,
    }),
  );

  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      forbidNonWhitelisted: true,
      whitelist: true,
      forbidUnknownValues: true,
      exceptionFactory: (errors) => {
        const formatError = (error: any): any => {
          const constraints = error.constraints || {};
          const messages = Object.values(constraints);
          const formatted: any = {
            property: error.property,
            value: error.value,
            message:
              messages[0] || `Validation failed for property ${error.property}`,
            constraints: constraints,
          };
          if (error.children && error.children.length > 0) {
            formatted.children = error.children.map((child: any) => formatError(child));
          }
          return formatted;
        };
        const formattedErrors = errors.map(formatError);
        return new BadRequestException({
          message: 'Validation failed',
          errors: formattedErrors.map((e) => e.message),
          details: formattedErrors,
        });
      },
    }),
  );

  app.useGlobalInterceptors(new SecurityHeadersInterceptor());

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      instance: process.env.INSTANCE_ID || 'default',
    });
  });

  const port = Number(process.env.PORT) || 3333;
  await app.listen(port, '0.0.0.0');
}

bootstrap();
