import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
// import { GoogleStrategy } from './strategies/google.strategy'; // Commented - method doesn't exist
// import { SteamStrategy } from './strategies/steam.strategy'; // Removed - not part of PodioGo
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    PrismaModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const secret = configService.get('JWT_SECRET');
        const expiresIn = configService.get('JWT_EXPIRES_IN', '1h');
        if (!secret) {
          throw new Error('JWT_SECRET environment variable is required');
        }
        return { secret, signOptions: { expiresIn } };
      },
    }),
  ],
  providers: [AuthService, JwtStrategy, LocalStrategy], // GoogleStrategy and SteamStrategy removed
  controllers: [AuthController],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
