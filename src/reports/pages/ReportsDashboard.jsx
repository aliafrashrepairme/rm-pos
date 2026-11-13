import { useListRequest } from '../../app/useListRequest.js';
import { dateTime, money, quantity } from '../../app/format.js';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { PaymentMethodChart, RevenueTrendChart, TopProductsChart } from '../components/ReportChart.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import { TableView } from '../components/ReportTable.jsx';
import SumStrip from '../components/SumStrip.jsx';
import { queryString, usePeriod } from '../utils/useReportData.js';

export default function ReportsDashboard() {
  const { t } = useI18n();
  const period = usePeriod('last30');
  const query = queryString(period.params);
  const sales = useListRequest(`/api/reports/sales?${query}`);
  const payments = useListRequest(`/api/reports/payments?${query}`);
  const stock = useListRequest('/api/reports/inventory');
  const recent = useListRequest(`/api/reports/sales/bills?${query}&pageSize=10`);
  const error = sales.error || payments.error || stock.error || recent.error;
  const totals = sales.data?.totals;

  const columns = [
    { key: 'billNo', label: t('Bill no.'), value: (row) => <b>{row.billNo}</b> },
    { key: 'date', label: t('Date'), value: (row) => dateTime(row.date) },
    { key: 'customer', label: t('Customer'), value: (row) => row.customer },
    { key: 'total', label: t('Total'), value: (row) => money(row.total) },
    { key: 'status', label: t('Status'), value: (row) => <Status value={row.status} label={t(row.status)} /> }
  ];

  return (
    <>
      <ReportFilters period={period} onReset={period.reset} />
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {!totals && !error && <div className="card"><div className="empty">{t('Loading…')}</div></div>}
      {totals && (
        <>
          <SumStrip items={[
            { label: t('Total revenue'), value: money(totals.net), note: `${t('Refunds')}: ${money(totals.refunds)}` },
            { label: t('Total orders'), value: totals.orders },
            { label: t('Average order value'), value: money(totals.average) },
            { label: t('Total products sold'), value: quantity(totals.items) },
            ...(stock.data ? [{ label: t('Low stock'), value: stock.data.low, down: stock.data.low > 0, note: `${t('Out of stock')}: ${stock.data.out}` }] : [])
          ]} />
          <div className="rpt-charts-grid">
            <div className="card rpt-chart-card"><h3>{t('Sales trend')}</h3><p className="sub">{t('Revenue after refunds')}</p><RevenueTrendChart data={sales.data.trend} /></div>
            <div className="card rpt-chart-card"><h3>{t('Best-selling products')}</h3><p className="sub">{t('By quantity sold')}</p><TopProductsChart data={[...sales.data.products].sort((a, b) => b.qty - a.qty).slice(0, 5)} /></div>
            <div className="card rpt-chart-card"><h3>{t('Payment distribution')}</h3><p className="sub">{t('Money collected by method')}</p>{payments.data
              ? <PaymentMethodChart data={payments.data.methods.filter((row) => row.collected > 0).map((row) => ({ method: t(row.method), amount: row.collected }))} />
              : <div className="rpt-chart-empty">{t('Loading…')}</div>}</div>
          </div>
          <div>
            <h3 className="rpt-heading">{t('Recent sales')}</h3>
            <TableView columns={columns} rows={recent.data?.bills ?? []} loading={!recent.data} />
          </div>
        </>
      )}
    </>
  );
}
