import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { dateTime, money, quantity } from '../../app/format.js';
import Modal from '../../components/Modal.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import OrderModal from '../purchases/OrderModal.jsx';

export default function SupplierProfile({ supplierId, user, onClose, onEdit, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const [supplier, setSupplier] = useState(null);
  const [error, setError] = useState('');
  const [openOrder, setOpenOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const canManage = can(user, 'suppliers.manage');

  const load = useCallback(async () => {
    try {
      setSupplier((await api(`/api/suppliers/${supplierId}`)).supplier);
    } catch (failure) {
      setError(failure.message);
    }
  }, [supplierId]);

  useEffect(() => { load(); }, [load]);

  async function setActive(active) {
    setBusy(true);
    try {
      await api(`/api/suppliers/${supplierId}`, { method: 'PATCH', body: JSON.stringify({ active }) });
      toast(`${supplier.name}: ${t(active ? 'Active' : 'Inactive')}`);
      await load();
      onChanged();
    } catch (failure) {
      toast(t(failure.message));
    } finally {
      setBusy(false);
    }
  }

  const stats = supplier?.stats;

  return (
    <>
      <Modal wide title={supplier?.name ?? t('Suppliers')} description={supplier ? [supplier.code, supplier.contactPerson, supplier.phone, supplier.email, supplier.city].filter(Boolean).join(' · ') : ''} onClose={onClose}>
        {error && <p className="form-error" role="alert">{t(error)}</p>}
        {!supplier && !error && <div className="empty">{t('Loading…')}</div>}
        {supplier && (
          <>
            <div className="modal-scroll">
              {supplier.address && <p className="sub">{supplier.address}</p>}
              <div className="sum-strip">
                <div><span className="sl">{t('Purchases')}</span><b>{stats.orders}</b><small>{money(stats.purchased)}</small></div>
                <div><span className="sl">{t('Paid')}</span><b>{money(stats.paid)}</b></div>
                <div><span className="sl">{t('Balance payable')}</span><b className={stats.balance > 0 ? 'qty-down' : ''}>{money(stats.balance)}</b><small>{t(supplier.paymentTerms)}</small></div>
                <div><span className="sl">{t('On-time delivery')}</span><b>{stats.onTimePercent === null ? '—' : `${stats.onTimePercent}%`}</b><small>{stats.onTimePercent === null ? t('No deliveries to judge yet') : `${stats.judged} ${t('orders judged')}`}</small></div>
              </div>

              <h3 className="dash-gap">{t('Products supplied')}</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr>{['Product', 'Last cost', 'On hand', 'Status'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
                  <tbody>
                    {supplier.products.length === 0 && <tr><td colSpan="4"><div className="empty">{t('No records found.')}</div></td></tr>}
                    {supplier.products.map((product) => {
                      const state = product.stock <= 0 ? 'Out of Stock' : product.stock <= product.minStock ? 'Low Stock' : 'In Stock';
                      return (
                        <tr key={product.id}>
                          <td><b className="pname">{product.name}</b><br /><span className="muted small-note">{product.sku}</span></td>
                          <td>{money(product.costPrice)}</td>
                          <td>{quantity(product.stock)} {t(product.unit)}</td>
                          <td><Status value={state} label={t(state)} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <h3 className="dash-gap">{t('Purchase history')}</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr>{['PO no.', 'Expected', 'Total', 'Balance', 'Status', ''].map((heading) => <th key={heading || 'open'}>{heading && t(heading)}</th>)}</tr></thead>
                  <tbody>
                    {supplier.purchases.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No records found.')}</div></td></tr>}
                    {supplier.purchases.map((order) => (
                      <tr key={order.id}>
                        <td><b>{order.poNo}</b></td>
                        <td>{order.expectedAt ?? '—'}</td>
                        <td>{money(order.total)}</td>
                        <td>{money(order.balance)}</td>
                        <td><Status value={order.status} label={t(order.status)} /></td>
                        <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setOpenOrder(order.id)}>{t('View')}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="dash-gap">{t('Payment records')}</h3>
              {supplier.payments.length === 0 && <div className="empty">{t('No records found.')}</div>}
              {supplier.payments.map((payment) => (
                <div className="list-row" key={payment.paymentNo}>
                  <span><b>{payment.paymentNo}</b> · {payment.poNo} · {t(payment.method)}{payment.reference && ` · ${payment.reference}`}</span>
                  <span className="row-end"><b>{money(payment.amount)}</b><br /><span className="muted small-note">{dateTime(payment.createdAt)}</span></span>
                </div>
              ))}
            </div>
            <div className="modal-actions-row bill-actions">
              {canManage && (
                <>
                  <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setActive(!supplier.active)}>{t(supplier.active ? 'Deactivate' : 'Reactivate')}</button>
                  <button type="button" className="btn btn-outline" onClick={() => onEdit(supplier)}>{t('Edit')}</button>
                </>
              )}
              <button type="button" className="btn btn-primary" onClick={onClose}>{t('Close')}</button>
            </div>
          </>
        )}
      </Modal>
      {openOrder && (
        <OrderModal
          key={openOrder}
          purchaseId={openOrder}
          user={user}
          onClose={() => setOpenOrder(null)}
          onChanged={() => { load(); onChanged(); }}
        />
      )}
    </>
  );
}
