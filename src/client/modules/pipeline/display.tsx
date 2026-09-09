/**
 * Board, table, forecast — the three ways the deal surface is read.
 *
 * One control on every one of them, so the forecast is a sibling of the board
 * rather than a screen you have to know the address of, and switching back
 * lands on the board with the same pipeline and window you were forecasting.
 */
import { Icons, SegmentedControl } from '@/client/design';

export type DealDisplay = 'board' | 'table' | 'forecast';

export function DisplaySwitch({ value, onChange }: { value: DealDisplay; onChange: (next: DealDisplay) => void }) {
  return (
    <SegmentedControl<DealDisplay>
      value={value}
      onChange={onChange}
      aria-label="How to show deals"
      options={[
        { value: 'board', label: 'Board', icon: <Icons.columns size={14} /> },
        { value: 'table', label: 'Table', icon: <Icons.table size={14} /> },
        { value: 'forecast', label: 'Forecast', icon: <Icons.target size={14} /> },
      ]}
    />
  );
}
