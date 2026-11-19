import { createContext, useContext, useMemo, useState } from 'react';

const CartContext = createContext(null);

// Keeps the current bill while the cashier moves between screens. Signing out discards it.
export function CartProvider({ children }) {
  const [lines, setLines] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [couponCode, setCouponCode] = useState('');
  // The accepted quotation this bill was started from, if any: { id, quoteNo }.
  const [quotation, setQuotation] = useState(null);
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
