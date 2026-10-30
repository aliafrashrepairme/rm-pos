import { HttpError } from '../errors.js';

export function notFound(req, res, next) {
  next(new HttpError(404, 'This API route does not exist.'));
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large.' });
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
}
