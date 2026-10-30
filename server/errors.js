export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Business errors raised by Postgres functions look like PREFIX:Readable message.
const BUSINESS_ERRORS = {
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  STOCK_GUARD: 409,
  APPEND_ONLY: 409,
  INVALID_QTY: 400
};

export function fromSupabase(error) {
  const message = error.message || 'Supabase request failed.';
  if (error.code === 'P0001') {
    const separator = message.indexOf(':');
    const status = BUSINESS_ERRORS[message.slice(0, separator)];
    return status ? new HttpError(status, message.slice(separator + 1)) : new HttpError(400, message);
  }
  if (error.code === '23505') return new HttpError(409, 'A record with the same unique value already exists.');
  if (error.code === '23503') return new HttpError(400, 'A referenced record does not exist.');
  if (error.code === '23514' || error.code === '22P02') return new HttpError(400, 'The request contains invalid data.');
  if (error.code === '42501') return new HttpError(403, 'You do not have permission to perform this action.');
  console.error('Supabase error:', error);
  return new HttpError(500, 'The storage service could not complete the request.');
}

export function unwrap(result) {
  if (result.error) throw fromSupabase(result.error);
  return result.data;
}
