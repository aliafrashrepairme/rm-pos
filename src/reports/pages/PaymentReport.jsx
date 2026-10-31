import { useState } from 'react';
import { api } from '../../api.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import { dateTime, money } from '../../app/format.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { PaymentMethodChart, RevenueTrendChart } from '../components/ReportChart.jsx';
import ReportExport from '../components/ReportExport.jsx';
import ReportFilters from '../components/ReportFilters.jsx';
import { TableView } from '../components/ReportTable.jsx';
import SumStrip from '../components/SumStrip.jsx';
import { queryString, useFilterOptions, usePagedReport, usePeriod } from '../utils/useReportData.js';

export default function PaymentReport({ user }) {
  const { t } = useI18n();
  const options = useFilterOptions();
  const period = usePeriod('last30');
  const [method, setMethod] = useState('');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const { data, error } = useListRequest(`/api/reports/payments?${queryString(period.params)}`);
  const list = usePagedReport('/api/reports/payments/list', { ...period.params, method, q: search });
  const methods = data?.methods ?? [];
  const collected = (test) => methods.filter(test).reduce((sum, row) => sum + row.collected, 0);

  const columns = [
    { key: 'date', sort: 'date', label: t('Date'), value: (row) => dateTime(row.date) },
    { key: 'billNo', label: t('Bill no.'), value: (row) => row.billNo },
    { key: 'customer', label: t('Customer'), value: (row) => row.customer },
    { key: 'method', label: t('Method'), value: (row) => t(row.method) },
    { key: 'reference', label: t('Reference'), value: (row) => row.reference },
    { key: 'status', label: t('Status'), value: (row) => t(row.status) },
    { key: 'amount', sort: 'amount', label: t('Amount'), value: (row) => money(row.amount), csv: (row) => row.amount }
  ];
  const screen = columns.map((column) => (column.key === 'status' ? { ...column, value: (row) => <Status value={row.status} label={t(row.status)} /> } : column));
  const summaryColumns = [
    { key: 'method', label: t('Method'), value: (row) => t(row.method) },
    { key: 'payments', label: t('Payments'), value: (row) => row.payments },
    { key: 'collected', label: t('Collected'), value: (row) => money(row.collected) },
    { key: 'refunds', label: t('Refunds'), value: (row) => money(row.refunds) },
    { key: 'net', label: t('Net'), value: (row) => money(row.collected - row.refunds) }
  ];

  return (
    <>
      <ReportFilters
        period={period}
        method={method}
        methods={options?.paymentMethods ?? []}
        onMethod={setMethod}
        search={typed}
        onSearch={setTyped}
        onReset={() => { period.reset(); setMethod(''); setTyped(''); }}
      />
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {!data && !error && <div className="card"><div className="empty">{t('Loading…')}</div></div>}
      {data && (
        <>
          <SumStrip items={[
            { label: t('Total collected'), value: money(data.totals.collected), note: `${data.period.from} – ${data.period.to}` },
            { label: t('Cash payments'), value: money(collected((row) => row.method === 'Cash')) },
            { label: t('Card payments'), value: money(collected((row) => row.method === 'Card')) },
            { label: t('Other methods'), value: money(collected((row) => row.method !== 'Cash' && row.method !== 'Card')) },
            { label: t('Refunds'), value: money(data.totals.refunds), down: data.totals.refunds > 0, note: `${t('Net')}: ${money(data.totals.net)}` }
          ]} />
          <div className="rpt-charts-grid">
            <div className="card rpt-chart-card"><h3>{t('Payment distribution')}</h3><PaymentMethodChart data={methods.filter((row) => row.collected > 0).map((row) => ({ method: t(row.method), amount: row.collected }))} /></div>
            <div className="card rpt-chart-card"><h3>{t('Daily payment summary')}</h3><p className="sub">{t('Money collected less refunds')}</p><RevenueTrendChart data={data.trend} /></div>
          </div>
          <div>
            <h3 className="rpt-heading">{t('Payment summary')}</h3>
            <TableView columns={summaryColumns} rows={methods.map((row) => ({ ...row, id: row.method }))} />
          </div>
          <div className="section-row">
            <h3 className="rpt-heading">{t('Payment history')}</h3>
            <ReportExport
              user={user}
              report="payments"
              title={t('Payment history')}
              subtitle={`${data.period.from} – ${data.period.to}`}
              columns={columns}
              loadRows={async () => (await api(list.allPath)).payments}
            />
          </div>
          {list.error && <p className="form-error" role="alert">{t(list.error)}</p>}
          <TableView columns={screen} rows={list.data?.payments ?? []} loading={!list.data} sort={list.sort} dir={list.dir} onSort={list.onSort} />
          {list.data && list.data.total > list.data.pageSize && <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={list.setPage} />}
        </>
      )}
    </>
  );
}
