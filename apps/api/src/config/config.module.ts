import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv, type Env } from './env';

/**
 * Validated configuration, resolved once at boot.
 *
 * Global because nearly every module needs it and threading it through
 * imports adds noise without adding safety.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => loadEnv(),
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
