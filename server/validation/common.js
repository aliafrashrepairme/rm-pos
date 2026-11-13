import { HttpError } from '../errors.js';

export function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} is required.`);
  return value.trim();
}

export function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (value.length > 72) throw new HttpError(400, 'Password must be 72 characters or fewer.');
  return value;
}

export function dateRange(query) {
  let start;
  let end;
  if (query.start) {
    start = new Date(query.start);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Invalid start date.');
  }
  if (query.end) {
    end = new Date(query.end);
    if (Number.isNaN(end.getTime())) throw new HttpError(400, 'Invalid end date.');
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.end)) end.setUTCHours(23, 59, 59, 999);
  }
  if (start && end && start > end) throw new HttpError(400, 'Start date must not be after end date.');
  return { start: start?.toISOString(), end: end?.toISOString() };
}
