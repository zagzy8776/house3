import { describe, expect, it } from 'vitest';
import {
  assertAuthorized,
  UnauthorizedInventoryError,
  UnsupportedChannelError,
  type AuthorizationRecord
} from '@/inventory/types';
import { createAdapter, isSupportedChannel, SUPPORTED_CHANNELS } from '@/inventory/registry';
import {
  blockedNightsFromEvents,
  IcalFeedAdapter,
  parseIcalEvents,
  parseUnitConfig,
  unfoldIcal
} from '@/inventory/icalAdapter';

const NOW = '2026-04-01T09:00:00.000Z';

const publishedFeed: AuthorizationRecord = {
  kind: 'ICAL_FEED',
  basis: 'PARTNER_PUBLISHED_FEED',
  reference: 'supply-agreement-H3-0042',
  grantedAt: '2026-01-05T00:00:00.000Z',
  expiresAt: null,
  partnerId: 'p_lekki_1'
};

describe('authorization guard', () => {
  it('accepts a valid, unexpired record', () => {
    expect(assertAuthorized(publishedFeed, NOW).reference).toBe('supply-agreement-H3-0042');
  });

  it('refuses inventory with no authorization at all', () => {
    expect(() => assertAuthorized(null, NOW)).toThrow(UnauthorizedInventoryError);
    expect(() => assertAuthorized(undefined, NOW)).toThrow(UnauthorizedInventoryError);
  });

  it('refuses a basis that does not match the channel', () => {
    const mismatch: AuthorizationRecord = { ...publishedFeed, basis: 'AFFILIATE_PROGRAM_TERMS' };
    expect(() => assertAuthorized(mismatch, NOW)).toThrow(UnauthorizedInventoryError);
  });

  it('refuses an expired record', () => {
    const expired: AuthorizationRecord = { ...publishedFeed, expiresAt: '2026-03-01T00:00:00.000Z' };
    expect(() => assertAuthorized(expired, NOW)).toThrow(/expired/);
  });

  it('refuses a record with no paper trail', () => {
    expect(() => assertAuthorized({ ...publishedFeed, reference: '  ' }, NOW)).toThrow(
      UnauthorizedInventoryError
    );
  });
});

describe('adapter registry', () => {
  it('only supports consented channels', () => {
    expect(SUPPORTED_CHANNELS).toHaveLength(4);
    expect(isSupportedChannel('ICAL_FEED')).toBe(true);
    expect(isSupportedChannel('SCRAPER')).toBe(false);
    expect(isSupportedChannel('PUBLIC_WEB_SCRAPE')).toBe(false);
  });

  it('rejects an unsupported channel loudly', () => {
    expect(() =>
      createAdapter({ partnerId: 'p1', channel: 'SCRAPER', authorization: null, config: {} })
    ).toThrow(UnsupportedChannelError);
  });

  it('rejects an authorization issued to a different partner', () => {
    expect(() =>
      createAdapter({
        partnerId: 'p_other',
        channel: 'ICAL_FEED',
        authorization: publishedFeed,
        config: {}
      })
    ).toThrow(/granted to partner p_lekki_1/);
  });
});

describe('ical parsing', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:booking-8812',
    'SUMMARY:Booked via Airbnb',
    'DTSTART;VALUE=DATE:20260410',
    'DTEND;VALUE=DATE:20260413',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:owner-block',
    'SUMMARY:Owner',
    'DTSTART;VALUE=DATE:20260420',
    'DTEND;VALUE=DATE:20260421',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  it('parses events into blocked nights', () => {
    const events = parseIcalEvents(feed);
    expect(events).toHaveLength(2);
    expect(blockedNightsFromEvents(events)).toEqual([
      '2026-04-10',
      '2026-04-11',
      '2026-04-12',
      '2026-04-20'
    ]);
  });

  it('unfolds folded lines before parsing', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:fold',
      'DTSTART;VALUE=DATE:20',
      ' 260501',
      'DTEND;VALUE=DATE:20260502',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\n');
    expect(parseIcalEvents(folded)[0]?.start).toBe('2026-05-01');
  });

  it('ignores malformed events rather than inventing a stay window', () => {
    const broken = ['BEGIN:VEVENT', 'UID:x', 'DTSTART;VALUE=DATE:20260501', 'END:VEVENT'].join('\n');
    expect(parseIcalEvents(broken)).toEqual([]);
  });

  it('drops blank lines when unfolding', () => {
    expect(unfoldIcal('BEGIN:VCALENDAR\n\nEND:VCALENDAR')).toEqual(['BEGIN:VCALENDAR', 'END:VCALENDAR']);
  });
});

