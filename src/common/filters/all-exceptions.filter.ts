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

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}
