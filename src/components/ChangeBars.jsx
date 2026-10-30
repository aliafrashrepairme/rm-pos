import { shortMoney } from '../app/format.js';

const UP = '#18865b';
const DOWN = '#c0392b';
const FIRST = '#ffb000';
const WIDTH = 780;
const HEIGHT = 220;
const LEFT = 52;
const TOP = 22;
const BOTTOM = 32;

// The prototype's bar chart: each bar is coloured by its change from the bar before.
export default function ChangeBars({ rows, ariaLabel, formatTip }) {
  const max = Math.max(...rows.map((row) => row.value), 1) * 1.15;
  const barSlot = (WIDTH - LEFT - 6) / rows.length;
  const y = (value) => TOP + (HEIGHT - TOP) * (1 - value / max);

  return (
    <svg className="chart wide-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT + BOTTOM}`} role="img" aria-label={ariaLabel}>
      {[0, 0.5, 1].map((share) => (
        <g key={share}>
          <line x1={LEFT} x2={WIDTH} y1={y(max * share)} y2={y(max * share)} stroke="currentColor" opacity=".1" />
          <text x={LEFT - 8} y={y(max * share) + 4} textAnchor="end">{shortMoney(max * share)}</text>
        </g>
      ))}
      <line x1={LEFT} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke="currentColor" opacity=".3" />
      {rows.map((row, index) => {
        const x = LEFT + index * barSlot + barSlot * 0.16;
        const barWidth = barSlot * 0.68;
        const top = y(row.value);
        const color = index === 0 ? FIRST : row.value >= rows[index - 1].value ? UP : DOWN;
        return (
          <g key={row.key}>
            <rect x={x} y={top} width={barWidth} height={Math.max(HEIGHT - top, row.value ? 2 : 0)} rx="3" fill={color} />
            <text x={x + barWidth / 2} y={HEIGHT + 18} textAnchor="middle">{row.label}</text>
            <title>{formatTip(row)}</title>
          </g>
        );
      })}
    </svg>
  );
}

export const CHANGE_COLORS = { UP, DOWN, FIRST };
