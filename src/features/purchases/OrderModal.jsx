import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { createDuplicateFilter } from '../../app/barcode.js';
import { dateTime, money, quantity } from '../../app/format.js';
import Modal from '../../components/Modal.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { usePrintDocument } from '../../components/usePrintDocument.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import PurchaseBill from './PurchaseBill.jsx';

function ReceiveForm({ purchase, canScan, onDone, onCancel }) {
  const { t } = useI18n();
  const due = purchase.lines.filter((line) => line.received < line.ordered);
  const [values, setValues] = useState(() => Object.fromEntries(due.map((line) => [line.id, String(line.ordered - line.received)])));
  const [note, setNote] = useState('');
  const [scan, setScan] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(null);
  const isNew = useMemo(() => createDuplicateFilter({ windowMs: 250 }), []);

  useEffect(() => { request.current = null; }, [values, note]);

  function clearForCounting() {
    setValues(Object.fromEntries(due.map((line) => [line.id, ''])));
    setNotice('');
  }

  // Scanning counts what actually arrived, one unit at a time, against this order only.
  function submitScan(event) {
    event.preventDefault();
    const code = scan.trim();
    setScan('');
    if (!code || !isNew(code)) return;
    const line = due.find((item) => item.barcode === code || item.sku.toLowerCase() === code.toLowerCase());
    if (!line) {
      setNotice(`${t('This code is not due on this order:')} ${code}`);
      return;
    }
    const next = Number(values[line.id] || 0) + 1;
    if (next > line.ordered - line.received) {
      setNotice(`${line.name}: ${t('all due units are already counted.')}`);
      return;
    }
    setValues((current) => ({ ...current, [line.id]: String(next) }));
    setNotice(`${line.name}: ${next}`);
  }

  async function submit() {
    setError('');
    const lines = due.filter((line) => Number(values[line.id]) > 0).map((line) => ({ purchaseItemId: line.id, qty: Number(values[line.id]) }));
    if (!lines.length) {
      setError('Enter the quantity delivered for at least one product.');
      return;
    }
    request.current ||= crypto.randomUUID();
    setBusy(true);
    try {
      const result = await api(`/api/purchases/${purchase.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ clientRequestId: request.current, lines, note })
      });
      onDone(result.purchase, `${result.grnNo} · ${t('Goods received.')}`);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <>
      <p className="sub">{t('Enter quantities delivered. Stock and the inventory ledger update when you post.')}</p>
      {canScan && (
        <div className="receive-scan">
          <form className="search" onSubmit={submitScan}>
            <span>⌸</span>
            <input name="receiveScan" aria-label={t('Scan or type a barcode')} placeholder={t('Scan or type a barcode')} value={scan} onChange={(event) => setScan(event.target.value)} autoComplete="off" />
          </form>
          <button type="button" className="btn btn-outline btn-sm" onClick={clearForCounting}>{t('Count by scanning')}</button>
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      <div className="modal-scroll">
        <div className="table-wrap">
          <table>
            <thead><tr>{['Product', 'Ordered', 'Already received', 'Receiving now'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
            <tbody>
              {due.map((line) => (
                <tr key={line.id}>
                  <td><b className="pname">{line.name}</b></td>
                  <td>{quantity(line.ordered)}</td>
                  <td>{quantity(line.received)}</td>
                  <td><input className="mini-input" type="number" min="0" max={line.ordered - line.received} step="any" aria-label={`${t('Receiving now')} ${line.name}`} value={values[line.id]} onChange={(event) => setValues((current) => ({ ...current, [line.id]: event.target.value }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <label className="field receive-note">{t('Note')}<input name="receiveNote" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onCancel}>{t('Back')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>{t('Post GRN')}</button>
      </div>
    </>
  );
}

function PayForm({ purchase, onDone, onCancel }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState(purchase.balance.toFixed(2));
  const [method, setMethod] = useState('Bank transfer');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { purchase: updated } = await api(`/api/purchases/${purchase.id}/pay`, { method: 'POST', body: JSON.stringify({ amount, method, reference }) });
      onDone(updated, t('Payment recorded.'));
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="sub">{purchase.supplier.name} · {t('Balance')} {money(purchase.balance)}</p>
      <div className="form-grid">
        <label className="field">{t('Amount (LKR)')}<input name="payAmount" type="number" min="0.01" step="0.01" max={purchase.balance} value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
        <label className="field">{t('Method')}
          <select name="payMethod" value={method} onChange={(event) => setMethod(event.target.value)}>
            {['Bank transfer', 'Cash', 'Cheque'].map((item) => <option key={item} value={item}>{t(item)}</option>)}
          </select>
        </label>
        <label className="field full">{t('Reference')}<input name="payReference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} placeholder={t('Cheque no. / transfer ref')} /></label>
      </div>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onCancel}>{t('Back')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{t('Record supplier payment')}</button>
      </div>
    </form>
  );
}

export default function OrderModal({ purchaseId, user, initialMode = 'view', onClose, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [purchase, setPurchase] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);
  const { printArea, startPrint } = usePrintDocument();

  const load = useCallback(async () => {
    try {
      setPurchase((await api(`/api/purchases/${purchaseId}`)).purchase);
    } catch (failure) {
      setError(failure.message);
    }
  }, [purchaseId]);

  useEffect(() => { load(); }, [load]);

  function done(updated, message) {
    setPurchase(updated);
    setMode('view');
    toast(message);
    onChanged?.();
  }

  async function act(path, message) {
    setBusy(true);
    try {
      const { purchase: updated } = await api(`/api/purchases/${purchaseId}/${path}`, { method: 'POST' });
      done(updated, message);
    } catch (failure) {
      toast(t(failure.message));
      load();
    } finally {
      setBusy(false);
    }
  }

  function print(kind) {
    startPrint({
      kind,
      className: 'print-purchase',
      content: <PurchaseBill purchase={purchase} />,
      fileName: `${purchase.poNo}.pdf`,
      size: 'a5',
      onDone: (finished) => {
        api(`/api/purchases/${purchase.id}/printed`, { method: 'POST', body: JSON.stringify({ kind: finished }) })
          .catch((failure) => console.error('Could not record the printed bill:', failure.message));
      }
    });
  }

  const canManage = can(user, 'purchases.manage');
  const canPay = can(user, 'supplier_payments.manage');
  const open = purchase && ['Ordered', 'Partially Received'].includes(purchase.status);
  const payable = purchase && !['Draft', 'Cancelled'].includes(purchase.status) && purchase.balance > 0;
  const cancellable = purchase && ['Draft', 'Ordered'].includes(purchase.status) && purchase.paid === 0;

  return (
    <Modal wide title={purchase ? `${purchase.poNo} · ${purchase.supplier.name}` : t('Purchase order')} description={purchase ? [purchase.source, purchase.invoiceNo].filter(Boolean).join(' · ') : ''} onClose={onClose}>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {!purchase && !error && <div className="empty">{t('Loading…')}</div>}
      {purchase && mode === 'receive' && <ReceiveForm purchase={purchase} canScan={can(user, 'barcode.scan')} onDone={done} onCancel={() => setMode('view')} />}
      {purchase && mode === 'pay' && <PayForm purchase={purchase} onDone={done} onCancel={() => setMode('view')} />}
      {purchase && mode === 'bill' && (
        <>
          <div className="receipt-stage modal-scroll"><PurchaseBill purchase={purchase} /></div>
          <div className="modal-actions-row">
            <button type="button" className="btn btn-outline" onClick={() => setMode('view')}>{t('Back')}</button>
            <button type="button" className="btn btn-outline" onClick={() => print('pdf')}>⇩ {t('Download PDF')}</button>
            <button type="button" className="btn btn-primary" onClick={() => print('print')}>⎙ {t('Print bill')}</button>
          </div>
        </>
      )}
      {purchase && mode === 'view' && (
        <>
          <div className="order-statuses">
            <Status value={purchase.status} label={t(purchase.status)} />
            <Status value={purchase.paymentStatus} label={t(purchase.paymentStatus)} />
          </div>
          <div className="modal-scroll">
            <div className="table-wrap">
              <table>
                <thead><tr>{['Product', 'Ordered', 'Received', 'Unit cost', 'Line total'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
                <tbody>
                  {purchase.lines.map((line) => (
                    <tr key={line.id}>
                      <td><b className="pname">{line.name}</b></td>
                      <td>{quantity(line.ordered)}</td>
                      <td>{quantity(line.received)}</td>
                      <td>{money(line.unitCost)}</td>
                      <td>{money(line.ordered * line.unitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cart-totals">
              <div className="total-row"><span>{t('Order total')}</span><b>{money(purchase.total)}</b></div>
              <div className="total-row"><span>{t('Paid')}</span><b>{money(purchase.paid)}</b></div>
              <div className="total-row grand"><span>{t('Balance')}</span><span>{money(purchase.balance)}</span></div>
            </div>
            {purchase.receipts.length > 0 && (
              <>
                <h3 className="dash-gap">{t('Deliveries')}</h3>
                {purchase.receipts.map((receipt) => <div className="list-row" key={receipt.grnNo}><span><b>{receipt.grnNo}</b>{receipt.note && <><br /><span className="muted small-note">{receipt.note}</span></>}</span><span className="muted small-note">{receipt.by} · {dateTime(receipt.receivedAt)}</span></div>)}
              </>
            )}
            {purchase.payments.length > 0 && (
              <>
                <h3 className="dash-gap">{t('Payments')}</h3>
                {purchase.payments.map((payment) => <div className="list-row" key={payment.paymentNo}><span><b>{payment.paymentNo}</b> · {t(payment.method)}{payment.reference && ` · ${payment.reference}`}</span><span><b>{money(payment.amount)}</b><br /><span className="muted small-note">{dateTime(payment.createdAt)}</span></span></div>)}
              </>
            )}
          </div>
          <div className="modal-actions-row bill-actions">
            {canManage && cancellable && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => act('cancel', t('Purchase order cancelled.'))}>{t('Cancel order')}</button>}
            {purchase.status !== 'Draft' && <button type="button" className="btn btn-outline" onClick={() => setMode('bill')}>🧾 {t('Bill')}</button>}
            {canPay && payable && <button type="button" className="btn btn-outline" onClick={() => setMode('pay')}>{t('Pay')}</button>}
            {canManage && purchase.status === 'Draft' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('send', t('Purchase order sent.'))}>{t('Send')}</button>}
            {canManage && open && <button type="button" className="btn btn-primary" onClick={() => setMode('receive')}>{t('Receive')}</button>}
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('Close')}</button>
          </div>
        </>
      )}
      {printArea}
    </Modal>
  );
}
