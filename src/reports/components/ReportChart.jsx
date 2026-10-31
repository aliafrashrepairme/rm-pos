import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const COLORS = ['#f6c928', '#18865b', '#4fc3f7', '#ff8a65', '#ba68c8', 'var(--muted)'];

export function RevenueTrendChart({ data, height = 260 }) {
  const { t } = useI18n();
  if (!data || data.every((row) => !row.revenue)) return <div className="rpt-chart-empty">{t('No sales in this period.')}</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
        <XAxis dataKey="date" stroke="var(--muted)" fontSize={11} />
        <YAxis stroke="var(--muted)" fontSize={11} />
        <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--text)' }} />
        <Line isAnimationActive={false} type="monotone" dataKey="revenue" stroke="#f6c928" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TopProductsChart({ data, height = 260 }) {
  const { t } = useI18n();
  if (!data || data.length === 0) return <div className="rpt-chart-empty">{t('No product sales in this period.')}</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
        <XAxis type="number" stroke="var(--muted)" fontSize={11} />
        <YAxis type="category" dataKey="name" stroke="var(--muted)" fontSize={11} width={140} />
        <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--text)' }} />
        <Bar isAnimationActive={false} dataKey="qty" fill="#f6c928" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PaymentMethodChart({ data, height = 260 }) {
  const { t } = useI18n();
  if (!data || data.length === 0) return <div className="rpt-chart-empty">{t('No payments in this period.')}</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie isAnimationActive={false} data={data} dataKey="amount" nameKey="method" cx="50%" cy="50%" outerRadius={90} label>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--text)' }} />
        <Legend wrapperStyle={{ color: 'var(--text)', fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function CategoryBarChart({ data, height = 260 }) {
  const { t } = useI18n();
  if (!data || data.length === 0) return <div className="rpt-chart-empty">{t('No category sales in this period.')}</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
        <XAxis dataKey="category" stroke="var(--muted)" fontSize={11} />
        <YAxis stroke="var(--muted)" fontSize={11} />
        <Tooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--text)' }} />
        <Bar isAnimationActive={false} dataKey="revenue" fill="#4fc3f7" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
