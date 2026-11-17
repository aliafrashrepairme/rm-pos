import { useState } from 'react';
import { api } from '../../api.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import { dateTime, money, quantity } from '../../app/format.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { CategoryBarChart, RevenueTrendChart, TopProductsChart } from '../components/ReportChart.jsx';
import ReportExport from '../components/ReportExport.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import ReportTable, { TableView } from '../components/ReportTable.jsx';
import SumStrip from '../components/SumStrip.jsx';
import { queryString, useFilterOptions, usePagedReport, usePeriod } from '../utils/useReportData.js';

const GROUPS = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };
const TABS = { periods: 'Sales by period', categories: 'Sales by category', products: 'Sales by product', bills: 'Sales transactions' };

export default function SalesReport({ user }) {
  const { t } = useI18n();
  const options = useFilterOptions();
  const period = usePeriod('last7');
  const [group, setGroup] = useState('day');
  const [category, setCategory] = useState('');
  const [product, setProduct] = useState('');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [tab, setTab] = useState('periods');

  const filters = { ...period.params, category, product };
  const { data, error } = useListRequest(`/api/reports/sales?${queryString({ ...filters, group })}`);
  const bills = usePagedReport('/api/reports/sales/bills', { ...filters, q: search });
  const totals = data?.totals;
  const subtitle = data ? `${data.period.from} – ${data.period.to}` : '';

  const periodColumns = [
    { key: 'date', sort: 'date', label: t('Period'), value: (row) => row.date },
    { key: 'orders', sort: 'orders', label: t('Bills'), value: (row) => row.orders },
    { key: 'refunds', sort: 'refunds', label: t('Refunds'), value: (row) => money(row.refunds), csv: (row) => row.refunds },
    { key: 'revenue', sort: 'revenue', label: t('Revenue'), value: (row) => money(row.revenue), csv: (row) => row.revenue }
  ];
  const categoryColumns = [
    { key: 'category', sort: 'category', label: t('Category'), value: (row) => row.category },
    { key: 'qty', sort: 'qty', label: t('Qty sold'), value: (row) => quantity(row.qty), csv: (row) => row.qty },
    { key: 'revenue', sort: 'revenue', label: t('Revenue'), value: (row) => money(row.revenue), csv: (row) => row.revenue }
  ];
  const productColumns = [
    { key: 'name', sort: 'name', label: t('Product'), value: (row) => row.name },
    { key: 'sku', sort: 'sku', label: t('SKU'), value: (row) => row.sku },
    { key: 'category', sort: 'category', label: t('Category'), value: (row) => row.category },
    { key: 'qty', sort: 'qty', label: t('Qty sold'), value: (row) => quantity(row.qty), csv: (row) => row.qty },
    { key: 'revenue', sort: 'revenue', label: t('Revenue'), value: (row) => money(row.revenue), csv: (row) => row.revenue }
  ];
  const billColumns = [
    { key: 'billNo', sort: 'billNo', label: t('Bill no.'), value: (row) => row.billNo },
    { key: 'date', sort: 'date', label: t('Date'), value: (row) => dateTime(row.date) },
    { key: 'customer', sort: 'customer', label: t('Customer'), value: (row) => row.customer },
    { key: 'items', label: t('Items'), value: (row) => quantity(row.items), csv: (row) => row.items },
    { key: 'payment', label: t('Payment'), value: (row) => t(row.payment) },
    { key: 'status', label: t('Status'), value: (row) => t(row.status) },
    { key: 'refunded', label: t('Refunded'), value: (row) => money(row.refunded), csv: (row) => row.refunded },
    { key: 'total', sort: 'total', label: t('Total'), value: (row) => money(row.total), csv: (row) => row.total }
  ];
  const billScreen = billColumns.map((column) => (column.key === 'status' ? { ...column, value: (row) => <Status value={row.status} label={t(row.status)} /> } : column));

  const exports = {
    periods: { report: 'sales-periods', columns: periodColumns, rows: data?.trend ?? [] },
    categories: { report: 'sales-categories', columns: categoryColumns, rows: data?.categories ?? [] },
    products: { report: 'sales-products', columns: productColumns, rows: data?.products ?? [] },
    bills: { report: 'sales', columns: billColumns, loadRows: async () => (await api(bills.allPath)).bills }
  }[tab];

  return (
    <>
      <ReportFilters
        period={period}
        category={category}
        categories={options?.categories ?? []}
        onCategory={setCategory}
        product={product}
        products={options?.products ?? []}
        onProduct={setProduct}
        search={typed}
        onSearch={tab === 'bills' ? setTyped : undefined}
        onReset={() => { period.reset(); setCategory(''); setProduct(''); setTyped(''); }}
      />
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {!totals && !error && <div className="card"><div className="empty">{t('Loading…')}</div></div>}
      {totals && (
        <>
          <SumStrip items={[
            { label: t('Total revenue'), value: money(totals.net), note: subtitle },
            { label: t('Gross sales'), value: money(totals.gross) },
            { label: t('Refunds'), value: money(totals.refunds), down: totals.refunds > 0 },
            { label: t('Total orders'), value: totals.orders, note: `${t('Average order value')}: ${money(totals.average)}` },
            { label: t('Total items sold'), value: quantity(totals.items) }
          ]} />
          <div className="rpt-charts-grid">
            <div className="card rpt-chart-card">
              <div className="section-row">
                <h3>{t('Sales trend')}</h3>
                <select name="group" className="filters" aria-label={t('Group by')} value={group} onChange={(event) => setGroup(event.target.value)}>
                  {Object.entries(GROUPS).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
                </select>
              </div>
              <RevenueTrendChart data={data.trend} />
            </div>
            <div className="card rpt-chart-card"><h3>{t('Sales by category')}</h3><CategoryBarChart data={data.categories} /></div>
            <div className="card rpt-chart-card"><h3>{t('Best-selling products')}</h3><TopProductsChart data={[...data.products].sort((a, b) => b.qty - a.qty).slice(0, 8)} /></div>
          </div>
          <div className="section-row">
            <div className="tabs rpt-subtabs">
              {Object.entries(TABS).map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{t(label)}</button>)}
            </div>
            <ReportExport user={user} title={t(TABS[tab])} subtitle={subtitle} {...exports} />
          </div>
          {tab === 'periods' && <ReportTable columns={periodColumns} rows={data.trend} />}
          {tab === 'categories' && <ReportTable columns={categoryColumns} rows={data.categories} />}
          {tab === 'products' && <ReportTable columns={productColumns} rows={data.products} />}
          {tab === 'bills' && (
            <>
              {bills.error && <p className="form-error" role="alert">{t(bills.error)}</p>}
              <TableView columns={billScreen} rows={bills.data?.bills ?? []} loading={!bills.data} sort={bills.sort} dir={bills.dir} onSort={bills.onSort} />
              {bills.data && bills.data.total > bills.data.pageSize && <Pager page={bills.data.page} pageSize={bills.data.pageSize} total={bills.data.total} onPage={bills.setPage} />}
            </>
          )}
        </>
      )}
    </>
  );
}
