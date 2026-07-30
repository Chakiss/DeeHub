import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Cloud Run runs the server build; standalone keeps the image small.
  output: 'standalone',
  // The API base URL is read at request time on the server, never shipped to
  // the browser: all API calls go through this app's own route handlers.
  serverExternalPackages: [],
};

export default withNextIntl(nextConfig);
