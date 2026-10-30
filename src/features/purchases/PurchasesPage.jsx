import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { money } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import NewOrderModal from './NewOrderModal.jsx';
import OrderModal from './OrderModal.jsx';

const FILTERS = ['', 'Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled'];

export default function PurchasesPage({ user }) {
  const { t } = useI18n();
  const toast = useToast();
  const canManage = can(user, 'purchases.manage');
  const [status, setStatus] = useState('');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setPage(1); }, [status, search]);
  const params = new URLSearchParams({ page: String(page) });
  if (status) params.set('status', status);
  if (search) params.set('q', search);
  const { data, error, reload } = useListRequest(`/api/purchases?${params}`);
  const totals = useListRequest('/api/purchases/summary');
  const summary = totals.data?.summary;

  function refresh() {
    reload();
    totals.reload();
  }

  async function autoReorder() {
    setBusy(true);
    try {
      const { created, withoutSupplier } = await api('/api/purchases/auto-reorder', { method: 'POST' });
      const skipped = withoutSupplier ? ` ${withoutSupplier} ${t('low item(s) have no supplier.')}` : '';
      toast(created.length ? `${created.length} ${t('draft PO(s) created from reorder levels.')}${skipped}` : `${t('Nothing to reorder — open orders already cover low stock.')}${skipped}`);
      if (created.length) setStatus('Draft');
      refresh();
    } catch (failure) {
      toast(t(failure.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Purchases')}</h1>
          <p>{t('Create purchase orders, receive deliveries (GRN) and track supplier payments.')}</p>
        </div>
        {canManage && (
          <div className="toolbar head-actions">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={autoReorder}>⚡ {t('Auto-reorder')}</button>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>＋ {t('New purchase order')}</button>
          </div>
        )}
      </div>

      {summary && (
        <div className="sum-strip">
          <div><span className="sl">{t('Open orders')}</span><b>{summary.openOrders}</b></div>
          <div><span className="sl">{t('Awaiting delivery')}</span><b>{money(summary.awaiting)}</b></div>
          <div><span className="sl">{t('Balance payable')}</span><b>{money(summary.payable)}</b></div>
          <div><span className="sl">{t('Draft')}</span><b>{summary.drafts}</b></div>
        </div>
      )}

      <div className="tabs dash-gap">
        {FILTERS.map((item) => (
          <button type="button" key={item || 'all'} className={status === item ? 'active' : ''} onClick={() => setStatus(item)}>{t(item || 'All orders')}</button>
        ))}
      </div>
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search PO no. or supplier invoice…')} placeholder={t('Search PO no. or supplier invoice…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['PO no.', 'Supplier', 'Expected', 'Total', 'Received', 'Payment', 'Status', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="8"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.purchases.length === 0 && <tr><td colSpan="8"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.purchases.map((row) => (
              <tr key={row.id}>
                <td><b>{row.poNo}</b>{row.source === 'AI Scan' && <> <span className="ai-badge">AI</span></>}</td>
                <td>{row.supplier}</td>
                <td>{row.expectedAt ?? '—'}</td>
                <td>{money(row.total)}</td>
                <td><div className="received-cell"><div className="meter"><i style={{ width: `${row.receivedPercent}%` }} /></div><span className="muted">{row.receivedPercent}%</span></div></td>
                <td><Status value={row.paymentStatus} label={t(row.paymentStatus)} /></td>
                <td><Status value={row.status} label={t(row.status)} /></td>
                <td>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen({ id: row.id, mode: 'view' })}>{t('View')}</button>
                  {canManage && ['Ordered', 'Partially Received'].includes(row.status) && <> <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen({ id: row.id, mode: 'receive' })}>{t('Receive')}</button></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}

      {creating && (
        <NewOrderModal
          user={user}
          onClose={() => setCreating(false)}
          onCreated={(purchase) => {
            setCreating(false);
            toast(`${purchase.poNo} · ${t(purchase.status)}`);
            refresh();
          }}
        />
      )}
      {open && <OrderModal key={open.id} purchaseId={open.id} initialMode={open.mode} user={user} onClose={() => setOpen(null)} onChanged={refresh} />}
    </>
  );
}
