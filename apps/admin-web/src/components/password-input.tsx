'use client';

import { useTranslations } from 'next-intl';
import { useState, type ComponentPropsWithoutRef } from 'react';

/**
 * A password field with a way to see what was typed.
 *
 * Front-desk staff type passwords on phones, often with a Thai keyboard one
 * tap away from the Latin one. A masked field cannot tell them which layout
 * the last three characters landed on; this can. Revealing is a deliberate
 * click and lasts only until the page goes away — nothing is remembered.
 *
 * The toggle is a sibling of the input, never a child of its `<label>`, so
 * clicking it does not also focus the field, and its own name ("Show
 * password") does not leak into the input's accessible name.
 */
export function PasswordInput({
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'type'>) {
  const t = useTranslations('common');
  const [shown, setShown] = useState(false);
  const label = shown ? t('hidePassword') : t('showPassword');

  return (
    <div className="relative">
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        className={`${className ?? defaultClass} pr-10`}
      />
      <button
        type="button"
        onClick={() => setShown((current) => !current)}
        aria-label={label}
        title={label}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-stone-400 transition hover:text-ink-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
}

const defaultClass =
  'w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="m2.5 2.5 11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
