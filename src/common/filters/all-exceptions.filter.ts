import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    // Ignorar erros de autenticação JWT no callback do Google (o GoogleAuthGuard já trata)
    // Esses erros são esperados porque o Passport tenta JWT antes do Google
    const url = request.url || httpAdapter.getRequestUrl(request);
    if (
      (url?.includes('/auth/google/callback') ||
        url?.includes('/api/v1/auth/google/callback')) &&
      exception instanceof HttpException &&
      exception.getStatus() === HttpStatus.UNAUTHORIZED
    ) {
      if (response.headersSent || response.finished) return;
      return;
    }

    let httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = undefined;

    if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Se a resposta é um objeto com mensagem
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as any;

        // Capturar mensagem principal
        if (responseObj.message) {
          if (Array.isArray(responseObj.message)) {
            // Erros de validação do class-validator
            message = responseObj.message[0] || 'Validation failed';
            errors = responseObj.message;
          } else {
            message = responseObj.message;
          }
        } else {
          message = exception.message || 'Bad Request';
        }

        // Capturar erros adicionais se existirem (details do ValidationPipe customizado)
        if (responseObj.errors) {
          errors = responseObj.errors;
        }

        // Capturar detalhes se existirem
        if (responseObj.details) {
          errors = responseObj.details;
        }
      } else if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else {
        message = exception.message || 'Bad Request';
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }

    // Log detalhado para debug
    this.logger.error(
      `Exception: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    const responseBody: any = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(request),
      message,
    };

    // Adicionar erros de validação se existirem
    if (errors) {
      responseBody.errors = errors;
    }

    // Adicionar detalhes adicionais em desenvolvimento
    if (process.env.NODE_ENV === 'development' && exception instanceof Error) {
      responseBody.stack = exception.stack;
    }

    // Verificar se a resposta já foi enviada (ex: redirect)
    if (response.headersSent || response.finished) {
      this.logger.warn(
        `Cannot send error response: headers already sent for ${request.url}`,
      );
      return;
    }

    httpAdapter.reply(response, responseBody, httpStatus);
  }
}
