import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import * as bodyParser from 'body-parser';
import { join } from 'path';
import { useContainer } from 'class-validator';
import helmet from 'helmet';
import { SecurityHeadersInterceptor } from './common/interceptors/security-headers.interceptor';
import { ConcurrencyLimiterMiddleware } from './common/middleware/concurrency-limiter.middleware';
import { SSRFProtectionMiddleware } from './common/middleware/ssrf-protection.middleware';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import * as compression from 'compression';
import * as passport from 'passport';
import * as session from 'express-session';
import * as express from 'express';
import * as cookieParser from 'cookie-parser';
import { initializeSentry } from './config/sentry.config';

initializeSentry();

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  const configService = app.get(ConfigService);
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

  app.use(compression());
  app.use(cookieParser());

  const allowedOrigins = ['http://localhost:3000', 'http://localhost:3333'];

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
        'Content-Type,Authorization,x-api-bypass,x-csrf-token,Origin,Accept,X-Requested-With',
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
      'Content-Type,Authorization,x-api-bypass,x-csrf-token,Origin,Accept,X-Requested-With',
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
        'Content-Type,Authorization,x-api-bypass,x-csrf-token,Origin,Accept,X-Requested-With',
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
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  app.use('/api/v1/upload', bodyParser.raw({ limit: '10mb' }));
  app.use(
    new ConcurrencyLimiterMiddleware().use.bind(
      new ConcurrencyLimiterMiddleware(),
    ),
  );

  app.use(
    new SSRFProtectionMiddleware().use.bind(new SSRFProtectionMiddleware()),
  );

  app.use('/uploads', express.static(join(__dirname, '..', 'uploads')));

  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      forbidNonWhitelisted: true,
      whitelist: true,
      forbidUnknownValues: true,
      exceptionFactory: (errors) => {
        const formattedErrors = errors.map((error) => {
          const constraints = error.constraints || {};
          const messages = Object.values(constraints);
          return {
            property: error.property,
            value: error.value,
            message:
              messages[0] || `Validation failed for property ${error.property}`,
            constraints: constraints,
          };
        });

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
  httpAdapter.get('/health', (req: express.Request, res: express.Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      instance: process.env.INSTANCE_ID || 'default',
    });
  });

  await app.listen(process.env.PORT || 3333);
}

bootstrap();
