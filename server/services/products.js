import { randomUUID } from 'node:crypto';
import { HttpError, unwrap } from '../errors.js';
import { categoryName } from '../validation/products.js';
import { writeAudit } from './audit.js';

const BUCKET = 'product-images';
const IMAGE_LINK_SECONDS = 3600;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const COLUMNS = '*, categories(name), tax_rates(name, rate), suppliers(name)';

function asProduct(row, imageUrls = {}) {
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    category: row.categories?.name || '',
    unitCode: row.unit_code,
    costPrice: Number(row.cost_price),
    sellingPrice: Number(row.selling_price),
    taxRateId: row.tax_rate_id,
    taxName: row.tax_rates?.name || '',
    taxRate: Number(row.tax_rates?.rate ?? 0),
    stock: Number(row.stock_qty),
    minStock: Number(row.min_stock),
    location: row.location,
    preferredSupplierId: row.preferred_supplier_id,
    supplier: row.suppliers?.name || '',
    active: row.active,
    imageUrl: imageUrls[row.image_path] || null,
    updatedAt: row.updated_at
  };
}

// Photos stay private, so each list hands out links that expire.
async function signedImageUrls(database, rows) {
  const paths = rows.map((row) => row.image_path).filter(Boolean);
  if (!paths.length) return {};
  const { data, error } = await database.storage.from(BUCKET).createSignedUrls(paths, IMAGE_LINK_SECONDS);
  if (error) {
    console.error('Could not create image links:', error);
    return {};
  }
  return Object.fromEntries(data.filter((item) => item.signedUrl).map((item) => [item.path, item.signedUrl]));
}

export async function listProducts({ database }, options) {
  const from = (options.page - 1) * options.pageSize;
  let query = database.from('products').select(COLUMNS, { count: 'exact' });
  if (options.status !== 'all') query = query.eq('active', options.status === 'active');
  if (options.categoryId) query = query.eq('category_id', options.categoryId);
  if (options.search) {
    const pattern = `"*${options.search}*"`;
    query = query.or(`name.ilike.${pattern},sku.ilike.${pattern},barcode.ilike.${pattern}`);
  }
  const result = await query
    .order(options.sort, { ascending: options.ascending })
    .order('id')
    .range(from, from + options.pageSize - 1);
  const rows = unwrap(result);
  const imageUrls = await signedImageUrls(database, rows);
  return {
    products: rows.map((row) => asProduct(row, imageUrls)),
    total: result.count ?? rows.length,
    page: options.page,
    pageSize: options.pageSize
  };
}

export async function getProduct({ database }, id) {
  const row = unwrap(await database.from('products').select(COLUMNS).eq('id', id).maybeSingle());
  if (!row) throw new HttpError(404, 'Product not found.');
  return asProduct(row, await signedImageUrls(database, [row]));
}

export async function createProduct(clients, user, product) {
  const id = unwrap(await clients.database.rpc('create_product', { p_product: product, p_created_by: user.id }));
  const created = await getProduct(clients, id);
  await writeAudit(clients.database, {
    user,
    action: 'Product created',
    description: `${created.sku} ${created.name}`,
    entityType: 'product',
    entityId: id
  });
  return created;
}

export async function updateProduct(clients, user, id, changes) {
  const before = unwrap(await clients.database.from('products').select('id').eq('id', id).maybeSingle());
  if (!before) throw new HttpError(404, 'Product not found.');
  unwrap(await clients.database.from('products').update(changes).eq('id', id));
  const updated = await getProduct(clients, id);
  const onlyStatus = Object.keys(changes).length === 1 && 'active' in changes;
  await writeAudit(clients.database, {
    user,
    action: onlyStatus ? (changes.active ? 'Product reactivated' : 'Product deactivated') : 'Product updated',
    description: `${updated.sku} ${updated.name}`,
    entityType: 'product',
    entityId: id
  });
  return updated;
}

const IMAGE_TYPES = {
  'image/jpeg': { extension: 'jpg', matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  'image/png': { extension: 'png', matches: (bytes) => bytes.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { extension: 'webp', matches: (bytes) => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' }
};

export const ACCEPTED_IMAGE_TYPES = Object.keys(IMAGE_TYPES);
export const IMAGE_BODY_LIMIT = MAX_IMAGE_BYTES;

async function ensureBucket(database) {
  const { error } = await database.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: MAX_IMAGE_BYTES,
    allowedMimeTypes: ACCEPTED_IMAGE_TYPES
  });
  if (error && !/already exists/i.test(error.message)) throw error;
}

export async function setProductImage(clients, user, id, contentType, bytes) {
  const { database } = clients;
  const type = IMAGE_TYPES[contentType];
  if (!type || !Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(415, 'Choose a JPG, PNG or WebP image.');
  if (!type.matches(bytes)) throw new HttpError(415, 'This file is not a valid image.');

  const before = unwrap(await database.from('products').select('sku, name, image_path').eq('id', id).maybeSingle());
  if (!before) throw new HttpError(404, 'Product not found.');

  const path = `products/${id}/${randomUUID()}.${type.extension}`;
  try {
    await ensureBucket(database);
    const { error } = await database.storage.from(BUCKET).upload(path, bytes, { contentType });
    if (error) throw error;
  } catch (error) {
    console.error('Image upload failed:', error);
    throw new HttpError(502, 'The image could not be saved. Try again.');
  }
  unwrap(await database.from('products').update({ image_path: path }).eq('id', id));
  if (before.image_path) {
    const removed = await database.storage.from(BUCKET).remove([before.image_path]);
    if (removed.error) console.error('Could not remove the old image:', removed.error);
  }
  await writeAudit(database, {
    user,
    action: 'Product photo changed',
    description: `${before.sku} ${before.name}`,
    entityType: 'product',
    entityId: id
  });
  return getProduct(clients, id);
}

export async function listOptions({ database }) {
  const [categories, units, taxRates, suppliers] = await Promise.all([
    database.from('categories').select('id, name, active').order('name'),
    database.from('units').select('code').eq('active', true).order('code'),
    database.from('tax_rates').select('id, name, rate, is_default').eq('active', true).order('rate', { ascending: false }),
    database.from('suppliers').select('id, name').eq('active', true).order('name')
  ]);
  return {
    categories: unwrap(categories),
    units: unwrap(units).map((row) => row.code),
    taxRates: unwrap(taxRates).map((row) => ({ id: row.id, name: row.name, rate: Number(row.rate), isDefault: row.is_default })),
    suppliers: unwrap(suppliers)
  };
}

export async function createCategory({ database }, user, name) {
  const category = unwrap(await database.from('categories').insert({ name: categoryName(name) }).select('id, name, active').single());
  await writeAudit(database, { user, action: 'Category created', description: category.name, entityType: 'category', entityId: category.id });
  return category;
}

export async function updateCategory({ database }, user, id, body) {
  const changes = {};
  if (body?.name !== undefined) changes.name = categoryName(body.name);
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'Active must be true or false.');
    changes.active = body.active;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
  if (changes.active === false) {
    const { count, error } = await database.from('products')
      .select('id', { count: 'exact', head: true })
      .eq('category_id', id)
      .eq('active', true);
    unwrap({ error });
    if (count > 0) throw new HttpError(409, `${count} active product(s) use this category. Move them first.`);
  }
  const category = unwrap(await database.from('categories').update(changes).eq('id', id).select('id, name, active').maybeSingle());
  if (!category) throw new HttpError(404, 'Category not found.');
  await writeAudit(database, { user, action: 'Category updated', description: category.name, entityType: 'category', entityId: id });
  return category;
}
