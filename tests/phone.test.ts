import { describe, expect, it } from 'vitest';
import { prettyPhone, telHref, toWhatsappHref } from '@/domain/phone';

/**
 * Phone numbers.
 *
 * These are the card's primary action, so an error here is the difference between
 * a guest calling an operator and a guest getting a WhatsApp error page. The
 * numbers below are the shapes actually present in `directory.json`.
 */
describe('prettyPhone', () => {
  it('spaces a Nigerian mobile for reading', () => {
    // A guest reads the number off the screen and dials it, or checks it digit by
    // digit against the listing - both are harder unspaced.
    expect(prettyPhone('08030000000')).toBe('0803 000 0000');
    expect(prettyPhone('0803 000 0000')).toBe('0803 000 0000');
  });

  it('handles the international form', () => {
    expect(prettyPhone('2348030000000')).toBe('+234 803 000 0000');
  });

  it('leaves an unparseable number alone rather than mangling it', () => {
    // Better to show something odd than to reformat a number into a wrong one.
    expect(prettyPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(prettyPhone('0700-SHORTLET')).toBe('0700-SHORTLET');
  });
});

describe('telHref', () => {
  it('strips everything a dialler cannot use', () => {
    // A space in a `tel:` href is silently dropped by some diallers and breaks it
    // in others, so the href must not carry the display formatting.
    expect(telHref('0803 000 0000')).toBe('tel:08030000000');
    expect(telHref('+234 803 000 0000')).toBe('tel:+2348030000000');
  });
});

describe('toWhatsappHref', () => {
  it('normalises a local number to the international form wa.me needs', () => {
    expect(toWhatsappHref('08030000000')).toBe('https://wa.me/2348030000000');
    expect(toWhatsappHref('0803 000 0000')).toBe('https://wa.me/2348030000000');
  });

  it('leaves an already-international number alone', () => {
    expect(toWhatsappHref('2348030000000')).toBe('https://wa.me/2348030000000');
  });

  it('returns null rather than a link that opens an error', () => {
    // The card renders no WhatsApp button on null, which is the honest outcome:
    // a broken button is worse than no button.
    expect(toWhatsappHref(null)).toBeNull();
    expect(toWhatsappHref('')).toBeNull();
    expect(toWhatsappHref('  ')).toBeNull();
    expect(toWhatsappHref('0803')).toBeNull();
  });
});
