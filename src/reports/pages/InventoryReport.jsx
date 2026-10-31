import { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import { dateTime, money, quantity } from '../../app/format.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { CategoryBarChart } from '../components/ReportChart.jsx';
import ReportExport from '../components/ReportExport.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import ReportTable, { TableView } from '../components/ReportTable.jsx';
import SumStrip from '../components/SumStrip.jsx';
import { useFilterOptions, usePagedReport, usePeriod } from '../utils/useReportData.js';

const TABS = { stock: 'Current stock', low: 'Low and out of stock', category: 'Inventory valuation', movement: 'Stock movement' };

function stockState(product) {
  if (product.stock <= 0) return 'Out of Stock';
  return product.stock <= product.reorderLevel ? 'Low Stock' : 'In Stock';
}

export default function InventoryReport({ user }) {
  const { t } = useI18n();
  const options = useFilterOptions();
  const summary = useListRequest('/api/reports/inventory');
  const products = useListRequest('/api/reports/products');
  const [tab, setTab] = useState('stock');
  const [category, setCategory] = useState('');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const period = usePeriod('last30');
  const [product, setProduct] = useState('');
  const [type, setType] = useState('');
  const movements = usePagedReport('/api/reports/stock-movements', { ...period.params, product, type, q: tab === 'movement' ? search : '' });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (products.data?.products ?? []).filter((row) => (!category || row.category === category)
      && (!term || row.name.toLowerCase().includes(term) || row.sku.toLowerCase().includes(term)));
  }, [products.data, category, search]);
  const low = useMemo(() => rows.filter((row) => stockState(row) !== 'In Stock').sort((a, b) => a.stock - b.stock), [rows]);

  const stockColumns = [
    { key: 'name', sort: 'name', label: t('Product'), value: (row) => row.name },
    { key: 'sku', sort: 'sku', label: t('SKU'), value: (row) => row.sku },
    { key: 'category', sort: 'category', label: t('Category'), value: (row) => row.category },
    { key: 'stock', sort: 'stock', label: t('On hand'), value: (row) => quantity(row.stock), csv: (row) => row.stock },
    { key: 'reorderLevel', sort: 'reorderLevel', label: t('Reorder level'), value: (row) => quantity(row.reorderLevel), csv: (row) => row.reorderLevel },
    { key: 'unitCost', sort: 'unitCost', label: t('Unit cost'), value: (row) => money(row.unitCost), csv: (row) => row.unitCost },
    { key: 'value', sort: 'value', label: t('Stock value'), value: (row) => money(row.stock * row.unitCost), csv: (row) => Math.round(row.stock * row.unitCost * 100) / 100 },
    { key: 'status', label: t('Status'), value: (row) => t(stockState(row)) }
  ];
  const stockScreen = stockColumns.map((column) => (column.key === 'status' ? { ...column, value: (row) => <Status value={stockState(row)} label={t(stockState(row))} /> } : column));
  const categoryColumns = [
    { key: 'category', sort: 'category', label: t('Category'), value: (row) => row.category },
    { key: 'products', sort: 'products', label: t('Products'), value: (row) => row.products },
    { key: 'stock', sort: 'stock', label: t('Total stock'), value: (row) => quantity(row.stock), csv: (row) => row.stock },
    { key: 'value', sort: 'value', label: t('Stock value'), value: (row) => money(row.value), csv: (row) => row.value }
  ];
  const movementColumns = [
    { key: 'date', sort: 'date', label: t('Date'), value: (row) => dateTime(row.date) },
    { key: 'name', label: t('Product'), value: (row) => row.name },
    { key: 'type', label: t('Type'), value: (row) => t(row.type) },
    { key: 'change', sort: 'quantity', label: t('Change'), value: (row) => (row.change > 0 ? `+${quantity(row.change)}` : quantity(row.change)), csv: (row) => row.change },
    { key: 'balance', label: t('Balance'), value: (row) => quantity(row.balance), csv: (row) => row.balance },
    { key: 'reference', label: t('Reference'), value: (row) => row.reference },
    { key: 'reason', label: t('Reason'), value: (row) => row.reason }
  ];
  const categories = summary.data?.categories ?? [];

  const exports = {
    stock: { report: 'stock', columns: stockColumns, rows },
    low: { report: 'low-stock', columns: stockColumns, rows: low },
    category: { report: 'stock-categories', columns: categoryColumns, rows: categories },
    movement: { report: 'stock-movements', columns: movementColumns, loadRows: async () => (await api(movements.allPath)).movements }
  }[tab];
  const error = summary.error || products.error;

  return (
    <>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {summary.data && (
        <SumStrip items={[
          { label: t('Products'), value: summary.data.products },
          { label: t('Low stock'), value: summary.data.low, down: summary.data.low > 0 },
          { label: t('Out of stock'), value: summary.data.out, down: summary.data.out > 0 },
          { label: t('Stock value'), value: money(summary.data.value), note: t('At cost') }
        ]} />
      )}
      <div className="section-row">
        <div className="tabs rpt-subtabs">
          {Object.entries(TABS).map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{t(label)}</button>)}
        </div>
        <ReportExport user={user} title={t(TABS[tab])} {...exports} />
      </div>

      {(tab === 'stock' || tab === 'low') && (
        <ReportFilters
          category={category}
          categories={options?.categories ?? []}
          onCategory={setCategory}
          search={typed}
          onSearch={setTyped}
          onReset={() => { setCategory(''); setTyped(''); }}
        />
      )}
      {tab === 'stock' && (products.data ? <ReportTable columns={stockScreen} rows={rows} /> : <TableView columns={stockScreen} rows={[]} loading />)}
      {tab === 'low' && (products.data ? <ReportTable columns={stockScreen} rows={low} /> : <TableView columns={stockScreen} rows={[]} loading />)}
      {tab === 'category' && (
        <>
          <div className="card rpt-chart-card">
            <h3>{t('Stock value by category')}</h3>
            <CategoryBarChart data={categories.map((row) => ({ category: row.category, revenue: row.value }))} />
          </div>
          <ReportTable columns={categoryColumns} rows={categories} />
        </>
      )}
      {tab === 'movement' && (
        <>
          <ReportFilters
            period={period}
            product={product}
            products={options?.products ?? []}
            onProduct={setProduct}
            type={type}
            types={options?.movementTypes ?? []}
            onType={setType}
            search={typed}
            onSearch={setTyped}
            onReset={() => { period.reset(); setProduct(''); setType(''); setTyped(''); }}
          />
          {movements.error && <p className="form-error" role="alert">{t(movements.error)}</p>}
          {movements.data && (
            <SumStrip items={[
              { label: t('Stock in'), value: quantity(movements.data.totals.stockIn), note: `${movements.data.period.from} – ${movements.data.period.to}` },
              { label: t('Stock out'), value: quantity(movements.data.totals.stockOut) }
            ]} />
          )}
          <TableView columns={movementColumns} rows={movements.data?.movements ?? []} loading={!movements.data} sort={movements.sort === 'date' || movements.sort === 'quantity' ? movements.sort : null} dir={movements.dir} onSort={movements.onSort} />
          {movements.data && movements.data.total > movements.data.pageSize && <Pager page={movements.data.page} pageSize={movements.data.pageSize} total={movements.data.total} onPage={movements.setPage} />}
        </>
      )}
    </>
  );
}
