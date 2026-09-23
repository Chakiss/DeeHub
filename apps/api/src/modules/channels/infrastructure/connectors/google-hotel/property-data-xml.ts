import { attrs, esc, timestamp } from './xml';

export interface CatalogRoom {
  readonly externalRoomId: string;
  readonly name: string;
  readonly description: string | null;
  readonly maxOccupancy: number;
}

export interface CatalogPackage {
  readonly externalRateId: string;
  readonly name: string;
  readonly description: string | null;
  readonly refundable: boolean;
  readonly breakfastIncluded: boolean;
}

/**
 * Google's "Transaction (Property Data)" message: what a room and a package
 * are, so the ARI messages that follow have something to price. `overlay`
 * replaces the whole set for this property, which keeps a renamed or retired
 * room from lingering on Google under an old name.
 */
export function buildPropertyData(
  partner: string,
  hotelCode: string,
  rooms: readonly CatalogRoom[],
  packages: readonly CatalogPackage[],
  language: string,
  now: Date = new Date(),
): string {
  const text = (value: string) => `<Text${attrs({ text: value, language })}/>`;
  const roomData = rooms
    .map(
      (room) =>
        `<RoomData>` +
        `<RoomID>${esc(room.externalRoomId)}</RoomID>` +
        `<Name>${text(room.name)}</Name>` +
        `<Description>${text(room.description ?? room.name)}</Description>` +
        `<Capacity>${esc(room.maxOccupancy)}</Capacity>` +
        `</RoomData>`,
    )
    .join('');
  const packageData = packages
    .map(
      (pkg) =>
        `<PackageData>` +
        `<PackageID>${esc(pkg.externalRateId)}</PackageID>` +
        `<Name>${text(pkg.name)}</Name>` +
        `<Description>${text(pkg.description ?? pkg.name)}</Description>` +
        `<Refundable${attrs({ available: pkg.refundable ? 'true' : 'false' })}/>` +
        `<BreakfastIncluded>${pkg.breakfastIncluded ? '1' : '0'}</BreakfastIncluded>` +
        `</PackageData>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Transaction${attrs({ timestamp: timestamp(now), id: String(now.getTime()), partner })}>` +
    `<PropertyDataSet${attrs({ action: 'overlay' })}>` +
    `<Property>${esc(hotelCode)}</Property>` +
    roomData +
    packageData +
    `</PropertyDataSet>` +
    `</Transaction>`
  );
}
