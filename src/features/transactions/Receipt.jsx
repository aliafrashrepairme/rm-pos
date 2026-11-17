import { dateTime, money, quantity } from '../../app/format.js';
import BarcodeImage from '../../components/BarcodeImage.jsx';

const number = (value) => money(value).replace('LKR ', '');

// Always in English, like the prototype: it is a business record the customer keeps.
export default function Receipt({ bill }) {
  const { store, payment } = bill;
  const options = store.receipt ?? {};
  const sizeClass = options.size === 'A4' ? 'receipt-a4' : options.size === '100mm' ? 'receipt-100' : '';
  return (
    <div className={`receipt ${sizeClass}`}>
      <div className="c">
        <div className="big">{store.name}</div>
        {store.address}<br />
        {store.phone && <>Tel: {store.phone}</>}{store.vatRegistration && <> · VAT Reg {store.vatRegistration}</>}
      </div>
      <div className="bill-band dist">DISTRIBUTION BILL{bill.status !== 'Paid' ? ` — ${bill.status.toUpperCase()}` : ''}</div>
      <div className="r"><span>Bill</span><b>{bill.billNo}</b></div>
      <div className="r"><span>Date</span><span>{dateTime(bill.createdAt, store.timeZone)}</span></div>
      <div className="r"><span>Cashier</span><span>{bill.cashier}</span></div>
      <div className="r"><span>Customer</span><span>{bill.customer}</span></div>
      <hr />
      {bill.lines.map((line) => (
        <div className="it" key={line.id}>
          <div>{line.name}</div>
          <div className="r muted"><span>{quantity(line.qty)} × {number(line.price)}</span><span>{number(line.qty * line.price)}</span></div>
        </div>
      ))}
      <hr />
      <div className="r"><span>Subtotal</span><span>{money(bill.subtotal)}</span></div>
      {bill.discount > 0 && <div className="r"><span>{bill.discountLabel || 'Discount'}</span><span>− {money(bill.discount)}</span></div>}
      {options.showTax !== false && <div className="r"><span>VAT</span><span>{money(bill.tax)}</span></div>}
      <div className="r big"><span>TOTAL</span><span>{money(bill.total)}</span></div>
      {payment && (
        <>
          <div className="r"><span>Paid by</span><span>{payment.method}</span></div>
          {payment.reference && <div className="r"><span>Reference</span><span>{payment.reference}</span></div>}
          {payment.tendered !== null && (
            <>
              <div className="r"><span>Cash received</span><span>{money(payment.tendered)}</span></div>
              {options.showBalance !== false && <div className="r big"><span>BALANCE</span><span>{money(payment.change)}</span></div>}
            </>
          )}
        </>
      )}
      {bill.pointsEarned > 0 && <div className="r"><span>Loyalty points earned</span><span>+{bill.pointsEarned}</span></div>}
      {bill.refunds.map((refund) => (
        <div className="r" key={refund.refundNo}><span>Refund {refund.refundNo}</span><span>− {money(refund.total)}</span></div>
      ))}
      {bill.voidReason && <div className="c"><b>VOID:</b> {bill.voidReason}</div>}
      <hr />
      {options.footer ? <div className="c">{options.footer}</div> : <div className="c">Thank you for shopping with us!<br /><span className="muted">Goods once sold can be exchanged within 7 days with this bill.</span></div>}
      <div className="receipt-code"><BarcodeImage code={bill.billNo} height={40} /></div>
    </div>
  );
}
