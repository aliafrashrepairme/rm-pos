import { useEffect, useState } from 'react';
import { dateTime, money, quantity } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import BillModal from './BillModal.jsx';

const STATUSES = ['Paid', 'Partially Refunded', 'Refunded', 'Voided'];

export default function BillsPage({ user }) {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [status, setStatus] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { setPage(1); }, [search, status, start, end]);

  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set('q', search);
  if (status) params.set('status', status);
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const { data, error, reload } = useListRequest(`/api/transactions/bills?${params}`);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Bills register')}</h1>
        </div>
      </div>
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search bill no. or customer…')} placeholder={t('Search bill no. or customer…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <select className="filters" aria-label={t('Status')} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{t('All')}</option>
          {STATUSES.map((item) => <option key={item} value={item}>{t(item)}</option>)}
        </select>
        <input className="inp date-input" type="date" aria-label={t('From')} value={start} onChange={(event) => setStart(event.target.value)} />
        <input className="inp date-input" type="date" aria-label={t('To')} value={end} onChange={(event) => setEnd(event.target.value)} />
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{['Bill no.', 'Customer', 'Date / time', 'Items', 'Cashier', 'Payment', 'Total', 'Status', 'Action'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan="9"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.bills.length === 0 && <tr><td colSpan="9"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.bills.map((bill) => (
              <tr key={bill.id}>
                <td><b>{bill.billNo}</b></td>
                <td>{bill.customer}</td>
                <td>{dateTime(bill.createdAt)}</td>
                <td>{quantity(bill.items)}</td>
                <td>{bill.cashier}</td>
                <td>{t(bill.payment)}</td>
                <td><b>{money(bill.total)}</b></td>
                <td><Status value={bill.status} label={t(bill.status)} /></td>
                <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setOpenId(bill.id)}>{t('View')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {openId && <BillModal billId={openId} user={user} onClose={() => setOpenId(null)} onChanged={reload} />}
    </>
  );
}
