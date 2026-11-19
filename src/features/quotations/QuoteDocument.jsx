import { dateTime, money, quantity } from '../../app/format.js';
import { useStoreLogo } from '../../app/storeLogo.js';

const number = (value) => money(value).replace('LKR ', '');

// The printable quotation handed to the customer. Uses the purchase bill's layout styles.
export default function QuoteDocument({ quote }) {
  const { store } = quote;
  const logo = useStoreLogo();
  return (
    <div className="pbill">
      <div className="pb-band">
        <div>{logo && <img className="pb-logo" src={logo} alt="" />}<b>{store.name}</b><br /><span>{[store.address, store.phone].filter(Boolean).join(' · ')}</span></div>
        <div className="pb-title"><b>QUOTATION</b><br /><span>{quote.quoteNo}</span></div>
      </div>
      <div className="pb-meta">
        <div><span>Customer</span><b>{quote.customerName}</b><small>{quote.customerPhone}</small></div>
        <div><span>Date</span><b>{dateTime(quote.createdAt)}</b><small>Valid until {quote.validUntil}</small></div>
        <div><span>Status</span><b>{quote.status}</b><small>{quote.billNo ? `Bill ${quote.billNo}` : ''}</small></div>
      </div>
      <table className="pb-table">
        <thead><tr><th>Product</th><th>Qty</th><th>Unit price</th><th>VAT</th><th>Amount</th></tr></thead>
        <tbody>
          {quote.lines.map((line) => (
            <tr key={line.productId}>
              <td>{line.name}<br /><small>{line.sku}</small></td>
              <td>{quantity(line.qty)} {line.unit}</td>
              <td>{number(line.unitPrice)}</td>
              <td>{line.taxRate}%</td>
              <td>{number(line.qty * line.unitPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pb-tot">
        <div><span>Subtotal</span><b>{money(quote.subtotal)}</b></div>
        <div><span>VAT</span><b>{money(quote.tax)}</b></div>
        <div className="big"><span>Total</span><b>{money(quote.total)}</b></div>
      </div>
      {quote.note && <div className="pb-invoice">{quote.note}</div>}
      <div className="pb-foot">Prepared by {quote.createdBy} · Prices are valid until {quote.validUntil} and subject to stock availability.</div>
    </div>
  );
}
