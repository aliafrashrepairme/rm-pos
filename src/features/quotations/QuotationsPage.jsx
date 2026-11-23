import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { dateTime, money } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import Pager from '../../components/Pager.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { usePrintDocument } from '../../components/usePrintDocument.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { useCart } from '../pos/CartContext.jsx';
import QuoteDocument from './QuoteDocument.jsx';
import QuoteForm from './QuoteForm.jsx';

const STATUSES = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Expired', 'Cancelled'];

// Which buttons each status offers. Converted only happens through a completed POS sale.
const MOVES = {
  Draft: [['send', 'Mark as sent', 'btn-primary'], ['cancel', 'Cancel quotation', 'btn-outline']],
  Sent: [['accept', 'Mark accepted', 'btn-primary'], ['reject', 'Mark rejected', 'btn-outline'], ['cancel', 'Cancel quotation', 'btn-outline']],
  Accepted: [['cancel', 'Cancel quotation', 'btn-outline']]
};

function QuoteModal({ quoteId, user, onClose, onChanged, onEdit, onConvert }) {
  const { t } = useI18n();
  const toast = useToast();
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { printArea, startPrint } = usePrintDocument();
  const canManage = can(user, 'quotations.manage');
  const canSell = can(user, 'pos.sell');

  useEffect(() => {
    api(`/api/quotations/${quoteId}`).then(({ quotation }) => setQuote(quotation)).catch((failure) => setError(failure.message));
  }, [quoteId]);

  async function move(action) {
    setBusy(true);
    setError('');
    try {
      const { quotation } = await api(`/api/quotations/${quoteId}/${action}`, { method: 'POST' });
      setQuote(quotation);
      toast(`${quotation.quoteNo} · ${t(quotation.status)}`);
      onChanged();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function print(kind) {
    startPrint({ kind, className: 'print-purchase', content: <QuoteDocument quote={quote} />, fileName: `${quote.quoteNo}.pdf`, size: 'a5' });
  }

  const priceChanged = quote?.lines.some((line) => line.currentPrice !== line.unitPrice || line.currentTaxRate !== line.taxRate);

  return (
    <Modal wide title={quote ? `${quote.quoteNo} · ${quote.customerName}` : t('Quotation')} description={quote ? `${t('Valid until')} ${quote.validUntil} · ${t('Created by')} ${quote.createdBy}` : ''} onClose={onClose}>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      {!quote && !error && <div className="empty">{t('Loading…')}</div>}
      {quote && (
        <>
          <div className="order-statuses">
            <Status value={quote.status} label={t(quote.status)} />
            {quote.billNo && <span className="badge">{t('Bill')} {quote.billNo}</span>}
            {quote.sentAt && <span className="muted small-note">{t('Sent')} {dateTime(quote.sentAt)}</span>}
          </div>
          <div className="receipt-stage modal-scroll"><QuoteDocument quote={quote} /></div>
          {quote.status === 'Accepted' && priceChanged && <div className="light-note">{t('Some prices have changed since this quotation was made. The bill will use the current prices.')}</div>}
          {quote.status === 'Accepted' && quote.labourFee > 0 && <div className="light-note">{t('This quotation includes a labour fee. It is not added to the POS bill, so charge it separately.')}</div>}
          {quote.status === 'Accepted' && !canSell && <div className="light-note">{t('A cashier converts accepted quotations into a bill from this screen.')}</div>}
          <div className="modal-actions-row quote-actions">
            <button type="button" className="btn btn-outline" onClick={() => print('pdf')}>⇩ {t('Download PDF')}</button>
            <button type="button" className="btn btn-outline" onClick={() => print('print')}>⎙ {t('Print')}</button>
            {canManage && quote.status === 'Draft' && <button type="button" className="btn btn-outline" onClick={() => onEdit(quote)}>✎ {t('Edit')}</button>}
            {canManage && (MOVES[quote.status] ?? []).map(([action, label, tone]) => (
              <button key={action} type="button" className={`btn ${tone}`} disabled={busy} onClick={() => move(action)}>{t(label)}</button>
            ))}
            {canSell && quote.status === 'Accepted' && <button type="button" className="btn btn-primary" onClick={() => onConvert(quote)}>▣ {t('Convert to bill')}</button>}
          </div>
        </>
      )}
      {printArea}
    </Modal>
  );
}

export default function QuotationsPage({ user, onNavigate }) {
  const { t } = useI18n();
  const toast = useToast();
  const cart = useCart();
  const canManage = can(user, 'quotations.manage');
  const [status, setStatus] = useState('');
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(null);

  useEffect(() => { setPage(1); }, [status, search]);
  const params = new URLSearchParams({ page: String(page) });
  if (status) params.set('status', status);
  if (search) params.set('q', search);
  const { data, error, reload } = useListRequest(`/api/quotations?${params}`);
  const counts = data?.counts ?? {};
  const all = Object.values(counts).reduce((sum, value) => sum + value, 0);

  // Puts the accepted quote on the POS bill. The quote is marked Converted once that sale completes.
  async function convert(quote) {
    if (cart.lines.length && !window.confirm(t('The current POS bill will be replaced with this quotation. Continue?'))) return;
    const unavailable = quote.lines.filter((line) => !line.active || line.stock < line.qty);
    let customer = null;
    if (quote.customerId) {
      customer = await api(`/api/customers/${quote.customerId}`).then((result) => result.customer).catch(() => null);
    }
    cart.clear();
    cart.setLines(quote.lines.filter((line) => line.active && line.stock > 0).map((line) => ({
      id: line.productId,
      name: line.name,
      sku: line.sku,
      unit: line.unit,
      price: line.currentPrice,
      taxRate: line.currentTaxRate,
      stock: line.stock,
      qty: Math.min(line.qty, line.stock)
    })));
    if (customer) cart.setCustomer(customer);
    cart.setQuotation({ id: quote.id, quoteNo: quote.quoteNo });
    if (unavailable.length) toast(`${t('Not enough stock for:')} ${unavailable.map((line) => line.name).join(', ')}`);
    setDialog(null);
    onNavigate('POS Billing');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Quotations')}</h1>
          <p>{t('Price offers for customers. Send, track the answer, and turn accepted ones into a bill.')}</p>
        </div>
        {canManage && (
          <div className="toolbar head-actions">
            <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}>＋ {t('New quotation')}</button>
          </div>
        )}
      </div>

      <div className="tabs dash-gap quote-tabs">
        <button type="button" className={status === '' ? 'active' : ''} onClick={() => setStatus('')}>{t('All')} <span className="tab-count">{all}</span></button>
        {STATUSES.map((item) => (
          <button type="button" key={item} className={status === item ? 'active' : ''} onClick={() => setStatus(item)}>
            {t(item)} <span className="tab-count">{counts[item] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="table-toolbar">
        <div className="search">
          <span>⌕</span>
          <input aria-label={t('Search quote no., customer or phone…')} placeholder={t('Search quote no., customer or phone…')} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['Quote No', 'Customer', 'Date', 'Valid until', 'Total', 'Status', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="7"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.quotations.length === 0 && <tr><td colSpan="7"><div className="empty">{t('No records found.')}</div></td></tr>}
            {data?.quotations.map((row) => (
              <tr key={row.id}>
                <td><b>{row.quoteNo}</b></td>
                <td>{row.customerName}<br /><span className="muted small-note">{row.customerPhone}</span></td>
                <td>{dateTime(row.createdAt)}</td>
                <td>{row.validUntil}</td>
                <td>{money(row.total)}</td>
                <td><Status value={row.status} label={t(row.status)} /></td>
                <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog({ kind: 'view', id: row.id })}>{t('View')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}

      {dialog?.kind === 'new' && (
        <QuoteForm
          onClose={() => setDialog(null)}
          onSaved={(quote) => { toast(`${quote.quoteNo} · ${t('Draft')}`); setDialog({ kind: 'view', id: quote.id }); reload(); }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <QuoteForm
          quote={dialog.quote}
          onClose={() => setDialog({ kind: 'view', id: dialog.quote.id })}
          onSaved={(quote) => { toast(t('Quotation updated.')); setDialog({ kind: 'view', id: quote.id }); reload(); }}
        />
      )}
      {dialog?.kind === 'view' && (
        <QuoteModal
          key={dialog.id}
          quoteId={dialog.id}
          user={user}
          onClose={() => setDialog(null)}
          onChanged={reload}
          onEdit={(quote) => setDialog({ kind: 'edit', quote })}
          onConvert={convert}
        />
      )}
    </>
  );
}
