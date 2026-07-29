import './config/load-dotenv';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
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

  // Every response carries a correlation id. It appears in logs, in error
  // bodies, and in Sentry, so a user reporting "booking failed at 14:02" can
  // be traced to one request.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const existing = req.headers['x-request-id'];
    const requestId = typeof existing === 'string' && existing ? existing : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

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
