import { describe, expect, it } from 'vitest';
import { crc16, promptPayPayload, promptPayTarget } from './promptpay';

describe('promptpay', () => {
  it('computes CRC-16/CCITT-FALSE (the EMVCo check value)', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('turns a Thai mobile number into its international PromptPay form', () => {
    expect(promptPayTarget('081-234-5678')).toEqual({ tag: '01', value: '0066812345678' });
    expect(promptPayTarget('1234567890123')).toEqual({ tag: '02', value: '1234567890123' });
    expect(promptPayTarget('123456789012345')).toEqual({ tag: '03', value: '123456789012345' });
    expect(promptPayTarget('12345')).toBeNull();
  });

  it('builds a dynamic payload with the amount baked in', () => {
    // The CRC was cross-checked with an independent implementation.
    expect(promptPayPayload('0812345678', 45000)).toBe(
      '00020101021229370016A0000006770101110113006681234567853037645406450.005802TH6304ECFA',
    );
  });

  it('refuses a bad id or a non-positive amount', () => {
    expect(promptPayPayload('abc', 45000)).toBeNull();
    expect(promptPayPayload('0812345678', 0)).toBeNull();
    expect(promptPayPayload('0812345678', 12.5)).toBeNull();
  });
});
