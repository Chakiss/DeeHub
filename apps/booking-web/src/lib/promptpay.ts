/**
 * A PromptPay QR payload (EMVCo merchant-presented QR, Thai QR Payment).
 *
 * Written here rather than pulled in: the format is forty lines, stable
 * since 2017, and a dependency for it would be a supply-chain risk on the
 * page that tells guests where to send money. Verified against the EMVCo
 * CRC check value and against payloads scanned with a bank app.
 *
 * Tag 29 (merchant account information) carries the PromptPay AID and the
 * target: a mobile number in international form (0812345678 → 0066812345678),
 * a 13-digit national id, or a 15-digit e-wallet id. Tag 54 carries the
 * amount, which makes the QR "dynamic" (tag 01 = 12): the bank app fills it
 * in and the guest cannot mistype it.
 */

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xor-out. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (const char of input) {
    crc ^= char.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** The target as PromptPay wants it, or null when it is not a PromptPay id at all. */
export function promptPayTarget(id: string): { tag: '01' | '02' | '03'; value: string } | null {
  const digits = id.replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) return { tag: '01', value: `0066${digits.slice(1)}` };
  if (/^\d{13}$/.test(digits)) return { tag: '02', value: digits };
  if (/^\d{15}$/.test(digits)) return { tag: '03', value: digits };
  return null;
}

/**
 * The full payload for `id`, with `amountMinor` satang baked in (THB only:
 * PromptPay is a Thai rail). Null when the id is not usable.
 */
export function promptPayPayload(id: string, amountMinor: number): string | null {
  const target = promptPayTarget(id);
  if (!target || !Number.isInteger(amountMinor) || amountMinor <= 0) return null;

  const amount = `${String(Math.trunc(amountMinor / 100))}.${String(amountMinor % 100).padStart(2, '0')}`;
  const body =
    field('00', '01') +
    field('01', '12') +
    field('29', field('00', 'A000000677010111') + field(target.tag, target.value)) +
    field('53', '764') +
    field('54', amount) +
    field('58', 'TH') +
    '6304';
  return body + crc16(body);
}
