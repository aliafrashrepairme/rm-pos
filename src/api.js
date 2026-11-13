// All calls to the Node API go through here.
const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:4000';
const TOKEN_KEY = 'rm-pos-token';
const REFRESH_TOKEN_KEY = 'rm-pos-refresh-token';
export const SESSION_EXPIRED_EVENT = 'rm-pos:session-expired';

// Session storage ends with the window, so a shared shop PC doesn't stay signed in.
export function getAuthToken() {
  return typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(TOKEN_KEY) || '';
}

function getRefreshToken() {
  return typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(REFRESH_TOKEN_KEY) || '';
}

export function setAuthToken(token, refreshToken) {
  if (typeof sessionStorage === 'undefined') return;
  if (!token) {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) sessionStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

async function send(path, options, token) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    const error = new Error('Cannot reach the RM POS server. Check the internet connection and try again.');
    error.status = 0;
    throw error;
  }
}

function endExpiredSession() {
  setAuthToken(null);
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export async function api(path, options = {}) {
  let token = getAuthToken();
  let res = await send(path, options, token);
  if (res.status === 401 && token) {
    const refreshToken = getRefreshToken();
    const refreshResponse = refreshToken && await send('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    });
    const refreshed = refreshResponse ? await refreshResponse.json().catch(() => ({})) : {};
    if (refreshResponse?.ok && refreshed.token) {
      token = refreshed.token;
      setAuthToken(refreshed.token, refreshed.refreshToken);
      res = await send(path, options, token);
    } else {
      endExpiredSession();
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

// For stored files, which need the sign-in but aren't JSON.
export async function apiFile(path) {
  const res = await send(path, {}, getAuthToken());
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const error = new Error(data.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return res.blob();
}
