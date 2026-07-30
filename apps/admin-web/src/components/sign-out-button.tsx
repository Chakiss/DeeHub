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
      className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
    >
      {label}
    </button>
  );
}
