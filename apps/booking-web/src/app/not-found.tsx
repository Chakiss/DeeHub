import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main className="mx-auto max-w-lg px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold">{t('notFoundTitle')}</h1>
      <p className="mt-3 text-ink-700">{t('notFoundBody')}</p>
    </main>
  );
}
