/**
 * Discovery and referral tests.
 *
 * House3 does not take bookings or payments. What it must do is tell a guest what a
 * place costs and where to reach the property. These tests pin that.
 */

import { describe, expect, it } from 'vitest';
import {
  contactConfidence,
  contactRoutes,
  isHouse3Bookable,
  isSameHost,
  primaryRoute,
  type ContactEvidence
} from '@/domain/contact';

const base: ContactEvidence = {
  sourceUrl: 'https://nigeriapropertycentre.com/for-rent/short-let/flats-apartments/lagos/lekki/x-3690250',
  sourceName: 'Nigeria Property Centre',
  operatorName: null,
  operatorWebsite: null,
  phone: null,
  instagram: null
};

describe('contact routes', () => {
  it('always offers the source listing, so a guest can always reach the place', () => {
    const routes = contactRoutes(base);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.kind).toBe('SOURCE_LISTING');
    expect(routes[0]?.destination).toBe(base.sourceUrl);
    expect(primaryRoute(routes).kind).toBe('SOURCE_LISTING');
  });

  it('offers a call when the listing published a number', () => {
    const routes = contactRoutes({ ...base, phone: '09167296217' });

    const call = routes.find((route) => route.kind === 'PHONE');
    expect(call).toBeDefined();
    expect(call?.destination).toBe('09167296217');
    // A call reaches the property directly, so it is the primary action.
    expect(primaryRoute(routes).kind).toBe('PHONE');
  });

  it('offers WhatsApp with an international number', () => {
    const routes = contactRoutes({ ...base, phone: '09167296217' });

    const whatsapp = routes.find((route) => route.kind === 'WHATSAPP');
    expect(whatsapp?.destination).toBe('https://wa.me/2349167296217');
    // Not primary: a call reaches the same place and does not depend on the operator
    // using WhatsApp at all.
    expect(whatsapp?.primary).toBe(false);
  });

  it('prefers the operator website when the operator is actually identified', () => {
    const routes = contactRoutes({
      ...base,
      operatorName: 'Lekki Homes',
      operatorWebsite: 'https://lekkihomes.ng',
      phone: '09167296217'
    });

    expect(primaryRoute(routes).kind).toBe('OPERATOR_WEBSITE');
    expect(routes.map((route) => route.kind)).toEqual([
      'OPERATOR_WEBSITE',
      'PHONE',
      'WHATSAPP',
      'SOURCE_LISTING'
    ]);
  });

  it('refuses to offer a website when no operator name was stated', () => {
    // The failure this prevents: a website inferred from a domain hint, sent to a
    // guest as "the property's site" when nobody established whose site it is.
    const routes = contactRoutes({ ...base, operatorWebsite: 'https://fonts.googleapis.com' });

    expect(routes.some((route) => route.kind === 'OPERATOR_WEBSITE')).toBe(false);
  });

  it('never offers the availability hint as a booking destination', () => {
    // A live portal page pointed an availability link at a DIFFERENT listing on the
    // same portal, which is why the field is quarantined by name. Offering it as
    // "book here" would send a guest to the wrong property and call it a booking.
    const hint = 'https://nigeriapropertycentre.com/for-rent/short-let/lagos/other-9999999';
    const routes = contactRoutes({ ...base, availabilityHintUrl: hint });

    expect(routes.map((route) => route.destination)).not.toContain(hint);
  });

  it('does not offer the source page as the operator website', () => {
    const routes = contactRoutes({
      ...base,
      operatorName: 'Nigeria Property Centre',
      operatorWebsite: 'https://www.nigeriapropertycentre.com'
    });

    // Same host as the source, so it is not a separate destination: the portal is not
    // the operator, and listing it twice would imply the guest has two options.
    expect(routes.filter((route) => route.kind === 'OPERATOR_WEBSITE')).toHaveLength(0);
  });

  it('labels nothing as a House3 booking', () => {
    const routes = contactRoutes({
      ...base,
      operatorName: 'Lekki Homes',
      operatorWebsite: 'https://lekkihomes.ng',
      phone: '09167296217'
    });

    for (const route of routes) {
      const text = `${route.label} ${route.explanation}`.toLowerCase();
      expect(text).not.toContain('book with house3');
      expect(text).not.toContain('pay house3');
      expect(text).not.toContain('reserve');
    }
  });
});

describe('contact confidence', () => {
  it('reports SOURCE_ONLY when we know nothing else', () => {
    expect(contactConfidence(base)).toBe('SOURCE_ONLY');
  });

  it('reports PHONE_OBSERVED for a discovered number', () => {
    expect(contactConfidence({ ...base, phone: '09167296217' })).toBe('PHONE_OBSERVED');
  });

  it('reports OPERATOR_IDENTIFIED only with a stated name and a site', () => {
    expect(
      contactConfidence({
        ...base,
        operatorName: 'Lekki Homes',
        operatorWebsite: 'https://lekkihomes.ng'
      })
    ).toBe('OPERATOR_IDENTIFIED');
    // A site with no name is not an identified operator.
    expect(contactConfidence({ ...base, operatorWebsite: 'https://lekkihomes.ng' })).toBe(
      'SOURCE_ONLY'
    );
  });
});

/*
 * The `handoff disclosure` suite has been removed with the constant it tested.
 *
 * `HANDOFF_DISCLOSURE` was rendered in body text on the place page and on every
 * search result. It was honest and it was clutter: a guest looking at a room does
 * not need the platform's commercial model repeated beneath it, and on 260 rows
 * it read as a disclaimer the site was anxious about.
 *
 * The FACT it carried is still enforced, and by something better than prose:
 * `isHouse3Bookable` below refuses a House3-bookable claim for anything observed
 * on a public source, and `assertBookable` refuses a payable price at the type
 * level. That suite is the one that matters, and it is right here.
 */

describe('house3 bookability', () => {
  it('is false for anything observed on a public source', () => {
    // A discovered phone number is one signal. It is not an agreement, and it must not
    // make a place bookable by House3.
    expect(isHouse3Bookable('OBSERVED_ON_SOURCE')).toBe(false);
  });

  it('is true only for partner-authorized inventory, which does not exist yet', () => {
    expect(isHouse3Bookable('PARTNER_AUTHORIZED')).toBe(true);
  });
});

describe('host comparison', () => {
  it('ignores protocol and www', () => {
    expect(isSameHost('https://www.example.com', 'http://example.com')).toBe(true);
    expect(isSameHost('https://example.com/a/b', 'https://www.example.com/c')).toBe(true);
    expect(isSameHost('https://example.com', 'https://other.com')).toBe(false);
    expect(isSameHost(null, 'https://example.com')).toBe(false);
  });
});
