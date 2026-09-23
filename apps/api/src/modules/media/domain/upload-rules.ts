import { errors } from '@deehub/shared';

/**
 * What a photo may be. Decided once here, enforced on the signed URL (type and
 * size are part of the signature) and again when the row is written.
 */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Phones produce 3–6 MB straight off the sensor; the dashboard shrinks first. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Enough for a gallery, small enough that a page is not 200 requests. */
export const MAX_PHOTOS_PER_GALLERY = 20;

export function extensionFor(contentType: string): string {
  const extension = IMAGE_TYPES[contentType];
  if (!extension) {
    throw errors.validation('Photos must be JPEG, PNG or WebP', { contentType });
  }
  return extension;
}

export function assertImageSize(bytes: number): void {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw errors.validation('A photo must have a size');
  }
  if (bytes > MAX_IMAGE_BYTES) {
    throw errors.validation('A photo must be 5 MB or smaller', { bytes, max: MAX_IMAGE_BYTES });
  }
}

/**
 * The object key is minted by the server, never taken from the client: it is
 * the tenant boundary inside the bucket. `public/` is the prefix a bucket
 * policy makes world-readable; everything else in the bucket stays private.
 */
export function objectKeyFor(
  organizationId: string,
  propertyId: string,
  mediaId: string,
  contentType: string,
): string {
  return `public/${organizationId}/${propertyId}/${mediaId}.${extensionFor(contentType)}`;
}
