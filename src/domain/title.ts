/**
 * Property title documents.
 *
 * This is the filter that separates a Nigerian property platform from a generic
 * global one. Buyers and agents ask about title before almost anything else,
 * because it determines whether the asset is financeable, transferable and safe
 * to build on. A "Lagos property search" that cannot filter by C of O is a toy.
 *
 * Definitions are deliberately short and practical, because the UI has to fit
 * them in a tooltip.
 */

export const TITLE_DOCUMENTS = [
  'C_OF_O',
  'GOVERNORS_CONSENT',
  'DEED_OF_ASSIGNMENT',
  'EXCISION_GAZETTE',
  'RIGHT_OF_OCCUPANCY',
  'FREEHOLD',
  'REGISTERED_DEED',
  'UNREGISTERED',
  'NOT_DISCLOSED'
] as const;

export type TitleDocument = (typeof TITLE_DOCUMENTS)[number];

export const TITLE_DOCUMENT_LABELS: Record<TitleDocument, string> = {
  C_OF_O: 'Certificate of Occupancy',
  GOVERNORS_CONSENT: "Governor's Consent",
  DEED_OF_ASSIGNMENT: 'Deed of Assignment',
  EXCISION_GAZETTE: 'Excision & Gazette',
  RIGHT_OF_OCCUPANCY: 'Right of Occupancy',
  FREEHOLD: 'Freehold',
  REGISTERED_DEED: 'Registered Deed',
  UNREGISTERED: 'Unregistered',
  NOT_DISCLOSED: 'Not disclosed'
};

export const TITLE_DOCUMENT_DESCRIPTIONS: Record<TitleDocument, string> = {
  C_OF_O: 'State-issued certificate. The strongest and most bankable Nigerian title.',
  GOVERNORS_CONSENT: "Required when land is transferred out of a C of O. Its absence is the most common defect.",
  DEED_OF_ASSIGNMENT: 'The transfer instrument itself. Usually held alongside a C of O or Consent.',
  EXCISION_GAZETTE: 'Land formally released from government acquisition, evidenced in the gazette.',
  RIGHT_OF_OCCUPANCY: 'Statutory or customary right granted by the state; may be unalienable without consent.',
  FREEHOLD: 'Outright ownership, effectively obsolete for state land in most Nigerian states.',
  REGISTERED_DEED: 'Deed recorded at the land registry. Registration is not by itself proof of title.',
  UNREGISTERED: 'No document recorded. Highest risk; usually unfinanceable.',
  NOT_DISCLOSED: 'The operator has not told us. Shown honestly rather than assumed.'
};

/**
 * How much due diligence a title implies.
 *
 * Used to rank legal risk in the UI. This is a map for display, not legal
 * advice, and the wording above is deliberately plain rather than authoritative.
 */
export const TITLE_RISK: Record<TitleDocument, 'low' | 'medium' | 'high' | 'unknown'> = {
  C_OF_O: 'low',
  GOVERNORS_CONSENT: 'medium',
  RIGHT_OF_OCCUPANCY: 'medium',
  DEED_OF_ASSIGNMENT: 'medium',
  EXCISION_GAZETTE: 'medium',
  FREEHOLD: 'medium',
  REGISTERED_DEED: 'medium',
  UNREGISTERED: 'high',
  NOT_DISCLOSED: 'unknown'
};

export function isTitleDocument(value: string): value is TitleDocument {
  return (TITLE_DOCUMENTS as readonly string[]).includes(value);
}

/** Parse a comma-separated query parameter into valid title documents only. */
export function parseTitleDocuments(raw: string | null | undefined): TitleDocument[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(isTitleDocument);
}
