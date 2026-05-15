import {
  Controller,
  Post,
  Patch,
  Body,
  UseGuards,
  Get,
  Query,
  HttpCode,
  HttpStatus,
  Res,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  Request,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  EmailLoginDto,
  EmailRegisterDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  ChangeEmailDto,
  VerifyResetCodeDto,
  ResendResetCodeDto,
  VerifyEmailChangeDto,
  TwoFactorCodeDto,
  VerifyLoginMfaDto,
} from './dto/auth.dto';
import { Response } from 'express';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { TurnstileGuard } from './guards/turnstile.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('email/availability')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Check email availability', description: 'Returns whether an email address is already registered' })
  @ApiQuery({ name: 'email', description: 'Email address to check', required: true })
  @ApiResponse({ status: 200, description: '{ available: boolean }' })
  @ApiResponse({ status: 400, description: 'Missing or invalid email' })
  async checkEmailAvailability(@Query('email') email: string) {
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Endereço de e-mail inválido');
    }
    const available = await this.authService.isEmailAvailable(email.toLowerCase().trim());
    return { available };
  }

  @Post('register')
  @ApiOperation({ 
    summary: 'Register new user',
    description: 'Register a new user with email, password and required information for PodioGo'
  })
  @ApiBody({ type: EmailRegisterDto })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  @ApiResponse({ status: 400, description: 'Invalid data or terms not accepted' })
  async register(@Body() registerDto: EmailRegisterDto) {
    try {
      return await this.authService.register(registerDto);
    } catch (error) {
      throw error;
    }
  }

  @Post('login')
  @UseGuards(TurnstileGuard, LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email/CPF and password (User account)' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 400, description: 'Turnstile verification failed' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        emailOrCpf: {
          type: 'string',
          description: 'User email or CPF',
          example: 'user@example.com',
        },
        password: {
          type: 'string',
          description: 'User password',
          example: 'password123',
        },
        accountType: {
          type: 'string',
          enum: ['USER', 'ORGANIZER'],
          description: 'Account type: USER (participant) or ORGANIZER. Defaults to USER if not provided.',
          example: 'USER',
        },
        turnstileToken: {
          type: 'string',
          description: 'Cloudflare Turnstile token from frontend widget',
        },
      },
      required: ['emailOrCpf', 'password', 'turnstileToken'],
    },
  })
  async loginEmail(@Request() req) {
    return this.authService.login(req.user, { userAgent: req.headers?.['user-agent'] });
  }

  @Post('login/admin')
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Login — no Turnstile, role-gated' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        emailOrCpf: { type: 'string' },
        password: { type: 'string' },
        accountType: { type: 'string', enum: ['USER', 'ORGANIZER'], default: 'USER' },
      },
      required: ['emailOrCpf', 'password'],
    },
  })
  async loginAdmin(@Request() req) {
    const role = req.user?.role;
    if (role !== 'ADMIN' && role !== 'PODIOGO_STAFF') {
      throw new ForbiddenException('Admin access required');
    }
    return this.authService.login(req.user, { userAgent: req.headers?.['user-agent'] });
  }

  @Post('login/organizer')
  @UseGuards(TurnstileGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login as organizer with email/CPF and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 400, description: 'Turnstile verification failed' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        emailOrCpf: {
          type: 'string',
          description: 'Organizer email or CPF',
          example: 'organizer@example.com',
        },
        password: {
          type: 'string',
          description: 'Organizer password',
          example: 'password123',
        },
        turnstileToken: {
          type: 'string',
          description: 'Cloudflare Turnstile token from frontend widget',
        },
      },
      required: ['emailOrCpf', 'password', 'turnstileToken'],
    },
  })
  async loginOrganizer(@Request() req, @Body() body: { emailOrCpf: string; password: string }) {
    // Validar como organizador
    const user = await this.authService.validateUser(body.emailOrCpf, body.password, 'ORGANIZER');
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    return this.authService.login(user, { userAgent: req.headers?.['user-agent'] });
  }

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ 
    summary: 'Initiate Google OAuth login',
    description: 'Redirects to Google OAuth consent screen. Frontend should configure redirect_uri to point to frontend callback page.'
  })
  @ApiResponse({ status: 302, description: 'Redirects to Google OAuth consent screen' })
  async googleAuth() {
    // Guard handles the redirect to Google
    // Google will redirect back to frontend with code
  } 

  @Post('google/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Validate Google OAuth code',
    description: 'Receives Google OAuth code from frontend, validates with Google, and returns JWT tokens'
  })
  @ApiResponse({ status: 200, description: 'Login successful, returns tokens and user data' })
  @ApiResponse({ status: 400, description: 'Invalid or expired Google code' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Google OAuth authorization code received from Google redirect',
          example: '4/0ATX87lO8nvcAqU_MVyDPWPTKOHjxuiz2uTq7EKMO1xOrdJgVumhVwIB8CPfXJiIQ1vVARQ',
        },
        redirectUri: {
          type: 'string',
          description: 'Redirect URI used in the OAuth flow (must match Google Cloud Console)',
          example: 'http://localhost:3000/auth/callback',
        },
      },
      required: ['code', 'redirectUri'],
    },
  })
  async validateGoogleCode(@Body() body: { code: string; redirectUri: string }) {
    if (!body.code) {
      throw new BadRequestException('Código de autorização do Google é obrigatório');
    }

    if (!body.redirectUri) {
      throw new BadRequestException('URI de redirecionamento é obrigatória');
    }

    const result = await this.authService.validateGoogleCode(body.code, body.redirectUri);
    return result;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refreshToken(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshToken(refreshTokenDto);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiBearerAuth()
  async logout(@Request() req) {
    const refreshToken = req.headers['x-refresh-token'];
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    return { message: 'Logged out successfully' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ long: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Solicitar redefinição de senha (USER ou ORGANIZER)',
    description:
      'Envia e-mail com link seguro para a página de redefinição (FRONTEND_URL + PASSWORD_RESET_PATH). Resposta genérica por segurança.',
  })
  @ApiResponse({
    status: 200,
    description: 'Pedido aceito; o e-mail só é enviado se a conta existir e estiver ativa',
  })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    const accountType = forgotPasswordDto.accountType || 'USER';
    return this.authService.forgotPassword(forgotPasswordDto, accountType);
  }

  @Post('verify-reset-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify reset code and get token (for USER or ORGANIZER)' })
  @ApiResponse({ status: 200, description: 'Code verified, token returned' })
  @ApiResponse({ status: 400, description: 'Invalid or expired code' })
  async verifyResetCode(@Body() verifyResetCodeDto: VerifyResetCodeDto) {
    const accountType = verifyResetCodeDto.accountType || 'USER';
    return this.authService.verifyResetCode(
      verifyResetCodeDto.email,
      verifyResetCodeDto.code,
      accountType
    );
  }

  @Post('resend-reset-code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ long: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Reenviar link de redefinição de senha (USER ou ORGANIZER)',
    description: 'No máximo um envio efetivo por minuto por e-mail/tipo de conta (silencioso quando em cooldown).',
  })
  @ApiResponse({ status: 200, description: 'Pedido aceito' })
  async resendResetCode(@Body() resendResetCodeDto: ResendResetCodeDto) {
    const accountType = resendResetCodeDto.accountType || 'USER';
    return this.authService.resendResetCode(resendResetCodeDto.email, accountType);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redefinir senha com token (USER ou ORGANIZER)',
    description:
      'Aceita o token opaco recebido no link do e-mail (query `token`) ou JWT retornado por verify-reset-code (fluxo legado).',
  })
  @ApiResponse({ status: 200, description: 'Senha redefinida' })
  @ApiResponse({ status: 400, description: 'Token ou senha inválidos' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    return this.authService.resetPassword(resetPasswordDto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password (logged-in user)',
    description: 'Troca a senha do usuário. Se o usuário já tiver senha, envie currentPassword. Se não tiver (ex.: só login Google), envie apenas newPassword.',
  })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 200, description: 'Senha alterada com sucesso' })
  @ApiResponse({ status: 400, description: 'Dados inválidos ou nova senha igual à atual' })
  @ApiResponse({ status: 401, description: 'Não autenticado ou senha atual incorreta' })
  async changePassword(@Request() req, @Body() changePasswordDto: ChangePasswordDto) {
    return this.authService.changePassword(
      req.user.id,
      changePasswordDto,
      req.headers?.['user-agent'],
      req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    );
  }

  @Patch('change-email')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Alterar e-mail da conta (requer senha atual)' })
  @ApiBody({ type: ChangeEmailDto })
  @ApiResponse({ status: 200, description: 'E-mail alterado com sucesso' })
  @ApiResponse({ status: 400, description: 'E-mail já em uso ou senha incorreta' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async changeEmail(@Request() req, @Body() dto: ChangeEmailDto) {
    return this.authService.changeEmail(
      req.user.id,
      dto,
      req.headers?.['user-agent'],
      req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    );
  }

  @Post('verify-email-change')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirmar troca de e-mail com código enviado ao novo e-mail' })
  @ApiBody({ type: VerifyEmailChangeDto })
  @ApiResponse({ status: 200, description: 'E-mail alterado com sucesso' })
  @ApiResponse({ status: 400, description: 'Código inválido ou expirado' })
  async verifyEmailChange(@Request() req, @Body() dto: VerifyEmailChangeDto) {
    return this.authService.verifyEmailChange(req.user.id, dto.code);
  }

  @Get('profile')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  @ApiBearerAuth()
  async getProfile(@Request() req) {
    const hasPassword = await this.authService.hasPassword(req.user.id);
    return {
      data: { ...req.user, hasPassword },
      message: 'User profile',
      success: true,
    };
  }

  // ──────────────── 2FA ────────────────

  @Post('2fa/send-code')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Envia código OTP por e-mail para ativar ou desativar o 2FA',
    description:
      'Gera um código numérico de 6 dígitos, armazena em cache com TTL de 10 minutos e envia ao e-mail do usuário autenticado. ' +
      'Protegido por rate limit de 1 requisição por minuto por usuário. ' +
      'O código é invalidado automaticamente após 5 tentativas erradas.',
  })
  @ApiResponse({
    status: 200,
    description: 'Código enviado com sucesso',
    schema: { example: { message: 'Código enviado para o seu e-mail.', success: true } },
  })
  @ApiResponse({
    status: 400,
    description: 'Rate limit ativo — aguarde 1 minuto antes de solicitar novo código',
    schema: { example: { message: 'Aguarde 1 minuto antes de solicitar um novo código.' } },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async send2FACode(@Request() req) {
    await this.authService.send2FACode(req.user.id, req.user.email, { userAgent: req.headers?.['user-agent'] });
    return { message: 'Código enviado para o seu e-mail.', success: true };
  }

  @Post('2fa/enable')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Ativa o 2FA após verificação do código OTP enviado por e-mail',
    description:
      'Verifica o código de 6 dígitos em tempo constante (proteção contra timing attack). ' +
      'Em caso de sucesso, salva `mfaEnabled = true` no banco e invalida o código do cache. ' +
      'Após 5 tentativas incorretas o código é descartado e um novo deve ser solicitado.',
  })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({
    status: 200,
    description: '2FA ativado com sucesso',
    schema: { example: { message: '2FA ativado com sucesso.', success: true } },
  })
  @ApiResponse({
    status: 400,
    description: 'Código incorreto, expirado ou número de tentativas excedido',
    schema: { example: { message: 'Código incorreto ou expirado.' } },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 429, description: 'Muitas requisições — throttle ativo' })
  async enable2FA(@Request() req, @Body() dto: TwoFactorCodeDto) {
    await this.authService.enable2FA(req.user.id, dto.code);
    return { message: '2FA ativado com sucesso.', success: true };
  }

  @Post('2fa/disable')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Desativa o 2FA após verificação do código OTP enviado por e-mail',
    description:
      'Mesma lógica de verificação do endpoint de ativação. ' +
      'Em caso de sucesso, salva `mfaEnabled = false` e limpa `totpSecret` no banco.',
  })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({
    status: 200,
    description: '2FA desativado com sucesso',
    schema: { example: { message: '2FA desativado com sucesso.', success: true } },
  })
  @ApiResponse({
    status: 400,
    description: 'Código incorreto, expirado ou número de tentativas excedido',
    schema: { example: { message: 'Código incorreto ou expirado.' } },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 429, description: 'Muitas requisições — throttle ativo' })
  async disable2FA(@Request() req, @Body() dto: TwoFactorCodeDto) {
    await this.authService.disable2FA(req.user.id, dto.code);
    return { message: '2FA desativado com sucesso.', success: true };
  }

  @Post('2fa/verify-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verifica o código MFA e emite tokens reais de acesso',
    description:
      'Chamado quando o login retorna { mfaRequired: true, mfaToken }. ' +
      'Recebe o token MFA temporário (validade 10 min) e o código OTP enviado ao e-mail do usuário. ' +
      'Em caso de sucesso, retorna access_token e refresh_token definitivos.',
  })
  @ApiBody({ type: VerifyLoginMfaDto })
  @ApiResponse({
    status: 200,
    description: 'Login MFA concluído — tokens reais retornados',
    schema: {
      example: {
        message: 'Login successful',
        success: true,
        data: { access_token: 'eyJ...', refresh_token: '...', user: {} },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Código incorreto, expirado ou tentativas esgotadas' })
  @ApiResponse({ status: 401, description: 'Token MFA inválido ou expirado' })
  async verifyLoginMfa(@Body() dto: VerifyLoginMfaDto) {
    return this.authService.verifyLoginMfa(dto.mfaToken, dto.code);
  }

  @Post('2fa/resend-login-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenvia o código MFA durante o fluxo de login',
    description:
      'Aceita o mfaToken temporário como autenticação e reenvia o código OTP. ' +
      'Sujeito ao rate limit de 1 reenvio por minuto.',
  })
  @ApiResponse({ status: 200, schema: { example: { message: 'Código reenviado para o seu e-mail.', success: true } } })
  @ApiResponse({ status: 400, description: 'Rate limit ativo — aguarde 1 minuto' })
  @ApiResponse({ status: 401, description: 'Token MFA inválido ou expirado' })
  async resendLoginMfaCode(@Body() dto: { mfaToken: string }, @Request() req) {
    return this.authService.resendLoginMfaCode(dto.mfaToken, { userAgent: req.headers?.['user-agent'] });
  }

  @Get('csrf-token')
  @ApiOperation({
    summary: 'Obter token CSRF para requisições da API',
    description:
      'Gera um token CSRF seguro que deve ser usado no header x-csrf-token para endpoints protegidos como compras.',
  })
  @ApiResponse({
    status: 200,
    description: 'CSRF token generated successfully',
    schema: {
      type: 'object',
      properties: {
        csrfToken: {
          type: 'string',
          example: '1703123456789.a1b2c3d4e5f6...',
          description: 'Token to use in x-csrf-token header',
        },
        message: {
          type: 'string',
          example:
            'Use this token in x-csrf-token header for subsequent requests',
        },
        expiresAt: {
          type: 'string',
          format: 'date-time',
          description: 'Token expiration time',
        },
      },
    },
  })
  @ApiResponse({ status: 500, description: 'Failed to generate CSRF token' })
  async getCsrfToken(@Res({ passthrough: true }) response: Response) {
    try {
      const timestamp = Date.now().toString();
      const secret = crypto.randomBytes(32).toString('hex');
      const signature = crypto
        .createHmac('sha256', secret)
        .update(timestamp)
        .digest('hex');
      const csrfToken = `${timestamp}.${signature}`;
      response.cookie('csrf_secret', secret, {
        httpOnly: true,
        secure: false,
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
        maxAge: 60 * 60 * 1000,
        path: '/',
      });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      return {
        data: csrfToken,
        message:
          'Use this token in x-csrf-token header for subsequent requests',
        expiresAt: expiresAt.toISOString(),
        instructions: {
          header: 'x-csrf-token',
          value: csrfToken,
          note: 'Cookie csrf_secret is automatically set and will be validated',
        },
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to generate CSRF token: ${error.message}`,
      );
    }
  }
}
