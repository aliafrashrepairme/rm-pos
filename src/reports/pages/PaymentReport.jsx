import { useEffect, useMemo, useState } from 'react';
import ReportStatCard from '../components/ReportStatCard.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import ReportTable from '../components/ReportTable.jsx';
import ReportExport from '../components/ReportExport.jsx';
import { PaymentMethodChart, RevenueTrendChart } from '../components/ReportChart.jsx';
import { fetchSales } from '../services/reportService.js';
import { PAYMENT_METHODS, ORDER_STATUSES } from '../data/reportMockData.js';
import {
  resolveDateRange, filterSalesByRange, completedOnly, paymentsCollected,
  paymentMethodBreakdown, salesTrend, formatCurrency, formatDateTime
} from '../utils/reportCalculations.js';

export default function PaymentReport() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sales, setSales] = useState([]);
  const [preset, setPreset] = useState('last30');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });
  const [paymentMethod, setPaymentMethod] = useState('All');
  const [status, setStatus] = useState('All');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchSales()
      .then((s) => { if (active) { setSales(s); setError(''); } })
      .catch(() => { if (active) setError('Could not load payment data.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const range = useMemo(() => resolveDateRange(preset, customRange), [preset, customRange]);

  const filtered = useMemo(() => {
    let result = filterSalesByRange(sales, range);
    if (paymentMethod !== 'All') result = result.filter((s) => s.paymentMethod === paymentMethod);
    if (status !== 'All') result = result.filter((s) => s.status === status);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((s) => s.orderId.toLowerCase().includes(q) || s.transactionId.toLowerCase().includes(q));
    }
    return result;
  }, [sales, range, paymentMethod, status, search]);

  const completed = completedOnly(filtered);
  const byMethod = (m) => completed.filter((s) => s.paymentMethod === m).reduce((sum, s) => sum + s.total, 0);

  const columns = [
    { key: 'date', label: 'Date', value: (row) => formatDateTime(row.date), sortValue: 'date' },
    { key: 'transactionId', label: 'Transaction ID', value: 'transactionId' },
    { key: 'orderId', label: 'Order ID', value: 'orderId' },
    { key: 'paymentMethod', label: 'Method', value: 'paymentMethod' },
    { key: 'total', label: 'Amount', value: (row) => formatCurrency(row.total), sortValue: 'total' },
    { key: 'status', label: 'Status', value: 'status' }
  ];

  const exportColumns = [
    { label: 'Date', value: (row) => formatDateTime(row.date) },
    { label: 'Transaction ID', value: 'transactionId' },
    { label: 'Order ID', value: 'orderId' },
    { label: 'Payment Method', value: 'paymentMethod' },
    { label: 'Amount', value: 'total' },
    { label: 'Status', value: 'status' }
  ];

  if (loading) return <div className="rpt-loading">Loading payment report…</div>;
  if (error) return <div className="rpt-error">{error}</div>;

  return (
    <div className="rpt-page">
      <ReportFilters
        preset={preset}
        onPresetChange={setPreset}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
        paymentMethod={paymentMethod}
        paymentMethods={PAYMENT_METHODS}
        onPaymentMethodChange={setPaymentMethod}
        search={search}
        onSearchChange={setSearch}
        onApply={() => {}}
        onReset={() => { setPreset('last30'); setCustomRange({ start: '', end: '' }); setPaymentMethod('All'); setStatus('All'); setSearch(''); }}
      />

      <div className="rpt-filters-row" style={{ marginTop: -10 }}>
        <label>
          Payment status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="All">All Statuses</option>
            {ORDER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      <div className="rpt-stats-grid">
        <ReportStatCard label="Total Payments Collected" value={formatCurrency(paymentsCollected(filtered))} icon="💰" />
        <ReportStatCard label="Cash Payments" value={formatCurrency(byMethod('Cash'))} icon="💵" />
        <ReportStatCard label="Card Payments" value={formatCurrency(byMethod('Card'))} icon="💳" />
        <ReportStatCard label="Other Methods" value={formatCurrency(byMethod('Bank Transfer'))} icon="🏦" />
      </div>

      <div className="rpt-charts-grid">
        <div className="card rpt-chart-card">
          <h3>Payment Method Distribution</h3>
          <PaymentMethodChart data={paymentMethodBreakdown(filtered)} />
        </div>
        <div className="card rpt-chart-card">
          <h3>Daily Payment Summary</h3>
          <RevenueTrendChart data={salesTrend(filtered, range)} />
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Payment Transaction History</h3>
          <ReportExport filename="payment-report.csv" columns={exportColumns} rows={filtered} />
        </div>
        <ReportTable columns={columns} rows={filtered} />
      </div>
    </div>
  );
}
