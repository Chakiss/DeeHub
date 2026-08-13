import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { login, testData } from './helpers';
import { removeIsolatedRoomType, seedIsolatedRoomType, type IsolatedRoomType } from './fixtures';

/**
 * Checking a guest out who left before the night they paid for.
 *
 * The API suite proves the inventory arithmetic. This proves the only part a
 * clerk ever touches: that the question is ASKED when it should be, that it is
 * not asked when there is nothing to decide, and that each button does what its
 * label says. A wrong click here puts a room the hotel is still holding on sale
 * across every channel, so "the button did the other thing" is not a bug anyone
 * would find quickly in production.
 *
 * Its own room type, rates and physical room, for the reason booking.spec has
 * its own: the inventory and reservation specs assert absolute counts on the
 * shared fixture and this one books, checks in and releases.
 */

const API = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Real dates: a stay has to have begun before anyone can check out of it. */
const TODAY = bangkokToday();
const YESTERDAY = addDays(TODAY, -1);
/** Yesterday included: one case needs a stay that departs today as booked. */
const IN_HOUSE = [-1, 0, 1, 2, 3].map((offset) => addDays(TODAY, offset));

function pool(): Pool {
  return new Pool({
    connectionString:
      process.env['DATABASE_URL'] ?? 'postgresql://deehub:deehub@localhost:15432/deehub',
    max: 2,
  });
}

let room: IsolatedRoomType;
/*
 * One physical room per test. Check-out deliberately KEEPS the assignment —
 * "who was in 302 last Tuesday" is a question hotels ask — so the room stays
 * blocked for the dates of a stay that has ended, and a later test reusing it
 * is refused with "Room EC-1 is already taken".
 */
const roomIds = [randomUUID(), randomUUID(), randomUUID()];

