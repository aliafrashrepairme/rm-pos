import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { createDuplicateFilter, createScannerBuffer } from '../../app/barcode.js';
import { beep } from '../../app/beep.js';
import { decodePhoto, prepareScanner } from '../barcode/cameraScan.js';
import { money, quantity } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import CameraModal from './CameraModal.jsx';
import { useCart } from './CartContext.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import SaleCompleteModal from './SaleCompleteModal.jsx';
import { bestOffer, cartTotals, couponProblem, pointsFor, roundUpTo } from './totals.js';

const PAY_ICONS = { Cash: '💵', Card: '💳', 'Bank transfer': '🏦', Credit: '📒' };

function toLine(product) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    unit: product.unit,
    price: product.price,
    taxRate: product.taxRate,
    stock: product.stock,
    imageUrl: product.imageUrl,
    qty: 1
  };
}

function ProductTile({ product, onAdd }) {
  const { t } = useI18n();
  const out = product.stock <= 0;
  const low = product.stock <= product.minStock;
  return (
    <button type="button" className="product-tile" disabled={out} onClick={() => onAdd(product)}>
      <div className="product-art">
        {product.imageUrl ? <img className="pimg lg" src={product.imageUrl} alt="" /> : <span aria-hidden="true">▨</span>}
      </div>
      <strong>{product.name}</strong>
      <small>{t(product.unit)}</small>
      <div className="tile-bottom">
        <span className="price">{money(product.price)}</span>
        <span className={`stock ${out ? 'out' : low ? 'low' : ''}`}>
          {out ? t('Out of stock') : low ? t('Low stock') : `${quantity(product.stock)} ${t('in stock')}`}
        </span>
      </div>
    </button>
  );
}

