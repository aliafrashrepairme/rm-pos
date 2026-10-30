import { api } from '../../api.js';

export async function fetchSales() {
  const { sales } = await api('/api/reports/sales');
  return sales;
}

export async function fetchProducts() {
  const { products } = await api('/api/reports/products');
  return products;
}

export async function fetchStockMovements() {
  const { movements } = await api('/api/reports/stock-movements');
  return movements;
}
