import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // Cloud Run runs the server build; standalone keeps the image small.
  output: 'standalone',
  // Photos come from the media bucket, whose host is a deployment setting;
  // plain <img> is used instead of next/image so no host needs allowlisting.
  images: { unoptimized: true },
};

export default withNextIntl(nextConfig);
