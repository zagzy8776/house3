/**
 * MoneyTable - the trust centrepiece.
 *
 * Renders a Quote's lines exactly as the pricing engine produced them, in order,
 * with the total last. Two deliberate constraints:
 *
 *  1. The row style is derived from `QuoteLine.kind`, not hand-picked per screen.
 *     A new line kind therefore cannot ship without a designed treatment - it is
 *     a compile-time error, not a silent styling gap.
 *  2. Every row is rendered. There is no "hide the fee" prop, and there never
 *     should be: this component is the only way price reaches a guest.
 *
 * What it deliberately does NOT show: the internal split. An earlier version
 * printed the operator/platform division beneath the total. That was removed, so
 * the guest sees what they pay and what each line is for, but not how the money is
 * divided afterwards. The split still exists in the ledger (see
 * src/server/bookingService.ts) - it is simply not guest-facing.
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
};

export function MoneyTable({ lines, totalKobo, totalLabel = 'Total to pay now' }: MoneyTableProps) {
  return (
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
  );
}
