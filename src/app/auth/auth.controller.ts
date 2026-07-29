import {
  Controller,
  Post,
  Patch,
  Body,
  UseGuards,
  UseInterceptors,
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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { OrganizerSignupDto } from '../organizations/dto/organizer-signup.dto';
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
  DeleteAccountDto,
  VerifyLoginMfaDto,
} from './dto/auth.dto';
import { Response } from 'express';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { TurnstileGuard } from './guards/turnstile.guard';
import { ConfigService } from '@nestjs/config';
import { OAuthStateService } from './oauth-state.service';
import { sanitizeRelativePath } from 'src/common/utils/safe-redirect.util';
import { ALLOWED_ORIGINS } from 'src/common/config/allowed-origins';
import { NoCache } from 'src/common/decorators/cache.decorator';
import {
  applyAuthCookiesFromResult,
  clearAuthCookies,
  resolveAuthSurface,
  refreshCookieName,
} from './auth-cookies.util';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { TrackActivity } from 'src/common/decorators/track-activity.decorator';
import { TrackActivityInterceptor } from 'src/common/interceptors/track-activity.interceptor';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly organizationsService: OrganizationsService,
    private readonly oauthState: OAuthStateService,
    private readonly configService: ConfigService,
  ) {}

  @Get('email/availability')
  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Check email availability', description: 'Returns whether an email address is already registered for the given surface (accountType). USER and ORGANIZER coexist with the same email.' })
  @ApiQuery({ name: 'email', description: 'Email address to check', required: true })
  @ApiQuery({ name: 'accountType', description: 'USER (default) or ORGANIZER', required: false })
  @ApiResponse({ status: 200, description: '{ available: boolean }' })
  @ApiResponse({ status: 400, description: 'Missing or invalid email' })
  async checkEmailAvailability(
    @Query('email') email: string,
    @Query('accountType') accountType?: string,
  ) {
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Endereço de e-mail inválido');
    }
    // Escopo por superfície: USER e ORGANIZER coexistem com o mesmo e-mail.
    const surface = accountType === 'ORGANIZER' ? 'ORGANIZER' : 'USER';
    const available = await this.authService.isEmailAvailable(
      email.toLowerCase().trim(),
      surface,
    );
    return { available };
  }

  @Post('register')
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'AUTH', action: 'register' })
  @ApiOperation({
    summary: 'Register new user',
    description: 'Register a new user with email, password and required information for PodioGo'
  })
  @ApiBody({ type: EmailRegisterDto })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  @ApiResponse({ status: 400, description: 'Invalid data or terms not accepted' })
  async register(
    @Body() registerDto: EmailRegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // O cadastro JÁ autologa (authService.register termina em login()), então
    // precisa ESTABELECER a sessão da superfície 'client' via cookies httpOnly —
    // exatamente como o /login. Sem isto, os tokens voltavam só no body e o front
    // (que não grava mais token em JS desde a migração httpOnly) ficava sem cookie
    // de sessão → a 1ª chamada autenticada (reserve do checkout) dava 401
    // "não autorizado". Mesmo helper/superfície do loginEmail.
    const result = await this.authService.register(registerDto);
    return applyAuthCookiesFromResult(res, 'client', result);
  }

  @Post('login')
  @UseGuards(TurnstileGuard, LocalAuthGuard)
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'AUTH', action: 'login' })
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
        turnstileToken: {
          type: 'string',
          description: 'Cloudflare Turnstile token from frontend widget',
        },
      },
      required: ['emailOrCpf', 'password', 'turnstileToken'],
    },
  })
  async loginEmail(@Request() req, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(req.user, { userAgent: req.headers?.['user-agent'] });
    // Login do CLIENTE → cookies da superfície 'client' (no-op se desafio MFA).
    // Mantém tokens no body para compatibilidade durante a transição.
    return applyAuthCookiesFromResult(res, 'client', result);
  }

  @Post('login/admin')
  // Turnstile TAMBÉM aqui: sem ele a rota validava senha de QUALQUER usuário
  // sem captcha — brute-force/credential-stuffing livre, contornando a proteção
  // do /login. A página de login do admin já envia o turnstileToken.
  @UseGuards(TurnstileGuard, LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Login — Turnstile + role-gated' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        emailOrCpf: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['emailOrCpf', 'password'],
    },
  })
  async loginAdmin(@Request() req, @Res({ passthrough: true }) res: Response) {
    const role = req.user?.role;
    if (role !== 'ADMIN' && role !== 'PODIOGO_STAFF') {
      // 401 (não 403): a resposta distinta formava um oráculo — 403 confirmava
      // que a senha estava CERTA (só faltava papel), validando credenciais
      // roubadas. Indistinguível de credencial inválida.
      throw new UnauthorizedException('Invalid credentials');
    }
    const result = await this.authService.login(req.user, { userAgent: req.headers?.['user-agent'] });
    return applyAuthCookiesFromResult(res, 'admin', result);
  }

  @Post('login/organizer')
  @UseGuards(TurnstileGuard)
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'AUTH', action: 'login.organizer' })
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
  async loginOrganizer(
    @Request() req,
    @Body() body: { emailOrCpf: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    // Validar como organizador
    const user = await this.authService.validateUser(body.emailOrCpf, body.password, 'ORGANIZER');
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const result = await this.authService.login(user, { userAgent: req.headers?.['user-agent'] });
    return applyAuthCookiesFromResult(res, 'organizer', result);
  }

  @Post('register/organizer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Public organizer self-signup',
    description:
      'Cria conta ORGANIZER + organização ativa + membro OWNER e autologa na superfície organizer (cookies httpOnly).',
  })
  @ApiBody({ type: OrganizerSignupDto })
  @ApiResponse({ status: 201, description: 'Organizer created and logged in' })
  @ApiResponse({ status: 400, description: 'Turnstile verification / validation failed' })
  @ApiResponse({ status: 409, description: 'E-mail, CPF ou documento já cadastrado' })
  async registerOrganizer(
    @Body() dto: OrganizerSignupDto,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { data } = await this.organizationsService.signupOrganizer(dto);
    // Auto-login na superfície organizer (mesmo helper/cookies do loginOrganizer).
    const loginResult = await this.authService.login(data.user, {
      userAgent: req.headers?.['user-agent'],
    });
    return applyAuthCookiesFromResult(res, 'organizer', loginResult);
  }

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({
    summary: 'Initiate Google OAuth login',
    description:
      'Redireciona para o consent do Google. O `redirect_to` (caminho relativo da SPA, ex.: ' +
      '`/checkout/ingressos?eventId=XYZ`) é saneado e embutido no `state` do OAuth — o Google ' +
      'devolve esse state no callback do backend, que repassa o destino ao frontend.',
  })
  @ApiQuery({
    name: 'redirect_to',
    required: false,
    description: 'Caminho relativo de destino pós-login (URL-encoded). Apenas caminhos `/...` são aceitos.',
    example: '/checkout/ingressos?eventId=XYZ',
  })
  @ApiResponse({ status: 302, description: 'Redirects to Google OAuth consent screen' })
  async googleAuth() {
    // O GoogleAuthGuard monta a URL de consent e injeta o `state` (com o redirect_to saneado).
    // O Google redireciona para GET /api/v1/auth/google/callback.
  }

  @Get('google/callback')
  @NoCache()
  @ApiOperation({
    summary: 'Google OAuth callback (backend-mediated)',
    description:
      'Recebe o `code` + `state` do Google, extrai o `redirect_to` saneado do state e ' +
      'redireciona para {FRONTEND_URL}/auth/callback?code=...&redirect_to=.... O frontend troca ' +
      'o code por tokens via POST /api/v1/auth/google/validate.',
  })
  @ApiQuery({ name: 'code', required: false, description: 'Authorization code do Google' })
  @ApiQuery({ name: 'state', required: false, description: 'State assinado emitido em /auth/google' })
  @ApiQuery({ name: 'error', required: false, description: 'Erro do Google (ex.: access_denied)' })
  @ApiResponse({ status: 302, description: 'Redireciona para o callback do frontend' })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    // Destino do frontend (página que finaliza o login). NUNCA confia no client para isto.
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    // Valida o state e recupera o destino pós-login saneado (null se ausente/expirado/adulterado).
    const { redirectTo } = this.oauthState.verify(state);

    // Monta a URL de retorno via URL/searchParams → re-encoda tudo (neutraliza injeção).
    const url = new URL('/auth/callback', frontendUrl);

    if (error) {
      // Usuário cancelou ou o Google recusou — repassa o erro pro front decidir a UX.
      url.searchParams.set('error', error);
    } else if (code) {
      url.searchParams.set('code', code);
    } else {
      // Sem code e sem error: estado inesperado → trata como falha genérica.
      url.searchParams.set('error', 'google_oauth_failed');
    }

    // redirectTo já saneado pelo OAuthStateService; sanitize de novo (defesa em profundidade).
    const safe = sanitizeRelativePath(redirectTo);
    if (safe) url.searchParams.set('redirect_to', safe);

    return res.redirect(url.toString());
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
  async validateGoogleCode(
    @Request() req,
    @Body() body: { code: string; redirectUri: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!body.code) {
      throw new BadRequestException('Código de autorização do Google é obrigatório');
    }

    if (!body.redirectUri) {
      throw new BadRequestException('URI de redirecionamento é obrigatória');
    }

    // Valida que o redirectUri pertence a uma origem permitida
    try {
      const redirectUrl = new URL(body.redirectUri);
      const isAllowed = ALLOWED_ORIGINS.some(origin => {
        try {
          const allowed = new URL(origin);
          return allowed.hostname === redirectUrl.hostname;
        } catch { return false; }
      });
      // Em desenvolvimento, também aceita qualquer hostname localhost
      const isLocalhost =
        process.env.NODE_ENV === 'development' &&
        (redirectUrl.hostname === 'localhost' || redirectUrl.hostname.endsWith('.localhost'));
      if (!isAllowed && !isLocalhost) {
        throw new BadRequestException('redirectUri não permitido');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('redirectUri inválido');
    }

    const result = await this.authService.validateGoogleCode(body.code, body.redirectUri);
    // Superfície vem do header `x-pt-surface` (o front que finaliza o OAuth está
    // numa superfície específica — cliente ou organizador via "entrar com Google").
    return applyAuthCookiesFromResult(res, resolveAuthSurface(req), result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refreshToken(
    @Request() req,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { refresh_token?: string; refreshToken?: string },
  ) {
    // Refresh é por SUPERFÍCIE: lê o `pt_rt_<surface>` da superfície declarada no
    // header. Token vem do cookie httpOnly (fluxo novo) ou do body (legado).
    const surface = resolveAuthSurface(req);
    const token =
      req.cookies?.[refreshCookieName(surface)] ||
      body?.refresh_token ||
      body?.refreshToken;
    if (!token) {
      throw new UnauthorizedException('Refresh token ausente');
    }
    // O service lê `refreshTokenDto.refreshToken` (camelCase).
    const result = await this.authService.refreshToken({ refreshToken: token });
    return applyAuthCookiesFromResult(res, surface, result);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiBearerAuth()
  async logout(@Request() req, @Res({ passthrough: true }) res: Response) {
    // Logout SÓ da superfície atual — as outras sessões (admin/organizer/client)
    // permanecem logadas.
    const surface = resolveAuthSurface(req);
    const refreshToken =
      req.cookies?.[refreshCookieName(surface)] || req.headers['x-refresh-token'];
    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
    // Limpa os cookies httpOnly de auth DA SUPERFÍCIE no browser.
    clearAuthCookies(res, surface);
    return { message: 'Logged out successfully' };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'AUTH', action: 'password.forgot' })
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
      { email: verifyResetCodeDto.email, cpf: verifyResetCodeDto.cpf },
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
    return this.authService.resendResetCode(
      { email: resendResetCodeDto.email, cpf: resendResetCodeDto.cpf },
      accountType
    );
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'AUTH', action: 'password.reset' })
  @ApiOperation({
    summary: 'Redefinir senha com token (USER ou ORGANIZER)',
    description:
      'Aceita o token opaco recebido no link do e-mail (query `token`) ou JWT retornado por verify-reset-code (fluxo legado).',
  })
  @ApiResponse({ status: 200, description: 'Senha redefinida' })
  @ApiResponse({ status: 400, description: 'Token ou senha inválidos' })
  async resetPassword(@Request() req, @Body() resetPasswordDto: ResetPasswordDto) {
    return this.authService.resetPassword(
      resetPasswordDto,
      req.headers?.['user-agent'],
      req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    );
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TrackActivityInterceptor)
  @TrackActivity({ category: 'AUTH', action: 'password.change' })
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

  @Post('account/delete/send-code')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Envia o código OTP por e-mail para confirmar a EXCLUSÃO da conta',
    description:
      'Mesmo mecanismo do 2FA (código de 6 dígitos, TTL 10min, rate limit 1/min por ' +
      'usuário), porém com e-mail de copy PRÓPRIA de exclusão (sem card de login).',
  })
  @ApiResponse({
    status: 200,
    description: 'Código enviado com sucesso',
    schema: { example: { message: 'Código enviado para o seu e-mail.', success: true } },
  })
  @ApiResponse({ status: 400, description: 'Rate limit ativo — aguarde 1 minuto' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async sendAccountDeletionCode(@Request() req) {
    await this.authService.send2FACode(req.user.id, req.user.email, {
      purpose: 'delete',
    });
    return { message: 'Código enviado para o seu e-mail.', success: true };
  }

  @Post('account/delete')
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Exclui (soft-delete/anonimiza) a conta do usuário autenticado',
    description:
      'Verifica o código OTP enviado por e-mail (mesmo canal do 2FA) e então ' +
      'anonimiza a PII e neutraliza as credenciais da conta, marcando-a como ' +
      'excluída. Inscrições, pedidos e histórico são PRESERVADOS para o ' +
      'organizador (identidade do comprador/participante congelada em snapshot). ' +
      'A sessão é invalidada e os cookies de auth da superfície são limpos.',
  })
  @ApiBody({ type: DeleteAccountDto })
  @ApiResponse({
    status: 200,
    description: 'Conta excluída com sucesso',
    schema: { example: { message: 'Conta excluída com sucesso.', success: true } },
  })
  @ApiResponse({
    status: 400,
    description: 'Código incorreto, expirado ou número de tentativas excedido',
    schema: { example: { message: 'Código incorreto ou expirado.' } },
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 429, description: 'Muitas requisições — throttle ativo' })
  async deleteAccount(
    @Request() req,
    @Body() dto: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.deleteOwnAccount(req.user.id, dto.code, dto.reason);
    // Invalida a sessão local: limpa os cookies httpOnly da superfície atual.
    clearAuthCookies(res, resolveAuthSurface(req));
    return { message: 'Conta excluída com sucesso.', success: true };
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
  async verifyLoginMfa(
    @Request() req,
    @Body() dto: VerifyLoginMfaDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyLoginMfa(dto.mfaToken, dto.code);
    // MFA conclui o login iniciado numa superfície (admin/organizer/client) → o
    // header `x-pt-surface` da request de verificação diz qual cookie setar.
    return applyAuthCookiesFromResult(res, resolveAuthSurface(req), result);
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
}
