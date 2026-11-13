import { dateTime, money, quantity } from '../../app/format.js';

const number = (value) => money(value).replace('LKR ', '');

export default function PurchaseBill({ purchase }) {
  const { store, supplier } = purchase;
  return (
    <div className="pbill">
      <div className="pb-band">
        <div><b>{store.name}</b><br /><span>{[store.address, store.phone].filter(Boolean).join(' · ')}</span></div>
        <div className="pb-title"><b>PURCHASE BILL</b><br /><span>{purchase.poNo}</span></div>
      </div>
      <div className="pb-meta">
        <div><span>Supplier</span><b>{supplier.name}</b><small>{[supplier.contact, supplier.phone].filter(Boolean).join(' · ')}</small></div>
        <div><span>Order</span><b>{purchase.poNo}</b><small>{purchase.orderedAt ? `Ordered ${dateTime(purchase.orderedAt)}` : 'Not sent'}{purchase.expectedAt ? ` · Expected ${purchase.expectedAt}` : ''}</small></div>
        <div><span>Status</span><b>{purchase.status}</b><small>{purchase.paymentStatus}{supplier.terms ? ` · ${supplier.terms}` : ''}</small></div>
      </div>
      {purchase.invoiceNo && <div className="pb-invoice">Supplier invoice: <b>{purchase.invoiceNo}</b></div>}
      <table className="pb-table">
        <thead><tr><th>Product</th><th>Ordered</th><th>Received</th><th>Unit cost</th><th>Amount</th></tr></thead>
        <tbody>
          {purchase.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.name}</td>
              <td>{quantity(line.ordered)}</td>
              <td>{quantity(line.received)}</td>
              <td>{number(line.unitCost)}</td>
              <td>{number(line.ordered * line.unitCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pb-tot">
        <div><span>Total</span><b>{money(purchase.total)}</b></div>
        <div><span>Paid</span><b>{money(purchase.paid)}</b></div>
        <div className="big"><span>Balance due</span><b>{money(purchase.balance)}</b></div>
      </div>
      <div className="pb-foot">Prepared by {purchase.createdBy} · {purchase.source === 'AI Scan' ? 'Captured by AI invoice scan' : `${purchase.source} purchase order`}</div>
    </div>
  );
}
