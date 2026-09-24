/**
 * Numbers, formatted for a human.
 *
 * These live in the domain rather than in either page because the homepage card
 * and the search result card both need them, and two copies of a phone-number
 * rule is how the same number ends up rendered two different ways on one site.
 */

/**
 * A Nigerian number, spaced for reading: `0803 000 0000`.
 *
 * The observed data is already close to this, but spacing is not guaranteed and a
 * number rendered as `08030000000` is materially harder to read aloud or to check
 * digit by digit against a screen - which is what a guest does before dialling.
 * Anything we cannot parse comes back untouched rather than mangled.
 */
export function prettyPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 13 && digits.startsWith('234')) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return phone;
}

/**
 * The `tel:` target for a published number: digits and a leading `+`, nothing else.
 *
 * A guest's dialler appends whatever it is given, so a space must not survive into
 * the href even though it is what we show on screen.
 */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/**
 * The WhatsApp deep link for a published number, or null.
 *
 * Same normalisation rule as `contactRoutes`: `0803...` becomes `+234803...`, and
 * a number already international is left alone. A number too short to be a
 * Nigerian mobile yields null rather than a link that opens WhatsApp on an error.
 */
export function toWhatsappHref(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return null;
  const international = digits.startsWith('0')
    ? `234${digits.slice(1)}`
    : digits.startsWith('234')
      ? digits
      : `234${digits}`;
  if (international.length < 12) return null;
  return `https://wa.me/${international}`;
}
