'use client';

import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { MediaItem, MediaKind } from '@/lib/api';
import {
  attachMedia,
  createMediaUpload,
  deleteMedia,
  updateMedia,
} from '@/app/properties/[propertyId]/settings/actions';

/** Longest edge after shrinking. Plenty for a booking page; a fraction of a phone photo. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.86;

/**
 * One gallery — the property's, or one room type's.
 *
 * The browser does the heavy lifting: a phone photo is shrunk on a canvas
 * before it goes anywhere, then PUT straight to the bucket on the URL the API
 * signed, and only then is the API told the picture exists. The server never
 * sees the bytes, which is the point: Cloud Run's 1 MB request limit and its
 * per-request CPU are both wrong tools for images.
 */
export function MediaGallery({
  propertyId,
  title,
  kind,
  roomTypeId,
  items,
  storageAvailable,
  limits,
  canEdit,
}: {
  propertyId: string;
  title: string;
  kind: MediaKind;
  roomTypeId: string | null;
  items: MediaItem[];
  storageAvailable: boolean;
  limits: { maxBytes: number; maxPerGallery: number };
  canEdit: boolean;
}) {
  const t = useTranslations('settings');
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  const full = sorted.length >= limits.maxPerGallery;

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const room = limits.maxPerGallery - sorted.length;
    const chosen = [...files].slice(0, Math.max(0, room));
    if (chosen.length < files.length) setError(t('tooManyPhotos', { max: limits.maxPerGallery }));

    for (const file of chosen) {
      setBusy(file.name);
      try {
        await uploadOne(file);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('uploadFailed'));
        break;
      }
    }
    setBusy(null);
    if (inputRef.current) inputRef.current.value = '';
    router.refresh();
  }

  async function uploadOne(file: File): Promise<void> {
    const prepared = await shrink(file);
    if (prepared.blob.size > limits.maxBytes) throw new Error(t('tooLarge'));

    const grant = await createMediaUpload(propertyId, {
      kind,
      roomTypeId,
      contentType: prepared.blob.type,
      bytes: prepared.blob.size,
    });
    if (!grant.ok || !grant.data) throw new Error(grant.error?.message ?? t('uploadFailed'));

    const put = await fetch(grant.data.uploadUrl, {
      method: 'PUT',
      headers: grant.data.headers,
      body: prepared.blob,
    });
    if (!put.ok) throw new Error(t('uploadFailed'));

    const attached = await attachMedia(propertyId, {
      kind,
      roomTypeId,
      mediaId: grant.data.mediaId,
      width: prepared.width,
      height: prepared.height,
      alt: null,
    });
    if (!attached.ok) throw new Error(attached.error?.message ?? t('uploadFailed'));
  }

  function remove(item: MediaItem) {
    setError(null);
    startTransition(async () => {
      const result = await deleteMedia(propertyId, item.id);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  /** Swap sort orders with a neighbour; the first photo is the one the page leads with. */
  function move(index: number, direction: -1 | 1) {
    const a = sorted[index];
    const b = sorted[index + direction];
    if (!a || !b) return;
    setError(null);
    startTransition(async () => {
      const first = await updateMedia(propertyId, a.id, { sortOrder: b.sortOrder });
      const second = await updateMedia(propertyId, b.id, { sortOrder: a.sortOrder });
      if (!first.ok || !second.ok) setError(t('failed'));
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-stone-200/70 bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-900">
          {title}
          <span className="ml-2 text-xs font-normal text-stone-400">
            {sorted.length}/{limits.maxPerGallery}
          </span>
        </h3>
        {canEdit && storageAvailable && (
          <label className="cursor-pointer rounded-md border border-stone-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70">
            {busy ? t('uploading') : t('addPhotos')}
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={busy !== null || full}
              onChange={(event) => void onFiles(event.target.files)}
              className="sr-only"
              aria-label={`${t('addPhotos')}: ${title}`}
            />
          </label>
        )}
      </div>

      {!storageAvailable && <p className="text-xs text-stone-500">{t('storageMissing')}</p>}

      {sorted.length === 0 ? (
        <p className="text-sm text-stone-500">{t('noPhotos')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {sorted.map((item, index) => (
            <li key={item.id} className="group relative overflow-hidden rounded-lg bg-sunk">
              {/* Plain <img>: the host is the bucket, not this app, and
                  next/image would need it allowlisted per deployment. */}
              <img
                src={item.url}
                alt={item.alt ?? ''}
                className="aspect-[4/3] w-full object-cover"
                loading="lazy"
              />
              {index === 0 && (
                <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-xs font-medium text-ink-700">
                  {t('coverPhoto')}
                </span>
              )}
              {canEdit && (
                <div className="absolute inset-x-0 bottom-0 flex justify-between gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || pending}
                      aria-label={t('moveEarlier')}
                      className="rounded bg-white/90 px-2 py-0.5 text-xs text-ink-700 disabled:opacity-40"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === sorted.length - 1 || pending}
                      aria-label={t('moveLater')}
                      className="rounded bg-white/90 px-2 py-0.5 text-xs text-ink-700 disabled:opacity-40"
                    >
                      →
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(item)}
                    disabled={pending}
                    aria-label={`${t('removePhoto')}: ${title} ${String(index + 1)}`}
                    className="rounded bg-white/90 px-2 py-0.5 text-xs text-red-700 disabled:opacity-40"
                  >
                    {t('removePhoto')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Shrink on a canvas so a 12-megapixel phone photo becomes a few hundred
 * kilobytes before it leaves the device. PNG stays PNG (screenshots, plans
 * with text); everything else is re-encoded as JPEG, which is what a photo
 * of a room wants to be. Falls back to the original bytes if decoding fails —
 * the server still enforces the size cap.
 */
async function shrink(
  file: File,
): Promise<{ blob: Blob; width: number | null; height: number | null }> {
  if (typeof createImageBitmap !== 'function') return { blob: file, width: null, height: null };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { blob: file, width: null, height: null };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  if (scale === 1 && file.type !== 'image/heic') {
    bitmap.close();
    return { blob: file, width, height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return { blob: file, width: bitmap.width, height: bitmap.height };
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, type === 'image/jpeg' ? JPEG_QUALITY : undefined),
  );
  return { blob: blob ?? file, width, height };
}