describe('ical unit config', () => {
  it('requires a url and an id per unit', () => {
    expect(() => parseUnitConfig('[{"externalId":"a"}]', 'p1')).toThrow(/icalUrl/);
    expect(() => parseUnitConfig('[{"icalUrl":"https://x/y.ics"}]', 'p1')).toThrow(/externalId/);
  });

  it('fills sensible shortlet defaults', () => {
    const parsed = parseUnitConfig(
      '[{"externalId":"lekki-2bed","icalUrl":"https://pms.example/lekki-2bed.ics","nightlyRateKobo":15000000}]',
      'p_lekki_1'
    );
    expect(parsed[0]).toMatchObject({
      partnerId: 'p_lekki_1',
      unitType: 'APARTMENT',
      minNights: 1,
      maxNights: 30,
      nightlyRateKobo: 15_000_000
    });
  });
});

describe('IcalFeedAdapter.fetchSnapshot', () => {
  const unitConfig = JSON.stringify([
    { externalId: 'lekki-2bed', icalUrl: 'https://pms.example/lekki-2bed.ics', nightlyRateKobo: 15_000_000 }
  ]);

  it('refuses to fetch without authorization', async () => {
    const adapter = new IcalFeedAdapter({ authorization: null });
    await expect(
      adapter.fetchSnapshot({ partnerId: 'p_lekki_1', config: { units: unitConfig }, now: NOW })
    ).rejects.toThrow(UnauthorizedInventoryError);
  });

  it('converts the partner feed into CLOSED nights', async () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:1',
      'DTSTART;VALUE=DATE:20260410',
      'DTEND;VALUE=DATE:20260412',
      'END:VEVENT'
    ].join('\n');
    const fetchImpl = (async () => new Response(ical, { status: 200 })) as unknown as typeof fetch;

    const adapter = new IcalFeedAdapter({ authorization: publishedFeed, fetchImpl });
    const snapshot = await adapter.fetchSnapshot({
      partnerId: 'p_lekki_1',
      config: { units: unitConfig, origin: 'https://pms.example' },
      now: NOW
    });

    expect(snapshot.units).toHaveLength(1);
    expect(snapshot.units[0]).not.toHaveProperty('icalUrl');
    expect(snapshot.availability.map((night) => night.night)).toEqual(['2026-04-10', '2026-04-11']);
    expect(snapshot.availability.every((night) => night.state === 'CLOSED')).toBe(true);
  });

  it('rejects a calendar URL outside the declared origin', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const adapter = new IcalFeedAdapter({ authorization: publishedFeed, fetchImpl });

    await expect(
      adapter.fetchSnapshot({
        partnerId: 'p_lekki_1',
        config: { units: unitConfig, origin: 'https://other.example' },
        now: NOW
      })
    ).rejects.toThrow(/outside the declared origin/);
  });

  it('surfaces upstream HTTP failures instead of silently returning no inventory', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const adapter = new IcalFeedAdapter({ authorization: publishedFeed, fetchImpl });

    await expect(
      adapter.fetchSnapshot({ partnerId: 'p_lekki_1', config: { units: unitConfig }, now: NOW })
    ).rejects.toThrow(/HTTP 503/);
  });
});

