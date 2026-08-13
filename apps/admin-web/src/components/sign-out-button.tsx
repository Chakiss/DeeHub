'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void fetch('/api/session/logout', { method: 'POST' }).then(() => {
          router.replace('/login');
          router.refresh();
        });
      }}
      className="rounded-md border border-white/25 px-3 py-1.5 text-stone-200 transition hover:bg-white/10 hover:text-white disabled:opacity-60"
    >
      {label}
    </button>
  );
}
