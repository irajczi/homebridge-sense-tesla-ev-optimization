import { AppConfig } from './config.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'homebridge-ev-solar-charger/0.9.0 (https://github.com/irajczi/homebridge-sense-tesla-ev-optimization)';
const OSM_ATTRIBUTION = 'Geocoding by OpenStreetMap Nominatim. Data copyright OpenStreetMap contributors.';
const DEFAULT_HOME_RADIUS_METERS = 150;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface GeocodedAddress extends Coordinates {
  address: string;
  displayName: string;
  suggestedTimezone: string;
  attribution: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: {
    country_code?: string;
    state?: string;
    province?: string;
  };
}

export function needsAddressResolution(home: AppConfig['home'] | undefined): boolean {
  if (!home?.address?.trim()) return false;
  return !hasHomeCoordinates(home) ||
    !home.timezone?.trim() ||
    home.address.trim() !== home.address_last_resolved?.trim();
}

export async function geocodeHomeAddress(address: string): Promise<GeocodedAddress> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Address lookup failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
  }

  const results = (await res.json()) as NominatimResult[];
  const first = results[0];
  if (!first) {
    throw new Error(`Address lookup found no result for "${address}"`);
  }

  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`Address lookup returned invalid coordinates for "${address}"`);
  }

  return {
    address,
    latitude,
    longitude,
    displayName: first.display_name,
    suggestedTimezone: suggestTimezone(first.address),
    attribution: OSM_ATTRIBUTION,
  };
}

export function hasHomeCoordinates(home: AppConfig['home'] | undefined): home is Required<Pick<NonNullable<AppConfig['home']>, 'latitude' | 'longitude'>> & AppConfig['home'] {
  return typeof home?.latitude === 'number' && typeof home.longitude === 'number';
}

export function getHomeRadiusMeters(home: AppConfig['home'] | undefined): number {
  return home?.radius_meters ?? DEFAULT_HOME_RADIUS_METERS;
}

export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const earthRadiusMeters = 6_371_000;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const hav =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
}

export function isWithinHomeRadius(
  carLocation: Coordinates,
  home: AppConfig['home'],
): { atHome: boolean; distanceMeters: number; radiusMeters: number } {
  if (!hasHomeCoordinates(home)) {
    throw new Error('Home coordinates are not configured');
  }

  const radiusMeters = getHomeRadiusMeters(home);
  const distance = distanceMeters(carLocation, {
    latitude: home.latitude,
    longitude: home.longitude,
  });

  return {
    atHome: distance <= radiusMeters,
    distanceMeters: distance,
    radiusMeters,
  };
}

export function nextSunriseWake(
  now: Date,
  latitude: number,
  longitude: number,
  timeZone: string,
  wakeAfterSunriseMinutes: number,
): Date {
  let local = getLocalDateParts(now, timeZone);
  let wake = addMinutes(sunriseUtc(local.year, local.month, local.day, latitude, longitude), wakeAfterSunriseMinutes);

  if (wake.getTime() <= now.getTime()) {
    local = addLocalDays(local, 1);
    wake = addMinutes(sunriseUtc(local.year, local.month, local.day, latitude, longitude), wakeAfterSunriseMinutes);
  }

  return wake;
}

export function nextLocalClockTime(
  now: Date,
  timeZone: string,
  clockTime: string,
): Date {
  const [hour, minute] = clockTime.split(':').map(Number);
  let local = getLocalDateParts(now, timeZone);
  let target = localClockTimeToUtc(local.year, local.month, local.day, hour, minute, timeZone);

  if (target.getTime() <= now.getTime()) {
    local = addLocalDays(local, 1);
    target = localClockTimeToUtc(local.year, local.month, local.day, hour, minute, timeZone);
  }

  return target;
}

function suggestTimezone(address: NominatimResult['address']): string {
  const country = address?.country_code?.toUpperCase();
  const state = normalizeState(address?.state ?? address?.province);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

  if (country === 'CA') {
    return CANADA_TIMEZONES[state] ?? localTimeZone;
  }
  if (country === 'US') {
    return US_TIMEZONES[state] ?? localTimeZone;
  }
  return localTimeZone;
}

