function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function generatePinVaultKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey)
  };
}

export async function encryptPin(publicJwk, pin) {
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const cipher = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(String(pin)));
  return toBase64(new Uint8Array(cipher));
}

export async function decryptPin(privateJwk, ciphertext) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, fromBase64(ciphertext));
  return new TextDecoder().decode(plain);
}

function openCredentialDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('rendo-device-vault', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('keys')) request.result.createObjectStore('keys');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getDeviceKey() {
  const db = await openCredentialDb();
  const existing = await new Promise((resolve, reject) => {
    const req = db.transaction('keys', 'readonly').objectStore('keys').get('credential-key');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(key, 'credential-key');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

export async function saveRememberedCredential(loginId, pin) {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify({ loginId, pin, savedAt: new Date().toISOString() }))
  );
  localStorage.setItem('rendo-remembered', JSON.stringify({ iv: toBase64(iv), cipher: toBase64(new Uint8Array(cipher)) }));
}

export async function loadRememberedCredential() {
  const stored = localStorage.getItem('rendo-remembered');
  if (!stored) return null;
  try {
    const payload = JSON.parse(stored);
    const key = await getDeviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(payload.iv) }, key, fromBase64(payload.cipher)
    );
    const value = JSON.parse(new TextDecoder().decode(plain));
    if (!value.loginId || !/^\d{4}$/.test(value.pin)) return null;
    return value;
  } catch {
    clearRememberedCredential();
    return null;
  }
}

export function clearRememberedCredential() {
  localStorage.removeItem('rendo-remembered');
}
