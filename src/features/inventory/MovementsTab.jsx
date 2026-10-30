import { useEffect, useState } from 'react';
import { dateTime, quantity } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const TYPES = ['Opening', 'Sale', 'Refund', 'Void', 'Purchase', 'Adjustment', 'Count', 'Import'];

export default function MovementsTab() {
  const { t } = useI18n();
  const [type, setType] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [type, start, end]);

  const params = new URLSearchParams({ page: String(page) });
  if (type) params.set('type', type);
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const { data, error } = useListRequest(`/api/inventory/movements?${params}`);

  return (
    <>
      <div className="table-toolbar">
        <select className="filters" aria-label={t('Movement')} value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">{t('All')}</option>
          {TYPES.map((item) => <option key={item} value={item}>{t(item)}</option>)}
        </select>
        <input className="inp date-input" type="date" aria-label={t('From')} value={start} onChange={(event) => setStart(event.target.value)} />
        <input className="inp date-input" type="date" aria-label={t('To')} value={end} onChange={(event) => setEnd(event.target.value)} />
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>{['Date / time', 'Product', 'Movement', 'Before', 'Change', 'After', 'Reason', 'Reference', 'User'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
          </thead>
          <tbody>
            {!data && !error && <tr><td colSpan="9"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.movements.length === 0 && <tr><td colSpan="9"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.movements.map((row) => (
              <tr key={row.id}>
                <td>{dateTime(row.createdAt)}</td>
                <td><b className="pname">{row.product}</b><br /><span className="muted small-note">{row.sku}</span></td>
                <td>{t(row.type)}</td>
                <td>{quantity(row.previous)}</td>
                <td><b className={row.change < 0 ? 'qty-down' : 'qty-up'}>{row.change > 0 ? '+' : ''}{quantity(row.change)}</b></td>
                <td><b>{quantity(row.next)}</b></td>
                <td>{row.reason}</td>
                <td>{row.reference}</td>
                <td>{row.user}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </>
  );
}
