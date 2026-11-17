import { useSyncExternalStore } from 'react';
import { apiFile } from '../api.js';

// The Owner's logo, shared by the sidebar, sign-in screen and printed bills.
// Null means none is set, so each place shows the built-in logo instead.
let logoUrl = null;
let loading = null;
const listeners = new Set();

function publish(url) {
  if (logoUrl) URL.revokeObjectURL(logoUrl);
  logoUrl = url;
  listeners.forEach((listener) => listener());
}

// The image is fetched rather than linked, because the page may only show images it holds itself.
export function refreshStoreLogo() {
  loading = apiFile('/api/logo')
    .then((blob) => publish(blob.size ? URL.createObjectURL(blob) : null))
    .catch(() => {});
  return loading;
}

function subscribe(listener) {
  listeners.add(listener);
  if (!loading) refreshStoreLogo();
  return () => listeners.delete(listener);
}

export function useStoreLogo() {
  return useSyncExternalStore(subscribe, () => logoUrl, () => null);
}
