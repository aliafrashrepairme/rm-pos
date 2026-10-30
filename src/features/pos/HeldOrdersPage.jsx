import { useState } from 'react';
import { api } from '../../api.js';
import { dateTime, money, quantity } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import { useCart } from './CartContext.jsx';
import { cartTotals } from './totals.js';

export default function HeldOrdersPage({ onNavigate }) {
  const { t } = useI18n();
  const toast = useToast();
  const cart = useCart();
  const { data, error, reload } = useListRequest('/api/pos/held');
  const [busy, setBusy] = useState(false);

  async function resume(order) {
    if (cart.lines.length) {
      toast(t('Finish or clear the current bill first.'));
      return;
    }
    setBusy(true);
    try {
      const held = await api(`/api/pos/held/${order.id}/resume`, { method: 'POST' });
      const ids = held.items.map((item) => item.productId).join(',');
      const { products } = await api(`/api/pos/catalog?pageSize=60&ids=${ids}`);
      let dropped = 0;
      const lines = held.items.flatMap((item) => {
        const product = products.find((row) => row.id === item.productId);
        if (!product || product.stock <= 0) {
          dropped += 1;
          return [];
        }
        if (item.qty > product.stock) dropped += 1;
        return [{
          id: product.id,
          name: product.name,
          sku: product.sku,
          unit: product.unit,
          price: product.price,
          taxRate: product.taxRate,
          stock: product.stock,
          imageUrl: product.imageUrl,
          qty: Math.min(item.qty, product.stock)
        }];
      });
      cart.setLines(lines);
      cart.setCustomer(held.customer);
      cart.setCouponCode(held.couponCode ?? '');
      toast(dropped ? t('Resumed. Some items changed because stock has moved.') : `${t('Held order resumed.')} ${held.holdNo}`);
      onNavigate('POS Billing');
    } catch (failure) {
      toast(t(failure.message));
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function cancel(order) {
    setBusy(true);
    try {
      await api(`/api/pos/held/${order.id}/cancel`, { method: 'POST' });
      toast(t('Held order cancelled.'));
    } catch (failure) {
      toast(t(failure.message));
    } finally {
      setBusy(false);
      reload();
    }
  }

  const orders = data?.orders ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Held orders')}</h1>
          <p>{t('Resume or cancel orders paused at the billing counter.')}</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="card">
        <div className="section-row">
          <div>
            <h3>{t('Open / held orders')}</h3>
            <div className="sub">{t('Orders waiting to be resumed')}</div>
          </div>
          <span className="badge">{orders.length} {t('waiting')}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>{['Order ID', 'Customer', 'Items', 'Held at', 'Before offers', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr>
            </thead>
            <tbody>
              {!data && !error && <tr><td colSpan="6"><div className="empty">{t('Loading…')}</div></td></tr>}
              {data && orders.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No records found.')}</div></td></tr>}
              {orders.map((order) => (
                <tr key={order.id}>
                  <td><b>{order.holdNo}</b></td>
                  <td>{order.customer}</td>
                  <td>{order.lines.map((line) => <div key={line.name}>{line.name} × {quantity(line.qty)}</div>)}</td>
                  <td>{dateTime(order.createdAt)}</td>
                  <td>{money(cartTotals(order.lines).total)}</td>
                  <td>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => resume(order)}>{t('Resume')}</button>{' '}
                    <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => cancel(order)}>{t('Cancel')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
