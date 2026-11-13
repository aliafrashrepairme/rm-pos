import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can, canOpen } from '../../app/access.js';
import { dateTime, money, percentChange, quantity } from '../../app/format.js';
import ChangeBars, { CHANGE_COLORS } from '../../components/ChangeBars.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const REFRESH_MS = 60000;

function Change({ current, previous }) {
  const { t } = useI18n();
  const change = percentChange(current, previous);
  if (change === null) return current ? <span className="dchip flat">● {t('new')}</span> : null;
  const tone = Math.abs(change) < 0.05 ? 'flat' : change > 0 ? 'up' : 'down';
  const arrow = change > 0 ? '▲ +' : change < 0 ? '▼ ' : '● ';
  return <span className={`dchip ${tone}`}>{arrow}{change.toFixed(1)}%</span>;
}

function Summary({ label, value, change, note }) {
  return (
    <div>
      <span className="sl">{label}</span>
      <b>{value}</b>
      {change}
      {note && <small>{note}</small>}
    </div>
  );
}

function SalesChart({ days }) {
  const { t } = useI18n();
  if (!days.some((day) => day.total > 0)) return <div className="empty">{t('No sales in the last 14 days.')}</div>;
  const rows = days.map((day) => ({ key: day.date, label: String(Number(day.date.slice(8))), value: Math.max(day.total, 0), date: day.date }));
  return (
    <>
      <ChangeBars rows={rows} ariaLabel={t('Sales — last 14 days')} formatTip={(row) => `${row.date}: ${money(row.value)}`} />
      <div className="legend">
        <span><i style={{ background: CHANGE_COLORS.UP }} />▲ {t('Higher than previous day')}</span>
        <span><i style={{ background: CHANGE_COLORS.DOWN }} />▼ {t('Lower than previous day')}</span>
        <span><i style={{ background: CHANGE_COLORS.FIRST }} />{t('First / no comparison')}</span>
      </div>
    </>
  );
}

function Watchlist({ items, onNavigate, showReorder }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <div className="section-row">
        <div>
          <h3>{t('Low-stock watchlist')}</h3>
          <div className="sub">{t('Items at or below their reorder level')}</div>
        </div>
        {showReorder && <button type="button" className="btn btn-outline btn-sm" onClick={() => onNavigate('Inventory')}>{t('Inventory')} →</button>}
      </div>
      {items.length === 0 && <div className="empty">{t('All items above reorder level.')}</div>}
      {items.map((item) => (
        <div className="list-row" key={item.id}>
          <span>
            <b className="pname">{item.name}</b><br />
            <span className="muted small-note">{[item.location, item.supplier].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="row-end">
            <Status value={item.stock <= 0 ? 'Out of Stock' : 'Low Stock'} label={t(item.stock <= 0 ? 'Out of Stock' : 'Low Stock')} /><br />
            <span className="muted small-note">{quantity(item.stock)} {t('on hand')} / {t('reorder at')} {quantity(item.minStock)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Tasks({ tasks, user, onNavigate }) {
  const { t } = useI18n();
  const items = [
    { icon: '⇩', count: tasks.toReceive, label: 'TO RECEIVE', screen: 'Purchases' },
    { icon: '⚖', count: tasks.pendingAdjustments, label: 'APPROVE', screen: 'Inventory' },
    { icon: '☑', count: tasks.openCounts, label: 'COUNTING', screen: 'Inventory' },
    { icon: '✓', count: tasks.submittedCounts, label: 'SUBMITTED', screen: 'Inventory' },
    { icon: '✦', count: 'AI', label: 'SCAN INVOICE', screen: 'AI Invoice Scan', quiet: true }
  ].filter((item) => canOpen(user, item.screen));

  return (
    <div className="card">
      <h3>{t('Inventory tasks')}</h3>
      <div className="sub task-sub">{t('Tap a keyword to open it')}</div>
      <div className="kw-grid">
        {items.map((item) => (
          <button type="button" key={item.label} className={`kw ${!item.quiet && item.count ? 'hot' : ''}`} onClick={() => onNavigate(item.screen)}>
            <span className="kw-ico">{item.icon}</span>
            <b>{item.count}</b>
            <span className="kw-tag">{t(item.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecentSales({ rows, timeZone }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <div className="section-row"><h3>{t('Recent transactions')}</h3></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{['Bill no.', 'Customer', 'Cashier', 'Date / time', 'Total', 'Status'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No records found.')}</div></td></tr>}
            {rows.map((row) => (
              <tr key={row.id}>
                <td><b>{row.billNo}</b></td>
                <td>{row.customer}</td>
                <td>{row.cashier}</td>
                <td>{dateTime(row.createdAt, timeZone)}</td>
                <td><b>{money(row.total)}</b></td>
                <td><Status value={row.status} label={t(row.status)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Activity({ rows, timeZone }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <div className="section-row"><h3>{t('Business activity')}</h3></div>
      {rows.length === 0 && <div className="empty">{t('No records found.')}</div>}
      {rows.map((row) => (
        <div className="list-row" key={row.id}>
          <span><b>{t(row.action)}</b>{row.description && <><br /><span className="muted small-note">{row.description}</span></>}</span>
          <span className="row-end muted small-note">{row.user}<br />{dateTime(row.createdAt, timeZone)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard({ user, onNavigate }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { dashboard } = await api('/api/dashboard');
      setData(dashboard);
      setError('');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading}>{t('Refresh')}</button>;
  const head = (
    <div className="page-head">
      <div>
        <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
        <h1>{t('Store dashboard')}</h1>
        <p>{t('Your hardware store at a glance.')}</p>
      </div>
      <div className="toolbar head-actions">{refresh}</div>
    </div>
  );

  // A failed refresh keeps the last figures on screen and says they may be out of date.
  if (!data) {
    return (
      <>
        {head}
        <div className="card"><div className="empty">{error ? <span className="form-error" role="alert">{t(error)}</span> : t('Loading…')}</div></div>
      </>
    );
  }

  return (
    <>
      {head}
      {error && <p className="notice" role="alert">{t('Could not refresh. These figures may be out of date.')}</p>}
      <div className="sum-strip">
        <Summary label={t("Today's sales")} value={money(data.today.net)} change={<Change current={data.today.net} previous={data.yesterday.net} />} note={t('vs this time yesterday')} />
        <Summary label={t('Monthly sales')} value={money(data.month.net)} change={<Change current={data.month.net} previous={data.lastMonth.net} />} note={t('vs same days last month')} />
        <Summary label={t('Total orders')} value={quantity(data.month.orders)} change={<Change current={data.month.orders} previous={data.lastMonth.orders} />} note={t('This month')} />
        <Summary label={t('Total products')} value={quantity(data.products.total)} note={`${data.products.low} ${t('low')} · ${data.products.out} ${t('out')}`} />
      </div>
      <div className="card dash-gap">
        <h3>{t('Sales — last 14 days')}</h3>
        <div className="sub chart-sub">{t('Each bar is coloured by change from the day before.')}</div>
        <SalesChart days={data.dailySales} />
      </div>
      <div className="grid two-col dash-gap">
        <Watchlist items={data.lowStock} onNavigate={onNavigate} showReorder={can(user, 'inventory.view')} />
        <Tasks tasks={data.tasks} user={user} onNavigate={onNavigate} />
      </div>
      <div className="grid two-col dash-gap dash-bottom">
        <RecentSales rows={data.recentSales} timeZone={data.timeZone} />
        <Activity rows={data.activity} timeZone={data.timeZone} />
      </div>
    </>
  );
}
