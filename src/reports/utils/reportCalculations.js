// Pure calculation helpers for the Reports module.
// Only "Completed" orders count as valid revenue — Refunded/Cancelled are excluded
// from revenue and order counts, per standard POS reporting rules.

export const DATE_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'custom'];

export function resolveDateRange(preset, custom = {}) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

  switch (preset) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case 'last7': {
      const s = new Date(now); s.setDate(s.getDate() - 6);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case 'last30': {
      const s = new Date(now); s.setDate(s.getDate() - 29);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case 'thisMonth': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case 'lastMonth': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: startOfDay(s), end: endOfDay(e) };
    }
    case 'thisYear': {
      const s = new Date(now.getFullYear(), 0, 1);
      return { start: startOfDay(s), end: endOfDay(now) };
    }
    case 'custom': {
      if (!custom.start || !custom.end) return { start: startOfDay(now), end: endOfDay(now) };
      const s = new Date(custom.start);
      const e = new Date(custom.end);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s > e) {
        return { start: startOfDay(now), end: endOfDay(now) };
      }
      return { start: startOfDay(s), end: endOfDay(e) };
    }
    default:
      return { start: startOfDay(now), end: endOfDay(now) };
  }
}

export function isWithinRange(isoDate, range) {
  const t = new Date(isoDate).getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

export function filterSalesByRange(sales, range) {
  return sales.filter((s) => isWithinRange(s.date, range));
}

export function completedOnly(sales) {
  return sales.filter((s) => s.status === 'Completed');
}

export function sumRevenue(sales) {
  return completedOnly(sales).reduce((sum, s) => sum + s.total, 0);
}

export function countOrders(sales) {
  return completedOnly(sales).length;
}

export function averageOrderValue(sales) {
  const orders = completedOnly(sales);
  if (orders.length === 0) return 0;
  return sumRevenue(sales) / orders.length;
}

export function totalItemsSold(sales) {
  return completedOnly(sales).reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
}

export function paymentsCollected(sales) {
  return sumRevenue(sales);
}

export function paymentMethodBreakdown(sales) {
  const orders = completedOnly(sales);
  const byMethod = {};
  for (const s of orders) {
    byMethod[s.paymentMethod] = (byMethod[s.paymentMethod] || 0) + s.total;
  }
  return Object.entries(byMethod).map(([method, amount]) => ({ method, amount }));
}

export function topSellingProducts(sales, limit = 5) {
  const orders = completedOnly(sales);
  const byProduct = {};
  for (const s of orders) {
    for (const item of s.items) {
      if (!byProduct[item.productId]) byProduct[item.productId] = { productId: item.productId, name: item.name, category: item.category, qty: 0, revenue: 0 };
      byProduct[item.productId].qty += item.qty;
      byProduct[item.productId].revenue += item.lineTotal;
    }
  }
  return Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, limit);
}

export function salesByCategory(sales) {
  const orders = completedOnly(sales);
  const byCat = {};
  for (const s of orders) {
    for (const item of s.items) {
      byCat[item.category] = (byCat[item.category] || 0) + item.lineTotal;
    }
  }
  return Object.entries(byCat).map(([category, revenue]) => ({ category, revenue }));
}

export function salesTrend(sales, range) {
  const days = [];
  const cursor = new Date(range.start);
  while (cursor <= range.end) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const orders = completedOnly(sales);
  return days.map((day) => {
    const dayStr = day.toDateString();
    const dayRevenue = orders.filter((s) => new Date(s.date).toDateString() === dayStr).reduce((sum, s) => sum + s.total, 0);
    return { date: day.toISOString().slice(0, 10), revenue: dayRevenue };
  });
}

export function recentSales(sales, limit = 10) {
  return [...sales].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
}

export function lowStockProducts(products) {
  return products.filter((p) => p.stock > 0 && p.stock <= p.reorderLevel);
}

export function outOfStockProducts(products) {
  return products.filter((p) => p.stock === 0);
}

export function stockStatus(product) {
  if (product.stock === 0) return 'Out of Stock';
  if (product.stock <= product.reorderLevel) return 'Low Stock';
  return 'In Stock';
}

export function inventoryValuation(products) {
  return products.reduce((sum, p) => sum + p.stock * p.unitCost, 0);
}

export function categoryStockSummary(products) {
  const byCat = {};
  for (const p of products) {
    if (!byCat[p.category]) byCat[p.category] = { category: p.category, totalStock: 0, totalValue: 0, productCount: 0 };
    byCat[p.category].totalStock += p.stock;
    byCat[p.category].totalValue += p.stock * p.unitCost;
    byCat[p.category].productCount += 1;
  }
  return Object.values(byCat);
}

export function stockMovementSummary(movements, range) {
  const inRange = movements.filter((m) => isWithinRange(m.date, range));
  const stockIn = inRange.filter((m) => m.type === 'Stock In').reduce((sum, m) => sum + m.quantity, 0);
  const stockOut = inRange.filter((m) => m.type === 'Stock Out').reduce((sum, m) => sum + m.quantity, 0);
  return { stockIn, stockOut, movements: inRange };
}

export function formatCurrency(amount) {
  return `Rs. ${Number(amount || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(isoDate) {
  return new Date(isoDate).toLocaleDateString('en-LK', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(isoDate) {
  return new Date(isoDate).toLocaleString('en-LK', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
