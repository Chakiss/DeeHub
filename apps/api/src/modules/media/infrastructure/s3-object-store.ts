import { Inject, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ENV, type Env } from '../../../config/env';
import type { ObjectStore, StoredObject, UploadGrant } from '../domain/object-store';

/** Long enough to pick a file and start the PUT; short enough to be single use in practice. */
const GRANT_TTL_SECONDS = 5 * 60;

/**
 * S3-protocol object store — MinIO locally, Google Cloud Storage's S3
 * interoperability endpoint in production (ADR-0004; master prompt "Storage:
 * S3-compatible"). One adapter for both is the reason the S3 wire protocol
 * was chosen over GCS's own SDK: the development stack and production behave
 * identically, and a test can point at a throwaway bucket.
 *
 * Path-style addressing on purpose: MinIO does not resolve virtual-host
 * buckets without DNS games, and GCS accepts either.
 */
@Injectable()
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly publicBase: string;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.STORAGE_BUCKET;
    const configured = Boolean(
      env.STORAGE_ENDPOINT && env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY,
    );
    const config: S3ClientConfig = {
      region: env.STORAGE_REGION,
      forcePathStyle: true,
      ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
      ...(env.STORAGE_ACCESS_KEY && env.STORAGE_SECRET_KEY
        ? {
            credentials: {
              accessKeyId: env.STORAGE_ACCESS_KEY,
              secretAccessKey: env.STORAGE_SECRET_KEY,
            },
          }
        : {}),
    };
    this.client = configured ? new S3Client(config) : null;
    this.publicBase = (
      env.STORAGE_PUBLIC_URL ?? `${env.STORAGE_ENDPOINT ?? ''}/${env.STORAGE_BUCKET}`
    ).replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async createUploadGrant(key: string, contentType: string, bytes: number): Promise<UploadGrant> {
    const client = this.require();
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes,
    });
    const url = await getSignedUrl(client, command, {
      expiresIn: GRANT_TTL_SECONDS,
      // Both become signed headers, so the PUT must carry exactly these.
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes) },
      expiresAt: new Date(Date.now() + GRANT_TTL_SECONDS * 1000),
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    const client = this.require();
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        bytes: Number(result.ContentLength ?? 0),
        contentType: result.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.require();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.publicBase}/${key}`;
  }

  private require(): S3Client {
    if (!this.client) {
      throw new Error('Object storage is not configured (STORAGE_ENDPOINT / keys)');
    }
    return this.client;
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === 'NotFound' || named.$metadata?.httpStatusCode === 404;
}
