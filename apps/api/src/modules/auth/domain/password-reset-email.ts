import type { Locale } from '../../notifications/domain/templates';

/**
 * What the reset email says, in Thai and English (ADR-0003).
 *
 * Pure functions, like the booking templates, and for the same reason: this is
 * text a hotelier will want to argue about, so it has to be readable and
 * testable without a running system.
 *
 * Two things are here on purpose and should stay:
 *
 * - **The expiry, stated.** Someone who comes back to the link two hours later
 *   and finds it dead should already know why.
 * - **"If this wasn't you".** A reset email is what an account takeover looks
 *   like from the victim's side, and it is the only warning they get. It says
 *   the password has NOT changed yet, because that is the fact that decides
 *   whether they need to do anything.
 */

export interface ResetEmailInput {
  readonly fullName: string;
  readonly organizationName: string;
  readonly link: string;
  readonly expiresInMinutes: number;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly body: string;
}

export function renderPasswordResetEmail(input: ResetEmailInput, locale: Locale): RenderedEmail {
  return locale === 'th' ? resetTh(input) : resetEn(input);
}

/** `คุณสมชาย`, but `คุณ Chakrit` — see notifications/domain/templates.ts. */
function thaiHonorific(name: string): string {
  const trimmed = name.trim();
  return /^[\u0E00-\u0E7F]/.test(trimmed) ? `คุณ${trimmed}` : `คุณ ${trimmed}`;
}

function resetEn(input: ResetEmailInput): RenderedEmail {
  return {
    subject: `Reset your ${input.organizationName} password`,
    body: `Dear ${input.fullName},

Someone asked to reset the password for your ${input.organizationName} account.
Open this link to choose a new one:

${input.link}

The link works once and expires in ${String(input.expiresInMinutes)} minutes.

If this was not you, your password has NOT been changed and there is nothing
you need to do — the link above is the only thing that could change it, and it
is in this mailbox. Tell your manager if you keep receiving these.

DeeHub`,
  };
}

function resetTh(input: ResetEmailInput): RenderedEmail {
  return {
    subject: `ตั้งรหัสผ่านใหม่สำหรับ ${input.organizationName}`,
    body: `เรียน ${thaiHonorific(input.fullName)}

มีการขอตั้งรหัสผ่านใหม่สำหรับบัญชี ${input.organizationName} ของท่าน
กรุณาเปิดลิงก์นี้เพื่อตั้งรหัสผ่านใหม่

${input.link}

ลิงก์นี้ใช้ได้ครั้งเดียว และหมดอายุใน ${String(input.expiresInMinutes)} นาที

หากท่านไม่ได้เป็นผู้ขอ รหัสผ่านของท่าน "ยังไม่ถูกเปลี่ยน" และท่านไม่ต้องดำเนินการใด ๆ
เนื่องจากลิงก์ข้างต้นเป็นสิ่งเดียวที่เปลี่ยนรหัสผ่านได้ และอยู่ในกล่องจดหมายนี้เท่านั้น
หากยังได้รับอีเมลลักษณะนี้อย่างต่อเนื่อง กรุณาแจ้งผู้ดูแลระบบ

DeeHub`,
  };
}
