/**
 * Where a guest is sent to reach the accommodation's own contact channel.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 * ----------------------------------
 * House3 is a discovery and referral platform. It does not collect money, does not
 * process bookings, does not promise availability and is not the merchant of record.
 * A guest finds a place here and then deals with the accommodation directly.
 *
 * So this module resolves ONE question: "given what we observed about this place,
 * where is the legitimate place to send a guest to contact or book it?"
 *
 * It is deliberately not a booking engine, and the type is named so that is obvious
 * at every call site. There is no amount, no hold, no reference, no status. A
 * `ContactRoute` cannot express a payment, because a payment is not part of this
 * business yet.
 *
 * THE ORDERING IS THE COMPLIANCE DECISION
 * ---------------------------------------
 * Destinations are ranked by how legitimate they are as a handoff, not by how likely
 * they are to convert:
 *
 *   1. `OPERATOR_WEBSITE` - the accommodation's own site. Best for the guest and best
 *      for the operator, but only when the operator is identified by a channel we
 *      trust. A website is never inferred from a domain hint.
 *
 *   2. `PHONE` / `WHATSAPP` - the number the listing published. That is the operator's
 *      own contact information, published precisely so guests will call. Using it is
 *      the entire point of a referral.
 *
 *   3. `SOURCE_LISTING` - the listing page this fact came from. Always available and
 *      always correct: the publisher invited contact there and we merely point at it.
 *      This is the fallback, and it cannot be wrong.
 *
 * WHAT IS NOT A DESTINATION
 * -------------------------
 * An `availability_hint_url` is NOT a booking link and will never be offered as one.
 * A live portal page once pointed one at a different listing on the same portal, which
 * is why the field is quarantined by name in `compliance/allowed_fields.py`. Offering
 * it as "book here" would send a guest to the wrong property and call it a booking.
 */

export type ContactKind =
  | 'OPERATOR_WEBSITE'
  | 'PHONE'
  | 'WHATSAPP'
  | 'SOURCE_LISTING';

export type ContactRoute = {
  kind: ContactKind;
  /** Where to send the guest: a URL for web kinds, a number for PHONE. */
  destination: string;
  /** The button label. Deliberately never says "Book with House3". */
  label: string;
  /** One line explaining who the guest will be dealing with. */
  explanation: string;
  /** True for the option a guest should normally take. Exactly one is primary. */
  primary: boolean;
};

/**
 * What we know about a place that could help a guest reach it.
 *
 * This is *observed* data, not verified identity. `operatorName` is populated only
 * when a source STATED it; a name inferred from a domain is a hint and is not accepted
 * here, because sending a guest to a guessed website is worse than sending them to the
 * listing they were already reading.
 */
export type ContactEvidence = {
  sourceUrl: string;
  sourceName: string;
  operatorName: string | null;
  operatorWebsite: string | null;
  phone: string | null;
  instagram: string | null;
  /**
   * An availability link the source offered. Never used as a destination. Present
   * only so a caller cannot accidentally treat it as one.
   */
  availabilityHintUrl?: string | null;
};

/** Strip a website down to a comparison-safe form. No protocol, no trailing slash. */
function normaliseHost(value: string | null): string | null {
  if (!value) return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .split('/')[0];
  return host || null;
}

/** True when a URL points at the same host as another, ignoring www and protocol. */
export function isSameHost(a: string | null, b: string | null): boolean {
  const left = normaliseHost(a);
  const right = normaliseHost(b);
  return Boolean(left && right && left === right);
}

/**
 * Build the contact routes for one place, best first.
 *
 * Never returns an empty list: the source listing is always available, so a guest can
 * always reach the place they were looking at. That guarantee is the reason this
 * function exists rather than the UI assembling links itself.
 */
