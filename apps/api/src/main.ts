import './config/load-dotenv';
import { initSentry } from './observability/sentry';

// Before every other import: Sentry instruments modules as they load, so
// anything imported earlier reports nothing.
initSentry('api');

import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { ENV, type Env } from './config/env';

const API_PREFIX = 'api/v1';

function configureOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('DeeHub Hotel API')
    .setDescription('Reservations, inventory, rates and OTA connectivity.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  // packages/sdk is generated from docs-json; CI fails when it drifts.
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
    jsonDocumentUrl: `${API_PREFIX}/docs-json`,
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = app.get<Env>(ENV);
  const logger = new Logger('Bootstrap');

  app.use(helmet());

  // Refresh tokens live in an httpOnly cookie, so they are unreadable from
  // client-side JavaScript (api-spec.md §3).
  app.use(cookieParser());

  // Keep the raw body so webhook signatures can be verified over the exact
  // bytes received. Re-serializing the parsed JSON changes key order and
  // whitespace, and the HMAC would never match.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Request correlation and the tenant scope are established by
  // RequestScopeMiddleware, registered in AppModule so it runs before guards.

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  app.setGlobalPrefix(API_PREFIX, {
    // Probes must stay at the root: Cloud Run and uptime checks should not
    // depend on knowing the API version.
    exclude: ['health', 'health/ready'],
  });

  app.useGlobalFilters(new DomainExceptionFilter());

  // Lets Cloud Run drain in-flight requests and close the pool on SIGTERM.
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    configureOpenApi(app);
  }

  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`DeeHub API listening on port ${env.PORT} (${env.NODE_ENV})`);
}

void bootstrap();