function normalizeState(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

const US_TIMEZONES: Record<string, string> = {
  alabama: 'America/Chicago',
  alaska: 'America/Anchorage',
  arizona: 'America/Phoenix',
  arkansas: 'America/Chicago',
  california: 'America/Los_Angeles',
  colorado: 'America/Denver',
  connecticut: 'America/New_York',
  delaware: 'America/New_York',
  florida: 'America/New_York',
  georgia: 'America/New_York',
  hawaii: 'Pacific/Honolulu',
  idaho: 'America/Boise',
  illinois: 'America/Chicago',
  indiana: 'America/Indiana/Indianapolis',
  iowa: 'America/Chicago',
  kansas: 'America/Chicago',
  kentucky: 'America/New_York',
  louisiana: 'America/Chicago',
  maine: 'America/New_York',
  maryland: 'America/New_York',
  massachusetts: 'America/New_York',
  michigan: 'America/Detroit',
  minnesota: 'America/Chicago',
  mississippi: 'America/Chicago',
  missouri: 'America/Chicago',
  montana: 'America/Denver',
  nebraska: 'America/Chicago',
  nevada: 'America/Los_Angeles',
  'new hampshire': 'America/New_York',
  'new jersey': 'America/New_York',
  'new mexico': 'America/Denver',
  'new york': 'America/New_York',
  'north carolina': 'America/New_York',
  'north dakota': 'America/Chicago',
  ohio: 'America/New_York',
  oklahoma: 'America/Chicago',
  oregon: 'America/Los_Angeles',
  pennsylvania: 'America/New_York',
  'rhode island': 'America/New_York',
  'south carolina': 'America/New_York',
  'south dakota': 'America/Chicago',
  tennessee: 'America/Chicago',
  texas: 'America/Chicago',
  utah: 'America/Denver',
  vermont: 'America/New_York',
  virginia: 'America/New_York',
  washington: 'America/Los_Angeles',
  'west virginia': 'America/New_York',
  wisconsin: 'America/Chicago',
  wyoming: 'America/Denver',
  'district of columbia': 'America/New_York',
};

const CANADA_TIMEZONES: Record<string, string> = {
  alberta: 'America/Edmonton',
  'british columbia': 'America/Vancouver',
  manitoba: 'America/Winnipeg',
  'new brunswick': 'America/Moncton',
  'newfoundland and labrador': 'America/St_Johns',
  'nova scotia': 'America/Halifax',
  ontario: 'America/Toronto',
  'prince edward island': 'America/Halifax',
  quebec: 'America/Toronto',
  saskatchewan: 'America/Regina',
  'northwest territories': 'America/Yellowknife',
  nunavut: 'America/Iqaluit',
  yukon: 'America/Whitehorse',
};

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

function getLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function localClockTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMs = timeZoneOffsetMs(guess, timeZone);
  let utc = new Date(guess.getTime() - offsetMs);

  const actual = getLocalDateTimeParts(utc, timeZone);
  const deltaMinutes =
    ((year - actual.year) * 366 * 24 * 60) +
    ((dayOfYear(year, month, day) - dayOfYear(actual.year, actual.month, actual.day)) * 24 * 60) +
    ((hour - actual.hour) * 60) +
    (minute - actual.minute);

  if (deltaMinutes !== 0) {
    utc = new Date(utc.getTime() + deltaMinutes * 60_000);
  }

  return utc;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getLocalDateTimeParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - date.getTime();
}

function getLocalDateTimeParts(date: Date, timeZone: string): LocalDateParts & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function addLocalDays(date: LocalDateParts, days: number): LocalDateParts {
  const utc = Date.UTC(date.year, date.month - 1, date.day + days);
  const next = new Date(utc);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function sunriseUtc(year: number, month: number, day: number, latitude: number, longitude: number): Date {
  const zenith = 90.833;
  const n = dayOfYear(year, month, day);
  const lngHour = longitude / 15;
  const t = n + (6 - lngHour) / 24;
  const m = (0.9856 * t) - 3.289;
  let l = m + (1.916 * sinDeg(m)) + (0.020 * sinDeg(2 * m)) + 282.634;
  l = normalizeDegrees(l);

  let rightAscension = atanDeg(0.91764 * tanDeg(l));
  rightAscension = normalizeDegrees(rightAscension);
  rightAscension += Math.floor(l / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;

  const sinDec = 0.39782 * sinDeg(l);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (cosDeg(zenith) - sinDec * sinDeg(latitude)) / (cosDec * cosDeg(latitude));

  if (cosH > 1 || cosH < -1) {
    return new Date(Date.UTC(year, month - 1, day, 6));
  }

  const h = (360 - acosDeg(cosH)) / 15;
  const localMeanTime = h + rightAscension - (0.06571 * t) - 6.622;
  const utcHour = normalizeHours(localMeanTime - lngHour);

  const hour = Math.floor(utcHour);
  const minuteFloat = (utcHour - hour) * 60;
  const minute = Math.floor(minuteFloat);
  const second = Math.round((minuteFloat - minute) * 60);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function dayOfYear(year: number, month: number, day: number): number {
  const start = Date.UTC(year, 0, 0);
  const current = Date.UTC(year, month - 1, day);
  return Math.floor((current - start) / 86_400_000);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function sinDeg(value: number): number {
  return Math.sin(toRadians(value));
}

function cosDeg(value: number): number {
  return Math.cos(toRadians(value));
}

function tanDeg(value: number): number {
  return Math.tan(toRadians(value));
}

function atanDeg(value: number): number {
  return Math.atan(value) * 180 / Math.PI;
}

function acosDeg(value: number): number {
  return Math.acos(value) * 180 / Math.PI;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function normalizeHours(value: number): number {
  return ((value % 24) + 24) % 24;
}
