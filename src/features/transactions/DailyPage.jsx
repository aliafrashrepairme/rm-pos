import { useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { downloadCsv } from '../../app/csv.js';
import { dateTime, money, percentChange, quantity } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import ChangeBars, { CHANGE_COLORS } from '../../components/ChangeBars.jsx';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import BillModal from './BillModal.jsx';

export function Change({ current, previous, invert }) {
  const { t } = useI18n();
  const change = percentChange(current, previous);
  if (change === null) return current ? <span className="dchip flat">● {t('new')}</span> : null;
  const good = invert ? change < 0 : change > 0;
  const tone = Math.abs(change) < 0.05 ? 'flat' : good ? 'up' : 'down';
  return <span className={`dchip ${tone}`}>{change > 0 ? '▲ +' : change < 0 ? '▼ ' : '● '}{change.toFixed(1)}%</span>;
}

function shiftDate(date, days) {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

export default function DailyPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  // Monthly Transactions can ask for a particular day to be opened.
  const [date, setDate] = useState(() => {
    const asked = sessionStorage.getItem('rm-pos-open-day') ?? '';
    sessionStorage.removeItem('rm-pos-open-day');
    return asked;
  });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const { data, error, reload } = useListRequest(`/api/transactions/daily${date ? `?date=${date}` : ''}`);
  const daily = data?.daily;
  const shown = daily?.date ?? '';
  const bills = useListRequest(shown ? `/api/transactions/bills?start=${shown}&end=${shown}&page=${page}` : '/api/transactions/bills?pageSize=1');

  function choose(next) {
    setDate(next);
    setPage(1);
  }

  async function exportDay() {
    const rows = [['Time', 'Bill', 'Customer', 'Cashier', 'Payment', 'Items', 'Total', 'Status']];
    const first = await api(`/api/transactions/bills?start=${shown}&end=${shown}&pageSize=100&page=1`);
    let all = first.bills;
    for (let next = 2; next <= Math.ceil(first.total / 100); next += 1) {
      all = all.concat((await api(`/api/transactions/bills?start=${shown}&end=${shown}&pageSize=100&page=${next}`)).bills);
    }
    for (const bill of all) rows.push([dateTime(bill.createdAt, daily.timeZone), bill.billNo, bill.customer, bill.cashier, bill.payment, bill.items, bill.total, bill.status]);
    downloadCsv(`rm-transactions-${shown}.csv`, rows);
    toast(`rm-transactions-${shown}.csv`);
  }

  if (error) return <p className="form-error" role="alert">{t(error)}</p>;
  if (!daily) return <div className="card"><div className="empty">{t('Loading…')}</div></div>;

  const average = daily.day.orders ? daily.day.net / daily.day.orders : 0;
  const previousAverage = daily.previous.orders ? daily.previous.net / daily.previous.orders : 0;
  const rows = daily.days.map((day) => ({ key: day.date, label: String(Number(day.date.slice(8))), value: Math.max(day.total, 0), date: day.date }));
  const hasSales = rows.some((row) => row.value > 0);
  const canExport = can(user, 'reports.export') || can(user, 'bills.view');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Daily transactions')}</h1>
          <p>{new Date(`${shown}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <div className="toolbar head-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => choose(shiftDate(shown, -1))}>‹ {t('Previous day')}</button>
          <input className="inp date-input" type="date" aria-label={t('Date')} value={shown} max={daily.today} onChange={(event) => { if (event.target.value) choose(event.target.value); }} />
          <button type="button" className="btn btn-outline btn-sm" disabled={shown >= daily.today} onClick={() => choose(shiftDate(shown, 1))}>{t('Next day')} ›</button>
          {canExport && <button type="button" className="btn btn-primary btn-sm" onClick={exportDay}>{t('Export CSV')}</button>}
        </div>
      </div>

      <div className="sum-strip">
        <div><span className="sl">{t('Total sales')}</span><b>{money(daily.day.net)}</b><Change current={daily.day.net} previous={daily.previous.net} /><small>{t('vs previous day')}</small></div>
        <div><span className="sl">{t('Bills')}</span><b>{quantity(daily.day.orders)}</b><Change current={daily.day.orders} previous={daily.previous.orders} /><small>{t('vs previous day')}</small></div>
        <div><span className="sl">{t('Average bill')}</span><b>{money(average)}</b><Change current={average} previous={previousAverage} /><small>{t('vs previous day')}</small></div>
        <div><span className="sl">{t('Refunds')}</span><b>{money(daily.day.refunds)}</b><Change current={daily.day.refunds} previous={daily.previous.refunds} invert /><small>{quantity(daily.refundCount)} {t('Refunds')}</small></div>
      </div>

      <div className="card dash-gap">
        <h3>{t('Sales — last 14 days')}</h3>
        <div className="sub chart-sub">{t('Each bar is coloured by change from the day before. Tap a bar to open that day.')}</div>
        {hasSales ? (
          <>
            <ChangeBars rows={rows} ariaLabel={t('Sales — last 14 days')} selectedKey={shown} onSelect={(row) => choose(row.date)} formatTip={(row) => `${row.date}: ${money(row.value)}`} />
            <div className="legend">
              <span><i style={{ background: CHANGE_COLORS.UP }} />▲ {t('Higher than previous day')}</span>
              <span><i style={{ background: CHANGE_COLORS.DOWN }} />▼ {t('Lower than previous day')}</span>
              <span><i style={{ background: CHANGE_COLORS.FIRST }} />{t('First / no comparison')}</span>
            </div>
          </>
        ) : <div className="empty">{t('No sales in the last 14 days.')}</div>}
      </div>

      <div className="card dash-gap dash-bottom">
        <div className="section-row"><h3>{t('Transactions')}</h3></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>{['Time', 'Bill no.', 'Customer', 'Cashier', 'Payment', 'Items', 'Total', 'Status'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
            </thead>
            <tbody>
              {bills.data?.bills.length === 0 && <tr><td colSpan="8"><div className="empty">{t('No records found.')}</div></td></tr>}
              {bills.data?.bills.map((bill) => (
                <tr key={bill.id} className="clickable-row" onClick={() => setOpenId(bill.id)}>
                  <td>{new Date(bill.createdAt).toLocaleTimeString('en-GB', { timeZone: daily.timeZone, hour: '2-digit', minute: '2-digit', hour12: true })}</td>
                  <td><b>{bill.billNo}</b></td>
                  <td>{bill.customer}</td>
                  <td>{bill.cashier}</td>
                  <td>{t(bill.payment)}</td>
                  <td>{quantity(bill.items)}</td>
                  <td><b>{money(bill.total)}</b></td>
                  <td><Status value={bill.status} label={t(bill.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {bills.data && <Pager page={bills.data.page} pageSize={bills.data.pageSize} total={bills.data.total} onPage={setPage} />}
      </div>
      {openId && <BillModal billId={openId} user={user} onClose={() => setOpenId(null)} onChanged={() => { reload(); bills.reload(); }} />}
    </>
  );
}
