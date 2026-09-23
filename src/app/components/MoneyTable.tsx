/**
 * MoneyTable - the trust centrepiece of the whole product.
 *
 * It renders a Quote's lines exactly as the pricing engine produced them, in
 * order, with the total last. Two deliberate constraints:
 *
 *  1. The row style is derived from `QuoteLine.kind`, not hand-picked per screen.
 *     A new line kind therefore cannot ship without a designed treatment - it is
 *     a compile-time error, not a silent styling gap.
 *  2. Every row is rendered. There is no "hide the fee" prop, and there never
 *     should be: this component is the only way price reaches a guest.
 */

import { formatNaira } from '@/domain/money';
import type { QuoteLine } from '@/domain/pricing';

/** Maps the domain's line kind onto the design system's money row modifier. */
export function moneyRowClass(kind: QuoteLine['kind']): string {
  switch (kind) {
    case 'ROOM':
      return 'h3-money__row--room';
    case 'ADDON':
      return 'h3-money__row--passthrough';
    case 'PASSTHROUGH':
      return 'h3-money__row--passthrough';
    case 'DISCOUNT':
      return 'h3-money__row--discount';
    case 'FEE':
      return 'h3-money__row--fee';
    case 'TAX':
      return 'h3-money__row--tax';
  }
}

export type MoneyTableProps = {
  lines: readonly QuoteLine[];
  totalKobo: number;
  totalLabel?: string;
  /**
   * The radical-transparency line. Recommended on every confirmation:
   * "Lekki Homes Ltd receives NGN 310,000 · House3 keeps NGN 36,700".
   */
  settlement?: { operatorName: string; operatorKobo: number; platformKobo: number };
};

export function MoneyTable({ lines, totalKobo, totalLabel = 'Total to pay now', settlement }: MoneyTableProps) {
  return (
    <>
      <table className="h3-money">
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className={moneyRowClass(line.kind)}>
              <td>{line.label}</td>
              <td>{formatNaira(line.amountKobo)}</td>
            </tr>
          ))}
          <tr className="h3-money__row--total">
            <td>{totalLabel}</td>
            <td>{formatNaira(totalKobo)}</td>
          </tr>
        </tbody>
      </table>

      {settlement ? (
        <p className="h3-settlement">
          {settlement.operatorName} receives {formatNaira(settlement.operatorKobo)} · House3 keeps{' '}
          {formatNaira(settlement.platformKobo)} after payment processing
        </p>
      ) : null}
    </>
  );
}
