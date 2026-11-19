import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { dateTime, money } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const PAY_METHODS = ['Cash', 'Card', 'Bank transfer'];
const SUPPLIER_METHODS = ['Cash', 'Bank transfer', 'Cheque'];

function tierOf(points) {
  if (points >= 1000) return 'Gold';
  if (points >= 400) return 'Silver';
  return 'Bronze';
}

function CustomerCreditModal({ customerId, user, onClose, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState({ amount: '', method: 'Cash', reference: '' });
  const [limit, setLimit] = useState('');
  const canCollect = can(user, 'credit.collect');
  const canManage = can(user, 'credit.manage');

  async function load() {
    try {
      const result = await api(`/api/credit/customers/${customerId}`);
      setData(result);
      setLimit(String(result.customer.creditLimit));
    } catch (failure) {
      setError(failure.message);
    }
  }
  useEffect(() => { load(); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function receive(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api(`/api/credit/customers/${customerId}/payments`, { method: 'POST', body: JSON.stringify(payment) });
      setData(result);
      setPayment({ amount: '', method: payment.method, reference: '' });
      toast(`${t('Payment received.')} ${t('Balance')}: ${money(result.customer.creditBalance)}${payment.method === 'Cash' && !result.inShift ? ` · ${t('No shift is open, so this cash is not counted in a drawer.')}` : ''}`);
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api(`/api/credit/customers/${customerId}/limit`, { method: 'PUT', body: JSON.stringify({ limit }) });
      setData(result);
      toast(t('Credit limit saved.'));
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const customer = data?.customer;
  const method = PAY_METHODS.includes(payment.method) ? payment.method : 'Cash';

  return (
    <Modal wide title={customer ? `${customer.name} · ${customer.code}` : t('Customer credit')} description={customer?.phone} onClose={onClose}>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      {!data && !error && <div className="empty">{t('Loading…')}</div>}
      {customer && (
        <>
          <div className="sum-strip">
            <div><span className="sl">{t('Owes')}</span><b>{money(customer.creditBalance)}</b></div>
            <div><span className="sl">{t('Credit limit')}</span><b>{money(customer.creditLimit)}</b></div>
            <div><span className="sl">{t('Credit available')}</span><b>{money(customer.creditAvailable)}</b></div>
            <div><span className="sl">{t('Loyalty points')}</span><b>{customer.loyaltyPoints}</b></div>
          </div>
          <div className="credit-forms">
            {canCollect && customer.creditBalance > 0 && (
              <form className="inline-panel" onSubmit={receive}>
                <b>{t('Receive payment')}</b>
                <div className="form-grid">
                  <label className="field">{t('Amount (LKR)')}<input name="amount" type="number" min="0.01" step="0.01" max={customer.creditBalance} value={payment.amount} onChange={(event) => setPayment((current) => ({ ...current, amount: event.target.value }))} required /></label>
                  <label className="field">{t('Method')}
                    <select name="method" value={method} onChange={(event) => setPayment((current) => ({ ...current, method: event.target.value }))}>
                      {PAY_METHODS.map((item) => <option key={item} value={item}>{t(item)}</option>)}
                    </select>
                  </label>
                  {method === 'Bank transfer' && <label className="field full">{t('Reference')}<input name="reference" value={payment.reference} onChange={(event) => setPayment((current) => ({ ...current, reference: event.target.value }))} maxLength={100} required /></label>}
                </div>
                <div className="modal-actions-row">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setPayment((current) => ({ ...current, amount: String(customer.creditBalance) }))}>{t('Full balance')}</button>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{t('Save payment')}</button>
                </div>
              </form>
            )}
            {canManage && (
              <form className="inline-panel" onSubmit={saveLimit}>
                <b>{t('Credit limit')}</b>
                <label className="field">{t('Limit (LKR)')}<input name="limit" type="number" min="0" step="0.01" value={limit} onChange={(event) => setLimit(event.target.value)} required /></label>
                <span className="muted small-note">{t('Set 0 to stop selling to this customer on credit.')}</span>
                <div className="modal-actions-row"><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{t('Save limit')}</button></div>
              </form>
            )}
          </div>
          <div className="table-wrap modal-scroll">
            <table>
              <thead><tr>{['Date', 'Entry', 'Type', 'Bill / reference', 'Method', 'Amount', 'Balance', 'By'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan="8"><div className="empty">{t('No credit history yet.')}</div></td></tr>}
                {data.entries.map((row) => (
                  <tr key={row.entryNo}>
                    <td>{dateTime(row.createdAt)}</td>
                    <td>{row.entryNo}</td>
                    <td>{t(row.kind)}</td>
                    <td>{row.billNo || row.reference || '—'}</td>
                    <td>{row.method ? t(row.method) : '—'}</td>
                    <td className={row.amount < 0 ? 'qty-up' : 'qty-down'}>{row.amount > 0 ? '+' : '−'} {money(Math.abs(row.amount))}</td>
                    <td><b>{money(row.balanceAfter)}</b></td>
                    <td>{row.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function CustomerCreditTab({ user }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('all');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  useEffect(() => { setPage(1); }, [filter, search]);
  const params = new URLSearchParams({ page: String(page), filter });
  if (search) params.set('q', search);
  const { data, error, reload } = useListRequest(`/api/credit/customers?${params}`);

  return (
    <>
      {data && (
        <div className="sum-strip">
          <div><span className="sl">{t('Total owed by customers')}</span><b>{money(data.summary.totalOwed)}</b></div>
          <div><span className="sl">{t('Customers owing')}</span><b>{data.summary.customersOwing}</b></div>
          <div><span className="sl">{t('Over their limit')}</span><b>{data.summary.overLimit}</b></div>
        </div>
      )}
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search any customer to give credit…')} placeholder={t('Search any customer to give credit…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <select className="filters" aria-label={t('Show')} value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">{t('All credit customers')}</option>
          <option value="owing">{t('Owing money')}</option>
        </select>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['Code', 'Customer', 'Phone', 'Credit limit', 'Owes', 'Available', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="7"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.customers.length === 0 && <tr><td colSpan="7"><div className="empty">{t(search ? 'No records found.' : 'No credit customers yet. Search for a customer to set a credit limit.')}</div></td></tr>}
            {data?.customers.map((row) => (
              <tr key={row.id}>
                <td>{row.code}</td>
                <td><b>{row.name}</b></td>
                <td>{row.phone}</td>
                <td>{money(row.creditLimit)}</td>
                <td className={row.creditBalance > row.creditLimit ? 'qty-down' : ''}><b>{money(row.creditBalance)}</b></td>
                <td>{money(row.creditAvailable)}</td>
                <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(row.id)}>{t('Open')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      {open && <CustomerCreditModal key={open} customerId={open} user={user} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function PaySupplier({ row, onClose, onDone }) {
  const { t } = useI18n();
  const [values, setValues] = useState({ amount: String(row.balance), method: 'Bank transfer', reference: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api(`/api/purchases/${row.id}/pay`, { method: 'POST', body: JSON.stringify(values) });
      onDone();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`${t('Pay supplier')} · ${row.poNo}`} description={`${row.supplier} · ${t('Balance')} ${money(row.balance)}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field">{t('Amount (LKR)')}<input type="number" min="0.01" step="0.01" max={row.balance} value={values.amount} onChange={(event) => setValues((current) => ({ ...current, amount: event.target.value }))} required autoFocus /></label>
          <label className="field">{t('Method')}
            <select value={values.method} onChange={(event) => setValues((current) => ({ ...current, method: event.target.value }))}>
              {SUPPLIER_METHODS.map((item) => <option key={item} value={item}>{t(item)}</option>)}
            </select>
          </label>
          <label className="field full">{t('Reference')}<input value={values.reference} onChange={(event) => setValues((current) => ({ ...current, reference: event.target.value }))} maxLength={100} /></label>
        </div>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Save payment')}</button>
        </div>
      </form>
    </Modal>
  );
}

function SupplierCreditTab({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error, reload } = useListRequest('/api/credit/suppliers');
  const [paying, setPaying] = useState(null);
  const canPay = can(user, 'supplier_payments.manage');

  return (
    <>
      {data && (
        <div className="sum-strip">
          <div><span className="sl">{t('Total owed to suppliers')}</span><b>{money(data.summary.totalOwed)}</b></div>
          <div><span className="sl">{t('Overdue')}</span><b className={data.summary.overdue > 0 ? 'qty-down' : ''}>{money(data.summary.overdue)}</b></div>
          <div><span className="sl">{t('Overdue orders')}</span><b>{data.summary.overdueCount}</b></div>
        </div>
      )}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['PO no.', 'Supplier', 'Terms', 'Total', 'Paid', 'Balance', 'Due date', 'Status', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="9"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.payables.length === 0 && <tr><td colSpan="9"><div className="empty">{t('Nothing is owed to suppliers.')}</div></td></tr>}
            {data?.payables.map((row) => (
              <tr key={row.id}>
                <td><b>{row.poNo}</b></td>
                <td>{row.supplier}</td>
                <td>{t(row.terms)}</td>
                <td>{money(row.total)}</td>
                <td>{money(row.paid)}</td>
                <td><b>{money(row.balance)}</b></td>
                <td>{row.dueDate}</td>
                <td>{row.daysOverdue > 0 ? <Status value="Overdue" label={`${t('Overdue')} ${row.daysOverdue} ${t('days')}`} /> : <Status value="Due" label={t('Not yet due')} />}</td>
                <td>{canPay && <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(row)}>{t('Pay')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paying && <PaySupplier row={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); toast(t('Supplier payment recorded.')); reload(); }} />}
    </>
  );
}

function LoyaltyTab() {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [search]);
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set('q', search);
  const { data, error } = useListRequest(`/api/credit/points?${params}`);

  return (
    <>
      <div className="light-note loyalty-rules">
        ⭐ {t('Customers earn 1 point for every LKR 100 they pay (Gold members earn double).')} {t('1 point = LKR 1 when spent at POS.')} {t('Points can only cover the profit on a bill (selling price minus cost price), so goods are never sold below cost.')}
      </div>
      {data && (
        <div className="sum-strip">
          <div><span className="sl">{t('Points held by customers')}</span><b>{data.summary.outstandingPoints.toLocaleString('en-LK')}</b></div>
          <div><span className="sl">{t('Value if all spent')}</span><b>{money(data.summary.outstandingValue)}</b></div>
        </div>
      )}
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search customer…')} placeholder={t('Search customer…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['Code', 'Customer', 'Phone', 'Tier', 'Points', 'Value'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {data?.customers.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.customers.map((row) => (
              <tr key={row.id}>
                <td>{row.code}</td>
                <td><b>{row.name}</b></td>
                <td>{row.phone}</td>
                <td>{t(tierOf(row.loyaltyPoints))}</td>
                <td><b>{row.loyaltyPoints}</b></td>
                <td>{money(row.loyaltyPoints)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      <h3 className="section-title">{t('Recent point spending')}</h3>
      <div className="table-wrap">
        <table>
          <thead><tr>{['Date', 'Bill', 'Customer', 'Bill total', 'Points used'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {data?.redemptions.length === 0 && <tr><td colSpan="5"><div className="empty">{t('No points have been spent yet.')}</div></td></tr>}
            {data?.redemptions.map((row) => (
              <tr key={row.billNo}>
                <td>{dateTime(row.createdAt)}</td>
                <td><b>{row.billNo}</b></td>
                <td>{row.customer}</td>
                <td>{money(row.billTotal)}</td>
                <td>{row.points} ({money(row.points)})</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function CreditPage({ user }) {
  const { t } = useI18n();
  const canSeeSuppliers = can(user, 'purchases.view', 'supplier_payments.manage');
  const tabs = [['customers', 'Customer credit'], ...(canSeeSuppliers ? [['suppliers', 'Supplier credit']] : []), ['points', 'Loyalty points']];
  const [tab, setTab] = useState('customers');

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Credit management')}</h1>
          <p>{t('What customers owe, what the shop owes suppliers, and the loyalty points customers hold.')}</p>
        </div>
      </div>
      <div className="tabs dash-gap">
        {tabs.map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{t(label)}</button>)}
      </div>
      {tab === 'customers' && <CustomerCreditTab user={user} />}
      {tab === 'suppliers' && canSeeSuppliers && <SupplierCreditTab user={user} />}
      {tab === 'points' && <LoyaltyTab />}
    </>
  );
}
