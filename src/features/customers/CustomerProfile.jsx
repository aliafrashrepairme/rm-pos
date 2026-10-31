import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { dateTime, money } from '../../app/format.js';
import Modal from '../../components/Modal.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import BillModal from '../transactions/BillModal.jsx';
import { memberLabel } from './member.js';

export default function CustomerProfile({ customerId, user, onClose, onEdit, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [customer, setCustomer] = useState(null);
  const [error, setError] = useState('');
  const [openBill, setOpenBill] = useState(null);
  const [busy, setBusy] = useState(false);
  const canManage = can(user, 'customers.manage');
  const canViewBills = can(user, 'bills.view') || can(user, 'transactions.view');

  const load = useCallback(async () => {
    try {
      setCustomer((await api(`/api/customers/${customerId}`)).customer);
    } catch (failure) {
      setError(failure.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  async function setActive(active) {
    setBusy(true);
    try {
      await api(`/api/customers/${customerId}`, { method: 'PATCH', body: JSON.stringify({ active }) });
      toast(`${customer.name}: ${t(active ? 'Active' : 'Inactive')}`);
      await load();
      onChanged();
    } catch (failure) {
      toast(t(failure.message));
    } finally {
      setBusy(false);
    }
  }

  const stats = customer?.stats;

  return (
    <>
      <Modal wide title={customer?.name ?? t('Customers')} description={customer ? [customer.code, customer.phone, customer.email].filter(Boolean).join(' · ') : ''} onClose={onClose}>
        {error && <p className="form-error" role="alert">{t(error)}</p>}
        {!customer && !error && <div className="empty">{t('Loading…')}</div>}
        {customer && (
          <>
            <div className="modal-scroll">
              {customer.address && <p className="sub">{customer.address}</p>}
              <div className="sum-strip">
                <div><span className="sl">{t('Loyalty points')}</span><b>{customer.loyaltyPoints}</b><small>{t(memberLabel(customer))}</small></div>
                <div><span className="sl">{t('Bills')}</span><b>{stats.bills}</b><small>{stats.lastPurchaseAt ? dateTime(stats.lastPurchaseAt) : '—'}</small></div>
                <div><span className="sl">{t('Total spent')}</span><b>{money(stats.spent)}</b><small>{t('After refunds')}</small></div>
                <div><span className="sl">{t('Refunded')}</span><b>{money(stats.refunded)}</b></div>
              </div>

              <h3 className="dash-gap">{t('Purchase history')}</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr>{['Bill no.', 'Date', 'Total', 'Points', 'Status', ''].map((heading) => <th key={heading || 'open'}>{heading && t(heading)}</th>)}</tr></thead>
                  <tbody>
                    {customer.bills.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No records found.')}</div></td></tr>}
                    {customer.bills.map((bill) => (
                      <tr key={bill.id}>
                        <td><b>{bill.billNo}</b></td>
                        <td>{dateTime(bill.createdAt)}</td>
                        <td>{money(bill.total)}</td>
                        <td>{bill.points}</td>
                        <td><Status value={bill.status} label={t(bill.status)} /></td>
                        <td>{canViewBills && <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpenBill(bill.id)}>{t('View')}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {customer.billCount > customer.bills.length && <p className="sub">{t('Showing the latest')} {customer.bills.length} / {customer.billCount}</p>}

              <h3 className="dash-gap">{t('Refunds')}</h3>
              {customer.refunds.length === 0 && <div className="empty">{t('No records found.')}</div>}
              {customer.refunds.map((refund) => (
                <div className="list-row" key={refund.refundNo}>
                  <span><b>{refund.refundNo}</b> · {refund.billNo} · {refund.reason}</span>
                  <span className="row-end"><b>{money(refund.total)}</b><br /><span className="muted small-note">{dateTime(refund.createdAt)}</span></span>
                </div>
              ))}
            </div>
            <div className="modal-actions-row bill-actions">
              {canManage && (
                <>
                  <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setActive(!customer.active)}>{t(customer.active ? 'Deactivate' : 'Reactivate')}</button>
                  <button type="button" className="btn btn-outline" onClick={() => onEdit(customer)}>{t('Edit')}</button>
                </>
              )}
              <button type="button" className="btn btn-primary" onClick={onClose}>{t('Close')}</button>
            </div>
          </>
        )}
      </Modal>
      {openBill && <BillModal billId={openBill} user={user} onClose={() => setOpenBill(null)} onChanged={() => { load(); onChanged(); }} />}
    </>
  );
}
