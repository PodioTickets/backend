import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  BadRequestException,
  UnauthorizedException,
  Request,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  EmailLoginDto,
  EmailRegisterDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { Response } from 'express';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

@ApiTags('Authentication')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email/CPF and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
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
      },
      required: ['emailOrCpf', 'password'],
    },
  })
  async loginEmail(@Request() req) {
    return this.authService.login(req.user);
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
      throw new BadRequestException('Google authorization code is required');
    }

    if (!body.redirectUri) {
      throw new BadRequestException('Redirect URI is required');
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
  @ApiOperation({ summary: 'Request password reset' })
  @ApiResponse({
    status: 200,
    description: 'Reset email sent if account exists',
  })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    return this.authService.forgotPassword(forgotPasswordDto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    return this.authService.resetPassword(resetPasswordDto);
  }

  @Get('profile')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  @ApiBearerAuth()
  async getProfile(@Request() req) {
    return {
      data: req.user,
      message: 'User profile',
      success: true,
    };
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
