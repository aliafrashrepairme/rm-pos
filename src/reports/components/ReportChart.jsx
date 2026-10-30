import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts';

const COLORS = ['#f6c928', '#4fc3f7', '#81c784', '#ff8a65', '#ba68c8', '#a3a7ae'];

export function RevenueTrendChart({ data, height = 260 }) {
  if (!data || data.length === 0) return <div className="rpt-chart-empty">No sales in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2e2f33" />
        <XAxis dataKey="date" stroke="#a3a7ae" fontSize={11} />
        <YAxis stroke="#a3a7ae" fontSize={11} />
        <Tooltip contentStyle={{ background: '#1f2023', border: '1px solid #2e2f33', color: '#f2f2f2' }} />
        <Line type="monotone" dataKey="revenue" stroke="#f6c928" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TopProductsChart({ data, height = 260 }) {
  if (!data || data.length === 0) return <div className="rpt-chart-empty">No product sales in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2e2f33" />
        <XAxis type="number" stroke="#a3a7ae" fontSize={11} />
        <YAxis type="category" dataKey="name" stroke="#a3a7ae" fontSize={11} width={140} />
        <Tooltip contentStyle={{ background: '#1f2023', border: '1px solid #2e2f33', color: '#f2f2f2' }} />
        <Bar dataKey="qty" fill="#f6c928" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PaymentMethodChart({ data, height = 260 }) {
  if (!data || data.length === 0) return <div className="rpt-chart-empty">No payments in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="amount" nameKey="method" cx="50%" cy="50%" outerRadius={90} label>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip contentStyle={{ background: '#1f2023', border: '1px solid #2e2f33', color: '#f2f2f2' }} />
        <Legend wrapperStyle={{ color: '#f2f2f2', fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function CategoryBarChart({ data, height = 260 }) {
  if (!data || data.length === 0) return <div className="rpt-chart-empty">No category sales in this period.</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2e2f33" />
        <XAxis dataKey="category" stroke="#a3a7ae" fontSize={11} />
        <YAxis stroke="#a3a7ae" fontSize={11} />
        <Tooltip contentStyle={{ background: '#1f2023', border: '1px solid #2e2f33', color: '#f2f2f2' }} />
        <Bar dataKey="revenue" fill="#4fc3f7" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
