const KEY_STORAGE = 'jijun_data_key';
const KEY_BYTES = 32;

function generate() {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function getOrCreateKey() {
  let key = localStorage.getItem(KEY_STORAGE);
  if (!key || key.length !== KEY_BYTES * 2) {
    key = generate();
    localStorage.setItem(KEY_STORAGE, key);
  }
  return key;
}

export function getKey() {
  return localStorage.getItem(KEY_STORAGE);
}

export function setKey(key) {
  if (!key || key.length !== KEY_BYTES * 2 || !/^[0-9a-f]+$/.test(key)) {
    throw new Error('Invalid key format: must be 64 hex characters');
  }
  localStorage.setItem(KEY_STORAGE, key);
}
