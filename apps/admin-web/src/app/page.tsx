import { redirect } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * Entry point: send the user to their property.
 *
 * Most customers run one hotel, so a picker would be a click they never need.
 * With several, the first is a reasonable default and the switcher is in the
 * header.
 */
export default async function HomePage() {
  const properties = await api.properties();

  if (properties.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-lg font-medium text-slate-900">No properties yet</h1>
          <p className="mt-2 max-w-sm text-sm text-slate-500">
            Your account has no property access. Ask an administrator to add you to a property.
          </p>
        </div>
      </main>
    );
  }

  redirect(`/properties/${properties[0]!.id}/inventory`);
}