export default function PosPage({ user, onNavigate }) {
  const { t } = useI18n();
  const toast = useToast();
  const cart = useCart();
  const { lines, setLines, customer, setCustomer, couponCode, setCouponCode } = cart;
  const canScan = can(user, 'barcode.scan');
  const [options, setOptions] = useState(null);
  const [typed, setTyped] = useState('');
  const search = useDebounced(typed);
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [method, setMethod] = useState('Cash');
  const [noShift, setNoShift] = useState(false);
  useEffect(() => {
    api('/api/shifts/options').then(({ current }) => setNoShift(!current)).catch(() => {});
  }, []);
  const [cashGiven, setCashGiven] = useState('');
  const [reference, setReference] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [customerTyped, setCustomerTyped] = useState('');
  // A payment problem (such as the credit limit) belongs to the method it was found with.
  useEffect(() => { setError(''); }, [method]);
  // Loads the camera decoder in the background, so Camera scan reads from its first frame.
  useEffect(() => { prepareScanner(); }, []);
  const [completed, setCompleted] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const pendingRequest = useRef(null);
  const searchBox = useRef(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  useEffect(() => {
    api('/api/pos/options').then(setOptions).catch((failure) => setError(failure.message));
  }, []);
  useEffect(() => { setPage(1); }, [search, categoryId]);

  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set('q', search);
  if (categoryId) params.set('categoryId', categoryId);
  const { data, error: listError, reload } = useListRequest(`/api/pos/catalog?${params}`);

  // Regular-customer discount: the server says whether this customer has enough recent purchases.
  // Until it answers (undefined), the sale waits, so the till never shows a different total from the bill.
  const [regular, setRegular] = useState(null);
  useEffect(() => {
    if (!customer?.id) {
      setRegular(null);
      return undefined;
    }
    let current = true;
    setRegular(undefined);
    api(`/api/pos/customers/${customer.id}/regular`)
      .then((answer) => { if (current) setRegular(answer.qualifies ? { rate: answer.rate } : null); })
      .catch(() => { if (current) setRegular(null); });
    return () => { current = false; };
  }, [customer?.id]);
  const coupon = options?.coupons.find((item) => item.code === couponCode);
  const offer = bestOffer(customer, coupon, regular);
  const totals = useMemo(() => cartTotals(lines, offer.rate), [lines, offer.rate]);
  const payment = options?.paymentMethods.find((item) => item.code === method);
  const isCash = payment?.isCash ?? method === 'Cash';
  useEffect(() => {
    if (options && !payment && options.paymentMethods[0]) setMethod(options.paymentMethods[0].code);
  }, [options, payment]);
  const given = cashGiven === '' ? null : Number(cashGiven);

  // Loyalty points: 1 point = LKR 1, never more than the profit on this cart (the database works out that limit).
  const [pointsInput, setPointsInput] = useState('');
  const [pointsCap, setPointsCap] = useState(null);
  const canUsePoints = Boolean(customer && customer.loyaltyPoints > 0 && lines.length > 0);
  useEffect(() => {
    if (!canUsePoints) {
      setPointsCap(null);
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      api('/api/pos/points-cap', { method: 'POST', body: JSON.stringify({ items: lines.map((line) => ({ productId: line.id, qty: line.qty })), discountRate: offer.rate }) })
        .then(({ cap }) => { if (current) setPointsCap(cap); })
        .catch(() => { if (current) setPointsCap(0); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [canUsePoints, lines, offer.rate]);
  const maxPoints = canUsePoints && pointsCap !== null ? Math.max(Math.min(pointsCap, customer.loyaltyPoints, Math.floor(totals.total)), 0) : 0;
  const redeem = Math.min(Math.max(Math.floor(Number(pointsInput) || 0), 0), maxPoints);
  const due = Math.round((totals.total - redeem) * 100) / 100;
  const isCredit = method === 'Credit';
  const decimalUnits = options?.decimalUnits ?? [];

  // Any change to the bill makes it a new checkout, with its own request ID.
  useEffect(() => { pendingRequest.current = null; }, [lines, customer, couponCode, method, cashGiven, reference, pointsInput]);

  // Returns whether the product went onto the bill.
  const addProduct = useCallback((product) => {
    if (product.stock <= 0) {
      toast(`${product.name}: ${t('Out of stock')}`);
      return false;
    }
    const inCart = linesRef.current.find((line) => line.id === product.id);
    if (inCart && inCart.qty + 1 > product.stock) {
      toast(`${product.name}: ${t('Only')} ${quantity(product.stock)} ${t('in stock')}`);
      return false;
    }
    setLines((current) => {
      const existing = current.find((line) => line.id === product.id);
      if (!existing) return [...current, toLine(product)];
      // Two quick scans can both pass the check above, so this limit is the one that counts.
      if (existing.qty + 1 > product.stock) return current;
      return current.map((line) => (line.id === product.id ? { ...line, qty: line.qty + 1, stock: product.stock, price: product.price } : line));
    });
    return true;
  }, [setLines, t, toast]);

  const addByCode = useCallback(async (code) => {
    try {
      const { product } = await api(`/api/barcode/lookup?code=${encodeURIComponent(code)}`);
      if (!product.active) {
        toast(`${product.name}: ${t('This product is not for sale.')}`);
        return;
      }
      const added = addProduct({
        id: product.id,
        name: product.name,
        sku: product.sku,
        unit: product.unitCode,
        price: product.sellingPrice,
        taxRate: product.taxRate,
        stock: product.stock,
        imageUrl: product.imageUrl
      });
      // A beep and a message, so the cashier knows the scan worked without looking at the bill.
      if (added) {
        beep();
        toast(`✓ ${product.name} · ${money(product.sellingPrice)}`);
      }
    } catch (failure) {
      toast(failure.code === 'UNKNOWN_BARCODE'
        ? `${code}: ${t('This product is not in the product list. Ask a manager to add it.')}`
        : t(failure.message));
    }
  }, [addProduct, t, toast]);

  async function scanPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const code = await decodePhoto(file);
    if (code) await addByCode(code);
    else toast(t('No barcode found in that photo.'));
  }

  // USB and Bluetooth scanners work anywhere on this screen.
  const feedScanner = useMemo(() => createScannerBuffer(), []);
  const isNewScan = useMemo(() => createDuplicateFilter({ windowMs: 250 }), []);
  useEffect(() => {
    if (!canScan) return undefined;
    const onKey = (event) => {
      if (event.target.matches?.('input, textarea, select')) return;
      const code = feedScanner(event.key);
      if (code) {
        event.preventDefault();
        if (isNewScan(code)) addByCode(code);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [addByCode, canScan, feedScanner, isNewScan]);

  async function submitSearch(event) {
    event.preventDefault();
    const code = typed.trim();
    if (!code) return;
    // Only trust a single search result if it is for this exact text. A fast scanner presses Enter
    // before the search catches up, and the list on screen may still be from an earlier search.
    const exactMatch = search === code && data?.products.length === 1 ? data.products[0] : null;
    if (canScan && /^[0-9A-Za-z._/-]+$/.test(code) && !exactMatch) {
      await addByCode(code);
    } else if (exactMatch && addProduct(exactMatch)) {
      beep();
    }
    setTyped('');
    searchBox.current?.focus();
  }

  function changeQty(line, value) {
    const whole = !decimalUnits.includes(line.unit);
    let qty = Number(value);
    if (!Number.isFinite(qty)) return;
    qty = whole ? Math.trunc(qty) : Math.round(qty * 1000) / 1000;
    if (qty <= 0) {
      setLines((current) => current.filter((item) => item.id !== line.id));
      return;
    }
    if (qty > line.stock) {
      toast(`${line.name}: ${t('Only')} ${quantity(line.stock)} ${t('in stock')}`);
      qty = line.stock;
    }
    setLines((current) => current.map((item) => (item.id === line.id ? { ...item, qty } : item)));
  }

  function applyCoupon(code) {
    const value = code.trim().toUpperCase();
    const found = options?.coupons.find((item) => item.code === value);
    const problem = couponProblem(found, customer);
    if (problem) {
      toast(t(problem));
      return;
    }
    setCouponCode(value);
    setCouponInput('');
  }

  function chooseCustomer(next, { isNew } = {}) {
    setCustomer(next);
    setPointsInput('');
    setCouponCode('');
    // Any first-time buyer gets the first-purchase coupon, whether they were added here or on Customers.
    if (isNew || next?.purchaseCount === 0) {
      const welcome = options?.coupons.find((item) => item.firstPurchaseOnly);
      if (welcome) setCouponCode(welcome.code);
    }
  }

  function clearBill() {
    cart.clear();
    setCashGiven('');
    setPointsInput('');
    setReference('');
    setError('');
    pendingRequest.current = null;
  }

  async function refreshPrices() {
    if (!lines.length) return;
    const ids = lines.map((line) => line.id).join(',');
    const { products } = await api(`/api/pos/catalog?pageSize=60&ids=${ids}`);
    setLines((current) => current.flatMap((line) => {
      const fresh = products.find((product) => product.id === line.id);
      if (!fresh || fresh.stock <= 0) return [];
      return [{ ...line, price: fresh.price, taxRate: fresh.taxRate, stock: fresh.stock, qty: Math.min(line.qty, fresh.stock) }];
    }));
  }

  async function completeSale() {
    setError('');
    if (!lines.length) {
      setError('The bill is empty. Add a product first.');
      return;
    }
    if (!customer && customerTyped.trim()) {
      setError(`"${customerTyped.trim()}" ${t('is typed but not chosen. Click the customer in the list, or clear the box to sell to a walk-in customer.')}`);
      return;
    }
    if (isCash && due > 0 && (given === null || given < due)) {
      setError(given === null ? 'Enter the cash received.' : 'Cash received is less than the total.');
      return;
    }
    if (isCredit && due > 0) {
      if (!customer) {
        setError('Choose the customer to sell on credit.');
        return;
      }
      if (due > customer.creditAvailable) {
        setError(`${t('This goes over the customer credit limit. Available credit:')} ${money(customer.creditAvailable)}`);
        return;
      }
    }
    if (payment?.requiresReference && due > 0 && !reference.trim()) {
      setError('Enter the payment reference.');
      return;
    }
    // The same ID on a retry means a lost reply can't charge the customer twice.
    pendingRequest.current ||= crypto.randomUUID();
    setBusy(true);
    try {
      const { sale } = await api('/api/pos/sales', {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: pendingRequest.current,
          items: lines.map((line) => ({ productId: line.id, qty: line.qty })),
          customerId: customer?.id ?? null,
          couponCode: couponCode || null,
          expectedTotal: totals.total,
          pointsToRedeem: redeem,
          payment: { method, amountTendered: isCash ? given : null, reference: reference.trim() }
        })
      });
      const fromQuote = cart.quotation;
      setCompleted(sale);
      clearBill();
      reload();
      if (fromQuote) {
        // The sale is already saved, so a failed link is reported but doesn't undo the bill.
        api(`/api/quotations/${fromQuote.id}/convert`, { method: 'POST', body: JSON.stringify({ saleId: sale.id }) })
          .then(() => toast(`${fromQuote.quoteNo} ${t('converted to')} ${sale.billNo}`))
          .catch((failure) => toast(`${fromQuote.quoteNo}: ${t(failure.message)}`));
      }
    } catch (failure) {
      setError(failure.message);
      if (failure.status === 409) {
        await refreshPrices().catch(() => {});
        reload();
      }
    } finally {
      setBusy(false);
    }
  }

  async function holdBill() {
    if (!lines.length) {
      toast(t('Add at least one product before holding.'));
      return;
    }
    setBusy(true);
    try {
      const { order } = await api('/api/pos/held', {
        method: 'POST',
        body: JSON.stringify({
          items: lines.map((line) => ({ productId: line.id, qty: line.qty })),
          customerId: customer?.id ?? null,
          couponCode: couponCode || null
        })
      });
      clearBill();
      toast(`${t('Order held successfully.')} ${order.holdNo}`);
      onNavigate('Held Orders');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const change = isCash && given !== null ? given - due : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('POS billing counter')}</h1>
        </div>
        <div className="toolbar head-actions">
          {canScan && <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowCamera(true)}>⌸ {t('Camera scan')}</button>}
          {canScan && <label className="btn btn-outline btn-sm">🖼 {t('Scan from photo')}<input type="file" accept="image/*" hidden onChange={scanPhoto} /></label>}
          <span className="badge">{user.name}</span>
        </div>
      </div>

      {cart.quotation && (
        <div className="light-note pos-shift-note quote-note">
          <span>📄 {t('Billing quotation')} <b>{cart.quotation.quoteNo}</b>. {t('It will be marked Converted when this sale is completed.')}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => cart.setQuotation(null)}>{t('Unlink')}</button>
        </div>
      )}
      {noShift && <div className="light-note pos-shift-note">{t('No shift is open, so cash from these sales will not be counted in a drawer. Open one in Shifts & Cash.')}</div>}
      <div className="pos-layout">
        <div>
          <div className="toolbar">
            <form className="search pos-search" onSubmit={submitSearch}>
              <span>⌕</span>
              <input
                ref={searchBox}
                name="posSearch"
                aria-label={t('Search product name or scan barcode…')}
                placeholder={t('Search product name or scan barcode…')}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </form>
            <select className="filters" aria-label={t('Category')} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{t('All')}</option>
              {options?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </div>
          {listError && <p className="form-error" role="alert">{t(listError)}</p>}
          <div className="product-grid">
            {!data && !listError && <div className="empty">{t('Loading…')}</div>}
            {data?.products.length === 0 && <div className="empty">{t('No matching products.')}</div>}
            {data?.products.map((product) => <ProductTile key={product.id} product={product} onAdd={addProduct} />)}
          </div>
          {data && data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </div>

        <div className="card cart">
          <div className="cart-head">
            <div>
              <h3>{t('Bill')}</h3>
              <div className="sub">{quantity(lines.reduce((sum, line) => sum + line.qty, 0))} {t('item(s)')}</div>
            </div>
            <button type="button" className="btn btn-outline btn-sm" onClick={clearBill}>{t('Clear')}</button>
          </div>

          <CustomerPicker customer={customer} canCreate={can(user, 'customers.manage')} onChoose={chooseCustomer} onTyped={setCustomerTyped} />

          {offer.regular && (
            <div className="offer loyal">
              <div><b>🔁 {t(offer.label)}</b><br /><span>{Math.round(offer.rate * 100)}% {t('off')}</span></div>
            </div>
          )}
          {coupon && !offer.regular && (
            <div className="offer first">
              <div><b>🎁 {coupon.code}</b><br /><span>{Math.round(coupon.rate * 100)}% {t('off')}</span></div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setCouponCode('')}>{t('Remove')}</button>
            </div>
          )}
          {!coupon && offer.tier && !offer.regular && (
            <div className="offer loyal">
              <div><b>⭐ {t(offer.label)} · {customer.loyaltyPoints} {t('points')}</b><br /><span>{Math.round(offer.rate * 100)}% {t('off')}</span></div>
            </div>
          )}
          {!coupon && !offer.tier && !offer.regular && (
            <form className="coupon-row" onSubmit={(event) => { event.preventDefault(); applyCoupon(couponInput); }}>
              <input name="coupon" className="inp" placeholder={t('Coupon code')} aria-label={t('Coupon code')} value={couponInput} onChange={(event) => setCouponInput(event.target.value)} autoComplete="off" />
              <button type="submit" className="btn btn-outline btn-sm">{t('Apply')}</button>
            </form>
          )}

          <div className="bill-head"><span>{t('Product')}</span><span>{t('Price (LKR)')}</span><span>{t('Qty')}</span><span>{t('Total (LKR)')}</span></div>
          <div className="bill-lines">
            {lines.length === 0 && <div className="empty"><span>🛒</span>{t('No items yet.')}<br />{t('Tap a product to add it to the bill.')}</div>}
            {lines.map((line) => (
              <div className="bill-line" key={line.id}>
                <div className="bl-prod"><b>{line.name}</b></div>
                <div className="bl-price">{money(line.price).replace('LKR ', '')}</div>
                <div className="qty">
                  <button type="button" aria-label={`${t('Decrease')} ${line.name}`} onClick={() => changeQty(line, line.qty - 1)}>−</button>
                  {decimalUnits.includes(line.unit)
                    ? <input className="qty-input" type="number" min="0" step="any" aria-label={`${t('Qty')} ${line.name}`} value={line.qty} onChange={(event) => changeQty(line, event.target.value)} />
                    : <span>{line.qty}</span>}
                  <button type="button" aria-label={`${t('Increase')} ${line.name}`} onClick={() => changeQty(line, line.qty + 1)}>+</button>
                </div>
                <div className="bl-total">{money(line.price * line.qty).replace('LKR ', '')}</div>
              </div>
            ))}
          </div>

          <div className="cart-totals">
            <div className="total-row"><span>{t('Subtotal')}</span><b>{money(totals.subtotal)}</b></div>
            {totals.discount > 0 && <div className="total-row disc"><span>{t(offer.label)}</span><b>− {money(totals.discount)}</b></div>}
            <div className="total-row"><span>{t('VAT')}</span><b>{money(totals.tax)}</b></div>
            <div className="total-row grand"><span>{t('Total to pay')}</span><span>{money(totals.total)}</span></div>
            {canUsePoints && (
              <div className="points-redeem">
                <label htmlFor="pointsIn">⭐ {t('Use loyalty points')} <span className="muted small-note">({customer.loyaltyPoints} {t('available')} · {t('max')} {pointsCap === null ? '…' : maxPoints})</span></label>
                <div className="points-redeem-row">
                  <input id="pointsIn" type="number" min="0" step="1" max={maxPoints} inputMode="numeric" placeholder="0" value={pointsInput} onChange={(event) => setPointsInput(event.target.value)} />
                  <button type="button" className="btn btn-outline btn-sm" disabled={!maxPoints} onClick={() => setPointsInput(String(maxPoints))}>{t('Use max')}</button>
                </div>
                {pointsCap !== null && maxPoints < customer.loyaltyPoints && <span className="muted small-note">{t('Points can only cover the profit on this bill, so it is never sold below cost.')}</span>}
              </div>
            )}
            {redeem > 0 && <div className="total-row disc"><span>⭐ {t('Paid with points')} ({redeem})</span><b>− {money(redeem)}</b></div>}
            {redeem > 0 && <div className="total-row grand"><span>{t('Balance to pay')}</span><span>{money(due)}</span></div>}
            {customer && <div className="total-row points-row"><span>⭐ {t('Loyalty points to earn')}</span><b>+{pointsFor(customer, offer, due)}</b></div>}
          </div>

          <div className="pay-seg">
            {options?.paymentMethods.map((item) => (
              <button type="button" key={item.code} className={method === item.code ? 'active' : ''} onClick={() => setMethod(item.code)}>{PAY_ICONS[item.code] || '💠'} {t(item.code)}</button>
            ))}
          </div>

          {isCash && (
            <>
              <label className="cash-label" htmlFor="cashIn">{t('Cash received from customer (LKR)')}</label>
              <input id="cashIn" className="cash-input" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={cashGiven} onChange={(event) => setCashGiven(event.target.value)} />
              <div className="cash-row">
                <button type="button" onClick={() => setCashGiven(due.toFixed(2))}>{t('Exact')}</button>
                {[500, 1000, 5000].map((note) => <button type="button" key={note} onClick={() => setCashGiven(String(roundUpTo(due, note)))}>{note.toLocaleString('en-LK')}s</button>)}
              </div>
            </>
          )}
          {isCredit && (
            customer
              ? <div className={`light-note credit-note ${due > customer.creditAvailable ? 'over' : ''}`}>📒 {t('Credit available')}: <b>{money(customer.creditAvailable)}</b> · {t('Owes')} {money(customer.creditBalance)} / {t('limit')} {money(customer.creditLimit)}</div>
              : <div className="light-note credit-note over">{t('Choose the customer to sell on credit.')}</div>
          )}
          {payment?.requiresReference && (
            <label className="field pay-reference">{t('Reference')}
              <input name="reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} placeholder={t('Cheque no. / transfer ref')} />
            </label>
          )}

          {!lines.length || (isCash && due > 0 && change === null)
            ? <div className="balance"><span>{t(lines.length ? 'Enter cash received' : 'Balance')}</span><b>{money(0)}</b></div>
            : !isCash
              ? <div className="balance ok"><span>{t(isCredit ? 'On credit' : 'Paid by')} {!isCredit && t(method)}</span><b>{money(due)}</b></div>
              : change >= 0
                ? <div className="balance ok"><span>{t('Balance to give customer')}</span><b>{money(change)}</b></div>
                : <div className="balance due"><span>{t('Amount still due')}</span><b>{money(-change)}</b></div>}

          {error && <p className="form-error pos-error" role="alert">{t(error)}</p>}

          <div className="cart-actions">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={holdBill}>{t('Hold')}</button>
            <button type="button" className="btn btn-primary wide" disabled={busy || !options || regular === undefined} onClick={completeSale}>✓ {t('Complete sale')} · {money(due)}</button>
          </div>
        </div>
      </div>

      {showCamera && <CameraModal onCode={addByCode} onClose={() => setShowCamera(false)} />}
      {completed && <SaleCompleteModal sale={completed} onClose={() => { setCompleted(null); searchBox.current?.focus(); }} />}
    </>
  );
}
