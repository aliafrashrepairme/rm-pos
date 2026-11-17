const MONEY = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

export function money(value) {
  return `LKR ${Number(value || 0).toLocaleString('en-LK', MONEY)}`;
}

export function shortMoney(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (Math.abs(number) >= 1e3) return `${Math.round(number / 1e3)}K`;
  return String(Math.round(number));
}

export function quantity(value) {
  return Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 3 });
}

export function dateTime(value, timeZone) {
  return new Date(value).toLocaleString('en-GB', {
    timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
  });
}

// Change from the previous figure, or null when there is nothing to compare with.
export function percentChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}
