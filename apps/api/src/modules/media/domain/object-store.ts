/**
 * Where the bytes of a photo live.
 *
 * A port so the API never speaks to a bucket directly: MinIO in development,
 * Google Cloud Storage in production, and a fake in tests. Uploads are signed
 * rather than proxied — the browser PUTs the file to the store on a URL this
 * API vouched for, so a 5 MB photo never crosses Cloud Run's 1 MB body limit
 * or occupies an instance while it streams.
 */

export interface UploadGrant {
  /** Where the browser PUTs the bytes. Single use in spirit; expires quickly. */
  readonly url: string;
  /** Headers the PUT must carry, or the signature will not match. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly bytes: number;
  readonly contentType: string;
}

export interface ObjectStore {
  /** False when no store is configured; the dashboard says so instead of failing. */
  isConfigured(): boolean;

  /**
   * Sign a PUT for exactly this key, type and size. The size is part of the
   * signature so a grant for a 2 MB photo cannot be used to park 2 GB.
   */
  createUploadGrant(key: string, contentType: string, bytes: number): Promise<UploadGrant>;

  /** What is actually there, or null. Read BEFORE a row points at it. */
  head(key: string): Promise<StoredObject | null>;

  /** Idempotent: deleting what is not there is not an error. */
  delete(key: string): Promise<void>;

  /** The URL a browser reads the object from. */
  publicUrl(key: string): string;
}

export const OBJECT_STORE = Symbol('OBJECT_STORE');
