import { api } from '../api.js';
import { getValue, setValue } from './store.js';

// A copy of the products for sale and the POS options, kept on this device so billing, scanning and
// quotations keep working without a connection. Cost prices are never part of it.

const CATALOG_KEY = 'catalog';
const OPTIONS_KEY = 'posOptions';
const PAGE_SIZE = 60;
let syncing = null;

// The same codes the server accepts for one barcode (server/services/products.js codeEquivalents):
// as typed, in capitals, and UPC-A <-> EAN-13 with a leading zero.
export function codeEquivalents(code) {
  const codes = new Set([code, code.toUpperCase()]);
  if (/^\d{12}$/.test(code)) codes.add(`0${code}`);
  if (/^0\d{12}$/.test(code)) codes.add(code.slice(1));
  return [...codes];
}

export function findByCode(products, rawCode) {
  const code = String(rawCode ?? '').trim();
  if (!code) return null;
  const codes = new Set(codeEquivalents(code));
  return products.find((product) => codes.has(product.barcode) || codes.has(product.sku)) ?? null;
}

// The same answer shape as GET /api/pos/catalog: name, SKU or barcode contains the search words.
export function searchProducts(products, { q = '', categoryId = '', page = 1, pageSize = 24 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const matching = products.filter((product) => {
    if (categoryId && product.categoryId !== categoryId) return false;
    const text = `${product.name} ${product.sku ?? ''} ${product.barcode ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  matching.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const from = (page - 1) * pageSize;
  return { products: matching.slice(from, from + pageSize), total: matching.length, page, pageSize, offline: true };
}

export async function cachedCatalog() {
  return (await getValue(CATALOG_KEY)) ?? { products: [], savedAt: null };
}

export const cachedPosOptions = () => getValue(OPTIONS_KEY);

// Downloads every product for sale, a page at a time, then replaces the saved copy in one step,
// so a dropped connection part-way never leaves half a list.
export function syncCatalog() {
  syncing ||= (async () => {
    try {
      const options = await api('/api/pos/options');
      const products = [];
      for (let page = 1; ; page += 1) {
        const result = await api(`/api/pos/catalog?pageSize=${PAGE_SIZE}&page=${page}`);
        for (const product of result.products) {
          const { imageUrl, ...kept } = product;
          products.push(kept);
        }
        if (result.products.length < PAGE_SIZE || products.length >= result.total) break;
      }
      // The catalogue answer has the category name; the category filter needs its ID too.
      const categoryIds = new Map(options.categories.map((category) => [category.name, category.id]));
      for (const product of products) product.categoryId ??= categoryIds.get(product.category) ?? '';
      await setValue(OPTIONS_KEY, options);
      await setValue(CATALOG_KEY, { products, savedAt: new Date().toISOString() });
      return true;
    } catch {
      return false;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// After a bill is saved offline, the saved stock goes down too, so the next bill can't oversell it here.
export async function reduceCachedStock(items) {
  const catalog = await cachedCatalog();
  if (!catalog.products.length) return;
  const sold = new Map(items.map((item) => [item.productId, Number(item.qty)]));
  for (const product of catalog.products) {
    if (sold.has(product.id)) product.stock = Math.max(0, Number(product.stock) - sold.get(product.id));
  }
  await setValue(CATALOG_KEY, catalog);
}
