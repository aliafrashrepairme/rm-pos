import { useEffect, useMemo, useState } from 'react';
import ReportStatCard from '../components/ReportStatCard.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import ReportTable from '../components/ReportTable.jsx';
import ReportExport from '../components/ReportExport.jsx';
import { CategoryBarChart } from '../components/ReportChart.jsx';
import { fetchProducts, fetchStockMovements } from '../services/reportService.js';
import { CATEGORIES } from '../data/reportMockData.js';
import {
  resolveDateRange, lowStockProducts, outOfStockProducts, stockStatus,
  inventoryValuation, categoryStockSummary, stockMovementSummary,
  formatCurrency, formatDateTime
} from '../utils/reportCalculations.js';

const TABS = [
  { key: 'stock', label: 'Current Stock' },
  { key: 'low', label: 'Low / Out of Stock' },
  { key: 'category', label: 'Category Summary' },
  { key: 'movement', label: 'Stock Movement' }
];

export default function InventoryReport() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [products, setProducts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [tab, setTab] = useState('stock');
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState('last30');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([fetchProducts(), fetchStockMovements()])
      .then(([p, m]) => { if (active) { setProducts(p); setMovements(m); setError(''); } })
      .catch(() => { if (active) setError('Could not load inventory data.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const range = useMemo(() => resolveDateRange(preset, customRange), [preset, customRange]);

  const filteredProducts = useMemo(() => {
    let result = products;
    if (category !== 'All') result = result.filter((p) => p.category === category);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    return result;
  }, [products, category, search]);

  const stockColumns = [
    { key: 'name', label: 'Product', value: 'name' },
    { key: 'sku', label: 'SKU', value: 'sku' },
    { key: 'category', label: 'Category', value: 'category' },
    { key: 'stock', label: 'Current Qty', value: 'stock' },
    { key: 'reorderLevel', label: 'Min Level', value: 'reorderLevel' },
    { key: 'unitCost', label: 'Unit Cost', value: (row) => formatCurrency(row.unitCost), sortValue: 'unitCost' },
    { key: 'totalValue', label: 'Stock Value', value: (row) => formatCurrency(row.stock * row.unitCost), sortValue: (row) => row.stock * row.unitCost },
    { key: 'status', label: 'Status', value: (row) => <StatusBadge status={stockStatus(row)} />, sortable: false }
  ];

  const exportColumns = [
    { label: 'Product', value: 'name' },
    { label: 'SKU', value: 'sku' },
    { label: 'Category', value: 'category' },
    { label: 'Current Qty', value: 'stock' },
    { label: 'Min Level', value: 'reorderLevel' },
    { label: 'Unit Cost', value: 'unitCost' },
    { label: 'Stock Value', value: (row) => row.stock * row.unitCost },
    { label: 'Status', value: (row) => stockStatus(row) }
  ];

  const movementColumns = [
    { key: 'date', label: 'Date', value: (row) => formatDateTime(row.date), sortValue: 'date' },
    { key: 'name', label: 'Product', value: 'name' },
    { key: 'type', label: 'Type', value: 'type' },
    { key: 'quantity', label: 'Quantity', value: 'quantity' }
  ];

  const lowStock = lowStockProducts(products);
  const outOfStock = outOfStockProducts(products);
  const totalValue = inventoryValuation(products);
  const { stockIn, stockOut, movements: movementsInRange } = stockMovementSummary(movements, range);

  if (loading) return <div className="rpt-loading">Loading inventory report…</div>;
  if (error) return <div className="rpt-error">{error}</div>;

  return (
    <div className="rpt-page">
      <div className="rpt-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)} type="button">{t.label}</button>
        ))}
      </div>

      <div className="rpt-stats-grid">
        <ReportStatCard label="Total Products" value={products.length} icon="📦" />
        <ReportStatCard label="Low Stock" value={lowStock.length} icon="⚠️" />
        <ReportStatCard label="Out of Stock" value={outOfStock.length} icon="⛔" />
        <ReportStatCard label="Inventory Valuation" value={formatCurrency(totalValue)} icon="💰" />
      </div>

      {tab === 'stock' && (
        <>
          <ReportFilters
            category={category}
            categories={CATEGORIES}
            onCategoryChange={setCategory}
            search={search}
            onSearchChange={setSearch}
            onApply={() => {}}
            onReset={() => { setCategory('All'); setSearch(''); }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <ReportExport filename="inventory-stock-report.csv" columns={exportColumns} rows={filteredProducts} />
          </div>
          <ReportTable columns={stockColumns} rows={filteredProducts} />
        </>
      )}

      {tab === 'low' && (
        <>
          <div>
            <h3 style={{ margin: '0 0 10px' }}>Low Stock Products</h3>
            <ReportTable columns={stockColumns} rows={lowStock} emptyMessage="No low-stock products." />
          </div>
          <div>
            <h3 style={{ margin: '0 0 10px' }}>Out of Stock Products</h3>
            <ReportTable columns={stockColumns} rows={outOfStock} emptyMessage="No out-of-stock products." />
          </div>
        </>
      )}

      {tab === 'category' && (
        <>
          <div className="card rpt-chart-card">
            <h3>Stock Value by Category</h3>
            <CategoryBarChart data={categoryStockSummary(products).map((c) => ({ category: c.category, revenue: c.totalValue }))} />
          </div>
          <ReportTable
            columns={[
              { key: 'category', label: 'Category', value: 'category' },
              { key: 'productCount', label: 'Products', value: 'productCount' },
              { key: 'totalStock', label: 'Total Stock', value: 'totalStock' },
              { key: 'totalValue', label: 'Total Value', value: (row) => formatCurrency(row.totalValue), sortValue: 'totalValue' }
            ]}
            rows={categoryStockSummary(products)}
          />
        </>
      )}

      {tab === 'movement' && (
        <>
          <ReportFilters
            preset={preset}
            onPresetChange={setPreset}
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
            onApply={() => {}}
            onReset={() => { setPreset('last30'); setCustomRange({ start: '', end: '' }); }}
          />
          <div className="rpt-stats-grid">
            <ReportStatCard label="Stock In" value={stockIn} icon="⬆️" />
            <ReportStatCard label="Stock Out" value={stockOut} icon="⬇️" />
          </div>
          <ReportTable columns={movementColumns} rows={movementsInRange} emptyMessage="No stock movement in this period." />
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const cls = status === 'Low Stock' ? 'warn' : status === 'Out of Stock' ? 'red' : 'good';
  return <span className={`rpt-status ${cls}`}><span className="dot" />{status}</span>;
}
