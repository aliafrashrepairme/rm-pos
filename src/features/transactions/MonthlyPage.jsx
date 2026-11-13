import { useState } from 'react';
import { can } from '../../app/access.js';
import { downloadCsv } from '../../app/csv.js';
import { money, quantity, shortMoney } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import ChangeBars, { CHANGE_COLORS } from '../../components/ChangeBars.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { Change } from './DailyPage.jsx';

const HEAT = ['#fff2c2', '#ffe07a', '#f6c928', '#cf9b00', '#8a6400'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monthLabel(year, month) {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' });
}

function Heatmap({ days, onOpenDay }) {
  const { t } = useI18n();
  const values = days.map((day) => day.totals.net);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const first = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return (
    <>
      <div className="hm-grid">
        {WEEKDAYS.map((day) => <div className="hm-h" key={day}>{t(day)}</div>)}
        {Array.from({ length: first }, (_, index) => <div key={`blank-${index}`} />)}
        {days.map((day) => {
          const value = day.totals.net;
          const level = Math.min(4, Math.floor(((value - min) / (max - min || 1)) * 4.999));
          return (
            <button
              type="button"
              key={day.date}
              className="hm-cell"
              style={{ background: HEAT[level], color: level >= 3 ? '#fff' : '#171717' }}
              title={`${day.date}: ${money(value)}`}
              onClick={() => onOpenDay(day.date)}
            >
              <b>{Number(day.date.slice(8))}</b>
              <span>{shortMoney(value)}</span>
            </button>
          );
        })}
      </div>
      <div className="legend heat-legend">
        <span>{t('Low')}</span>
        {HEAT.map((color) => <i key={color} style={{ background: color }} />)}
        <span>{t('High')}</span>
      </div>
    </>
  );
}

export default function MonthlyPage({ user, onNavigate }) {
  const { t } = useI18n();
  const [chosen, setChosen] = useState(null);
  const { data, error } = useListRequest(`/api/transactions/monthly${chosen ? `?year=${chosen.year}&month=${chosen.month}` : ''}`);
  const monthly = data?.monthly;

  if (error) return <p className="form-error" role="alert">{t(error)}</p>;
  if (!monthly) return <div className="card"><div className="empty">{t('Loading…')}</div></div>;

  const key = (item) => `${item.year}-${item.month}`;
  const rows = monthly.months.map((item) => ({
    key: key(item),
    label: new Date(Date.UTC(item.year, item.month - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short' }),
    value: Math.max(item.total, 0),
    year: item.year,
    month: item.month
  }));
  const hasSales = rows.some((row) => row.value > 0);
  const label = monthLabel(monthly.year, monthly.month);
  const dayCount = monthly.days.length;
  const previousAverage = dayCount ? monthly.previous.net / dayCount : 0;
  const canExport = can(user, 'reports.export') || can(user, 'bills.view');

  function exportMonth() {
    const csv = [['Date', 'Bills', 'Sales', 'Refunds', 'Net']];
    for (const day of monthly.days) csv.push([day.date, day.totals.orders, day.totals.gross, day.totals.refunds, day.totals.net]);
    downloadCsv(`rm-month-${monthly.year}-${String(monthly.month).padStart(2, '0')}.csv`, csv);
  }

  const openDay = (date) => {
    sessionStorage.setItem('rm-pos-open-day', date);
    onNavigate('Daily Transactions');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Monthly transactions')}</h1>
          <p>{label}{monthly.isCurrent ? ` · ${dayCount} ${t('day(s) so far')}` : ''}</p>
        </div>
        <div className="toolbar head-actions">
          <select
            className="filters"
            aria-label={t('Month')}
            value={`${monthly.year}-${monthly.month}`}
            onChange={(event) => {
              const [year, month] = event.target.value.split('-').map(Number);
              setChosen({ year, month });
            }}
          >
            {monthly.months.map((item) => <option key={key(item)} value={key(item)}>{monthLabel(item.year, item.month)}</option>)}
          </select>
          {canExport && <button type="button" className="btn btn-primary btn-sm" onClick={exportMonth}>{t('Export CSV')}</button>}
        </div>
      </div>

      <div className="sum-strip">
        <div><span className="sl">{t('Total sales')}</span><b>{money(monthly.totals.net)}</b><Change current={monthly.totals.net} previous={monthly.previous.net} /><small>{t('vs same days last month')}</small></div>
        <div><span className="sl">{t('Bills')}</span><b>{quantity(monthly.totals.orders)}</b><Change current={monthly.totals.orders} previous={monthly.previous.orders} /><small>{t('vs same days last month')}</small></div>
        <div><span className="sl">{t('Average per day')}</span><b>{money(dayCount ? monthly.totals.net / dayCount : 0)}</b><Change current={dayCount ? monthly.totals.net / dayCount : 0} previous={previousAverage} /><small>{t('vs last month')}</small></div>
        <div><span className="sl">{t('Gross profit')}</span><b>{money(monthly.grossProfit)}</b><small>{t('Sales less VAT and the cost of goods')}</small></div>
      </div>

      <div className="grid two-col dash-gap dash-bottom">
        <div className="card">
          <h3>{t('Monthly sales — last 12 months')}</h3>
          <div className="sub chart-sub">{t('Coloured by change from the month before. Tap a bar to open that month.')}</div>
          {hasSales ? (
            <>
              <ChangeBars rows={rows} ariaLabel={t('Monthly sales')} selectedKey={key(monthly)} onSelect={(row) => setChosen({ year: row.year, month: row.month })} formatTip={(row) => `${row.label}: ${money(row.value)}`} />
              <div className="legend">
                <span><i style={{ background: CHANGE_COLORS.UP }} />▲ {t('Higher than previous month')}</span>
                <span><i style={{ background: CHANGE_COLORS.DOWN }} />▼ {t('Lower than previous month')}</span>
              </div>
            </>
          ) : <div className="empty">{t('No records found.')}</div>}
        </div>
        <div className="card">
          <h3>{t('Daily sales heatmap')}</h3>
          <div className="sub chart-sub">{t('Darker = higher sales. Tap a day to see its bills.')}</div>
          <Heatmap days={monthly.days} onOpenDay={openDay} />
        </div>
      </div>

      <div className="card dash-gap dash-bottom">
        <h3>{t('Day by day')}</h3>
        <div className="table-wrap">
          <table>
            <thead><tr>{['Date', 'Bills', 'Sales', 'Refunds', ''].map((heading) => <th key={heading || 'open'}>{heading && t(heading)}</th>)}</tr></thead>
            <tbody>
              {[...monthly.days].reverse().map((day) => (
                <tr key={day.date}>
                  <td>{new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })}</td>
                  <td>{day.totals.orders}</td>
                  <td><b>{money(day.totals.net)}</b></td>
                  <td>{money(day.totals.refunds)}</td>
                  <td><button type="button" className="btn btn-outline btn-sm" onClick={() => openDay(day.date)}>{t('View day')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
