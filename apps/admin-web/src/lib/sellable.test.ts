import { describe, expect, it } from 'vitest';
import type { InventoryGrid } from '@/lib/api';
import { sellableByRoomType, sellableUnits } from './sellable';

const day = { open: true, stopSell: false, allotment: 3, booked: 1 };

describe('sellableUnits', () => {
  it('is allotment minus booked on an open night', () => {
    expect(sellableUnits(day)).toBe(2);
  });
  it('is zero when stop-sold', () => {
    expect(sellableUnits({ ...day, stopSell: true })).toBe(0);
  });
  it('is zero when the night is closed', () => {
    expect(sellableUnits({ ...day, open: false })).toBe(0);
  });
  it('is zero, never negative, when oversold', () => {
    expect(sellableUnits({ ...day, booked: 5 })).toBe(0);
  });
});

describe('sellableByRoomType', () => {
  it('maps room type to date to sellable units', () => {
    const grid = {
      from: '2026-10-01',
      to: '2026-10-03',
      roomTypes: [
        {
          roomTypeId: 'rt1',
          code: 'DLX',
          name: 'Deluxe',
          days: [
            { ...day, date: '2026-10-01' },
            { ...day, date: '2026-10-02', stopSell: true },
          ],
        },
      ],
    } as unknown as InventoryGrid;
    expect(sellableByRoomType(grid)).toEqual({ rt1: { '2026-10-01': 2, '2026-10-02': 0 } });
  });
  it('is empty when the grid is unavailable', () => {
    expect(sellableByRoomType(null)).toEqual({});
  });
});
