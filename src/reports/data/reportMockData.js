// Sample data for the Reports & Analytics module.
// This stands in for the real backend until sales/inventory/payment APIs exist.
// Shape mirrors what reportService.js expects — swap the service internals later
// without touching any component.

export const CATEGORIES = ['Hand Tools', 'Power Tools', 'Plumbing', 'Electrical', 'Paint', 'Fasteners', 'Safety Gear'];

export const PRODUCTS = [
  { id: 'P-1001', name: 'Claw Hammer 16oz', sku: 'HT-1001', category: 'Hand Tools', unitCost: 850, unitPrice: 1450, stock: 42, reorderLevel: 15 },
  { id: 'P-1002', name: 'Adjustable Wrench 10"', sku: 'HT-1002', category: 'Hand Tools', unitCost: 620, unitPrice: 1100, stock: 8, reorderLevel: 10 },
  { id: 'P-1003', name: 'Cordless Drill 18V', sku: 'PT-2001', category: 'Power Tools', unitCost: 7800, unitPrice: 12900, stock: 14, reorderLevel: 5 },
  { id: 'P-1004', name: 'Angle Grinder 850W', sku: 'PT-2002', category: 'Power Tools', unitCost: 6200, unitPrice: 9800, stock: 0, reorderLevel: 6 },
  { id: 'P-1005', name: 'PVC Pipe 1" (3m)', sku: 'PL-3001', category: 'Plumbing', unitCost: 320, unitPrice: 520, stock: 180, reorderLevel: 40 },
  { id: 'P-1006', name: 'Brass Tap Fitting', sku: 'PL-3002', category: 'Plumbing', unitCost: 410, unitPrice: 690, stock: 26, reorderLevel: 20 },
  { id: 'P-1007', name: 'MCB Circuit Breaker 20A', sku: 'EL-4001', category: 'Electrical', unitCost: 540, unitPrice: 890, stock: 60, reorderLevel: 25 },
  { id: 'P-1008', name: 'LED Bulb 12W', sku: 'EL-4002', category: 'Electrical', unitCost: 180, unitPrice: 350, stock: 9, reorderLevel: 30 },
  { id: 'P-1009', name: 'Emulsion Paint 4L (White)', sku: 'PT-5001', category: 'Paint', unitCost: 2400, unitPrice: 3600, stock: 22, reorderLevel: 10 },
  { id: 'P-1010', name: 'Enamel Paint 1L (Red)', sku: 'PT-5002', category: 'Paint', unitCost: 780, unitPrice: 1250, stock: 4, reorderLevel: 8 },
  { id: 'P-1011', name: 'Hex Bolt M8x40 (Box 100)', sku: 'FA-6001', category: 'Fasteners', unitCost: 950, unitPrice: 1500, stock: 35, reorderLevel: 12 },
  { id: 'P-1012', name: 'Wood Screw 2" (Box 200)', sku: 'FA-6002', category: 'Fasteners', unitCost: 680, unitPrice: 1080, stock: 50, reorderLevel: 15 },
  { id: 'P-1013', name: 'Safety Helmet', sku: 'SG-7001', category: 'Safety Gear', unitCost: 650, unitPrice: 1100, stock: 18, reorderLevel: 10 },
  { id: 'P-1014', name: 'Work Gloves (Pair)', sku: 'SG-7002', category: 'Safety Gear', unitCost: 220, unitPrice: 420, stock: 3, reorderLevel: 20 },
  { id: 'P-1015', name: 'Measuring Tape 5m', sku: 'HT-1003', category: 'Hand Tools', unitCost: 310, unitPrice: 550, stock: 60, reorderLevel: 20 }
];

const PAYMENT_METHODS = ['Cash', 'Card', 'Bank Transfer'];
const ORDER_STATUSES = ['Completed', 'Refunded', 'Cancelled'];

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function buildSales() {
  const rand = seededRandom(20240501);
  const sales = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const DAYS_BACK = 400;
  let orderSeq = 1;

  for (let d = DAYS_BACK; d >= 0; d--) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const ordersToday = Math.floor((isWeekend ? 10 : 6) + rand() * (isWeekend ? 10 : 8));

    for (let i = 0; i < ordersToday; i++) {
      const orderId = `ORD-${String(orderSeq).padStart(5, '0')}`;
      const itemCount = 1 + Math.floor(rand() * 4);
      const items = [];
      let orderTotal = 0;

      for (let j = 0; j < itemCount; j++) {
        const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
        const qty = 1 + Math.floor(rand() * 5);
        const lineTotal = qty * product.unitPrice;
        orderTotal += lineTotal;
        items.push({ productId: product.id, name: product.name, category: product.category, qty, unitPrice: product.unitPrice, lineTotal });
      }

      const statusRoll = rand();
      const status = statusRoll < 0.04 ? 'Refunded' : statusRoll < 0.07 ? 'Cancelled' : 'Completed';
      const methodRoll = rand();
      const paymentMethod = methodRoll < 0.55 ? 'Cash' : methodRoll < 0.85 ? 'Card' : 'Bank Transfer';
      const hour = 8 + Math.floor(rand() * 10);
      const minute = Math.floor(rand() * 60);
      const timestamp = new Date(date);
      timestamp.setHours(hour, minute, 0, 0);

      sales.push({
        orderId,
        transactionId: `TXN-${String(orderSeq).padStart(6, '0')}`,
        date: timestamp.toISOString(),
        items,
        total: orderTotal,
        status,
        paymentMethod,
        customer: rand() < 0.2 ? 'Walk-in Customer' : `Customer ${100 + (orderSeq % 40)}`
      });

      orderSeq++;
    }
  }

  return sales;
}

export const SALES = buildSales();

export const STOCK_MOVEMENTS = (() => {
  const rand = seededRandom(778899);
  const movements = [];
  const today = new Date();
  for (let d = 60; d >= 0; d--) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const eventsToday = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < eventsToday; i++) {
      const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
      const isIn = rand() < 0.4;
      movements.push({
        id: `MV-${d}-${i}`,
        date: date.toISOString(),
        productId: product.id,
        name: product.name,
        type: isIn ? 'Stock In' : 'Stock Out',
        quantity: isIn ? 10 + Math.floor(rand() * 40) : 1 + Math.floor(rand() * 8)
      });
    }
  }
  return movements;
})();

export { PAYMENT_METHODS, ORDER_STATUSES };
