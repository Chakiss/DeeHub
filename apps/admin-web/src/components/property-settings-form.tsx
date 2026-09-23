'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { PropertyProfile } from '@/lib/api';
import { saveProperty } from '@/app/properties/[propertyId]/settings/actions';

const INPUT =
  'w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk disabled:text-stone-500';

/**
 * The hotel as a guest and Google will see it.
 *
 * Code, timezone, currency and tax are shown but not editable: each of them
 * is what stored prices and past bookings are denominated in, and changing
 * one from a form would silently re-label history. They change by migration
 * or in accounting settings, on purpose.
 */
export function PropertySettingsForm({
  propertyId,
  property,
  canEdit,
}: {
  propertyId: string;
  property: PropertyProfile;
  canEdit: boolean;
}) {
  const t = useTranslations('settings');

  const [name, setName] = useState(property.name);
  const [addressLine1, setAddressLine1] = useState(property.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(property.addressLine2 ?? '');
  const [city, setCity] = useState(property.city ?? '');
  const [postalCode, setPostalCode] = useState(property.postalCode ?? '');
  const [phone, setPhone] = useState(property.phone ?? '');
  const [email, setEmail] = useState(property.email ?? '');
  const [website, setWebsite] = useState(property.website ?? '');
  const [latitude, setLatitude] = useState(
    property.latitude === null ? '' : String(property.latitude),
  );
  const [longitude, setLongitude] = useState(
    property.longitude === null ? '' : String(property.longitude),
  );
  const [descriptionTh, setDescriptionTh] = useState(property.descriptionTh ?? '');
  const [descriptionEn, setDescriptionEn] = useState(property.descriptionEn ?? '');
  const [amenities, setAmenities] = useState(property.amenities.join(', '));
  const [checkInTime, setCheckInTime] = useState(property.checkInTime.slice(0, 5));
  const [checkOutTime, setCheckOutTime] = useState(property.checkOutTime.slice(0, 5));

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    const lat = latitude.trim() === '' ? null : Number(latitude);
    const lng = longitude.trim() === '' ? null : Number(longitude);
    if ((lat === null) !== (lng === null)) {
      setError(t('coordinatesPair'));
      return;
    }
    if ((lat !== null && !Number.isFinite(lat)) || (lng !== null && !Number.isFinite(lng))) {
      setError(t('coordinatesInvalid'));
      return;
    }

    setSaving(true);
    const result = await saveProperty(propertyId, {
      name: name.trim(),
      addressLine1: addressLine1.trim() || null,
      addressLine2: addressLine2.trim() || null,
      city: city.trim() || null,
      postalCode: postalCode.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      website: website.trim() || null,
      latitude: lat,
      longitude: lng,
      descriptionTh: descriptionTh.trim() || null,
      descriptionEn: descriptionEn.trim() || null,
      amenities: amenities
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
      checkInTime,
      checkOutTime,
    });
    setSaving(false);

    if (!result.ok) {
      setError(result.error?.message ?? t('failed'));
      return;
    }
    setSaved(true);
  }

  const mapsLink =
    property.latitude !== null && property.longitude !== null
      ? `https://www.google.com/maps?q=${String(property.latitude)},${String(property.longitude)}`
      : null;

  return (
    <form onSubmit={onSubmit} className="max-w-3xl space-y-6">
      <fieldset disabled={!canEdit} className="space-y-6">
        <Section title={t('identity')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ps-name" label={t('name')}>
              <input
                id="ps-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={200}
                className={INPUT}
              />
            </Field>
            <Field id="ps-code" label={t('code')} hint={t('fixedHint')}>
              <input id="ps-code" value={property.code} disabled className={INPUT} />
            </Field>
            <Field id="ps-phone" label={t('phone')}>
              <input
                id="ps-phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                maxLength={40}
                className={INPUT}
              />
            </Field>
            <Field id="ps-email" label={t('email')}>
              <input
                id="ps-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={320}
                className={INPUT}
              />
            </Field>
            <Field id="ps-website" label={t('website')} hint={t('websiteHint')}>
              <input
                id="ps-website"
                type="url"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                maxLength={500}
                placeholder="https://"
                className={INPUT}
              />
            </Field>
          </div>
        </Section>

        <Section title={t('address')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ps-address1" label={t('addressLine1')}>
              <input
                id="ps-address1"
                value={addressLine1}
                onChange={(event) => setAddressLine1(event.target.value)}
                maxLength={200}
                className={INPUT}
              />
            </Field>
            <Field id="ps-address2" label={t('addressLine2')}>
              <input
                id="ps-address2"
                value={addressLine2}
                onChange={(event) => setAddressLine2(event.target.value)}
                maxLength={200}
                className={INPUT}
              />
            </Field>
            <Field id="ps-city" label={t('city')}>
              <input
                id="ps-city"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                maxLength={120}
                className={INPUT}
              />
            </Field>
            <Field id="ps-postal" label={t('postalCode')}>
              <input
                id="ps-postal"
                value={postalCode}
                onChange={(event) => setPostalCode(event.target.value)}
                maxLength={20}
                className={INPUT}
              />
            </Field>
            <Field id="ps-lat" label={t('latitude')} hint={t('coordinatesHint')}>
              <input
                id="ps-lat"
                inputMode="decimal"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="12.9236"
                className={INPUT}
              />
            </Field>
            <Field id="ps-lng" label={t('longitude')}>
              <input
                id="ps-lng"
                inputMode="decimal"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="100.8825"
                className={INPUT}
              />
            </Field>
          </div>
          {mapsLink && (
            <a
              href={mapsLink}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-brand-600 hover:text-brand-700"
            >
              {t('checkOnMap')}
            </a>
          )}
        </Section>

        <Section title={t('description')}>
          <Field id="ps-desc-th" label={t('descriptionTh')}>
            <textarea
              id="ps-desc-th"
              value={descriptionTh}
              onChange={(event) => setDescriptionTh(event.target.value)}
              rows={4}
              maxLength={4000}
              className={INPUT}
            />
          </Field>
          <Field id="ps-desc-en" label={t('descriptionEn')}>
            <textarea
              id="ps-desc-en"
              value={descriptionEn}
              onChange={(event) => setDescriptionEn(event.target.value)}
              rows={4}
              maxLength={4000}
              className={INPUT}
            />
          </Field>
          <Field id="ps-amenities" label={t('amenities')} hint={t('amenitiesHint')}>
            <input
              id="ps-amenities"
              value={amenities}
              onChange={(event) => setAmenities(event.target.value)}
              placeholder="Free Wi-Fi, Parking, Pool"
              className={INPUT}
            />
          </Field>
        </Section>

        <Section title={t('times')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ps-checkin" label={t('checkInTime')}>
              <input
                id="ps-checkin"
                type="time"
                value={checkInTime}
                onChange={(event) => setCheckInTime(event.target.value)}
                required
                className={INPUT}
              />
            </Field>
            <Field id="ps-checkout" label={t('checkOutTime')}>
              <input
                id="ps-checkout"
                type="time"
                value={checkOutTime}
                onChange={(event) => setCheckOutTime(event.target.value)}
                required
                className={INPUT}
              />
            </Field>
          </div>
          <p className="text-xs text-stone-500">
            {t('fixedSummary', {
              timezone: property.timezone,
              currency: property.currency,
              tax: property.taxRateBp / 100,
              serviceCharge: property.serviceChargeRateBp / 100,
            })}
          </p>
        </Section>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {t('saved')}
        </p>
      )}

      {canEdit && (
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      )}
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border border-stone-200/70 bg-white p-5 shadow-card">
      <h2 className="text-base font-medium text-ink-900">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-400">{hint}</span>}
    </div>
  );
}
