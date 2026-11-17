// Theme and language are remembered on the device so the login screen can use them.
// Signed-in users also have them saved to their account, which wins after login.
const KEYS = { language: 'rm-pos-language', theme: 'rm-pos-theme' };
const DEFAULTS = { language: 'en', theme: 'dark' };
const ALLOWED = { language: ['en', 'ta', 'si'], theme: ['light', 'dark'] };

function read(name) {
  try {
    const value = localStorage.getItem(KEYS[name]);
    return ALLOWED[name].includes(value) ? value : DEFAULTS[name];
  } catch {
    return DEFAULTS[name];
  }
}

export function loadDevicePreferences() {
  return { language: read('language'), theme: read('theme') };
}

export function saveDevicePreference(name, value) {
  try {
    localStorage.setItem(KEYS[name], value);
  } catch {
    // The choice still applies until the window closes.
  }
}

export function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
}
