import { redirect } from 'next/navigation';

/**
 * Nothing lives at the root: every hotel is at /{org}/{code}. A stranger who
 * typed the bare host is sent to the company site, which says what this is.
 */
export default function Home() {
  redirect(process.env.MARKETING_URL ?? 'https://deehubhotel.com');
}
