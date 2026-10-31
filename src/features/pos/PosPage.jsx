import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { can } from '../../app/access.js';
import { createDuplicateFilter, createScannerBuffer } from '../../app/barcode.js';
import { money, quantity } from '../../app/format.js';
import { useDebounced, useListRequest } from '../../app/useListRequest.js';
import Pager from '../../components/Pager.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';
import CameraModal from './CameraModal.jsx';
import { useCart } from './CartContext.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import SaleCompleteModal from './SaleCompleteModal.jsx';
import { bestOffer, cartTotals, couponProblem, roundUpTo } from './totals.js';

const PAY_ICONS = { Cash: '💵', Card: '💳', 'Bank transfer': '🏦' };

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
  const [cashGiven, setCashGiven] = useState('');
  const [reference, setReference] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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

  const coupon = options?.coupons.find((item) => item.code === couponCode);
  const offer = bestOffer(customer, coupon);
  const totals = useMemo(() => cartTotals(lines, offer.rate), [lines, offer.rate]);
  const payment = options?.paymentMethods.find((item) => item.code === method);
  const isCash = payment?.isCash ?? method === 'Cash';
  useEffect(() => {
    if (options && !payment && options.paymentMethods[0]) setMethod(options.paymentMethods[0].code);
  }, [options, payment]);
  const given = cashGiven === '' ? null : Number(cashGiven);
  const decimalUnits = options?.decimalUnits ?? [];

  // Any change to the bill makes it a new checkout, with its own request ID.
  useEffect(() => { pendingRequest.current = null; }, [lines, customer, couponCode, method, cashGiven, reference]);

  const addProduct = useCallback((product) => {
    if (product.stock <= 0) {
      toast(`${product.name}: ${t('Out of stock')}`);
      return;
    }
    const inCart = linesRef.current.find((line) => line.id === product.id);
    if (inCart && inCart.qty + 1 > product.stock) {
      toast(`${product.name}: ${t('Only')} ${quantity(product.stock)} ${t('in stock')}`);
      return;
    }
    setLines((current) => {
      const existing = current.find((line) => line.id === product.id);
      if (!existing) return [...current, toLine(product)];
      // Two quick scans can both pass the check above, so this limit is the one that counts.
      if (existing.qty + 1 > product.stock) return current;
      return current.map((line) => (line.id === product.id ? { ...line, qty: line.qty + 1, stock: product.stock, price: product.price } : line));
    });
  }, [setLines, t, toast]);

  const addByCode = useCallback(async (code) => {
    try {
      const { product } = await api(`/api/barcode/lookup?code=${encodeURIComponent(code)}`);
      if (!product.active) {
        toast(`${product.name}: ${t('This product is not for sale.')}`);
        return;
      }
      addProduct({
        id: product.id,
        name: product.name,
        sku: product.sku,
        unit: product.unitCode,
        price: product.sellingPrice,
        taxRate: product.taxRate,
        stock: product.stock,
        imageUrl: product.imageUrl
      });
    } catch (failure) {
      toast(t(failure.message));
    }
  }, [addProduct, t, toast]);

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
    const exactMatch = data?.products.length === 1 ? data.products[0] : null;
    if (canScan && /^[0-9A-Za-z._/-]+$/.test(code) && !exactMatch) {
      await addByCode(code);
    } else if (exactMatch) {
      addProduct(exactMatch);
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
    setCouponCode('');
    if (isNew) {
      const welcome = options?.coupons.find((item) => item.firstPurchaseOnly);
      if (welcome) setCouponCode(welcome.code);
    }
  }

  function clearBill() {
    cart.clear();
    setCashGiven('');
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
    if (isCash && (given === null || given < totals.total)) {
      setError(given === null ? 'Enter the cash received.' : 'Cash received is less than the total.');
      return;
    }
    if (payment?.requiresReference && !reference.trim()) {
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
          payment: { method, amountTendered: isCash ? given : null, reference: reference.trim() }
        })
      });
      setCompleted(sale);
      clearBill();
      reload();
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

  const change = isCash && given !== null ? given - totals.total : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('POS billing counter')}</h1>
        </div>
        <div className="toolbar head-actions">
          {canScan && <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowCamera(true)}>⌸ {t('Camera scan')}</button>}
          <span className="badge">{user.name}</span>
        </div>
      </div>

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

          <CustomerPicker customer={customer} canCreate={can(user, 'customers.manage')} onChoose={chooseCustomer} />

          {coupon && (
            <div className="offer first">
              <div><b>🎁 {coupon.code}</b><br /><span>{Math.round(coupon.rate * 100)}% {t('off')}</span></div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setCouponCode('')}>{t('Remove')}</button>
            </div>
          )}
          {!coupon && offer.tier && (
            <div className="offer loyal">
              <div><b>⭐ {t(offer.label)} · {customer.loyaltyPoints} {t('points')}</b><br /><span>{Math.round(offer.rate * 100)}% {t('off')}</span></div>
            </div>
          )}
          {!coupon && !offer.tier && (
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
                <button type="button" onClick={() => setCashGiven(totals.total.toFixed(2))}>{t('Exact')}</button>
                {[500, 1000, 5000].map((note) => <button type="button" key={note} onClick={() => setCashGiven(String(roundUpTo(totals.total, note)))}>{note.toLocaleString('en-LK')}s</button>)}
              </div>
            </>
          )}
          {payment?.requiresReference && (
            <label className="field pay-reference">{t('Reference')}
              <input name="reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} placeholder={t('Cheque no. / transfer ref')} />
            </label>
          )}

          {!lines.length || (isCash && change === null)
            ? <div className="balance"><span>{t(lines.length ? 'Enter cash received' : 'Balance')}</span><b>{money(0)}</b></div>
            : !isCash
              ? <div className="balance ok"><span>{t('Paid by')} {t(method)}</span><b>{money(totals.total)}</b></div>
              : change >= 0
                ? <div className="balance ok"><span>{t('Balance to give customer')}</span><b>{money(change)}</b></div>
                : <div className="balance due"><span>{t('Amount still due')}</span><b>{money(-change)}</b></div>}

          {error && <p className="form-error pos-error" role="alert">{t(error)}</p>}

          <div className="cart-actions">
            <button type="button" className="btn btn-outline" disabled={busy} onClick={holdBill}>{t('Hold')}</button>
            <button type="button" className="btn btn-primary wide" disabled={busy || !options} onClick={completeSale}>✓ {t('Complete sale')} · {money(totals.total)}</button>
          </div>
        </div>
      </div>

      {showCamera && <CameraModal onCode={addByCode} onClose={() => setShowCamera(false)} />}
      {completed && <SaleCompleteModal sale={completed} onClose={() => { setCompleted(null); searchBox.current?.focus(); }} />}
    </>
  );
}
