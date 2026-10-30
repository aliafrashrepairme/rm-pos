import { useEffect, useMemo, useState } from 'react';
import ReportStatCard from '../components/ReportStatCard.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import ReportTable from '../components/ReportTable.jsx';
import ReportExport from '../components/ReportExport.jsx';
import { RevenueTrendChart, CategoryBarChart, TopProductsChart } from '../components/ReportChart.jsx';
import { fetchSales } from '../services/reportService.js';
import { CATEGORIES } from '../data/reportMockData.js';
import {
  resolveDateRange, filterSalesByRange, sumRevenue, countOrders, averageOrderValue,
  totalItemsSold, salesTrend, salesByCategory, topSellingProducts,
  formatCurrency, formatDateTime
} from '../utils/reportCalculations.js';

export default function SalesReport() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sales, setSales] = useState([]);
  const [preset, setPreset] = useState('last7');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchSales()
      .then((s) => { if (active) { setSales(s); setError(''); } })
      .catch(() => { if (active) setError('Could not load sales data.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const range = useMemo(() => resolveDateRange(preset, customRange), [preset, customRange]);

  const filtered = useMemo(() => {
    let result = filterSalesByRange(sales, range);
    if (category !== 'All') {
      result = result.filter((s) => s.items.some((i) => i.category === category));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((s) =>
        s.orderId.toLowerCase().includes(q) ||
        s.customer.toLowerCase().includes(q) ||
        s.items.some((i) => i.name.toLowerCase().includes(q))
      );
    }
    return result;
  }, [sales, range, category, search]);

  const columns = [
    { key: 'orderId', label: 'Order ID', value: 'orderId' },
    { key: 'date', label: 'Date', value: (row) => formatDateTime(row.date), sortValue: 'date' },
    { key: 'customer', label: 'Customer', value: 'customer' },
    { key: 'items', label: 'Items', value: (row) => row.items.reduce((n, i) => n + i.qty, 0), sortable: false },
    { key: 'paymentMethod', label: 'Payment', value: 'paymentMethod' },
    { key: 'status', label: 'Status', value: 'status' },
    { key: 'total', label: 'Total', value: (row) => formatCurrency(row.total), sortValue: 'total' }
  ];

  const exportColumns = [
    { label: 'Order ID', value: 'orderId' },
    { label: 'Date', value: (row) => formatDateTime(row.date) },
    { label: 'Customer', value: 'customer' },
    { label: 'Items', value: (row) => row.items.reduce((n, i) => n + i.qty, 0) },
    { label: 'Payment Method', value: 'paymentMethod' },
    { label: 'Status', value: 'status' },
    { label: 'Total', value: 'total' }
  ];

  if (loading) return <div className="rpt-loading">Loading sales report…</div>;
  if (error) return <div className="rpt-error">{error}</div>;

  return (
    <div className="rpt-page">
      <ReportFilters
        preset={preset}
        onPresetChange={setPreset}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
        category={category}
        categories={CATEGORIES}
        onCategoryChange={setCategory}
        search={search}
        onSearchChange={setSearch}
        onApply={() => {}}
        onReset={() => { setPreset('last7'); setCustomRange({ start: '', end: '' }); setCategory('All'); setSearch(''); }}
      />

      <div className="rpt-stats-grid">
        <ReportStatCard label="Total Revenue" value={formatCurrency(sumRevenue(filtered))} icon="💰" />
        <ReportStatCard label="Total Orders" value={countOrders(filtered)} icon="🧾" />
        <ReportStatCard label="Average Order Value" value={formatCurrency(averageOrderValue(filtered))} icon="📊" />
        <ReportStatCard label="Total Items Sold" value={totalItemsSold(filtered)} icon="📦" />
      </div>

      <div className="rpt-charts-grid">
        <div className="card rpt-chart-card">
          <h3>Sales Trend</h3>
          <p className="sub">Revenue per day for the selected period</p>
          <RevenueTrendChart data={salesTrend(filtered, range)} />
        </div>
        <div className="card rpt-chart-card">
          <h3>Sales by Category</h3>
          <CategoryBarChart data={salesByCategory(filtered)} />
        </div>
        <div className="card rpt-chart-card">
          <h3>Best-Selling Products</h3>
          <TopProductsChart data={topSellingProducts(filtered, 8)} />
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Sales Transactions</h3>
          <ReportExport filename="sales-report.csv" columns={exportColumns} rows={filtered} />
        </div>
        <ReportTable columns={columns} rows={filtered} />
      </div>
    </div>
  );
}
