import { useEffect, useMemo, useState } from 'react';
import ReportStatCard from '../components/ReportStatCard.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import { RevenueTrendChart, TopProductsChart, PaymentMethodChart } from '../components/ReportChart.jsx';
import ReportTable from '../components/ReportTable.jsx';
import { fetchSales, fetchProducts } from '../services/reportService.js';
import {
  resolveDateRange, filterSalesByRange, sumRevenue, countOrders, averageOrderValue,
  totalItemsSold, paymentsCollected, paymentMethodBreakdown, topSellingProducts,
  salesTrend, recentSales, lowStockProducts, formatCurrency, formatDateTime
} from '../utils/reportCalculations.js';

export default function ReportsDashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [preset, setPreset] = useState('last30');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchSales(), fetchProducts()])
      .then(([s, p]) => { if (active) { setSales(s); setProducts(p); setError(''); } })
      .catch(() => { if (active) setError('Could not load report data.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const range = useMemo(() => resolveDateRange(preset, customRange), [preset, customRange]);
  const inRange = useMemo(() => filterSalesByRange(sales, range), [sales, range]);

  const recentColumns = [
    { key: 'orderId', label: 'Order ID', value: 'orderId' },
    { key: 'date', label: 'Date', value: (row) => formatDateTime(row.date) },
    { key: 'customer', label: 'Customer', value: 'customer' },
    { key: 'total', label: 'Total', value: (row) => formatCurrency(row.total) },
    { key: 'status', label: 'Status', value: 'status' }
  ];

  if (loading) return <div className="rpt-loading">Loading dashboard…</div>;
  if (error) return <div className="rpt-error">{error}</div>;

  return (
    <div className="rpt-page">
      <ReportFilters
        preset={preset}
        onPresetChange={setPreset}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
        onApply={() => {}}
        onReset={() => { setPreset('last30'); setCustomRange({ start: '', end: '' }); }}
      />

      <div className="rpt-stats-grid">
        <ReportStatCard label="Total Sales Revenue" value={formatCurrency(sumRevenue(inRange))} icon="💰" />
        <ReportStatCard label="Total Orders" value={countOrders(inRange)} icon="🧾" />
        <ReportStatCard label="Average Order Value" value={formatCurrency(averageOrderValue(inRange))} icon="📊" />
        <ReportStatCard label="Total Products Sold" value={totalItemsSold(inRange)} icon="📦" />
        <ReportStatCard label="Payments Collected" value={formatCurrency(paymentsCollected(inRange))} icon="💳" />
        <ReportStatCard label="Low-Stock Products" value={lowStockProducts(products).length} icon="⚠️" />
      </div>

      <div className="rpt-charts-grid">
        <div className="card rpt-chart-card">
          <h3>Revenue Trend</h3>
          <p className="sub">Daily revenue for the selected period</p>
          <RevenueTrendChart data={salesTrend(inRange, range)} />
        </div>
        <div className="card rpt-chart-card">
          <h3>Top-Selling Products</h3>
          <p className="sub">By quantity sold</p>
          <TopProductsChart data={topSellingProducts(inRange, 5)} />
        </div>
        <div className="card rpt-chart-card">
          <h3>Payment Method Distribution</h3>
          <p className="sub">Share of revenue by method</p>
          <PaymentMethodChart data={paymentMethodBreakdown(inRange)} />
        </div>
      </div>

      <div>
        <h3 style={{ margin: '0 0 10px' }}>Recent Sales</h3>
        <ReportTable columns={recentColumns} rows={recentSales(inRange, 10)} />
      </div>
    </div>
  );
}