export function contactRoutes(evidence: ContactEvidence): ContactRoute[] {
  const routes: ContactRoute[] = [];

  // 1. The operator's own site, but ONLY when we have a stated name to attribute it
  //    to. Without a name we cannot tell the guest who they are about to contact, and
  //    an unattributed outbound link is how "we sent a guest to a font CDN" happened
  //    once already in this codebase.
  const website = evidence.operatorWebsite;
  if (website && evidence.operatorName && !isSameHost(website, evidence.sourceUrl)) {
    routes.push({
      kind: 'OPERATOR_WEBSITE',
      destination: website,
      label: 'Visit their website',
      explanation: `${evidence.operatorName}'s own site. Booking happens there.`,
      primary: true
    });
  }

  // 2. Phone. The number the listing published for exactly this purpose.
  const phone = evidence.phone?.trim() || null;
  if (phone) {
    routes.push({
      kind: 'PHONE',
      destination: phone,
      label: `Call ${evidence.operatorName ?? 'the property'}`,
      explanation: 'The number this listing published. You arrange the stay directly.',
      primary: routes.length === 0
    });
  }
  // 3. WhatsApp. Offered after the phone call because a call reaches the same place
  //    and does not depend on the operator using WhatsApp at all.
  if (phone) {
    const digits = phone.replace(/[^\d]/g, '');
    const international = digits.startsWith('0')
      ? `234${digits.slice(1)}`
      : digits.startsWith('234')
        ? digits
        : `234${digits}`;
    routes.push({
      kind: 'WHATSAPP',
      destination: `https://wa.me/${international}`,
      label: 'Message on WhatsApp',
      explanation: 'Opens WhatsApp with the property. You arrange the stay directly.',
      primary: false
    });
  }

  // 4. The source listing. Always present, so there is always a route, and it is the
  //    primary when nothing better was observed.
  routes.push({
    kind: 'SOURCE_LISTING',
    destination: evidence.sourceUrl,
    label: 'View original listing',
    explanation: `This was observed on ${evidence.sourceName}. Contact happens there.`,
    primary: routes.length === 0
  });

  return routes;
}

/**
 * The route a guest should normally take. Exactly one.
 *
 * Falls back to the last route rather than returning undefined: `contactRoutes` always
 * appends the source listing, so the array is never empty, and stating that invariant
 * here means every caller gets a non-optional route without a null check it cannot act
 * on anyway.
 */
export function primaryRoute(routes: ContactRoute[]): ContactRoute {
  const found = routes.find((route) => route.primary) ?? routes[routes.length - 1];
  if (!found) {
    throw new Error('contactRoutes returned no routes; the source listing must always be present');
  }
  return found;
}

/**
 * How much we actually know about reaching this place.
 *
 * A discovered phone number is one signal. It is not proof of ownership and it does
 * not make the place bookable. This exists so the UI can be honest about the
 * difference between "we observed a number" and "we have an agreement", and so nothing
 * downstream can quietly promote the first into the second.
 */
export type ContactConfidence = 'SOURCE_ONLY' | 'PHONE_OBSERVED' | 'OPERATOR_IDENTIFIED';

export function contactConfidence(evidence: ContactEvidence): ContactConfidence {
  if (evidence.operatorWebsite && evidence.operatorName) return 'OPERATOR_IDENTIFIED';
  if (evidence.phone) return 'PHONE_OBSERVED';
  return 'SOURCE_ONLY';
}

/**
 * The wording a property page must use for the handoff.
 *
 * Centralised because this is a legal statement, not copy. House3 is not the merchant
 * of record and does not take the money, so no page may imply otherwise, and the
 * phrase must not drift per template.
 */
/*
 * `HANDOFF_DISCLOSURE` has been REMOVED, and this note says why so nobody re-adds
 * it by instinct.
 *
 * It read: "House3 lists this place and shows you what we observed. We do not take
 * the booking or the payment - you arrange your stay directly with the property."
 * It was rendered on the place page and on every search result, in body text,
 * on every listing.
 *
 * It was honest, and it was still wrong on the page. A guest who has opened a
 * listing is looking at a room - they are not reading a platform's statement of
 * its own commercial model, and repeating it on every row reads as a disclaimer
 * the site is anxious about. The fact remains true and is still communicated:
 * every contact button says "Call", "Message on WhatsApp" or "Visit their
 * website" and goes to the operator, there is no basket or checkout anywhere in
 * the application, and `assertBookable` in this file refuses a payable price at
 * the type level. The product makes the statement; the prose was belt-and-braces
 * on top of it.
 *
 * If a disclosure is ever genuinely needed here - a market where a regulator
 * requires specific wording - it should go on a page about how House3 works, once,
 * rather than attached to 260 listings.
 */

/**
 * Whether a rate or listing may be presented as something a guest can pay.
 *
 * This is the boundary in one place. A rate we observed on a public source is
 * research, attributed to the source, and is never a payable price. The only thing
 * that can be payable is a partner rate, which this platform does not have yet -
 * so today this is false for everything House3 currently holds, and that is correct
 * rather than a gap.
 *
 * It lives beside the handoff wording because those two statements must always agree:
 * a page that says "we do not take the payment" cannot also render a payable price.
 */
export type ListingProvenance =
  /** A signed partner. House3 may sell it and may show a payable price. */
  | 'PARTNER_AUTHORIZED'
  /** Everything observed on a public source. Referral inventory, never payable. */
  | 'OBSERVED_ON_SOURCE';

export function isHouse3Bookable(provenance: ListingProvenance): boolean {
  return provenance === 'PARTNER_AUTHORIZED';
}
