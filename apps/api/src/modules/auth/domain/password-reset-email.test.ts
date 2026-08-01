import { describe, expect, it } from 'vitest';
import { renderPasswordResetEmail } from './password-reset-email';

const INPUT = {
  fullName: 'Somchai P.',
  organizationName: 'Baan Suan',
  link: 'https://admin.example.com/reset-password?token=abc123',
  expiresInMinutes: 60,
};

describe('renderPasswordResetEmail', () => {
  it.each(['en', 'th'] as const)('puts the link in the %s body', (locale) => {
    const { body } = renderPasswordResetEmail(INPUT, locale);
    expect(body).toContain(INPUT.link);
  });

  it.each(['en', 'th'] as const)('says how long the %s link lasts', (locale) => {
    const { body } = renderPasswordResetEmail(INPUT, locale);
    expect(body).toContain('60');
  });

  it.each(['en', 'th'] as const)('names the organization in the %s subject', (locale) => {
    const { subject } = renderPasswordResetEmail(INPUT, locale);
    expect(subject).toContain('Baan Suan');
  });

  it.each(['en', 'th'] as const)(
    'tells a %s recipient who did not ask that nothing has changed yet',
    (locale) => {
      // The only warning a victim of an attempted takeover gets, and the fact
      // that decides whether they need to act.
      const { body } = renderPasswordResetEmail(INPUT, locale);
      expect(body).toMatch(locale === 'th' ? /ยังไม่ถูกเปลี่ยน/ : /NOT been changed/);
    },
  );

  it('spaces the Thai honorific before a romanised name', () => {
    const { body } = renderPasswordResetEmail(INPUT, 'th');
    expect(body).toContain('คุณ Somchai P.');
  });

  it('runs the Thai honorific into a Thai name', () => {
    const { body } = renderPasswordResetEmail({ ...INPUT, fullName: 'สมชาย' }, 'th');
    expect(body).toContain('คุณสมชาย');
    expect(body).not.toContain('คุณ สมชาย');
  });
});
