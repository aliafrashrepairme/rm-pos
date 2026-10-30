// All calls to the Node API go through here.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'rm-pos-token';
const REFRESH_TOKEN_KEY = 'rm-pos-refresh-token';

export function getAuthToken() {
  return typeof localStorage === 'undefined' ? '' : localStorage.getItem(TOKEN_KEY) || '';
}

function getRefreshToken() {
  return typeof localStorage === 'undefined' ? '' : localStorage.getItem(REFRESH_TOKEN_KEY) || '';
}

export function setAuthToken(token, refreshToken) {
  if (typeof localStorage === 'undefined') return;
  if (!token) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

async function send(path, options, token) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers
  });
}

export async function api(path, options = {}) {
  let token = getAuthToken();
  let res = await send(path, options, token);
  if (res.status === 401 && token && path !== '/api/auth/login' && path !== '/api/auth/refresh') {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      const refreshResponse = await send('/api/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken })
      });
      const refreshed = await refreshResponse.json().catch(() => ({}));
      if (refreshResponse.ok && refreshed.token) {
        token = refreshed.token;
        setAuthToken(refreshed.token, refreshed.refreshToken);
        res = await send(path, options, token);
      } else {
        setAuthToken(null);
      }
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
