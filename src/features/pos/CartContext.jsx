import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { deleteValue, getValue, setValue } from '../../offline/store.js';

const CartContext = createContext(null);
const KEY_PREFIX = 'cart:';

// Signing out discards the saved bill, as it always has.
export function clearSavedCart(userId) {
  if (!userId) return;
  deleteValue(KEY_PREFIX + userId).catch(() => {});
}

// Keeps the current bill while the cashier moves between screens. It is also saved on this device
// (encrypted), so closing the app, a refresh or a power cut doesn't lose a bill being rung up.
// Signing out discards it.
export function CartProvider({ userId, children }) {
  const [loaded, setLoaded] = useState(!userId);
  const [lines, setLines] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [couponCode, setCouponCode] = useState('');
  // The accepted quotation this bill was started from, if any: { id, quoteNo }.
  const [quotation, setQuotation] = useState(null);
  const saving = useRef(Promise.resolve());

  // The saved bill is read before the screens appear, so nothing typed can be overwritten by it.
  useEffect(() => {
    if (!userId) return undefined;
    let current = true;
    // Earlier versions kept the bill unencrypted in localStorage; remove that copy.
    try { localStorage.removeItem(`rm-pos-cart:${userId}`); } catch { /* storage unavailable */ }
    getValue(KEY_PREFIX + userId)
      .then((saved) => {
        if (!current || !saved) return;
        setLines(saved.lines ?? []);
        setCustomer(saved.customer ?? null);
        setCouponCode(saved.couponCode ?? '');
        setQuotation(saved.quotation ?? null);
      })
      .catch(() => {})
      .finally(() => { if (current) setLoaded(true); });
    return () => { current = false; };
  }, [userId]);

  useEffect(() => {
    if (!userId || !loaded) return;
    const empty = !lines.length && !customer && !couponCode && !quotation;
    // Saves run one after another, so an older bill can never land after a newer one.
    saving.current = saving.current
      .then(() => (empty ? deleteValue(KEY_PREFIX + userId) : setValue(KEY_PREFIX + userId, { lines, customer, couponCode, quotation })))
      .catch(() => {});
  }, [userId, loaded, lines, customer, couponCode, quotation]);

  const value = useMemo(() => ({
    lines,
    setLines,
    customer,
    setCustomer,
    couponCode,
    setCouponCode,
    quotation,
    setQuotation,
    clear() {
      setLines([]);
      setCustomer(null);
      setCouponCode('');
      setQuotation(null);
    }
  }), [lines, customer, couponCode, quotation]);
  if (!loaded) return null;
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}
