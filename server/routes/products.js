import express, { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import * as products from '../services/products.js';
import { newProduct, productChanges, productListQuery } from '../validation/products.js';

const VIEW = requirePermission('products.view');
const MANAGE = requirePermission('products.manage');

export function productRoutes(clients) {
  const router = Router();
  const imageBody = express.raw({ type: products.ACCEPTED_IMAGE_TYPES, limit: products.IMAGE_BODY_LIMIT });

  router.get('/', VIEW, async (req, res) => {
    res.json(await products.listProducts(clients, productListQuery(req.query)));
  });
  router.get('/options', VIEW, async (req, res) => {
    res.json(await products.listOptions(clients));
  });
  router.get('/:id', VIEW, async (req, res) => {
    res.json({ product: await products.getProduct(clients, req.params.id) });
  });
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ product: await products.createProduct(clients, req.user, newProduct(req.body)) });
  });
  router.patch('/:id', MANAGE, async (req, res) => {
    res.json({ product: await products.updateProduct(clients, req.user, req.params.id, productChanges(req.body)) });
  });
  router.put('/:id/image', MANAGE, imageBody, async (req, res) => {
    res.json({ product: await products.setProductImage(clients, req.user, req.params.id, req.get('content-type'), req.body) });
  });
  return router;
}

export function categoryRoutes(clients) {
  const router = Router();
  router.post('/', MANAGE, async (req, res) => {
    res.status(201).json({ category: await products.createCategory(clients, req.user, req.body?.name) });
  });
  router.patch('/:id', MANAGE, async (req, res) => {
    res.json({ category: await products.updateCategory(clients, req.user, req.params.id, req.body) });
  });
  return router;
}
