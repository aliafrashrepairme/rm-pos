import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const CartContext = createContext(null);
const STORAGE_PREFIX = 'rm-pos-cart:';

function loadSaved(userId) {
  if (!userId) return null;
  try {
    return JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) || 'null');
  } catch {
    return null;
  }
}

// Signing out discards the saved bill, as it always has.
export function clearSavedCart(userId) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + userId);
  } catch {
    // Storage unavailable: nothing was saved.
  }
}

// Keeps the current bill while the cashier moves between screens. It is also saved on this device, so
// closing the app, a refresh or a power cut doesn't lose a bill being rung up. Signing out discards it.
export function CartProvider({ userId, children }) {
  const [saved] = useState(() => loadSaved(userId));
  const [lines, setLines] = useState(saved?.lines ?? []);
  const [customer, setCustomer] = useState(saved?.customer ?? null);
  const [couponCode, setCouponCode] = useState(saved?.couponCode ?? '');
  // The accepted quotation this bill was started from, if any: { id, quoteNo }.
  const [quotation, setQuotation] = useState(saved?.quotation ?? null);

  useEffect(() => {
    if (!userId) return;
    try {
      if (!lines.length && !customer && !couponCode && !quotation) localStorage.removeItem(STORAGE_PREFIX + userId);
      else localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify({ lines, customer, couponCode, quotation }));
    } catch {
      // Storage full or blocked: the bill still works for this session.
    }
  }, [userId, lines, customer, couponCode, quotation]);

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
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}
