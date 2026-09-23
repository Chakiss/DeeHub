import type { Photo } from '@/lib/api';

/**
 * Plain <img>, lazy after the first: the host is the bucket, and the first
 * photo is the page's largest paint, so it loads eagerly and the rest wait.
 */
export function PhotoStrip({ photos, alt }: { photos: Photo[]; alt: string }) {
  if (photos.length === 0) return null;
  const [first, ...rest] = photos;
  if (!first) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <img
        src={first.url}
        alt={first.alt ?? alt}
        width={first.width ?? undefined}
        height={first.height ?? undefined}
        className="aspect-[4/3] w-full rounded-2xl object-cover sm:col-span-2 sm:row-span-2"
        fetchPriority="high"
      />
      {rest.slice(0, 2).map((photo) => (
        <img
          key={photo.url}
          src={photo.url}
          alt={photo.alt ?? alt}
          width={photo.width ?? undefined}
          height={photo.height ?? undefined}
          loading="lazy"
          className="hidden aspect-[4/3] w-full rounded-2xl object-cover sm:block"
        />
      ))}
    </div>
  );
}
