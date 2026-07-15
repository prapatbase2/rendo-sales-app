import { firebaseConfig, rendoConfig } from './config.js';
import { initializeApp, getApps, deleteApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence, browserSessionPersistence,
  signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, onAuthStateChanged,
  deleteUser
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  query, where, orderBy, limit, startAfter, writeBatch, runTransaction,
  serverTimestamp, Timestamp, documentId, enableNetwork, disableNetwork
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

export const FIREBASE_EXPORTS = {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  query, where, orderBy, limit, startAfter, writeBatch, runTransaction,
  serverTimestamp, Timestamp, documentId, enableNetwork, disableNetwork
};

export function isFirebaseConfigured() {
  const values = [firebaseConfig.apiKey, firebaseConfig.authDomain, firebaseConfig.projectId, firebaseConfig.appId];
  return values.every((value) => value && !String(value).includes('ใส่-'))
    && rendoConfig.authPepper && !rendoConfig.authPepper.startsWith('เปลี่ยนเป็น');
}

export const app = isFirebaseConfigured() ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
let firestoreInstance = null;
if (app) {
  try {
    firestoreInstance = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true
    });
  } catch (error) {
    console.warn('Persistent Firestore cache unavailable; using memory cache.', error);
    firestoreInstance = getFirestore(app);
  }
}
export const db = firestoreInstance;

if (auth) setPersistence(auth, browserLocalPersistence).catch(() => setPersistence(auth, browserSessionPersistence));

export function normalizeLoginId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

export function loginEmail(loginId) {
  return `rendo.${normalizeLoginId(loginId)}@${rendoConfig.internalEmailDomain}`;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function derivePassword(loginId, pin) {
  const normalized = normalizeLoginId(loginId);
  const raw = `Rendo/v1/${normalized}/${pin}/${rendoConfig.authPepper}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return `R1!${bytesToBase64Url(new Uint8Array(digest))}`;
}

export async function signInWithLoginId(loginId, pin) {
  return signInWithEmailAndPassword(auth, loginEmail(loginId), await derivePassword(loginId, pin));
}

export async function signOutRendo() {
  if (auth) await signOut(auth);
}

export function observeAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function createSecondaryAuthUser(loginId, pin) {
  const name = `secondary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const secondary = initializeApp(firebaseConfig, name);
  const secondaryAuth = getAuth(secondary);
  await setPersistence(secondaryAuth, browserSessionPersistence);
  const credential = await createUserWithEmailAndPassword(
    secondaryAuth, loginEmail(loginId), await derivePassword(loginId, pin)
  );
  return {
    uid: credential.user.uid,
    user: credential.user,
    async cleanup({ removeAuthUser = false } = {}) {
      try { if (removeAuthUser && secondaryAuth.currentUser) await deleteUser(secondaryAuth.currentUser); } catch {}
      try { await signOut(secondaryAuth); } catch {}
      try { await deleteApp(secondary); } catch {}
    }
  };
}

export async function reauthenticateCurrent(loginId, pin) {
  if (!auth?.currentUser) throw new Error('ยังไม่ได้เข้าสู่ระบบ');
  const credential = EmailAuthProvider.credential(loginEmail(loginId), await derivePassword(loginId, pin));
  return reauthenticateWithCredential(auth.currentUser, credential);
}

export async function updateCurrentPin(loginId, oldPin, newPin) {
  if (!auth?.currentUser) throw new Error('ยังไม่ได้เข้าสู่ระบบ');
  await reauthenticateCurrent(loginId, oldPin);
  const oldPassword = await derivePassword(loginId, oldPin);
  const newPassword = await derivePassword(loginId, newPin);
  await updatePassword(auth.currentUser, newPassword);
  return {
    async rollback() {
      try {
        await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(loginEmail(loginId), newPassword));
        await updatePassword(auth.currentUser, oldPassword);
      } catch {}
    }
  };
}

export { firebaseConfig, rendoConfig };