test.beforeAll(async () => {
  const data = testData();
  room = await seedIsolatedRoomType(data, {
    code: 'ECO',
    name: 'Early Checkout Suite',
    dates: IN_HOUSE,
    // Two, so "back on sale" is a number a human can check rather than a
    // rounding difference in a pile of thirty.
    allotment: 2,
  });

  // seedIsolatedRoomType does not make physical rooms, and check-in refuses a
  // stay with none assigned — a guest cannot arrive without somewhere to sleep.
  const db = pool();
  try {
    for (const [index, id] of roomIds.entries()) {
      await db.query(
        `INSERT INTO physical_rooms (id, organization_id, property_id, room_type_id, room_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, data.organizationId, data.propertyId, room.roomTypeId, `EC-${index + 1}`],
      );
    }
  } finally {
    await db.end();
  }
});

test.afterAll(async () => {
  // Before the room type goes: physical_rooms references it with RESTRICT.
  // Stays point at the room with ON DELETE SET NULL, so this is safe while
  // their bookings still exist.
  const db = pool();
  try {
    await db.query('DELETE FROM physical_rooms WHERE id = ANY($1)', [roomIds]);
  } finally {
    await db.end();
  }
  await removeIsolatedRoomType(room);
});

async function apiToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const data = testData();
  const response = await request.post(`${API}/auth/login`, {
    data: {
      organizationSlug: data.organizationSlug,
      email: data.managerEmail,
      password: 'dashboard-e2e-password',
    },
  });
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

/** A guest in the building: booked, given the room, and checked in. */
async function arrive(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  guestName: string,
  checkOut: string,
  physicalRoomId: string,
): Promise<{ id: string; stayId: string }> {
  const data = testData();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const created = await request.post(`${API}/properties/${data.propertyId}/reservations`, {
    headers,
    data: {
      source: 'WALK_IN',
      booker: { name: guestName },
      stays: [
        {
          roomTypeId: room.roomTypeId,
          ratePlanId: room.ratePlanId,
          checkIn: TODAY,
          checkOut,
          adults: 2,
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const booking = (await created.json()) as {
    id: string;
    version: number;
    stays: { id: string }[];
  };

  const assigned = await request.patch(
    `${API}/properties/${data.propertyId}/stays/${booking.stays[0]!.id}/room`,
    { headers, data: { roomId: physicalRoomId } },
  );
  expect(assigned.ok(), await assigned.text()).toBeTruthy();

  const detail = await request.get(
    `${API}/properties/${data.propertyId}/reservations/${booking.id}`,
    { headers },
  );
  const { version } = (await detail.json()) as { version: number };

  const checkedIn = await request.post(
    `${API}/properties/${data.propertyId}/reservations/${booking.id}/check-in`,
    { headers, data: { version } },
  );
  expect(checkedIn.ok(), await checkedIn.text()).toBeTruthy();

  return { id: booking.id, stayId: booking.stays[0]!.id };
}

/**
 * Move a one-night stay back a day, so it DEPARTS today as booked.
 *
 * The API will not take a booking that arrived yesterday, and this is the only
 * shape that has nothing left to hand back — the case the screen must not ask
 * about. Inventory moves with it, so the ledger stays true.
 */
async function backdateToDepartToday(stayId: string): Promise<void> {
  const db = pool();
  try {
    await db.query('UPDATE reservation_stays SET check_in = $2, check_out = $3 WHERE id = $1', [
      stayId,
      YESTERDAY,
      TODAY,
    ]);
    await db.query('UPDATE reservation_stay_nights SET date = $2 WHERE stay_id = $1', [
      stayId,
      YESTERDAY,
    ]);
    await db.query(
      `UPDATE inventory_days SET booked = booked - 1
        WHERE room_type_id = $1 AND date = $2`,
      [room.roomTypeId, TODAY],
    );
    await db.query(
      `UPDATE inventory_days SET booked = booked + 1
        WHERE room_type_id = $1 AND date = $2`,
      [room.roomTypeId, YESTERDAY],
    );
  } finally {
    await db.end();
  }
}

/** How many of this room type are sold for a night, straight from the ledger. */
async function bookedOn(date: string): Promise<number> {
  const db = pool();
  try {
    const { rows } = await db.query<{ booked: string }>(
      'SELECT booked FROM inventory_days WHERE room_type_id = $1 AND date = $2',
      [room.roomTypeId, date],
    );
    return Number(rows[0]!.booked);
  } finally {
    await db.end();
  }
}

test.describe('a guest who leaves early', () => {
  test('is offered the choice, and putting the room back frees the night', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    // Two nights booked; they are walking out on the first.
    const booking = await arrive(
      request,
      token,
      'Preecha Wongsawat',
      addDays(TODAY, 2),
      roomIds[0]!,
    );
    expect(await bookedOn(TODAY)).toBe(1);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${booking.id}`);

    await page.getByRole('button', { name: 'Check-out' }).click();

    // The consequence has to be readable before the click, not after it.
    await expect(page.getByText('Leaving before the booked date')).toBeVisible();
    await expect(page.getByText(/Take the key back first/)).toBeVisible();

    await page.getByRole('button', { name: 'Check out and put the room back on sale' }).click();

    await expect(page.getByText('checked out')).toBeVisible();
    expect(await bookedOn(TODAY)).toBe(0);
  });

  test('can be checked out without giving the room back', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    const booking = await arrive(
      request,
      token,
      'Sunisa Thongchai',
      addDays(TODAY, 2),
      roomIds[1]!,
    );
    expect(await bookedOn(TODAY)).toBe(1);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${booking.id}`);

    await page.getByRole('button', { name: 'Check-out' }).click();
    await page.getByRole('button', { name: 'Check out and hold the room' }).click();

    await expect(page.getByText('checked out')).toBeVisible();
    // The other button, and the whole point of there being two: the night the
    // guest paid for stays sold.
    expect(await bookedOn(TODAY)).toBe(1);
  });

  test('is not asked anything when the booking ends today anyway', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    // One night, then moved back a day so today IS the booked departure:
    // nothing left to hand back, so nothing to ask about.
    const booking = await arrive(request, token, 'Chalerm Boonmee', addDays(TODAY, 1), roomIds[2]!);
    await backdateToDepartToday(booking.stayId);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${booking.id}`);

    await page.getByRole('button', { name: 'Check-out' }).click();

    // Straight through. An ordinary departure is the common case and must not
    // grow a question it cannot answer.
    await expect(page.getByText('checked out')).toBeVisible();
    await expect(page.getByText('Leaving before the booked date')).toBeHidden();
  });
});
