import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { money, quantity } from '../../app/format.js';
import Modal from '../../components/Modal.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import Receipt from './Receipt.jsx';
import { usePrintBill } from './usePrintBill.jsx';

function VoidForm({ bill, onDone, onCancel }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { bill: updated } = await api(`/api/transactions/bills/${bill.id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
      onDone(updated, `${bill.billNo} ${t('voided. All items are back in stock.')}`);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="notice">{t('This cancels the whole bill and returns all items to stock.')}</p>
      <label className="field">{t('Reason')}<input name="voidReason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} required autoFocus /></label>
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onCancel}>{t('Back')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{t('Void bill')}</button>
      </div>
    </form>
  );
}

function RefundForm({ bill, onDone, onCancel }) {
  const { t } = useI18n();
  const open = bill.lines.filter((line) => line.qty > line.refundedQty);
  const [quantities, setQuantities] = useState({});
  const [damaged, setDamaged] = useState({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState(bill.payment?.method ?? 'Cash');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(null);

  useEffect(() => { request.current = null; }, [quantities, damaged, reason, method]);

  const chosen = open.filter((line) => Number(quantities[line.id]) > 0);
  // The server decides the exact amount. This preview uses the same share of the line.
  const estimate = chosen.reduce((sum, line) => sum + (line.total * Number(quantities[line.id])) / line.qty, 0);

  async function submit(event) {
    event.preventDefault();
    setError('');
    request.current ||= crypto.randomUUID();
    setBusy(true);
    try {
      const result = await api(`/api/transactions/bills/${bill.id}/refund`, {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: request.current,
          reason,
          method,
          lines: chosen.map((line) => ({ saleItemId: line.id, qty: Number(quantities[line.id]), restock: !damaged[line.id] }))
        })
      });
      onDone(result.bill, `${result.refundNo} · ${t('Refund recorded.')}`);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="modal-scroll">
        {open.map((line) => {
          const left = line.qty - line.refundedQty;
          return (
            <div className="category-row" key={line.id}>
              <span className="grow"><b>{line.name}</b><br /><span className="muted small-note">{quantity(left)} {t('can be refunded')} · {money(line.total)}</span></span>
              <label className="refund-damaged"><input type="checkbox" aria-label={`${t('Damaged')} ${line.name}`} checked={Boolean(damaged[line.id])} onChange={(event) => setDamaged((current) => ({ ...current, [line.id]: event.target.checked }))} /> {t('Damaged')}</label>
              <input
                className="mini-input"
                type="number"
                min="0"
                max={left}
                step="any"
                aria-label={`${t('Qty')} ${line.name}`}
                value={quantities[line.id] ?? ''}
                placeholder="0"
                onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
              />
            </div>
          );
        })}
      </div>
      <div className="form-grid refund-fields">
        <label className="field">{t('Reason')}<input name="refundReason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} required /></label>
        <label className="field">{t('Refund method')}
          <select name="refundMethod" value={method} onChange={(event) => setMethod(event.target.value)}>
            {['Cash', 'Card', 'Bank transfer'].map((item) => <option key={item} value={item}>{t(item)}</option>)}
          </select>
        </label>
      </div>
      {chosen.length > 0 && <div className="total-row refund-total"><span>{t('Refund total')}</span><b>{money(estimate)}</b></div>}
      {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
      <div className="modal-actions-row">
        <button type="button" className="btn btn-outline" onClick={onCancel}>{t('Back')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !chosen.length}>{t('Refund')}</button>
      </div>
    </form>
  );
}

export default function BillModal({ billId, user, onClose, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [bill, setBill] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('view');
  const { printArea, printBill, saveBillPdf } = usePrintBill();

  const load = useCallback(async () => {
    try {
      setBill((await api(`/api/transactions/bills/${billId}`)).bill);
    } catch (failure) {
      setError(failure.message);
    }
  }, [billId]);

  useEffect(() => { load(); }, [load]);

  function done(updated, message) {
    setBill(updated);
    setMode('view');
    toast(message);
    onChanged?.();
  }

  const canRefund = can(user, 'refunds.process');
  const canPrint = can(user, 'bills.print');
  const refundable = bill && ['Paid', 'Partially Refunded'].includes(bill.status);

  return (
    <Modal title={bill ? `${t('Bill')} ${bill.billNo}` : t('Bill')} description={bill ? `${bill.customer} · ${money(bill.total)}` : ''} onClose={onClose}>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {!bill && !error && <div className="empty">{t('Loading…')}</div>}
      {bill && mode === 'view' && (
        <>
          <div className="bill-status"><Status value={bill.status} label={t(bill.status)} /></div>
          <div className="receipt-stage modal-scroll"><Receipt bill={bill} /></div>
          <div className="modal-actions-row bill-actions">
            {canRefund && bill.status === 'Paid' && <button type="button" className="btn btn-outline" onClick={() => setMode('void')}>{t('Void')}</button>}
            {canRefund && refundable && <button type="button" className="btn btn-outline" onClick={() => setMode('refund')}>{t('Refund')}</button>}
            {canPrint && <button type="button" className="btn btn-outline" onClick={() => saveBillPdf(bill)}>⇩ {t('Download PDF')}</button>}
            {canPrint && <button type="button" className="btn btn-primary" onClick={() => printBill(bill)}>⎙ {t('Print bill')}</button>}
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('Close')}</button>
          </div>
        </>
      )}
      {bill && mode === 'void' && <VoidForm bill={bill} onDone={done} onCancel={() => setMode('view')} />}
      {bill && mode === 'refund' && <RefundForm bill={bill} onDone={done} onCancel={() => setMode('view')} />}
      {printArea}
    </Modal>
  );
}
