import {
  ROLE, ROLE_LABELS, DEFAULT_SETTINGS, toCents, fromCents, money, sumCents,
  calculateSales, calculateCashEquation, calculateHours, monthKeyFromDate,
  monthOrdinalFromDate, calculateCompensationMonth, calculateDashboard
} from './calc.js';
import {
  auth, db, FIREBASE_EXPORTS as F, isFirebaseConfigured, normalizeLoginId,
  signInWithLoginId, signOutRendo, observeAuth, createSecondaryAuthUser,
  reauthenticateCurrent, updateCurrentPin, rendoConfig
} from './firebase.js';
import {
  generatePinVaultKeys, encryptPin, decryptPin,
  saveRememberedCredential, loadRememberedCredential, clearRememberedCredential
} from './crypto-utils.js';

const APP_VERSION = '1.0.0';
const SCHEMA_VERSION = 'rendo-schema-1';
const BACKUP_SCHEMA_VERSION = 'rendo-backup-1';
const LOWER_ROLES = [ROLE.FRONT_KITCHEN, ROLE.BACK_KITCHEN, ROLE.FRONT_STAFF, ROLE.ROTATING_STAFF, ROLE.DAILY];
const ADMIN_ATTENDANCE_ROLES = [ROLE.OWNER, ROLE.MANAGER, ROLE.SUPERVISOR];
const SALES_ROLES = [ROLE.OWNER, ROLE.MANAGER, ROLE.SUPERVISOR, ROLE.FRONT_STAFF];
const BACKUP_COLLECTIONS = [
  'users','userPins','payrollProfiles','attendance','dailySales','dailySalesDrafts',
  'salaryAdvances','compensationMonthSettings','compensationRecords','recurringExpenses',
  'recurringExpenseSnapshots','ownerExpenses','appSettings','auditLogs','backupsMetadata'
];
const RESTORE_COLLECTIONS = BACKUP_COLLECTIONS.filter((name) => !['backupsMetadata'].includes(name));

const state = {
  user: null,
  settings: { ...DEFAULT_SETTINGS },
  page: null,
  initialized: false,
  navOpen: false,
  serviceWorkerRegistration: null,
  lastBackupTimer: null,
  pendingRestore: null,
  currentCompensation: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function dateToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterdayIso() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function currentMonthKey() { return dateToday().slice(0, 7); }

function monthOrdinal(monthKey) {
  const [y,m] = String(monthKey).split('-').map(Number);
  return y * 12 + m;
}

function monthRange(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const last = new Date(year, month, 0).getDate();
  return { start: `${monthKey}-01`, end: `${monthKey}-${String(last).padStart(2,'0')}`, days: last };
}

function formatThaiDate(iso, includeWeekday = true) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso || '-');
  const [y,m,d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    weekday: includeWeekday ? 'long' : undefined, day: 'numeric', month: 'short', year: 'numeric'
  }).format(new Date(y, m - 1, d));
}

function formatTimestamp(value) {
  if (!value) return '-';
  const date = value.toDate ? value.toDate() : new Date(value);
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function minuteLabel(minutes) {
  const n = Number(minutes);
  if (n === 1440) return '24:00';
  return `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
}

function timeOptions(start = 660, end = 1440, selected = '') {
  const options = ['<option value="">เลือกเวลา</option>'];
  for (let m = start; m <= end; m += 60) {
    options.push(`<option value="${m}" ${String(selected) === String(m) ? 'selected' : ''}>${minuteLabel(m)}</option>`);
  }
  return options.join('');
}

function roleOptions(allowed, selected = '') {
  return allowed.map((role) => `<option value="${role}" ${role === selected ? 'selected' : ''}>${ROLE_LABELS[role]}</option>`).join('');
}

function setScreen(id) {
  for (const screen of ['loading-screen','setup-screen','auth-screen','first-owner-screen','app-shell']) {
    $(`#${screen}`)?.classList.toggle('hidden', screen !== id);
  }
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  $('#toast-region').append(el);
  setTimeout(() => el.remove(), 4500);
}

function setBusy(button, busy, busyText = 'กำลังทำรายการ…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function onlineRequired() {
  if (!navigator.onLine) {
    toast('ออฟไลน์อยู่ กรุณาต่ออินเทอร์เน็ตก่อน', 'error');
    return false;
  }
  return true;
}

function updateOfflineUi() {
  const offline = !navigator.onLine;
  $('#offline-banner').classList.toggle('hidden', !offline);
  $('#online-indicator').textContent = offline ? 'ออฟไลน์' : 'ออนไลน์';
  $('#online-indicator').classList.toggle('offline', offline);
  document.body.classList.toggle('has-system-banner', offline || !$('#update-banner').classList.contains('hidden'));
  $$('[data-write-action]').forEach((button) => {
    button.disabled = offline || button.dataset.forceDisabled === 'true';
    if (offline) button.title = 'ออฟไลน์อยู่ กรุณาต่ออินเทอร์เน็ตก่อน';
  });
}

function confirmAction(title, message) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

function requestReauth(reason) {
  const dialog = $('#reauth-dialog');
  const form = $('#reauth-form');
  $('#reauth-reason').textContent = reason;
  $('#reauth-pin').value = '';
  $('#reauth-error').textContent = '';
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      $('#reauth-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
    };
    const onCancel = (event) => {
      event.preventDefault();
      if (settled) return;
      settled = true;
      cleanup();
      dialog.close();
      reject(new Error('ยกเลิกการยืนยันตัวตน'));
    };
    const onSubmit = async (event) => {
      event.preventDefault();
      const pin = $('#reauth-pin').value;
      if (!/^\d{4}$/.test(pin)) {
        $('#reauth-error').textContent = 'กรุณากรอก PIN ตัวเลข 4 หลัก';
        return;
      }
      try {
        await reauthenticateCurrent(state.user.loginId, pin);
        if (settled) return;
        settled = true;
        cleanup();
        dialog.close();
        resolve(pin);
      } catch {
        $('#reauth-error').textContent = 'PIN ไม่ถูกต้อง';
      }
    };
    form.addEventListener('submit', onSubmit);
    $('#reauth-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    setTimeout(() => $('#reauth-pin').focus(), 30);
  });
}

function serializeFirestore(value) {
  if (value === null || value === undefined) return value;
  if (value?.toDate) return { __type: 'timestamp', value: value.toDate().toISOString() };
  if (Array.isArray(value)) return value.map(serializeFirestore);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, serializeFirestore(v)]));
  return value;
}

function deserializeFirestore(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deserializeFirestore);
  if (typeof value === 'object') {
    if (value.__type === 'timestamp' && value.value) return F.Timestamp.fromDate(new Date(value.value));
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, deserializeFirestore(v)]));
  }
  return value;
}

function auditDoc({ action, area, targetId, before = null, after = null, reason = '', hidden = false }) {
  return {
    action, area, targetId: String(targetId || ''),
    actorId: state.user?.id || auth?.currentUser?.uid || '',
    actorName: state.user?.displayName || 'ระบบเริ่มต้น',
    actorRole: state.user?.role || ROLE.OWNER,
    before: serializeFirestore(before), after: serializeFirestore(after), reason: String(reason || ''),
    hidden, createdAt: F.serverTimestamp(), monthKey: currentMonthKey()
  };
}

async function getDocData(collectionName, id) {
  const snap = await F.getDoc(F.doc(db, collectionName, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function getCollectionData(collectionName, constraints = []) {
  const ref = F.collection(db, collectionName);
  const q = constraints.length ? F.query(ref, ...constraints) : ref;
  const snap = await F.getDocs(q);
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function writeWithAudit({ writes, audit, backup = true }) {
  if (!onlineRequired()) throw new Error('ออฟไลน์อยู่');
  const batch = F.writeBatch(db);
  for (const write of writes) {
    const ref = F.doc(db, write.collection, write.id);
    if (write.type === 'delete') batch.delete(ref);
    else if (write.type === 'update') batch.update(ref, write.data);
    else if (write.merge) batch.set(ref, write.data, { merge: true });
    else batch.set(ref, write.data);
  }
  batch.set(F.doc(F.collection(db, 'auditLogs')), auditDoc(audit));
  await batch.commit();
  if (backup) queueBackupAfterWrite();
}

function pageHeading(title, subtitle = '') {
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
}

function setPageHtml(html) {
  $('#page-root').innerHTML = html;
  updateOfflineUi();
  $('#main-content').focus({ preventScroll: true });
}

function isRole(...roles) { return roles.includes(state.user?.role); }

const MENU = {
  dashboard: { label: 'Dashboard', roles: [ROLE.OWNER, ROLE.MANAGER], render: renderDashboardPage },
  attendance: { label: 'ลงทำงาน / เช็คชื่อ', roles: Object.values(ROLE), render: renderAttendancePage },
  sales: { label: 'ยอดขาย', roles: SALES_ROLES, render: renderSalesPage },
  monthly: { label: 'รายเดือน', roles: Object.values(ROLE), render: renderMonthlyPage },
  advances: { label: 'เบิกเงินล่วงหน้า', roles: Object.values(ROLE), render: renderAdvancesPage, visible: () => isRole(ROLE.OWNER, ROLE.MANAGER) || state.user?.canUseAdvance },
  compensation: { label: 'ค่าตอบแทน', roles: [ROLE.OWNER, ROLE.MANAGER], render: renderCompensationPage },
  expenses: { label: 'ลงรายจ่าย', roles: [ROLE.OWNER, ROLE.MANAGER], render: renderExpensesPage },
  audit: { label: 'ประวัติ', roles: [ROLE.OWNER, ROLE.MANAGER], render: renderAuditPage },
  users: { label: 'ผู้ใช้งาน', roles: [ROLE.OWNER, ROLE.MANAGER, ROLE.SUPERVISOR], render: renderUsersPage },
  backup: { label: 'สำรอง / กู้คืนข้อมูล', roles: [ROLE.OWNER], render: renderBackupPage },
  settings: { label: 'ตั้งค่า', roles: [ROLE.OWNER], render: renderSettingsPage },
  'change-pin': { label: 'เปลี่ยน PIN ของฉัน', roles: Object.values(ROLE), render: renderChangePinPage }
};

function allowedMenuKeys() {
  const order = Array.isArray(state.settings.menuOrder) ? state.settings.menuOrder : DEFAULT_SETTINGS.menuOrder;
  return order.filter((key) => MENU[key] && MENU[key].roles.includes(state.user.role) && (!MENU[key].visible || MENU[key].visible()));
}

function renderNav() {
  const nav = $('#main-nav');
  nav.innerHTML = allowedMenuKeys().map((key) => `<button type="button" data-page="${key}" class="${state.page === key ? 'active' : ''}">${escapeHtml(MENU[key].label)}</button>`).join('');
  $$('button[data-page]', nav).forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
}

async function navigate(page) {
  if (!MENU[page] || !MENU[page].roles.includes(state.user.role) || (MENU[page].visible && !MENU[page].visible())) {
    page = allowedMenuKeys()[0];
  }
  state.page = page;
  location.hash = page;
  renderNav();
  $('#side-nav').classList.remove('open');
  try {
    setPageHtml('<div class="card"><p>กำลังโหลดข้อมูล…</p></div>');
    await MENU[page].render();
  } catch (error) {
    console.error(error);
    setPageHtml(`<div class="card danger"><h2>เปิดหน้านี้ไม่สำเร็จ</h2><p>${escapeHtml(friendlyError(error))}</p></div>`);
  }
}

function friendlyError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || 'เกิดข้อผิดพลาด');
  if (code.includes('permission-denied')) return 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ หรือกฎ Firestore ยังตั้งค่าไม่ถูกต้อง';
  if (code.includes('unavailable')) return 'ติดต่อ Firebase ไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่';
  if (code.includes('auth/invalid-credential')) return 'รหัสผู้ใช้หรือ PIN ไม่ถูกต้อง';
  if (code.includes('auth/email-already-in-use')) return 'รหัสผู้ใช้นี้ถูกใช้แล้ว';
  if (code.includes('auth/too-many-requests')) return 'กรอกผิดหลายครั้งเกินไป กรุณารอแล้วลองใหม่';
  return message.replace(/^Firebase:\s*/,'');
}

function applyTheme() {
  const s = state.settings;
  document.documentElement.style.setProperty('--primary', s.primaryColor || DEFAULT_SETTINGS.primaryColor);
  document.documentElement.style.setProperty('--secondary', s.secondaryColor || DEFAULT_SETTINGS.secondaryColor);
  document.documentElement.style.setProperty('--background', s.backgroundColor || DEFAULT_SETTINGS.backgroundColor);
  document.documentElement.style.setProperty('--font-scale', String(Number(s.fontScale || 1)));
  $('#header-store-name').textContent = s.storeName || 'Rendo';
  const logo = s.customLogoDataUrl || 'icons/favicon-32.png';
  $('#header-logo').src = logo;
  $('#auth-logo').src = s.customLogoDataUrl || 'icons/logo-192.png';
}

async function loadCurrentUser(firebaseUser) {
  const userDoc = await getDocData('users', firebaseUser.uid);
  if (!userDoc) throw new Error('ไม่พบข้อมูลผู้ใช้ใน Firestore');
  if (userDoc.active === false) {
    await signOutRendo();
    throw new Error('บัญชีนี้ถูกปิดใช้งาน');
  }
  state.user = userDoc;
  const settings = await getDocData('appSettings', 'main');
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  applyTheme();
  $('#current-user-name').textContent = userDoc.displayName;
  $('#current-user-role').textContent = ROLE_LABELS[userDoc.role] || userDoc.role;
  setScreen('app-shell');
  const requested = location.hash.replace('#','');
  const startPage = requested && MENU[requested] ? requested : (isRole(ROLE.OWNER, ROLE.MANAGER) ? 'dashboard' : 'attendance');
  renderNav();
  setupAutoBackupTimer();
  await navigate(startPage);
}

async function checkInitialization() {
  try {
    const init = await getDocData('system', 'initialization');
    state.initialized = Boolean(init?.initialized);
  } catch (error) {
    console.error(error);
    state.initialized = false;
  }
}

function showLoggedOutScreen() {
  state.user = null;
  clearInterval(state.lastBackupTimer);
  setScreen(state.initialized ? 'auth-screen' : 'first-owner-screen');
}

function loginLockState(loginId) {
  const key = `rendo-login-lock-${normalizeLoginId(loginId)}`;
  const value = JSON.parse(localStorage.getItem(key) || '{"fails":0,"until":0}');
  return { key, fails: Number(value.fails || 0), until: Number(value.until || 0) };
}

function registerLoginFailure(loginId) {
  const lock = loginLockState(loginId);
  lock.fails += 1;
  if (lock.fails >= 5) {
    lock.until = Date.now() + 60000;
    lock.fails = 0;
  }
  localStorage.setItem(lock.key, JSON.stringify({ fails: lock.fails, until: lock.until }));
}

function clearLoginFailures(loginId) {
  localStorage.removeItem(loginLockState(loginId).key);
}

async function handleLogin(event) {
  event.preventDefault();
  if (!navigator.onLine) {
    $('#login-message').textContent = 'ไม่มีอินเทอร์เน็ต กรุณาต่ออินเทอร์เน็ตก่อนเข้าสู่ระบบ';
    return;
  }
  const loginId = normalizeLoginId($('#login-id').value);
  const pin = $('#login-pin').value;
  if (!loginId || !/^\d{4}$/.test(pin)) {
    $('#login-message').textContent = 'กรุณากรอกรหัสผู้ใช้และ PIN ตัวเลข 4 หลัก';
    return;
  }
  const lock = loginLockState(loginId);
  if (lock.until > Date.now()) {
    $('#login-message').textContent = `กรอกผิดหลายครั้ง กรุณารอ ${Math.ceil((lock.until - Date.now())/1000)} วินาที`;
    return;
  }
  const button = $('#login-button');
  setBusy(button, true, 'กำลังเข้าสู่ระบบ…');
  $('#login-message').textContent = '';
  try {
    const credential = await signInWithLoginId(loginId, pin);
    const userDoc = await getDocData('users', credential.user.uid);
    if (!userDoc) throw new Error('ไม่พบข้อมูลผู้ใช้');
    if (userDoc.active === false) {
      await signOutRendo();
      throw new Error('บัญชีถูกปิดใช้งาน');
    }
    clearLoginFailures(loginId);
    if ($('#remember-login').checked) await saveRememberedCredential(loginId, pin);
    else clearRememberedCredential();
  } catch (error) {
    registerLoginFailure(loginId);
    $('#login-message').textContent = friendlyError(error);
  } finally {
    setBusy(button, false);
  }
}

async function handleFirstOwner(event) {
  event.preventDefault();
  if (!onlineRequired()) return;
  const displayName = $('#owner-name').value.trim();
  const loginId = normalizeLoginId($('#owner-login-id').value);
  const pin = $('#owner-pin').value;
  const confirmPin = $('#owner-pin-confirm').value;
  if (!displayName || !loginId || !/^\d{4}$/.test(pin) || pin !== confirmPin) {
    $('#owner-message').textContent = 'กรอกข้อมูลให้ครบ และ PIN ทั้งสองช่องต้องเป็นเลข 4 หลักตรงกัน';
    return;
  }
  const button = $('#create-owner-button');
  setBusy(button, true, 'กำลังสร้างเจ้าของ…');
  let secondary = null;
  try {
    await checkInitialization();
    if (state.initialized) throw new Error('มีเจ้าของคนแรกแล้ว กรุณากลับไปหน้าเข้าสู่ระบบ');
    secondary = await createSecondaryAuthUser(loginId, pin);
    const keys = await generatePinVaultKeys();
    const pinCiphertext = await encryptPin(keys.publicJwk, pin);
    const uid = secondary.uid;
    const today = dateToday();
    await F.runTransaction(secondary.db, async (tx) => {
      const initRef = F.doc(secondary.db, 'system', 'initialization');
      const initSnap = await tx.get(initRef);
      if (initSnap.exists()) throw new Error('มีเจ้าของคนแรกแล้วจากอุปกรณ์อื่น');
      tx.set(initRef, { initialized: true, ownerUid: uid, schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, createdAt: F.serverTimestamp() });
      tx.set(F.doc(secondary.db, 'users', uid), {
        displayName, loginId, role: ROLE.OWNER, active: true, startDate: today, endDate: '', canUseAdvance: true,
        createdAt: F.serverTimestamp(), createdBy: uid, updatedAt: F.serverTimestamp(), updatedBy: uid
      });
      tx.set(F.doc(secondary.db, 'userPins', uid), {
        ciphertext: pinCiphertext, algorithm: 'RSA-OAEP-SHA256', updatedAt: F.serverTimestamp(), updatedBy: uid
      });
      tx.set(F.doc(secondary.db, 'securityKeys', 'pinPublic'), { publicJwk: keys.publicJwk, createdAt: F.serverTimestamp() });
      tx.set(F.doc(secondary.db, 'ownerSecrets', 'pinPrivate'), { privateJwk: keys.privateJwk, createdAt: F.serverTimestamp() });
      tx.set(F.doc(secondary.db, 'appSettings', 'main'), {
        ...DEFAULT_SETTINGS, appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION,
        updatedAt: F.serverTimestamp(), updatedBy: uid
      });
      tx.set(F.doc(F.collection(secondary.db, 'auditLogs')), {
        action: 'initialize', area: 'system', targetId: 'initialization', actorId: uid, actorName: displayName,
        actorRole: ROLE.OWNER, before: null, after: { initialized: true, ownerUid: uid }, reason: 'สร้างเจ้าของคนแรก',
        hidden: false, createdAt: F.serverTimestamp(), monthKey: currentMonthKey()
      });
    });
    await secondary.cleanup();
    secondary = null;
    state.initialized = true;
    await signInWithLoginId(loginId, pin);
  } catch (error) {
    if (secondary) await secondary.cleanup({ removeAuthUser: true });
    $('#owner-message').textContent = friendlyError(error);
  } finally {
    setBusy(button, false);
  }
}

function attachCoreEvents() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#first-owner-form').addEventListener('submit', handleFirstOwner);
  $('#toggle-login-pin').addEventListener('click', () => {
    const input = $('#login-pin');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggle-login-pin').textContent = input.type === 'password' ? 'แสดง' : 'ซ่อน';
  });
  $('#clear-remembered').addEventListener('click', () => {
    clearRememberedCredential();
    $('#login-id').value = '';
    $('#login-pin').value = '';
    $('#remember-login').checked = false;
    toast('ล้างข้อมูลที่จำไว้แล้ว', 'success');
  });
  $('#logout-button').addEventListener('click', () => signOutRendo());
  $('#menu-toggle').addEventListener('click', () => $('#side-nav').classList.toggle('open'));
  window.addEventListener('online', updateOfflineUi);
  window.addEventListener('offline', updateOfflineUi);
  window.addEventListener('hashchange', () => {
    if (state.user) navigate(location.hash.replace('#',''));
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    state.serviceWorkerRegistration = registration;
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });
    if (registration.waiting) showUpdateBanner();
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  } catch (error) { console.warn('Service worker:', error); }
}

function showUpdateBanner() {
  $('#update-banner').classList.remove('hidden');
  document.body.classList.add('has-system-banner');
}

async function initializeAppUi() {
  attachCoreEvents();
  updateOfflineUi();
  await registerServiceWorker();
  $('#apply-update').addEventListener('click', () => {
    state.serviceWorkerRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  });
  if (!isFirebaseConfigured()) {
    setScreen('setup-screen');
    return;
  }
  try {
    const remembered = await loadRememberedCredential();
    if (remembered) {
      $('#login-id').value = remembered.loginId;
      $('#login-pin').value = remembered.pin;
      $('#remember-login').checked = true;
    }
  } catch {}
  await checkInitialization();
  observeAuth(async (firebaseUser) => {
    if (!firebaseUser) {
      showLoggedOutScreen();
      return;
    }
    try {
      await loadCurrentUser(firebaseUser);
    } catch (error) {
      console.error(error);
      await signOutRendo();
      $('#login-message').textContent = friendlyError(error);
    }
  });
}

function creatableRoles() {
  if (isRole(ROLE.OWNER)) return Object.values(ROLE);
  if (isRole(ROLE.MANAGER)) return [ROLE.MANAGER, ROLE.SUPERVISOR, ...LOWER_ROLES];
  if (isRole(ROLE.SUPERVISOR)) return LOWER_ROLES;
  return [];
}

function canEditUserRole(target) {
  if (target.id === state.user.id) return false;
  if (isRole(ROLE.OWNER)) return true;
  if (isRole(ROLE.MANAGER)) return ![ROLE.OWNER, ROLE.MANAGER].includes(target.role);
  return false;
}

function editableRoleOptions(target) {
  if (isRole(ROLE.OWNER)) return Object.values(ROLE);
  if (isRole(ROLE.MANAGER) && ![ROLE.OWNER, ROLE.MANAGER].includes(target.role)) {
    return [ROLE.MANAGER, ROLE.SUPERVISOR, ...LOWER_ROLES];
  }
  return [target.role];
}

function canDeactivateUser(target) {
  if (target.id === state.user.id) return false;
  if (isRole(ROLE.OWNER)) return true;
  if (isRole(ROLE.MANAGER)) return ![ROLE.OWNER, ROLE.MANAGER].includes(target.role);
  return false;
}

async function renderUsersPage() {
  pageHeading('ผู้ใช้งาน', 'สร้างบัญชี เปลี่ยนระดับ ปิดใช้งาน และดูข้อมูลที่จำเป็น');
  const users = (await getCollectionData('users')).sort((a,b) => a.displayName.localeCompare(b.displayName,'th'));
  const showSensitive = isRole(ROLE.OWNER, ROLE.MANAGER);
  const profiles = showSensitive ? await getCollectionData('payrollProfiles') : [];
  const profileMap = Object.fromEntries(profiles.map((row) => [row.id, row]));
  const allowed = creatableRoles();
  setPageHtml(`
    <section class="card">
      <h2>สร้างรหัสผู้ใช้ใหม่</h2>
      <form id="create-user-form">
        <div class="grid two">
          <div class="field"><label for="new-display-name">ชื่อที่แสดง</label><input id="new-display-name" maxlength="80" required></div>
          <div class="field"><label for="new-login-id">รหัสผู้ใช้</label><input id="new-login-id" maxlength="32" pattern="[A-Za-z0-9._-]+" required><p class="help">ใช้ a-z, 0-9, จุด ขีดกลาง หรือขีดล่าง</p></div>
          <div class="field"><label for="new-user-pin">PIN 4 หลัก</label><input id="new-user-pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required></div>
          <div class="field"><label for="new-user-role">ระดับผู้ใช้</label><select id="new-user-role" required>${roleOptions(allowed, allowed[allowed.length-1])}</select></div>
          <div class="field"><label for="new-start-date">วันที่เริ่มงาน</label><input id="new-start-date" type="date" value="${dateToday()}" required></div>
          <div class="field"><label class="check-row"><input id="new-advance-permission" type="checkbox"> อนุญาตเข้าเบิกเงินล่วงหน้า</label></div>
        </div>
        <button class="primary" data-write-action id="create-user-button" type="submit">สร้างบัญชี</button>
        <p id="create-user-message" class="form-message" role="alert"></p>
      </form>
    </section>
    <section class="card">
      <h2>รายชื่อปัจจุบัน</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>ชื่อ / รหัส</th><th>ระดับ</th><th>เริ่มงาน</th><th>สถานะ</th><th>สิทธิ์เบิก</th><th>จัดการ</th></tr></thead>
        <tbody>${users.map((user) => `
          <tr data-user-row="${user.id}">
            <td><strong>${escapeHtml(user.displayName)}</strong><br><span class="muted">${escapeHtml(user.loginId)}</span></td>
            <td>
              ${canEditUserRole(user) ? `<select data-role-select="${user.id}">${roleOptions(editableRoleOptions(user), user.role)}</select>` : escapeHtml(ROLE_LABELS[user.role] || user.role)}
            </td>
            <td>${escapeHtml(user.startDate || '-')}<br>${user.endDate ? `<span class="muted">สิ้นสุด ${escapeHtml(user.endDate)}</span>` : ''}</td>
            <td>${user.active === false ? '<span class="badge danger">ปิดใช้งาน</span>' : '<span class="badge final">ใช้งานอยู่</span>'}</td>
            <td>${isRole(ROLE.OWNER) ? `<label class="check-row"><input type="checkbox" data-advance-user="${user.id}" ${user.canUseAdvance ? 'checked' : ''}> อนุญาต</label>` : (user.canUseAdvance ? 'อนุญาต' : 'ไม่อนุญาต')}</td>
            <td class="actions">
              ${isRole(ROLE.OWNER) ? `<button class="secondary small" data-reveal-pin="${user.id}" type="button">ดู PIN</button>` : ''}
              ${showSensitive && LOWER_ROLES.includes(user.role) ? `<button class="secondary small" data-payroll="${user.id}" type="button">เงินเดือน/ธนาคาร</button>` : ''}
              ${canDeactivateUser(user) && user.active !== false ? `<button class="danger small" data-deactivate="${user.id}" data-write-action type="button">ปิดใช้งาน</button>` : ''}
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    </section>
    <dialog id="payroll-dialog"><form id="payroll-form" class="dialog-card">
      <h2>ข้อมูลเงินเดือนและธนาคาร</h2>
      <input id="payroll-user-id" type="hidden">
      <label for="payroll-base-salary">เงินเดือนพื้นฐาน (บาท)</label><input id="payroll-base-salary" type="number" min="0" step="0.01">
      <label for="payroll-bank">ธนาคาร</label><input id="payroll-bank" maxlength="80">
      <label for="payroll-account">เลขบัญชี</label><input id="payroll-account" inputmode="numeric" maxlength="40">
      <label for="payroll-account-name">ชื่อบัญชี</label><input id="payroll-account-name" maxlength="100">
      <div id="daily-rate-fields" class="grid two hidden">
        <div><label for="payroll-daily-rate">เรททั้งวัน (บาท)</label><input id="payroll-daily-rate" type="number" min="0" step="0.01"></div>
        <div><label for="payroll-hourly-rate">เรทรายชั่วโมง (บาท)</label><input id="payroll-hourly-rate" type="number" min="0" step="0.01"></div>
      </div>
      <label class="check-row"><input id="payroll-sso" type="checkbox" checked> คิดประกันสังคมให้บุคคลนี้</label>
      <p class="help">ค่าปัจจุบันใช้เป็นค่าเริ่มต้นเดือนถัดไป ส่วนเดือนที่ Finalized แล้วจะใช้ snapshot เดิม</p>
      <div class="dialog-actions"><button id="payroll-cancel" class="secondary" type="button">ยกเลิก</button><button class="primary" data-write-action type="submit">บันทึก</button></div>
    </form></dialog>
  `);

  $('#create-user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!onlineRequired()) return;
    const displayName = $('#new-display-name').value.trim();
    const loginId = normalizeLoginId($('#new-login-id').value);
    const pin = $('#new-user-pin').value;
    const role = $('#new-user-role').value;
    const startDate = $('#new-start-date').value;
    if (!displayName || !loginId || !/^\d{4}$/.test(pin) || !allowed.includes(role) || !startDate) {
      $('#create-user-message').textContent = 'กรอกข้อมูลให้ครบและตรวจรูปแบบ PIN/รหัสผู้ใช้';
      return;
    }
    const button = $('#create-user-button');
    setBusy(button, true, 'กำลังสร้าง…');
    let secondary = null;
    try {
      secondary = await createSecondaryAuthUser(loginId, pin);
      const publicKey = await getDocData('securityKeys', 'pinPublic');
      if (!publicKey?.publicJwk) throw new Error('ไม่พบกุญแจเข้ารหัส PIN');
      const pinCiphertext = await encryptPin(publicKey.publicJwk, pin);
      const uid = secondary.uid;
      const userData = {
        displayName, loginId, role, startDate, endDate: '', active: true,
        canUseAdvance: $('#new-advance-permission').checked,
        createdAt: F.serverTimestamp(), createdBy: state.user.id,
        updatedAt: F.serverTimestamp(), updatedBy: state.user.id
      };
      await writeWithAudit({
        writes: [
          { collection: 'users', id: uid, data: userData },
          { collection: 'userPins', id: uid, data: { ciphertext: pinCiphertext, algorithm: 'RSA-OAEP-SHA256', updatedAt: F.serverTimestamp(), updatedBy: state.user.id } }
        ],
        audit: { action: 'create', area: 'users', targetId: uid, after: { ...userData, pin: '[เข้ารหัสแล้ว]' } }
      });
      await secondary.cleanup();
      secondary = null;
      toast('สร้างบัญชีแล้ว', 'success');
      await renderUsersPage();
    } catch (error) {
      if (secondary) await secondary.cleanup({ removeAuthUser: true });
      $('#create-user-message').textContent = friendlyError(error);
    } finally { setBusy(button, false); }
  });

  $$('[data-role-select]').forEach((select) => select.addEventListener('change', async () => {
    const target = users.find((u) => u.id === select.dataset.roleSelect);
    const newRole = select.value;
    if (!target || newRole === target.role) return;
    const ok = await confirmAction('เปลี่ยนระดับผู้ใช้', `เปลี่ยน ${target.displayName} จาก ${ROLE_LABELS[target.role]} เป็น ${ROLE_LABELS[newRole]} หรือไม่`);
    if (!ok) { select.value = target.role; return; }
    try {
      await writeWithAudit({
        writes: [{ collection: 'users', id: target.id, type: 'update', data: { role: newRole, updatedAt: F.serverTimestamp(), updatedBy: state.user.id } }],
        audit: { action: 'update-role', area: 'users', targetId: target.id, before: { role: target.role }, after: { role: newRole } }
      });
      toast('เปลี่ยนระดับแล้ว', 'success');
      await renderUsersPage();
    } catch (error) { toast(friendlyError(error), 'error'); select.value = target.role; }
  }));

  $$('[data-advance-user]').forEach((checkbox) => checkbox.addEventListener('change', async () => {
    const target = users.find((u) => u.id === checkbox.dataset.advanceUser);
    try {
      await writeWithAudit({
        writes: [{ collection: 'users', id: target.id, type: 'update', data: { canUseAdvance: checkbox.checked, updatedAt: F.serverTimestamp(), updatedBy: state.user.id } }],
        audit: { action: 'advance-permission', area: 'users', targetId: target.id, before: { canUseAdvance: !checkbox.checked }, after: { canUseAdvance: checkbox.checked } }
      });
      toast('บันทึกสิทธิ์แล้ว', 'success');
    } catch (error) { checkbox.checked = !checkbox.checked; toast(friendlyError(error), 'error'); }
  }));

  $$('[data-deactivate]').forEach((button) => button.addEventListener('click', async () => {
    const target = users.find((u) => u.id === button.dataset.deactivate);
    const ok = await confirmAction('ปิดใช้งานบัญชี', `ปิดบัญชี ${target.displayName} หรือไม่ ข้อมูลเก่าจะยังอยู่และไม่เสียหาย`);
    if (!ok) return;
    try {
      await requestReauth('กรอก PIN ของคุณเพื่อปิดใช้งานบัญชี');
      await writeWithAudit({
        writes: [{ collection: 'users', id: target.id, type: 'update', data: { active: false, endDate: dateToday(), deactivatedAt: F.serverTimestamp(), deactivatedBy: state.user.id, updatedAt: F.serverTimestamp(), updatedBy: state.user.id } }],
        audit: { action: 'deactivate', area: 'users', targetId: target.id, before: { active: true }, after: { active: false, endDate: dateToday() }, reason: 'ปิดใช้งานจากหน้าผู้ใช้' }
      });
      toast('ปิดใช้งานแล้ว ข้อมูลเก่ายังคงอยู่', 'success');
      await renderUsersPage();
    } catch (error) { if (!String(error.message).includes('ยกเลิก')) toast(friendlyError(error), 'error'); }
  }));

  $$('[data-reveal-pin]').forEach((button) => button.addEventListener('click', async () => {
    const target = users.find((u) => u.id === button.dataset.revealPin);
    try {
      await requestReauth('กรอก PIN เจ้าของเพื่อดู PIN ของผู้ใช้');
      const [pinDoc, privateDoc] = await Promise.all([getDocData('userPins', target.id), getDocData('ownerSecrets', 'pinPrivate')]);
      if (!pinDoc?.ciphertext || !privateDoc?.privateJwk) throw new Error('ข้อมูล PIN ไม่ครบ');
      const pin = await decryptPin(privateDoc.privateJwk, pinDoc.ciphertext);
      await confirmAction(`PIN ของ ${target.displayName}`, `PIN ปัจจุบันคือ ${pin}\nกรุณาเก็บเป็นความลับ`);
    } catch (error) { if (!String(error.message).includes('ยกเลิก')) toast(friendlyError(error), 'error'); }
  }));

  const payrollDialog = $('#payroll-dialog');
  $$('[data-payroll]').forEach((button) => button.addEventListener('click', () => {
    const user = users.find((u) => u.id === button.dataset.payroll);
    const profile = profileMap[user.id] || {};
    $('#payroll-user-id').value = user.id;
    $('#payroll-base-salary').value = fromCents(profile.baseSalaryCents || 0);
    $('#payroll-bank').value = profile.bankName || '';
    $('#payroll-account').value = profile.bankAccount || '';
    $('#payroll-account-name').value = profile.bankAccountName || '';
    $('#payroll-sso').checked = profile.socialSecurityEnabled !== false;
    $('#daily-rate-fields').classList.toggle('hidden', user.role !== ROLE.DAILY);
    $('#payroll-daily-rate').value = fromCents(profile.dailyFullDayRateCents ?? state.settings.dailyFullDayRateCents);
    $('#payroll-hourly-rate').value = fromCents(profile.dailyHourlyRateCents ?? state.settings.dailyHourlyRateCents);
    payrollDialog.showModal();
  }));
  $('#payroll-cancel').addEventListener('click', () => payrollDialog.close());
  $('#payroll-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = $('#payroll-user-id').value;
    const target = users.find((u) => u.id === userId);
    const before = profileMap[userId] || null;
    const data = {
      baseSalaryCents: toCents($('#payroll-base-salary').value),
      bankName: $('#payroll-bank').value.trim(), bankAccount: $('#payroll-account').value.trim(),
      bankAccountName: $('#payroll-account-name').value.trim(),
      socialSecurityEnabled: $('#payroll-sso').checked,
      dailyFullDayRateCents: toCents($('#payroll-daily-rate').value || fromCents(state.settings.dailyFullDayRateCents)),
      dailyHourlyRateCents: toCents($('#payroll-hourly-rate').value || fromCents(state.settings.dailyHourlyRateCents)),
      updatedAt: F.serverTimestamp(), updatedBy: state.user.id
    };
    try {
      await writeWithAudit({
        writes: [{ collection: 'payrollProfiles', id: userId, data, merge: true }],
        audit: { action: 'update-payroll-profile', area: 'payrollProfiles', targetId: userId, before, after: { ...data, person: target.displayName } }
      });
      payrollDialog.close();
      toast('บันทึกข้อมูลเงินเดือน/ธนาคารแล้ว', 'success');
      await renderUsersPage();
    } catch (error) { toast(friendlyError(error), 'error'); }
  });
}
function attendanceStatusOptions(role, selected = '') {
  const common = [
    ['full_day','ทำงานทั้งวัน'], ['off','หยุด']
  ];
  const salaried = [['vacation','ลาพักผ่อน'],['sick','ลาป่วย'],['personal','ลากิจ'],['other','อื่น ๆ']];
  const items = role === ROLE.DAILY ? [...common, ['hourly','ทำงานรายชั่วโมง']] : [...common, ...salaried];
  return items.map(([value,label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

async function renderAttendancePage() {
  pageHeading('ลงทำงาน / เช็คชื่อ', ADMIN_ATTENDANCE_ROLES.includes(state.user.role) ? 'ดูรายการของพนักงานและกรองตามเดือน วันที่ ระดับ หรือชื่อ' : 'ลงข้อมูลของตัวเองทีละวัน');
  const month = $('#attendance-month')?.value || currentMonthKey();
  const isAdmin = ADMIN_ATTENDANCE_ROLES.includes(state.user.role);
  const constraints = [F.where('monthKey','==',month)];
  if (!isAdmin) constraints.push(F.where('userId','==',state.user.id));
  const attendance = await getCollectionData('attendance', constraints);
  const users = isAdmin ? await getCollectionData('users') : [state.user];
  const userMap = Object.fromEntries(users.map((u) => [u.id,u]));

  let missingHtml = '';
  if (!isAdmin) {
    const today = dateToday();
    const yesterday = yesterdayIso();
    const { start, end } = monthRange(month);
    const effectiveStart = [start, state.user.startDate || start].sort().at(-1);
    const effectiveEnd = [end, yesterday, state.user.endDate || end].sort().at(0);
    const existing = new Set(attendance.map((row) => row.date));
    const missing = [];
    if (effectiveStart <= effectiveEnd && month <= today.slice(0,7)) {
      let cursor = new Date(`${effectiveStart}T12:00:00`);
      const endDate = new Date(`${effectiveEnd}T12:00:00`);
      while (cursor <= endDate) {
        const iso = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`;
        if (!existing.has(iso)) missing.push(iso);
        cursor.setDate(cursor.getDate()+1);
      }
    }
    if (missing.length) {
      missingHtml = `<div class="alert"><strong>ยังไม่ได้เช็คชื่อ:</strong> ${missing.map((date) => `<button class="secondary missing-date-button" data-missing-date="${date}" type="button">วันที่ ${Number(date.slice(-2))}</button>`).join('')}</div>`;
    }
  }

  setPageHtml(`
    ${missingHtml}
    ${!isAdmin ? `<section class="card">
      <h2>ลงข้อมูลของฉัน</h2>
      <form id="attendance-form">
        <div class="grid two">
          <div class="field"><label for="attendance-date">วันที่</label><input id="attendance-date" type="date" value="${dateToday()}" max="${dateToday()}" required></div>
          <div class="field"><label for="attendance-status">สถานะ</label><select id="attendance-status">${attendanceStatusOptions(state.user.role,'full_day')}</select></div>
        </div>
        <div id="rotating-location-field" class="field ${state.user.role === ROLE.ROTATING_STAFF ? '' : 'hidden'}">
          <label for="attendance-location">สถานที่ทำงานทั้งวัน</label><select id="attendance-location"><option value="Rendo">Rendo</option><option value="Love Matcha">Love Matcha</option></select>
        </div>
        <div id="reason-field" class="field hidden"><label for="attendance-reason">สาเหตุ</label><textarea id="attendance-reason" maxlength="500"></textarea></div>
        <div id="hourly-fields" class="grid two hidden">
          <div><label for="attendance-start">เริ่ม</label><select id="attendance-start">${timeOptions(660,1440,660)}</select></div>
          <div><label for="attendance-end">สิ้นสุด</label><select id="attendance-end">${timeOptions(660,1440,1080)}</select><p id="attendance-hours" class="help"></p></div>
        </div>
        <div id="ot-fields" class="card soft">
          <label class="check-row"><input id="attendance-has-ot" type="checkbox"> ทำ OT ต่อ</label>
          <div id="ot-time-fields" class="grid two hidden">
            <div><label for="attendance-ot-start">เริ่ม OT</label><select id="attendance-ot-start"></select></div>
            <div><label for="attendance-ot-end">สิ้นสุด OT</label><select id="attendance-ot-end"></select></div>
          </div>
        </div>
        <button id="save-attendance" class="primary" data-write-action type="submit">บันทึกเช็คชื่อ</button>
        <p id="attendance-message" class="form-message"></p>
      </form>
    </section>` : ''}
    <section class="card">
      <h2>${isAdmin ? 'รายการเช็คชื่อพนักงาน' : 'ประวัติของฉัน'}</h2>
      <div class="grid ${isAdmin ? 'four' : 'two'}">
        <div><label for="attendance-month">เดือน</label><input id="attendance-month" type="month" value="${month}"></div>
        ${isAdmin ? `
          <div><label for="attendance-filter-date">วันที่</label><input id="attendance-filter-date" type="date"></div>
          <div><label for="attendance-filter-role">ระดับ</label><select id="attendance-filter-role"><option value="">ทุกระดับ</option>${roleOptions(LOWER_ROLES)}</select></div>
          <div><label for="attendance-filter-name">ชื่อ</label><input id="attendance-filter-name" placeholder="พิมพ์ชื่อหรือรหัส"></div>` : ''}
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>วันที่</th>${isAdmin ? '<th>พนักงาน</th><th>ระดับ</th>' : ''}<th>สถานะ</th><th>เวลา/OT</th><th>หมายเหตุ</th></tr></thead>
        <tbody id="attendance-list">${attendance.sort((a,b) => b.date.localeCompare(a.date)).map((row) => attendanceRowHtml(row,userMap[row.userId],isAdmin)).join('') || '<tr><td colspan="6">ยังไม่มีรายการในเดือนนี้</td></tr>'}</tbody>
      </table></div>
    </section>
  `);

  $('#attendance-month').addEventListener('change', renderAttendancePage);
  if (isAdmin) {
    const applyFilter = () => {
      const date = $('#attendance-filter-date').value;
      const role = $('#attendance-filter-role').value;
      const name = $('#attendance-filter-name').value.trim().toLowerCase();
      const filtered = attendance.filter((row) => {
        const user = userMap[row.userId] || {};
        return (!date || row.date === date) && (!role || row.role === role)
          && (!name || `${user.displayName || ''} ${user.loginId || ''}`.toLowerCase().includes(name));
      });
      $('#attendance-list').innerHTML = filtered.sort((a,b) => b.date.localeCompare(a.date)).map((row) => attendanceRowHtml(row,userMap[row.userId],true)).join('') || '<tr><td colspan="6">ไม่พบรายการ</td></tr>';
    };
    $('#attendance-filter-date').addEventListener('change', applyFilter);
    $('#attendance-filter-role').addEventListener('change', applyFilter);
    $('#attendance-filter-name').addEventListener('input', applyFilter);
    return;
  }

  $$('[data-missing-date]').forEach((button) => button.addEventListener('click', () => {
    $('#attendance-date').value = button.dataset.missingDate;
    $('#attendance-date').dispatchEvent(new Event('change'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));

  const form = $('#attendance-form');
  const status = $('#attendance-status');
  const location = $('#attendance-location');
  const hasOt = $('#attendance-has-ot');
  const updateConditionalFields = () => {
    const value = status.value;
    const needsReason = ['sick','personal','other'].includes(value);
    $('#reason-field').classList.toggle('hidden', !needsReason);
    $('#hourly-fields').classList.toggle('hidden', value !== 'hourly');
    const fullDay = value === 'full_day';
    $('#ot-fields').classList.toggle('hidden', !fullDay || state.user.role === ROLE.DAILY);
    $('#rotating-location-field').classList.toggle('hidden', !(state.user.role === ROLE.ROTATING_STAFF && fullDay));
    if (!fullDay) hasOt.checked = false;
    updateOtOptions();
  };
  const updateOtOptions = () => {
    const rotatingLove = state.user.role === ROLE.ROTATING_STAFF && location.value === 'Love Matcha';
    const startMin = rotatingLove ? 1080 : 1320;
    $('#attendance-ot-start').innerHTML = timeOptions(startMin, 1380, startMin);
    $('#attendance-ot-end').innerHTML = timeOptions(startMin + 60, 1440, 1440);
    $('#ot-time-fields').classList.toggle('hidden', !hasOt.checked);
  };
  const updateHours = () => {
    const hours = calculateHours($('#attendance-start').value, $('#attendance-end').value);
    $('#attendance-hours').textContent = hours > 0 ? `รวม ${hours} ชั่วโมง` : 'เวลาสิ้นสุดต้องมากกว่าเวลาเริ่ม';
  };
  status.addEventListener('change', updateConditionalFields);
  location?.addEventListener('change', updateOtOptions);
  hasOt.addEventListener('change', updateOtOptions);
  $('#attendance-start').addEventListener('change', updateHours);
  $('#attendance-end').addEventListener('change', updateHours);
  updateConditionalFields(); updateHours();

  $('#attendance-date').addEventListener('change', async () => {
    const date = $('#attendance-date').value;
    const existing = attendance.find((row) => row.date === date);
    if (!existing) { form.reset(); $('#attendance-date').value = date; status.value = 'full_day'; updateConditionalFields(); return; }
    status.value = existing.status;
    $('#attendance-reason').value = existing.reason || '';
    if (location) location.value = existing.workLocation || 'Rendo';
    $('#attendance-start').value = existing.startMinutes || '';
    $('#attendance-end').value = existing.endMinutes || '';
    hasOt.checked = Boolean(existing.otEndMinutes > existing.otStartMinutes);
    updateConditionalFields();
    if (hasOt.checked) {
      $('#attendance-ot-start').value = existing.otStartMinutes;
      $('#attendance-ot-end').value = existing.otEndMinutes;
    }
    updateHours();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!onlineRequired()) return;
    const date = $('#attendance-date').value;
    const statusValue = status.value;
    const reason = $('#attendance-reason').value.trim();
    if (['sick','personal','other'].includes(statusValue) && !reason) {
      $('#attendance-message').textContent = 'สถานะนี้ต้องกรอกสาเหตุ'; return;
    }
    let startMinutes = 0, endMinutes = 0;
    if (statusValue === 'hourly') {
      startMinutes = Number($('#attendance-start').value);
      endMinutes = Number($('#attendance-end').value);
      if (endMinutes <= startMinutes) { $('#attendance-message').textContent = 'เวลาสิ้นสุดต้องมากกว่าเวลาเริ่ม'; return; }
    }
    let otStartMinutes = 0, otEndMinutes = 0;
    if (hasOt.checked && statusValue === 'full_day' && state.user.role !== ROLE.DAILY) {
      otStartMinutes = Number($('#attendance-ot-start').value);
      otEndMinutes = Number($('#attendance-ot-end').value);
      if (otEndMinutes <= otStartMinutes) { $('#attendance-message').textContent = 'เวลา OT สิ้นสุดต้องมากกว่าเวลาเริ่ม'; return; }
    }
    const id = `${date}_${state.user.id}`;
    const before = attendance.find((row) => row.id === id) || null;
    const data = {
      date, monthKey: monthKeyFromDate(date), monthOrdinal: monthOrdinalFromDate(date),
      userId: state.user.id, role: state.user.role, status: statusValue,
      workLocation: state.user.role === ROLE.ROTATING_STAFF && statusValue === 'full_day' ? location.value : '',
      reason, startMinutes, endMinutes, otStartMinutes, otEndMinutes,
      paid: before?.paid || false,
      updatedAt: F.serverTimestamp(), updatedBy: state.user.id,
      createdAt: before?.createdAt || F.serverTimestamp()
    };
    const button = $('#save-attendance'); setBusy(button,true,'กำลังบันทึก…');
    try {
      await writeWithAudit({
        writes: [{ collection:'attendance', id, data }],
        audit: { action: before ? 'update' : 'create', area:'attendance', targetId:id, before, after:data }
      });
      toast('บันทึกเช็คชื่อแล้ว', 'success');
      await renderAttendancePage();
    } catch (error) { $('#attendance-message').textContent = friendlyError(error); }
    finally { setBusy(button,false); }
  });
}

function attendanceRowHtml(row, user, isAdmin) {
  const statusLabels = { full_day:'ทำงานทั้งวัน', off:'หยุด', vacation:'ลาพักผ่อน', sick:'ลาป่วย', personal:'ลากิจ', other:'อื่น ๆ', hourly:'รายชั่วโมง' };
  const time = row.status === 'hourly' ? `${minuteLabel(row.startMinutes)}–${minuteLabel(row.endMinutes)} (${calculateHours(row.startMinutes,row.endMinutes)} ชม.)`
    : row.otEndMinutes > row.otStartMinutes ? `OT ${minuteLabel(row.otStartMinutes)}–${minuteLabel(row.otEndMinutes)}` : '-';
  const note = [row.workLocation, row.reason].filter(Boolean).join(' — ');
  return `<tr>
    <td>${escapeHtml(formatThaiDate(row.date,false))}</td>
    ${isAdmin ? `<td>${escapeHtml(user?.displayName || row.userId)}</td><td>${escapeHtml(ROLE_LABELS[row.role] || row.role)}</td>` : ''}
    <td>${escapeHtml(statusLabels[row.status] || row.status)} ${row.paid ? '<span class="badge final">จ่ายแล้ว</span>' : ''}</td>
    <td>${escapeHtml(time)}</td><td>${escapeHtml(note || '-')}</td>
  </tr>`;
}
async function findSuggestedOpeningCash(date) {
  const rows = await getCollectionData('dailySales', [F.where('date','<',date), F.orderBy('date','desc'), F.limit(31)]);
  const lastOpen = rows.find((row) => row.status === 'final' && row.storeStatus === 'open');
  return lastOpen ? Number(lastOpen.closingCashCents || 0) : 0;
}

function saleExpenseRow(item = {}, index = 0) {
  return `<div class="expense-row" data-expense-row data-id="${escapeAttr(item.id || '')}">
    <div><label>ชื่อรายจ่าย</label><input data-expense-name maxlength="120" value="${escapeAttr(item.name || '')}"></div>
    <div><label>จำนวนเงิน</label><input data-expense-amount type="number" min="0" step="0.01" value="${fromCents(item.amountCents || 0)}"></div>
    <label class="check-row"><input data-expense-owner-paid type="checkbox" ${item.ownerPaid ? 'checked' : ''}> เจ้าของโอนเอง ไม่หักเงินสด</label>
    <button class="danger small" data-remove-expense type="button" aria-label="ลบรายจ่ายรายการ ${index+1}">ลบ</button>
  </div>`;
}

async function renderSalesPage(selectedDate = null) {
  const date = selectedDate || $('#sale-date')?.value || dateToday();
  pageHeading('ยอดขาย', 'บันทึกยอดรายวัน ฉบับร่างไม่รวมในการคำนวณ');
  const [finalSale, draftSale, suggestedOpening, yesterdaySale] = await Promise.all([
    getDocData('dailySales', date), getDocData('dailySalesDrafts', date), findSuggestedOpeningCash(date), getDocData('dailySales', yesterdayIso())
  ]);
  const record = finalSale || draftSale || {};
  const existingFinal = Boolean(finalSale);
  const isDraft = !existingFinal && Boolean(draftSale);
  const storeStatus = record.storeStatus || 'open';
  const expenses = Array.isArray(record.shiftExpenses) ? record.shiftExpenses : [];
  const openingCash = record.openingCashCents ?? suggestedOpening;
  const previousWarning = date === dateToday() && !yesterdaySale ? `<div class="alert"><strong>เมื่อวานยังไม่มีบันทึกจริง</strong> <button type="button" class="secondary small" id="go-yesterday">ไปลงยอดเมื่อวาน</button></div>` : '';

  setPageHtml(`
    ${previousWarning}
    ${isDraft ? '<div class="alert"><strong>ฉบับร่าง ยังไม่รวมในการคำนวณ</strong></div>' : ''}
    ${existingFinal ? `<div class="alert success"><strong>วันนี้มีบันทึกจริงแล้ว</strong> ตรวจสรุปก่อน หากต้องแก้ให้กด “เข้าสู่โหมดแก้ไข” <button id="edit-final-sale" class="secondary small" type="button">เข้าสู่โหมดแก้ไข</button></div>` : ''}
    <section class="card">
      <form id="sales-form">
        <div class="grid two">
          <div><label for="sale-date">วันที่</label><input id="sale-date" type="date" value="${date}" required></div>
          <div><label for="store-status">สถานะร้าน</label><select id="store-status" data-sale-field ${existingFinal ? 'disabled' : ''}><option value="open" ${storeStatus === 'open' ? 'selected' : ''}>เปิดร้าน</option><option value="closed" ${storeStatus === 'closed' ? 'selected' : ''}>หยุดร้าน</option></select></div>
        </div>
        <div id="sale-open-fields" class="${storeStatus === 'closed' ? 'hidden' : ''}">
          <h2>ยอดขายหลัก</h2>
          <div class="grid three">
            <div><label for="food-sales">ยอดขายอาหาร</label><input id="food-sales" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.foodCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
            <div><label for="beverage-sales">ยอดขายเครื่องดื่ม</label><input id="beverage-sales" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.beverageCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
            <div><label for="discount">ส่วนลด</label><input id="discount" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.discountCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
            <div><label for="cash-sales">เงินสด</label><input id="cash-sales" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.cashCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
            <div><label for="transfer-sales">เงินโอน</label><input id="transfer-sales" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.transferCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
            <div><label for="beer-bottles">เบียร์ (ขวด)</label><input id="beer-bottles" data-sale-field type="number" min="0" step="1" value="${Number(record.beerBottles || 0)}" ${existingFinal ? 'disabled' : ''}></div>
          </div>
          <div class="metric-grid">
            <div class="metric"><span>ยอดขายรวม</span><strong id="gross-sales-result">฿0.00</strong></div>
            <div class="metric"><span>รายได้รวมหลังส่วนลด</span><strong id="revenue-result">฿0.00</strong></div>
            <div class="metric" id="payment-diff-card"><span>ผลต่าง รายได้ กับ เงินสด+โอน</span><strong id="payment-diff-result">฿0.00</strong></div>
          </div>
          <div id="payment-note-field" class="field hidden"><label for="payment-note">หมายเหตุเมื่อรายรับไม่ตรงเงินสด+โอน</label><textarea id="payment-note" data-sale-field maxlength="800" ${existingFinal ? 'disabled' : ''}>${escapeHtml(record.paymentMismatchNote || '')}</textarea></div>

          <h2>เงินสดในกะ</h2>
          <div class="grid three">
            <div><label for="opening-cash">เงินสดเปิดกะ</label><input id="opening-cash" data-sale-field type="number" min="0" step="0.01" value="${fromCents(openingCash)}" ${existingFinal ? 'disabled' : ''}><p class="help">ค่าแนะนำจากวันเปิดร้านล่าสุด: ${money(suggestedOpening)}</p></div>
            <div><label for="cash-to-owner">เอาเงินสดให้เจ้าของ</label><input id="cash-to-owner" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.cashToOwnerCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
            <div><label for="closing-cash">เงินสดปิดกะ</label><input id="closing-cash" data-sale-field type="number" min="0" step="0.01" value="${fromCents(record.closingCashCents || 0)}" ${existingFinal ? 'disabled' : ''}></div>
          </div>
          <h3>รายจ่ายระหว่างกะ</h3>
          <div id="shift-expenses">${expenses.map(saleExpenseRow).join('')}</div>
          <button id="add-shift-expense" class="secondary small" data-sale-field type="button" ${existingFinal ? 'disabled' : ''}>+ เพิ่มรายจ่าย</button>
          <div class="metric-grid">
            <div class="metric"><span>เงินสดปิดกะตามสมการ</span><strong id="expected-closing-result">฿0.00</strong></div>
            <div class="metric" id="cash-diff-card"><span>ผลต่างเงินสด</span><strong id="cash-diff-result">฿0.00</strong></div>
          </div>
          <p class="formula">เงินสดเปิดกะ + เงินสดที่ขายได้ − รายจ่ายที่หักเงินสดจริง − เงินสดให้เจ้าของ = เงินสดปิดกะ</p>
          <div id="cash-reason-field" class="field hidden"><label for="cash-difference-reason">สาเหตุเงินสดขาด/เกิน</label><textarea id="cash-difference-reason" data-sale-field maxlength="800" ${existingFinal ? 'disabled' : ''}>${escapeHtml(record.cashDifferenceReason || '')}</textarea></div>
        </div>
        <div class="button-row">
          <button id="save-draft-sale" class="secondary" data-write-action type="button" ${existingFinal ? 'disabled' : ''}>บันทึกชั่วคราว</button>
          <button id="save-final-sale" class="primary" data-write-action type="submit" ${existingFinal ? 'disabled' : ''}>บันทึกจริง</button>
        </div>
        <p id="sales-message" class="form-message"></p>
      </form>
    </section>
  `);

  $('#go-yesterday')?.addEventListener('click', () => renderSalesPage(yesterdayIso()));
  $('#sale-date').addEventListener('change', () => renderSalesPage($('#sale-date').value));
  $('#store-status').addEventListener('change', () => $('#sale-open-fields').classList.toggle('hidden', $('#store-status').value === 'closed'));
  $('#edit-final-sale')?.addEventListener('click', async () => {
    const ok = await confirmAction('แก้ไขยอดที่บันทึกจริงแล้ว', `ตรวจสอบวันที่ ${formatThaiDate(date,false)} ให้ถูกต้องก่อน แก้ไขต่อหรือไม่`);
    if (!ok) return;
    $$('[data-sale-field]').forEach((el) => el.disabled = false);
    $('#save-draft-sale').disabled = false;
    $('#save-final-sale').disabled = false;
    $('#edit-final-sale').disabled = true;
    updateOfflineUi();
  });

  function attachExpenseEvents() {
    $$('[data-remove-expense]').forEach((button) => button.onclick = () => {
      button.closest('[data-expense-row]').remove(); calculateSalesForm();
    });
    $$('[data-expense-amount],[data-expense-owner-paid]').forEach((el) => el.addEventListener('input', calculateSalesForm));
  }
  $('#add-shift-expense').addEventListener('click', () => {
    $('#shift-expenses').insertAdjacentHTML('beforeend', saleExpenseRow({}, $$('[data-expense-row]').length));
    attachExpenseEvents();
  });

  function collectShiftExpenses() {
    return $$('[data-expense-row]').map((row, index) => ({
      id: row.dataset.id || `expense_${Date.now()}_${index}`,
      name: $('[data-expense-name]', row).value.trim(),
      amountCents: toCents($('[data-expense-amount]', row).value),
      ownerPaid: $('[data-expense-owner-paid]', row).checked
    })).filter((item) => item.name || item.amountCents > 0);
  }

  function calculateSalesForm() {
    const sales = calculateSales({
      foodCents: toCents($('#food-sales').value), beverageCents: toCents($('#beverage-sales').value),
      discountCents: toCents($('#discount').value), cashCents: toCents($('#cash-sales').value),
      transferCents: toCents($('#transfer-sales').value)
    });
    const cash = calculateCashEquation({
      openingCashCents: toCents($('#opening-cash').value), cashSalesCents: toCents($('#cash-sales').value),
      shiftExpenses: collectShiftExpenses(), cashToOwnerCents: toCents($('#cash-to-owner').value), closingCashCents: toCents($('#closing-cash').value)
    });
    $('#gross-sales-result').textContent = money(sales.grossSalesCents);
    $('#revenue-result').textContent = money(sales.revenueCents);
    $('#payment-diff-result').textContent = money(sales.paymentDifferenceCents);
    $('#payment-diff-card').classList.toggle('negative', sales.paymentDifferenceCents !== 0);
    $('#payment-note-field').classList.toggle('hidden', sales.paymentDifferenceCents === 0);
    $('#expected-closing-result').textContent = money(cash.expectedClosingCents);
    $('#cash-diff-result').textContent = `${cash.status === 'short' ? 'ขาด ' : cash.status === 'over' ? 'เกิน ' : ''}${money(Math.abs(cash.differenceCents))}`;
    $('#cash-diff-card').classList.toggle('negative', cash.differenceCents !== 0);
    $('#cash-diff-card').classList.toggle('positive', cash.differenceCents === 0);
    $('#cash-reason-field').classList.toggle('hidden', cash.differenceCents === 0);
    return { sales, cash };
  }
  $$('input[data-sale-field],textarea[data-sale-field]').forEach((el) => el.addEventListener('input', calculateSalesForm));
  attachExpenseEvents(); calculateSalesForm();

  async function saveSale(asDraft) {
    if (!onlineRequired()) return;
    const storeStatusValue = $('#store-status').value;
    if (storeStatusValue === 'closed' && finalSale?.storeStatus === 'open') {
      const ok = await confirmAction('เปลี่ยนเป็นหยุดร้าน', 'วันนี้เคยมียอดจริง ระบบจะเก็บข้อมูลเดิมในประวัติและนำยอดออกจากการคำนวณ ยืนยันหรือไม่');
      if (!ok) return;
    }
    const { sales, cash } = calculateSalesForm();
    const shiftExpenses = collectShiftExpenses();
    if (shiftExpenses.some((item) => !item.name || item.amountCents < 0)) {
      $('#sales-message').textContent = 'รายจ่ายทุกแถวต้องมีชื่อและจำนวนเงินที่ถูกต้อง'; return;
    }
    if (!asDraft && storeStatusValue === 'open' && cash.differenceCents !== 0 && !$('#cash-difference-reason').value.trim()) {
      $('#sales-message').textContent = 'เงินสดขาดหรือเกิน ต้องกรอกสาเหตุก่อนบันทึกจริง'; return;
    }
    if (!asDraft && storeStatusValue === 'open' && state.settings.requirePaymentMismatchNote && sales.paymentDifferenceCents !== 0 && !$('#payment-note').value.trim()) {
      $('#sales-message').textContent = 'รายได้ไม่ตรงกับเงินสด+โอน ต้องกรอกหมายเหตุ'; return;
    }
    const data = {
      date, monthKey: monthKeyFromDate(date), monthOrdinal: monthOrdinalFromDate(date),
      status: asDraft ? 'draft' : 'final', storeStatus: storeStatusValue,
      foodCents: storeStatusValue === 'open' ? toCents($('#food-sales').value) : 0,
      beverageCents: storeStatusValue === 'open' ? toCents($('#beverage-sales').value) : 0,
      grossSalesCents: storeStatusValue === 'open' ? sales.grossSalesCents : 0,
      discountCents: storeStatusValue === 'open' ? toCents($('#discount').value) : 0,
      revenueCents: storeStatusValue === 'open' ? sales.revenueCents : 0,
      cashCents: storeStatusValue === 'open' ? toCents($('#cash-sales').value) : 0,
      transferCents: storeStatusValue === 'open' ? toCents($('#transfer-sales').value) : 0,
      paymentDifferenceCents: storeStatusValue === 'open' ? sales.paymentDifferenceCents : 0,
      paymentMismatchNote: storeStatusValue === 'open' ? $('#payment-note').value.trim() : '',
      beerBottles: storeStatusValue === 'open' ? Math.max(0, Math.floor(Number($('#beer-bottles').value || 0))) : 0,
      openingCashCents: storeStatusValue === 'open' ? toCents($('#opening-cash').value) : 0,
      closingCashCents: storeStatusValue === 'open' ? toCents($('#closing-cash').value) : 0,
      suggestedOpeningCashCents: suggestedOpening,
      openingCashManualOverride: storeStatusValue === 'open' && toCents($('#opening-cash').value) !== suggestedOpening,
      openingCashNeedsReview: record.openingCashNeedsReview || false,
      shiftExpenses: storeStatusValue === 'open' ? shiftExpenses : [],
      shiftCashExpenseCents: storeStatusValue === 'open' ? cash.cashExpenseCents : 0,
      cashToOwnerCents: storeStatusValue === 'open' ? toCents($('#cash-to-owner').value) : 0,
      expectedClosingCents: storeStatusValue === 'open' ? cash.expectedClosingCents : 0,
      cashDifferenceCents: storeStatusValue === 'open' ? cash.differenceCents : 0,
      cashDifferenceReason: storeStatusValue === 'open' ? $('#cash-difference-reason').value.trim() : '',
      updatedAt: F.serverTimestamp(), updatedBy: state.user.id,
      createdAt: record.createdAt || F.serverTimestamp(), createdBy: record.createdBy || state.user.id
    };
    const button = asDraft ? $('#save-draft-sale') : $('#save-final-sale'); setBusy(button,true,asDraft?'กำลังบันทึกร่าง…':'กำลังบันทึกจริง…');
    try {
      const writes = asDraft
        ? [{ collection:'dailySalesDrafts', id:date, data }]
        : [{ collection:'dailySales', id:date, data }, { collection:'dailySalesDrafts', id:date, type:'delete' }];
      await writeWithAudit({ writes, audit: { action: asDraft ? 'draft' : (existingFinal ? 'update' : 'create'), area:'dailySales', targetId:date, before: finalSale || draftSale, after:data } });
      if (!asDraft && existingFinal && Number(finalSale.closingCashCents || 0) !== data.closingCashCents) {
        const future = await getCollectionData('dailySales', [F.where('date','>',date), F.orderBy('date','asc'), F.limit(31)]);
        const nextOpen = future.find((row) => row.status === 'final' && row.storeStatus === 'open');
        if (nextOpen) {
          await writeWithAudit({
            writes: [{ collection:'dailySales', id:nextOpen.id, type:'update', data:{ openingCashNeedsReview:true, updatedAt:F.serverTimestamp(), updatedBy:state.user.id } }],
            audit: { action:'mark-opening-review', area:'dailySales', targetId:nextOpen.id, before:{ openingCashNeedsReview:nextOpen.openingCashNeedsReview || false }, after:{ openingCashNeedsReview:true }, reason:`ยอดปิดกะ ${date} ถูกแก้ย้อนหลัง` }
          });
        }
      }
      toast(asDraft ? 'บันทึกฉบับร่างแล้ว ยังไม่รวมในการคำนวณ' : 'บันทึกยอดจริงแล้ว', 'success');
      await renderSalesPage(date);
    } catch (error) { $('#sales-message').textContent = friendlyError(error); }
    finally { setBusy(button,false); }
  }
  $('#save-draft-sale').addEventListener('click', () => saveSale(true));
  $('#sales-form').addEventListener('submit', (event) => { event.preventDefault(); saveSale(false); });
}
async function renderMonthlyPage(selectedMonth = null) {
  const month = selectedMonth || $('#monthly-month')?.value || currentMonthKey();
  const currentOrd = monthOrdinal(currentMonthKey());
  const selectedOrd = monthOrdinal(month);
  if (LOWER_ROLES.includes(state.user.role) && (selectedOrd < currentOrd - 1 || selectedOrd > currentOrd)) {
    throw new Error('พนักงานดูได้เฉพาะเดือนปัจจุบันและย้อนหลัง 1 เดือน');
  }
  pageHeading('รายเดือน', 'สรุปทุกวัน ใช้เฉพาะยอดขายที่บันทึกจริง ไม่รวมฉบับร่าง');
  const monthlySalesConstraints = [F.where('monthKey','==',month)];
  const monthlyAttendanceConstraints = [F.where('monthKey','==',month)];
  if (LOWER_ROLES.includes(state.user.role)) {
    monthlySalesConstraints.push(F.where('monthOrdinal','==',selectedOrd));
    monthlyAttendanceConstraints.push(F.where('monthOrdinal','==',selectedOrd));
  }
  const [sales, attendance, users] = await Promise.all([
    getCollectionData('dailySales', monthlySalesConstraints),
    getCollectionData('attendance', monthlyAttendanceConstraints),
    getCollectionData('users')
  ]);
  const saleMap = Object.fromEntries(sales.map((row) => [row.date,row]));
  const userMap = Object.fromEntries(users.map((row) => [row.id,row]));
  const attendanceByDate = new Map();
  for (const row of attendance) {
    if (!attendanceByDate.has(row.date)) attendanceByDate.set(row.date,[]);
    attendanceByDate.get(row.date).push(row);
  }
  const { days } = monthRange(month);
  let totalFood = 0, totalBeverage = 0, totalRevenue = 0, totalShiftCash = 0, totalCashOwner = 0;
  const rows = [];
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2,'0')}`;
    const sale = saleMap[date];
    const dayAttendance = attendanceByDate.get(date) || [];
    const kitchen = dayAttendance.filter((row) => row.status === 'full_day' && [ROLE.FRONT_KITCHEN,ROLE.BACK_KITCHEN].includes(row.role)).map((row) => userMap[row.userId]?.displayName || row.userId);
    const front = dayAttendance.filter((row) => row.status === 'full_day' && [ROLE.FRONT_STAFF,ROLE.ROTATING_STAFF,ROLE.DAILY].includes(row.role)).map((row) => userMap[row.userId]?.displayName || row.userId);
    if (sale?.status === 'final' && sale.storeStatus === 'open') {
      totalFood += Number(sale.foodCents || 0); totalBeverage += Number(sale.beverageCents || 0);
      totalRevenue += Number(sale.revenueCents || 0); totalShiftCash += Number(sale.shiftCashExpenseCents || 0);
      totalCashOwner += Number(sale.cashToOwnerCents || 0);
    }
    rows.push(`<details>
      <summary>${escapeHtml(formatThaiDate(date))} — ${sale?.storeStatus === 'closed' ? 'หยุดร้าน' : sale?.status === 'final' ? money(sale.revenueCents) : 'ยังไม่มีบันทึกจริง'}</summary>
      ${sale?.storeStatus === 'closed' ? '<p><strong>หยุดร้าน</strong></p>' : `
      <div class="grid two">
        <div><strong>ครัว (ทำงานทั้งวัน)</strong><p>${escapeHtml(kitchen.join(', ') || '-')}</p></div>
        <div><strong>หน้าร้าน (ทำงานทั้งวัน)</strong><p>${escapeHtml(front.join(', ') || '-')}</p></div>
      </div>
      <div class="metric-grid">
        <div class="metric"><span>อาหาร</span><strong>${sale?.status === 'final' ? money(sale.foodCents) : '-'}</strong></div>
        <div class="metric"><span>เครื่องดื่ม</span><strong>${sale?.status === 'final' ? money(sale.beverageCents) : '-'}</strong></div>
        <div class="metric"><span>รายได้รวม</span><strong>${sale?.status === 'final' ? money(sale.revenueCents) : '-'}</strong></div>
        <div class="metric"><span>รายจ่ายหักเงินสดจริง</span><strong>${sale?.status === 'final' ? money(sale.shiftCashExpenseCents) : '-'}</strong></div>
        <div class="metric"><span>เงินสดให้เจ้าของ</span><strong>${sale?.status === 'final' ? money(sale.cashToOwnerCents) : '-'}</strong></div>
      </div>`}
    </details>`);
  }
  const previousMonth = (() => { const [y,m] = currentMonthKey().split('-').map(Number); const d = new Date(y,m-2,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
  setPageHtml(`
    <section class="card">
      <div class="grid two">
        <div><label for="monthly-month">เดือน</label><input id="monthly-month" type="month" value="${month}" ${LOWER_ROLES.includes(state.user.role) ? `min="${previousMonth}" max="${currentMonthKey()}"` : ''}></div>
        <div class="button-row end"><button id="expand-all-month" class="secondary" type="button">แสดงรายละเอียดทั้งหมด</button><button id="collapse-all-month" class="secondary" type="button">ซ่อนรายละเอียดทั้งหมด</button></div>
      </div>
    </section>
    <section class="card">
      <h2>ยอดรวมทั้งเดือน</h2>
      <div class="metric-grid">
        <div class="metric"><span>ยอดอาหาร</span><strong>${money(totalFood)}</strong></div>
        <div class="metric"><span>ยอดเครื่องดื่ม</span><strong>${money(totalBeverage)}</strong></div>
        <div class="metric"><span>รายได้รวม</span><strong>${money(totalRevenue)}</strong></div>
        <div class="metric"><span>รายจ่ายหักเงินสดจริง</span><strong>${money(totalShiftCash)}</strong></div>
        <div class="metric"><span>เงินสดให้เจ้าของ</span><strong>${money(totalCashOwner)}</strong></div>
      </div>
    </section>
    <section class="card"><h2>รายวัน</h2>${rows.join('')}</section>
  `);
  $('#monthly-month').addEventListener('change', () => renderMonthlyPage($('#monthly-month').value));
  $('#expand-all-month').addEventListener('click', () => $$('details','#page-root').forEach((item) => item.open = true));
  $('#collapse-all-month').addEventListener('click', () => $$('details','#page-root').forEach((item) => item.open = false));
}
async function renderAdvancesPage(selectedMonth = null) {
  const month = selectedMonth || $('#advance-month')?.value || currentMonthKey();
  const admin = isRole(ROLE.OWNER, ROLE.MANAGER);
  if (!admin && !state.user.canUseAdvance) throw new Error('เจ้าของยังไม่ได้เปิดสิทธิ์เบิกเงินล่วงหน้าให้บัญชีนี้');
  pageHeading('เบิกเงินล่วงหน้า', admin ? 'ดูและจัดการรายการของทุกคน' : 'คุณเห็นเฉพาะรายการของตัวเอง');
  const constraints = [F.where('monthKey','==',month)];
  if (!admin) constraints.push(F.where('userId','==',state.user.id));
  const [rows, users] = await Promise.all([
    getCollectionData('salaryAdvances', constraints), admin ? getCollectionData('users') : Promise.resolve([state.user])
  ]);
  const activeUsers = users.filter((u) => u.active !== false && LOWER_ROLES.includes(u.role));
  const userMap = Object.fromEntries(users.map((u) => [u.id,u]));
  rows.sort((a,b) => b.date.localeCompare(a.date));
  setPageHtml(`
    <section class="card">
      <h2 id="advance-form-title">เพิ่มรายการ</h2>
      <form id="advance-form">
        <input id="advance-edit-id" type="hidden">
        <div class="grid ${admin ? 'three' : 'two'}">
          ${admin ? `<div><label for="advance-user">พนักงาน</label><select id="advance-user">${activeUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.displayName)} — ${escapeHtml(ROLE_LABELS[u.role])}</option>`).join('')}</select></div>` : ''}
          <div><label for="advance-date">วันที่</label><input id="advance-date" type="date" value="${dateToday()}" required></div>
          <div><label for="advance-amount">จำนวนเงิน</label><input id="advance-amount" type="number" min="0.01" step="0.01" required></div>
        </div>
        <label for="advance-note">หมายเหตุ</label><textarea id="advance-note" maxlength="800"></textarea>
        <div class="button-row"><button class="primary" data-write-action type="submit">บันทึก</button><button id="cancel-advance-edit" class="secondary hidden" type="button">ยกเลิกแก้ไข</button></div>
        <p id="advance-message" class="form-message"></p>
      </form>
    </section>
    <section class="card">
      <div class="grid two"><div><label for="advance-month">เดือน</label><input id="advance-month" type="month" value="${month}"></div><div class="metric"><span>รวมเดือนนี้</span><strong>${money(sumCents(rows.filter(r => !r.deleted).map(r => r.amountCents)))}</strong></div></div>
      <div class="table-wrap"><table><thead><tr><th>วันที่</th>${admin?'<th>พนักงาน</th>':''}<th>จำนวน</th><th>หมายเหตุ</th><th>จัดการ</th></tr></thead>
      <tbody>${rows.filter(r=>!r.deleted).map((row) => `<tr>
        <td>${escapeHtml(formatThaiDate(row.date,false))}</td>${admin?`<td>${escapeHtml(userMap[row.userId]?.displayName || row.userId)}</td>`:''}
        <td>${money(row.amountCents)}</td><td>${escapeHtml(row.note || '-')}</td>
        <td class="actions"><button class="secondary small" data-edit-advance="${row.id}" type="button">แก้ไข</button><button class="danger small" data-delete-advance="${row.id}" data-write-action type="button">ลบ</button></td>
      </tr>`).join('') || `<tr><td colspan="5">ยังไม่มีรายการ</td></tr>`}</tbody></table></div>
    </section>
  `);
  $('#advance-month').addEventListener('change', () => renderAdvancesPage($('#advance-month').value));
  const resetForm = () => {
    $('#advance-form').reset(); $('#advance-edit-id').value = ''; $('#advance-date').value = dateToday();
    $('#advance-form-title').textContent = 'เพิ่มรายการ'; $('#cancel-advance-edit').classList.add('hidden');
  };
  $('#cancel-advance-edit').addEventListener('click', resetForm);
  $$('[data-edit-advance]').forEach((button) => button.addEventListener('click', () => {
    const row = rows.find((item) => item.id === button.dataset.editAdvance);
    $('#advance-edit-id').value = row.id; if (admin) $('#advance-user').value = row.userId;
    $('#advance-date').value = row.date; $('#advance-amount').value = fromCents(row.amountCents); $('#advance-note').value = row.note || '';
    $('#advance-form-title').textContent = 'แก้ไขรายการ'; $('#cancel-advance-edit').classList.remove('hidden');
    window.scrollTo({top:0,behavior:'smooth'});
  }));
  $$('[data-delete-advance]').forEach((button) => button.addEventListener('click', async () => {
    const row = rows.find((item) => item.id === button.dataset.deleteAdvance);
    const ok = await confirmAction('ลบรายการเบิกเงิน', `ลบ ${money(row.amountCents)} วันที่ ${formatThaiDate(row.date,false)} หรือไม่`);
    if (!ok) return;
    try {
      await writeWithAudit({
        writes:[{collection:'salaryAdvances',id:row.id,type:'update',data:{deleted:true,deletedAt:F.serverTimestamp(),deletedBy:state.user.id,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],
        audit:{action:'soft-delete',area:'salaryAdvances',targetId:row.id,before:row,after:{...row,deleted:true}}
      });
      toast('ลบรายการแล้ว ประวัติยังคงอยู่','success'); await renderAdvancesPage(month);
    } catch(error){toast(friendlyError(error),'error');}
  }));
  $('#advance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const editId = $('#advance-edit-id').value;
    const userId = admin ? $('#advance-user').value : state.user.id;
    const date = $('#advance-date').value;
    const amountCents = toCents($('#advance-amount').value);
    if (!userId || !date || amountCents <= 0) { $('#advance-message').textContent='กรอกข้อมูลให้ครบและจำนวนเงินต้องมากกว่า 0'; return; }
    const id = editId || F.doc(F.collection(db,'salaryAdvances')).id;
    const before = rows.find((r)=>r.id===id) || null;
    const data = { userId,date,monthKey:monthKeyFromDate(date),monthOrdinal:monthOrdinalFromDate(date),amountCents,note:$('#advance-note').value.trim(),deleted:false,updatedAt:F.serverTimestamp(),updatedBy:state.user.id,createdAt:before?.createdAt||F.serverTimestamp(),createdBy:before?.createdBy||state.user.id };
    try {
      await writeWithAudit({writes:[{collection:'salaryAdvances',id,data}],audit:{action:before?'update':'create',area:'salaryAdvances',targetId:id,before,after:data}});
      toast('บันทึกรายการเบิกเงินแล้ว','success'); await renderAdvancesPage(month);
    } catch(error){$('#advance-message').textContent=friendlyError(error);}
  });
}
async function loadCompensationData(month) {
  const { start, end } = monthRange(month);
  const [allUsers, profiles, attendance, sales, advances, records, monthSettings] = await Promise.all([
    getCollectionData('users'), getCollectionData('payrollProfiles'),
    getCollectionData('attendance',[F.where('monthKey','==',month)]),
    getCollectionData('dailySales',[F.where('monthKey','==',month)]),
    getCollectionData('salaryAdvances',[F.where('monthKey','==',month)]),
    getCollectionData('compensationRecords',[F.where('monthKey','==',month)]),
    getDocData('compensationMonthSettings',month)
  ]);
  const users = allUsers.filter((u) => LOWER_ROLES.includes(u.role) && (!u.startDate || u.startDate <= end) && (!u.endDate || u.endDate >= start));
  const profileMap = Object.fromEntries(profiles.map((p)=>[p.id,p]));
  const recordMap = Object.fromEntries(records.map((r)=>[r.userId,r]));
  const calcSettings = monthSettings?.status === 'finalized' ? monthSettings.settingsSnapshot : state.settings;
  const calculation = calculateCompensationMonth({ users, profiles:profileMap, attendance, sales, advances, recordDrafts:recordMap, settings:calcSettings });
  return { users,profiles:profileMap,attendance,sales,advances,records,recordMap,monthSettings,calcSettings,calculation };
}

function compRecordDisplay(record) {
  return {
    ...record,
    displayName: record.displayName || '-', role: record.role || '', profile: record.profile || record.profileSnapshot || {}, draft: record.draft || record.adjustments || {},
    additionsCents:Number(record.additionsCents||0), outsideOtCents:Number(record.outsideOtCents||0), deductionsCents:Number(record.deductionsCents||0)
  };
}

async function renderCompensationPage(selectedMonth = null) {
  const month = selectedMonth || $('#comp-month')?.value || currentMonthKey();
  pageHeading('ค่าตอบแทน', 'เงินเดือน รายวัน โบนัส OT เงินเบิก และประกันสังคม — คำนวณจากฟังก์ชันกลาง');
  const data = await loadCompensationData(month);
  const finalized = data.monthSettings?.status === 'finalized';
  const displayRecords = finalized ? data.records.map(compRecordDisplay) : data.calculation.records;
  state.currentCompensation = { month, data, displayRecords };
  const totalTransfer = sumCents(displayRecords.map((r)=>r.transferCents));
  const totalCost = sumCents(displayRecords.map((r)=>r.shopCostCents));
  const dailyAttendance = data.attendance.filter((a)=>a.role===ROLE.DAILY && ['full_day','hourly'].includes(a.status));
  setPageHtml(`
    <section class="card">
      <div class="grid three">
        <div><label for="comp-month">เดือน</label><input id="comp-month" type="month" value="${month}" ${finalized?'disabled':''}></div>
        <div class="metric"><span>ยอดโอนปลายเดือนรวม</span><strong>${money(totalTransfer)}</strong></div>
        <div class="metric"><span>ต้นทุนค่าตอบแทนร้านรวม</span><strong>${money(totalCost)}</strong></div>
      </div>
      <p>${finalized?'<span class="badge final">Finalized — ใช้ snapshot เดิม</span>':'<span class="badge draft">Draft — ยังแก้เรทและรายการได้</span>'}</p>
      <p class="help">เงินเบิกล่วงหน้าเป็นการจ่ายล่วงหน้า จึงหักจากยอดโอน แต่ไม่หักซ้ำจากต้นทุนร้าน</p>
      <div class="button-row">
        ${!finalized?'<button id="finalize-comp" class="primary" data-write-action type="button">Finalize เดือนนี้</button>':''}
        ${finalized&&isRole(ROLE.OWNER)?'<button id="reopen-comp" class="danger" data-write-action type="button">เปิดแก้เดือนนี้</button>':''}
      </div>
    </section>
    ${dailyAttendance.length?`<section class="card"><h2>รายวัน: ทำเครื่องหมาย “จ่ายให้แล้ว”</h2><div class="list">${dailyAttendance.sort((a,b)=>a.date.localeCompare(b.date)).map((a)=>{
      const user=data.users.find(u=>u.id===a.userId); return `<label class="list-item check-row"><input data-paid-attendance="${a.id}" type="checkbox" ${a.paid?'checked':''} ${finalized?'disabled':''}> ${escapeHtml(user?.displayName||a.userId)} — ${escapeHtml(formatThaiDate(a.date,false))} — ${a.status==='full_day'?'ทั้งวัน':`${calculateHours(a.startMinutes,a.endMinutes)} ชั่วโมง`} — จ่ายให้แล้ว</label>`;
    }).join('')}</div></section>`:''}
    <section class="card"><h2>รายการแต่ละคน</h2><div class="table-wrap"><table>
      <thead><tr><th>พนักงาน</th><th>ฐาน/ค่าจ้าง</th><th>OT</th><th>โบนัส</th><th>เพิ่ม/OT นอกเวลา/หัก</th><th>เบิก/ปกส.</th><th>ยอดโอน</th><th>PDF</th></tr></thead>
      <tbody>${displayRecords.map((r)=>`<tr data-comp-row="${r.userId}">
        <td><strong>${escapeHtml(r.displayName)}</strong><br><span class="muted">${escapeHtml(ROLE_LABELS[r.role]||r.role)}</span><br><span class="muted">${escapeHtml(r.profile?.bankName||'ไม่ระบุธนาคาร')} ${escapeHtml(r.profile?.bankAccount||'')}</span></td>
        <td>${r.role===ROLE.DAILY?`ค่าจ้างทั้งหมด ${money(r.allDailyWagesCents)}<br>จ่ายแล้ว ${money(r.paidDailyWagesCents)}<br>ค้างโอน ${money(r.unpaidDailyWagesCents)}`:money(r.basePayCents)}</td>
        <td>${money(r.otCents)}<br><span class="muted">${Number(r.otMinutes||0)/60} ชม.</span></td>
        <td>รายวัน ${money(r.dailyBonusCents)}<br>รายเดือน ${money(r.monthlyBonusCents)}<br>เบียร์ ${money(r.beerBonusCents)}</td>
        <td>${finalized?`เพิ่ม ${money(r.additionsCents)}<br>OT นอก ${money(r.outsideOtCents)}<br>หัก ${money(r.deductionsCents)}`:`
          <label>เพิ่มอื่น ๆ<input data-comp-add="${r.userId}" type="number" min="0" step="0.01" value="${fromCents(r.additionsCents)}"></label>
          <input data-comp-add-note="${r.userId}" placeholder="รายละเอียดเพิ่ม" value="${escapeAttr(r.draft?.additionsNote||'')}">
          <label>OT นอกเวลา<input data-comp-outside="${r.userId}" type="number" min="0" step="0.01" value="${fromCents(r.outsideOtCents)}"></label>
          <input data-comp-outside-note="${r.userId}" placeholder="รายละเอียด OT นอก" value="${escapeAttr(r.draft?.outsideOtNote||'')}">
          <label>รายการหัก<input data-comp-deduct="${r.userId}" type="number" min="0" step="0.01" value="${fromCents(r.deductionsCents)}"></label>
          <input data-comp-deduct-note="${r.userId}" placeholder="รายละเอียดหัก" value="${escapeAttr(r.draft?.deductionsNote||'')}">
          <button class="secondary small" data-save-comp="${r.userId}" data-write-action type="button">บันทึกรายการเพิ่ม/หัก</button>`}</td>
        <td>เบิก ${money(r.advanceCents)}<br>ปกส.ลูกจ้าง ${money(r.employeeSocialSecurityCents)}</td>
        <td><strong>${money(r.transferCents)}</strong></td>
        <td><label class="check-row"><input data-bank-confirm="${r.userId}" type="checkbox"> ตรวจเลขบัญชีแล้ว</label><button class="secondary small" data-pdf="${r.userId}" type="button">ดาวน์โหลด PDF</button><button class="secondary small" data-share-pdf="${r.userId}" type="button">แชร์ PDF</button></td>
      </tr>`).join('')||'<tr><td colspan="8">ยังไม่มีพนักงานในเดือนนี้</td></tr>'}</tbody>
    </table></div></section>
  `);
  $('#comp-month')?.addEventListener('change',()=>renderCompensationPage($('#comp-month').value));
  $$('[data-paid-attendance]').forEach((cb)=>cb.addEventListener('change',async()=>{
    const row=data.attendance.find(a=>a.id===cb.dataset.paidAttendance); const old=Boolean(row.paid);
    try{await writeWithAudit({writes:[{collection:'attendance',id:row.id,type:'update',data:{paid:cb.checked,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'mark-paid',area:'attendance',targetId:row.id,before:{paid:old},after:{paid:cb.checked}}});toast('บันทึกสถานะจ่ายแล้ว','success');await renderCompensationPage(month);}catch(e){cb.checked=old;toast(friendlyError(e),'error');}
  }));
  $$('[data-save-comp]').forEach((button)=>button.addEventListener('click',async()=>{
    const uid=button.dataset.saveComp; const old=data.recordMap[uid]||null; const id=`${month}_${uid}`;
    const draft={additionsCents:toCents($(`[data-comp-add="${uid}"]`).value),additionsNote:$(`[data-comp-add-note="${uid}"]`).value.trim(),outsideOtCents:toCents($(`[data-comp-outside="${uid}"]`).value),outsideOtNote:$(`[data-comp-outside-note="${uid}"]`).value.trim(),deductionsCents:toCents($(`[data-comp-deduct="${uid}"]`).value),deductionsNote:$(`[data-comp-deduct-note="${uid}"]`).value.trim()};
    const docData={monthKey:month,monthOrdinal:monthOrdinal(month),userId:uid,status:'draft',...draft,updatedAt:F.serverTimestamp(),updatedBy:state.user.id};
    try{await writeWithAudit({writes:[{collection:'compensationRecords',id,data:docData,merge:true}],audit:{action:'save-adjustments',area:'compensationRecords',targetId:id,before:old,after:docData}});toast('บันทึกรายการเพิ่ม/หักแล้ว','success');await renderCompensationPage(month);}catch(e){toast(friendlyError(e),'error');}
  }));
  $('#finalize-comp')?.addEventListener('click',async()=>{
    const ok=await confirmAction('Finalize ค่าตอบแทน',`ล็อกค่าตอบแทนเดือน ${month} และเก็บ snapshot หรือไม่`);if(!ok)return;
    try{
      const latest=await loadCompensationData(month); const calc=latest.calculation;
      await F.runTransaction(db,async(tx)=>{
        const monthRef=F.doc(db,'compensationMonthSettings',month); const snap=await tx.get(monthRef); if(snap.exists()&&snap.data().status==='finalized')throw new Error('เดือนนี้ Finalized แล้วจากอุปกรณ์อื่น');
        for(const r of calc.records){const id=`${month}_${r.userId}`;tx.set(F.doc(db,'compensationRecords',id),{...serializeFirestore(r),monthKey:month,monthOrdinal:monthOrdinal(month),userId:r.userId,status:'finalized',profileSnapshot:r.profile,settingsSnapshot:serializeFirestore(latest.calcSettings),finalizedAt:F.serverTimestamp(),finalizedBy:state.user.id,updatedAt:F.serverTimestamp(),updatedBy:state.user.id});}
        tx.set(monthRef,{monthKey:month,status:'finalized',settingsSnapshot:serializeFirestore(latest.calcSettings),totals:calc.totals,finalizedAt:F.serverTimestamp(),finalizedBy:state.user.id,updatedAt:F.serverTimestamp(),updatedBy:state.user.id});
        tx.set(F.doc(F.collection(db,'auditLogs')),auditDoc({action:'finalize',area:'compensation',targetId:month,after:{status:'finalized',totals:calc.totals}}));
      });queueBackupAfterWrite();toast('Finalize ค่าตอบแทนแล้ว','success');await renderCompensationPage(month);
    }catch(e){toast(friendlyError(e),'error');}
  });
  $('#reopen-comp')?.addEventListener('click',async()=>{
    try{await requestReauth('กรอก PIN เจ้าของเพื่อเปิดแก้เดือนที่ Finalized');const ok=await confirmAction('เปิดแก้เดือน','ยอดเดือนเก่าอาจเปลี่ยนเมื่อคำนวณใหม่ ยืนยันหรือไม่');if(!ok)return;await writeWithAudit({writes:[{collection:'compensationMonthSettings',id:month,type:'update',data:{status:'draft',reopenedAt:F.serverTimestamp(),reopenedBy:state.user.id,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'reopen',area:'compensation',targetId:month,before:{status:'finalized'},after:{status:'draft'},reason:'เจ้าของเปิดแก้'}});toast('เปิดแก้เดือนแล้ว','success');await renderCompensationPage(month);}catch(e){if(!String(e.message).includes('ยกเลิก'))toast(friendlyError(e),'error');}
  });
  $$('[data-pdf],[data-share-pdf]').forEach((button)=>button.addEventListener('click',async()=>{
    const uid=button.dataset.pdf||button.dataset.sharePdf; const confirm=$(`[data-bank-confirm="${uid}"]`); if(!confirm.checked){toast('กรุณาตรวจเลขบัญชีและทำเครื่องหมายยืนยันก่อน','error');return;} const record=displayRecords.find(r=>r.userId===uid);try{await createCompensationPdf(record,month,Boolean(button.dataset.sharePdf));}catch(e){toast(friendlyError(e),'error');}
  }));
}

async function loadScriptOnce(url) {
  if (window.jspdf) return;
  await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.defer=true;s.onload=resolve;s.onerror=()=>reject(new Error('โหลดตัวสร้าง PDF ไม่สำเร็จ กรุณาต่ออินเทอร์เน็ต'));document.head.append(s);});
}

async function createCompensationPdf(record, month, share) {
  await loadScriptOnce(rendoConfig.pdfLibraryUrl);
  const canvas=document.createElement('canvas');canvas.width=1240;canvas.height=1754;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#111';ctx.font='bold 54px sans-serif';ctx.fillText('RENDO – RAMEN & GYOZA',80,110);ctx.font='34px sans-serif';ctx.fillText(`ใบสรุปค่าตอบแทน เดือน ${month}`,80,170);ctx.font='30px sans-serif';
  const lines=[`ชื่อ: ${record.displayName}`,`ตำแหน่ง: ${ROLE_LABELS[record.role]||record.role}`,`ธนาคาร: ${record.profile?.bankName||'-'}`,`เลขบัญชี: ${record.profile?.bankAccount||'-'}`,`ชื่อบัญชี: ${record.profile?.bankAccountName||'-'}`,'',`เงินเดือน/ค่าจ้างค้างโอน: ${money(record.role===ROLE.DAILY?record.unpaidDailyWagesCents:record.basePayCents)}`,`OT: ${money(record.otCents)}`,`เพิ่มอื่น ๆ: ${money(record.additionsCents)} ${record.draft?.additionsNote||''}`,`OT นอกเวลา: ${money(record.outsideOtCents)} ${record.draft?.outsideOtNote||''}`,`โบนัสรายวัน: ${money(record.dailyBonusCents)}`,`โบนัสรายเดือน: ${money(record.monthlyBonusCents)}`,`โบนัสเบียร์: ${money(record.beerBonusCents)}`,`รายการหัก: ${money(record.deductionsCents)} ${record.draft?.deductionsNote||''}`,`เงินเบิกล่วงหน้า: ${money(record.advanceCents)}`,`ประกันสังคมฝ่ายลูกจ้าง: ${money(record.employeeSocialSecurityCents)}`,'',`ยอดที่ต้องโอนเงินที่เหลือปลายเดือน: ${money(record.transferCents)}`];
  let y=250;for(const line of lines){if(line.startsWith('ยอดที่ต้อง'))ctx.font='bold 38px sans-serif';else ctx.font='30px sans-serif';ctx.fillText(line,80,y);y+=62;}ctx.font='24px sans-serif';ctx.fillStyle='#555';ctx.fillText(`สร้างจาก Rendo v1.0 เมื่อ ${new Date().toLocaleString('th-TH')}`,80,1680);
  const {jsPDF}=window.jspdf;const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});pdf.addImage(canvas.toDataURL('image/jpeg',.92),'JPEG',0,0,210,297);const blob=pdf.output('blob');const filename=`Rendo_${month}_${record.displayName.replace(/[^\p{L}\p{N}._-]+/gu,'_')}.pdf`;const file=new File([blob],filename,{type:'application/pdf'});
  if(share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:`ค่าตอบแทน ${record.displayName} ${month}`,text:'ใบสรุปค่าตอบแทน Rendo'});return;}
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);if(share)toast('อุปกรณ์นี้แชร์ไฟล์โดยตรงไม่ได้ จึงดาวน์โหลด PDF ให้แทน','success');
}
async function ensureRecurringSnapshots(month) {
  let snapshots=await getCollectionData('recurringExpenseSnapshots',[F.where('monthKey','==',month)]);
  if(snapshots.length||!navigator.onLine)return snapshots;
  const templates=(await getCollectionData('recurringExpenses')).filter(r=>!r.deleted);
  if(!templates.length)return [];
  const batch=F.writeBatch(db);
  for(const t of templates){const id=`${month}_${t.id}`;const day=Math.min(28,Math.max(1,Number(t.dayOfMonth||1)));batch.set(F.doc(db,'recurringExpenseSnapshots',id),{monthKey:month,monthOrdinal:monthOrdinal(month),templateId:t.id,name:t.name,amountCents:t.amountCents,dayOfMonth:day,date:`${month}-${String(day).padStart(2,'0')}`,sortOrder:t.sortOrder||0,deleted:false,createdAt:F.serverTimestamp(),createdBy:state.user.id});}
  batch.set(F.doc(F.collection(db,'auditLogs')),auditDoc({action:'carry-forward',area:'recurringExpenseSnapshots',targetId:month,after:{count:templates.length}}));await batch.commit();queueBackupAfterWrite();
  return getCollectionData('recurringExpenseSnapshots',[F.where('monthKey','==',month)]);
}

async function renderExpensesPage(selectedMonth=null){
  const month=selectedMonth||$('#expense-month')?.value||currentMonthKey();pageHeading('ลงรายจ่าย','แบบฟอร์มอยู่ด้านบน ตารางเรียงอัตโนมัติและใช้รหัสรายการคงที่');
  const [templates,snapshots,ownerRows,compRecords]=await Promise.all([getCollectionData('recurringExpenses'),ensureRecurringSnapshots(month),getCollectionData('ownerExpenses',[F.where('monthKey','==',month)]),getCollectionData('compensationRecords',[F.where('monthKey','==',month)])]);
  const activeTemplates=templates.filter(r=>!r.deleted).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)||a.name.localeCompare(b.name,'th'));
  const activeSnapshots=snapshots.filter(r=>!r.deleted);const rows=ownerRows.filter(r=>!r.deleted).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)||b.date.localeCompare(a.date));
  const salaryCost=sumCents(compRecords.filter(r=>r.status==='finalized').map(r=>r.shopCostCents));const recurringTotal=sumCents(activeSnapshots.map(r=>r.amountCents));const otherTotal=sumCents(rows.map(r=>r.amountCents));
  setPageHtml(`
  <section class="card"><h2>เพิ่มรายจ่ายอื่น</h2><form id="owner-expense-form"><input id="owner-expense-id" type="hidden"><div class="grid three"><div><label for="owner-expense-name">ชื่อรายการ</label><input id="owner-expense-name" required maxlength="140"></div><div><label for="owner-expense-date">วันที่</label><input id="owner-expense-date" type="date" value="${dateToday()}" required></div><div><label for="owner-expense-amount">จำนวนเงิน</label><input id="owner-expense-amount" type="number" min="0.01" step="0.01" required></div></div><label for="owner-expense-note">หมายเหตุ</label><textarea id="owner-expense-note" maxlength="800"></textarea><div class="button-row"><button class="primary" data-write-action type="submit">บันทึกรายจ่าย</button><button id="cancel-owner-expense" class="secondary hidden" type="button">ยกเลิกแก้ไข</button></div></form></section>
  <section class="card"><h2>เพิ่มรายจ่ายประจำ</h2><form id="recurring-form"><input id="recurring-id" type="hidden"><div class="grid three"><div><label for="recurring-name">ชื่อรายการ</label><input id="recurring-name" maxlength="140" required></div><div><label for="recurring-amount">จำนวนเงินต่อเดือน</label><input id="recurring-amount" type="number" min="0.01" step="0.01" required></div><div><label for="recurring-day">วันที่จ่ายของเดือน (1–28)</label><input id="recurring-day" type="number" min="1" max="28" value="1" required></div></div><div class="button-row"><button class="primary" data-write-action type="submit">บันทึกรายจ่ายประจำ</button><button id="cancel-recurring" class="secondary hidden" type="button">ยกเลิกแก้ไข</button></div><p class="help">รายการประจำถูก snapshot แยกแต่ละเดือน การแก้ค่าปัจจุบันไม่เปลี่ยนเดือนเก่า</p></form></section>
  <section class="card"><div class="grid four"><div><label for="expense-month">เดือน</label><input id="expense-month" type="month" value="${month}"></div><div class="metric"><span>ค่าตอบแทนพนักงานรวม ปกส.นายจ้าง</span><strong>${money(salaryCost)}</strong></div><div class="metric"><span>รายจ่ายประจำอื่น</span><strong>${money(recurringTotal)}</strong></div><div class="metric"><span>รายจ่ายอื่นที่ลงเอง</span><strong>${money(otherTotal)}</strong></div></div><p class="help">รายจ่ายระหว่างกะไม่ถูกนับซ้ำในหน้านี้</p></section>
  <section class="card"><h2>แม่แบบรายจ่ายประจำ</h2><div class="table-wrap"><table><thead><tr><th>ลำดับ</th><th>รายการ</th><th>จำนวน</th><th>วันที่จ่าย</th><th>จัดการ</th></tr></thead><tbody>${activeTemplates.map((r,i)=>`<tr><td><button class="secondary small" data-move-rec="${r.id}" data-dir="up" ${i===0?'disabled':''}>↑</button><button class="secondary small" data-move-rec="${r.id}" data-dir="down" ${i===activeTemplates.length-1?'disabled':''}>↓</button></td><td>${escapeHtml(r.name)}</td><td>${money(r.amountCents)}</td><td>${r.dayOfMonth||1}</td><td><button class="secondary small" data-edit-rec="${r.id}">แก้ไข</button><button class="danger small" data-delete-rec="${r.id}" data-write-action>ลบ</button></td></tr>`).join('')||'<tr><td colspan="5">ยังไม่มีรายการ</td></tr>'}</tbody></table></div></section>
  <section class="card"><h2>รายจ่ายอื่นในเดือนนี้</h2><div class="table-wrap"><table><thead><tr><th>ลำดับ</th><th>วันที่</th><th>รายการ</th><th>จำนวน</th><th>หมายเหตุ</th><th>จัดการ</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td><button class="secondary small" data-move-exp="${r.id}" data-dir="up" ${i===0?'disabled':''}>↑</button><button class="secondary small" data-move-exp="${r.id}" data-dir="down" ${i===rows.length-1?'disabled':''}>↓</button></td><td>${escapeHtml(formatThaiDate(r.date,false))}</td><td>${escapeHtml(r.name)}</td><td>${money(r.amountCents)}</td><td>${escapeHtml(r.note||'-')}</td><td><button class="secondary small" data-edit-exp="${r.id}">แก้ไข</button><button class="danger small" data-delete-exp="${r.id}" data-write-action>ลบ</button></td></tr>`).join('')||'<tr><td colspan="6">ยังไม่มีรายการ</td></tr>'}</tbody></table></div></section>`);
  $('#expense-month').addEventListener('change',()=>renderExpensesPage($('#expense-month').value));
  const resetExp=()=>{$('#owner-expense-form').reset();$('#owner-expense-id').value='';$('#owner-expense-date').value=dateToday();$('#cancel-owner-expense').classList.add('hidden');};$('#cancel-owner-expense').onclick=resetExp;
  $$('[data-edit-exp]').forEach(b=>b.onclick=()=>{const r=rows.find(x=>x.id===b.dataset.editExp);$('#owner-expense-id').value=r.id;$('#owner-expense-name').value=r.name;$('#owner-expense-date').value=r.date;$('#owner-expense-amount').value=fromCents(r.amountCents);$('#owner-expense-note').value=r.note||'';$('#cancel-owner-expense').classList.remove('hidden');window.scrollTo({top:0,behavior:'smooth'});});
  $('#owner-expense-form').onsubmit=async(e)=>{e.preventDefault();const edit=$('#owner-expense-id').value;const id=edit||F.doc(F.collection(db,'ownerExpenses')).id;const before=rows.find(r=>r.id===id)||null;const date=$('#owner-expense-date').value;const data={name:$('#owner-expense-name').value.trim(),date,monthKey:monthKeyFromDate(date),monthOrdinal:monthOrdinalFromDate(date),amountCents:toCents($('#owner-expense-amount').value),note:$('#owner-expense-note').value.trim(),sortOrder:before?.sortOrder??Date.now(),deleted:false,updatedAt:F.serverTimestamp(),updatedBy:state.user.id,createdAt:before?.createdAt||F.serverTimestamp(),createdBy:before?.createdBy||state.user.id};if(!data.name||data.amountCents<=0)return toast('กรอกชื่อและจำนวนเงินให้ถูกต้อง','error');try{await writeWithAudit({writes:[{collection:'ownerExpenses',id,data}],audit:{action:before?'update':'create',area:'ownerExpenses',targetId:id,before,after:data}});toast('บันทึกรายจ่ายแล้ว','success');await renderExpensesPage(month);}catch(err){toast(friendlyError(err),'error');}};
  $$('[data-delete-exp]').forEach(b=>b.onclick=async()=>{const r=rows.find(x=>x.id===b.dataset.deleteExp);if(!await confirmAction('ลบรายจ่าย',`ลบ ${r.name} หรือไม่`))return;await writeWithAudit({writes:[{collection:'ownerExpenses',id:r.id,type:'update',data:{deleted:true,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'soft-delete',area:'ownerExpenses',targetId:r.id,before:r,after:{...r,deleted:true}}});await renderExpensesPage(month);});
  const resetRec=()=>{$('#recurring-form').reset();$('#recurring-id').value='';$('#recurring-day').value=1;$('#cancel-recurring').classList.add('hidden');};$('#cancel-recurring').onclick=resetRec;
  $$('[data-edit-rec]').forEach(b=>b.onclick=()=>{const r=activeTemplates.find(x=>x.id===b.dataset.editRec);$('#recurring-id').value=r.id;$('#recurring-name').value=r.name;$('#recurring-amount').value=fromCents(r.amountCents);$('#recurring-day').value=r.dayOfMonth||1;$('#cancel-recurring').classList.remove('hidden');window.scrollTo({top:0,behavior:'smooth'});});
  $('#recurring-form').onsubmit=async(e)=>{e.preventDefault();const edit=$('#recurring-id').value;const id=edit||F.doc(F.collection(db,'recurringExpenses')).id;const before=activeTemplates.find(r=>r.id===id)||null;const data={name:$('#recurring-name').value.trim(),amountCents:toCents($('#recurring-amount').value),dayOfMonth:Math.min(28,Math.max(1,Number($('#recurring-day').value))),sortOrder:before?.sortOrder??Date.now(),deleted:false,updatedAt:F.serverTimestamp(),updatedBy:state.user.id,createdAt:before?.createdAt||F.serverTimestamp(),createdBy:before?.createdBy||state.user.id};if(!data.name||data.amountCents<=0)return toast('กรอกข้อมูลให้ถูกต้อง','error');await writeWithAudit({writes:[{collection:'recurringExpenses',id,data}],audit:{action:before?'update':'create',area:'recurringExpenses',targetId:id,before,after:data}});toast('บันทึกรายจ่ายประจำแล้ว มีผลเป็นค่าเริ่มต้นเดือนถัดไป','success');await renderExpensesPage(month);};
  $$('[data-delete-rec]').forEach(b=>b.onclick=async()=>{const r=activeTemplates.find(x=>x.id===b.dataset.deleteRec);if(!await confirmAction('ลบแม่แบบ',`ลบ ${r.name} หรือไม่ เดือนเก่าจะไม่เปลี่ยน`))return;await writeWithAudit({writes:[{collection:'recurringExpenses',id:r.id,type:'update',data:{deleted:true,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'soft-delete',area:'recurringExpenses',targetId:r.id,before:r,after:{...r,deleted:true}}});await renderExpensesPage(month);});
  async function swap(collectionName,list,id,dir){const i=list.findIndex(r=>r.id===id);const j=dir==='up'?i-1:i+1;if(i<0||j<0||j>=list.length)return;const a=list[i],b=list[j],aOrder=a.sortOrder||i,bOrder=b.sortOrder||j;await writeWithAudit({writes:[{collection:collectionName,id:a.id,type:'update',data:{sortOrder:bOrder,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}},{collection:collectionName,id:b.id,type:'update',data:{sortOrder:aOrder,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'reorder',area:collectionName,targetId:`${a.id}_${b.id}`,before:{[a.id]:aOrder,[b.id]:bOrder},after:{[a.id]:bOrder,[b.id]:aOrder}}});await renderExpensesPage(month);}
  $$('[data-move-rec]').forEach(b=>b.onclick=()=>swap('recurringExpenses',activeTemplates,b.dataset.moveRec,b.dataset.dir));$$('[data-move-exp]').forEach(b=>b.onclick=()=>swap('ownerExpenses',rows,b.dataset.moveExp,b.dataset.dir));
}
async function renderDashboardPage(){
  pageHeading('Dashboard','ตัวเลขจากยอด Final เท่านั้น พร้อมสูตรและช่วงวันที่ชัดเจน');
  const mode=$('#dash-mode')?.value||'month';const selectedMonth=$('#dash-month')?.value||currentMonthKey();const mr=monthRange(selectedMonth);const start=mode==='range'?($('#dash-start')?.value||mr.start):mr.start;const end=mode==='range'?($('#dash-end')?.value||mr.end):mr.end;if(end<start)throw new Error('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม');
  const startMonth=start.slice(0,7),endMonth=end.slice(0,7);const [sales,ownerExpenses,recurring,comp]=await Promise.all([
    getCollectionData('dailySales',[F.where('date','>=',start),F.where('date','<=',end)]),
    getCollectionData('ownerExpenses',[F.where('date','>=',start),F.where('date','<=',end)]),
    getCollectionData('recurringExpenseSnapshots',[F.where('date','>=',start),F.where('date','<=',end)]),
    getCollectionData('compensationRecords',[F.where('monthOrdinal','>=',monthOrdinal(startMonth)),F.where('monthOrdinal','<=',monthOrdinal(endMonth))])
  ]);
  const result=calculateDashboard({sales,ownerExpenses,recurringExpenses:recurring,compensationRecords:comp,grossMarginRate:state.settings.grossMarginRate});const items=[['รายได้รวม',result.revenueCents],['หลังต้นทุนสินค้าโดยประมาณ',result.estimatedAfterProductCostCents],['รายจ่ายระหว่างกะ',result.shiftExpenseCents],['รายจ่ายหน้าลงรายจ่าย',result.ownerExpenseCents],['รายได้หลังหักค่าใช้จ่าย',result.afterExpensesCents]];const max=Math.max(1,...items.map(x=>Math.abs(x[1])));
  setPageHtml(`<section class="card"><div class="grid four"><div><label for="dash-mode">รูปแบบช่วง</label><select id="dash-mode"><option value="month" ${mode==='month'?'selected':''}>เลือกเดือน</option><option value="range" ${mode==='range'?'selected':''}>กำหนดวันเริ่ม–สิ้นสุด</option></select></div><div id="dash-month-field" class="${mode==='range'?'hidden':''}"><label for="dash-month">เดือน</label><input id="dash-month" type="month" value="${selectedMonth}"></div><div id="dash-start-field" class="${mode==='month'?'hidden':''}"><label for="dash-start">เริ่ม</label><input id="dash-start" type="date" value="${start}"></div><div id="dash-end-field" class="${mode==='month'?'hidden':''}"><label for="dash-end">สิ้นสุด</label><input id="dash-end" type="date" value="${end}"></div></div><p><strong>ช่วงที่ใช้:</strong> ${escapeHtml(formatThaiDate(start,false))} ถึง ${escapeHtml(formatThaiDate(end,false))}</p></section>
  <section class="card"><div class="metric-grid"><div class="metric"><span>รายได้รวม</span><strong>${money(result.revenueCents)}</strong></div><div class="metric"><span>รายจ่ายระหว่างกะทั้งหมด</span><strong>${money(result.shiftExpenseCents)}</strong></div><div class="metric"><span>รายจ่ายเจ้าของ/ผู้จัดการลง รวมรายจ่ายประจำและต้นทุนค่าตอบแทน Finalized</span><strong>${money(result.ownerExpenseCents)}</strong></div><div class="metric"><span>เงินสดให้เจ้าของ</span><strong>${money(result.cashToOwnerCents)}</strong></div><div class="metric ${result.afterExpensesCents<0?'negative':'positive'}"><span>รายได้หลังหักค่าใช้จ่าย</span><strong>${money(result.afterExpensesCents)}</strong></div></div><p class="formula">รายได้หลังหักค่าใช้จ่าย = รายได้รวม × ${(Number(state.settings.grossMarginRate||.4)*100).toFixed(2)}% − รายจ่ายระหว่างกะ − รายจ่ายหน้าลงรายจ่าย</p><p class="help">${(Number(state.settings.grossMarginRate||.4)*100).toFixed(2)}% คือ “สัดส่วนรายได้หลังหักต้นทุนสินค้าโดยประมาณ” ไม่ใช่ภาษีหรือกำไรสุทธิทางบัญชี ค่าตอบแทนใช้ยอด Finalized ของเดือนที่เกี่ยวข้อง; ช่วงวันบางส่วนอาจรวมค่าตอบแทนเต็มเดือน จึงควรใช้มุมมองเดือนเมื่อต้องการเทียบรายเดือน</p></section>
  <section class="card"><h2>กราฟเปรียบเทียบ</h2><div class="chart">${items.map(([label,value])=>`<div class="chart-row"><span>${escapeHtml(label)}</span><div class="chart-bar"><span style="width:${Math.max(0,Math.abs(value)/max*100)}%"></span></div><strong>${money(value)}</strong></div>`).join('')}</div></section>`);
  const rerender=()=>renderDashboardPage();$('#dash-mode').onchange=rerender;$('#dash-month')?.addEventListener('change',rerender);$('#dash-start')?.addEventListener('change',rerender);$('#dash-end')?.addEventListener('change',rerender);
}
async function renderAuditPage(){
  pageHeading('ประวัติ','บันทึก create, update, draft, finalize, soft-delete, restore และการตั้งค่า');
  const constraints=isRole(ROLE.OWNER)?[F.orderBy('createdAt','desc'),F.limit(200)]:[F.where('hidden','==',false),F.orderBy('createdAt','desc'),F.limit(200)];
  const rows=await getCollectionData('auditLogs',constraints);
  setPageHtml(`<section class="card"><div class="grid four"><div><label for="audit-date">วันที่</label><input id="audit-date" type="date"></div><div><label for="audit-user">ผู้ทำ</label><input id="audit-user" placeholder="ชื่อหรือรหัส"></div><div><label for="audit-action">ประเภท</label><input id="audit-action" placeholder="create / update / ..."></div><div><label for="audit-search">ค้นหาข้อความ</label><input id="audit-search" placeholder="หน้า เอกสาร เหตุผล"></div></div><p class="help">แสดงล่าสุดไม่เกิน 200 รายการเพื่อให้โหลดเร็ว</p></section><section class="card"><div id="audit-list" class="list"></div></section>`);
  const renderList=()=>{const date=$('#audit-date').value,user=$('#audit-user').value.toLowerCase(),action=$('#audit-action').value.toLowerCase(),term=$('#audit-search').value.toLowerCase();const filtered=rows.filter(r=>{const hay=JSON.stringify(serializeFirestore(r)).toLowerCase();const d=r.createdAt?.toDate?`${r.createdAt.toDate().getFullYear()}-${String(r.createdAt.toDate().getMonth()+1).padStart(2,'0')}-${String(r.createdAt.toDate().getDate()).padStart(2,'0')}`:'';return(!date||d===date)&&(!user||`${r.actorName||''} ${r.actorId||''}`.toLowerCase().includes(user))&&(!action||String(r.action||'').toLowerCase().includes(action))&&(!term||hay.includes(term));});$('#audit-list').innerHTML=filtered.map(r=>`<article class="list-item ${r.hidden?'hidden-audit':''}"><div><strong>${escapeHtml(r.actorName||r.actorId||'ระบบ')}</strong> — ${escapeHtml(r.action||'-')} — ${escapeHtml(r.area||'-')} / ${escapeHtml(r.targetId||'-')}</div><div class="meta">${escapeHtml(formatTimestamp(r.createdAt))} · ${escapeHtml(ROLE_LABELS[r.actorRole]||r.actorRole||'')} ${r.hidden?'<span class="badge closed">ซ่อนจากผู้จัดการ</span>':''}</div>${r.reason?`<p><strong>เหตุผล:</strong> ${escapeHtml(r.reason)}</p>`:''}<details><summary>ดู Before / After</summary><pre class="audit-json">${escapeHtml(JSON.stringify({before:r.before,after:r.after},null,2))}</pre></details>${isRole(ROLE.OWNER)?`<button class="secondary small" data-toggle-audit="${r.id}" data-write-action>${r.hidden?'แสดงกลับ':'ซ่อนจากผู้จัดการ'}</button>`:''}</article>`).join('')||'<p>ไม่พบรายการ</p>';$$('[data-toggle-audit]').forEach(b=>b.onclick=async()=>{const r=rows.find(x=>x.id===b.dataset.toggleAudit);await writeWithAudit({writes:[{collection:'auditLogs',id:r.id,type:'update',data:{hidden:!r.hidden,hiddenAt:!r.hidden?F.serverTimestamp():null,hiddenBy:state.user.id}}],audit:{action:r.hidden?'unhide-audit':'hide-audit',area:'auditLogs',targetId:r.id,before:{hidden:r.hidden},after:{hidden:!r.hidden}}});await renderAuditPage();});};
  ['audit-date','audit-user','audit-action','audit-search'].forEach(id=>$(`#${id}`).addEventListener('input',renderList));renderList();
}
async function renderSettingsPage(){
  pageHeading('ตั้งค่า','ปรับภาพลักษณ์ สูตร เรท และลำดับเมนู พร้อมตรวจสอบก่อนบันทึก');const s={...DEFAULT_SETTINGS,...state.settings};
  const menuOrder=s.menuOrder||DEFAULT_SETTINGS.menuOrder;
  setPageHtml(`<section class="card"><form id="settings-form"><h2>ชื่อและหน้าตา</h2><div class="grid four"><div><label for="set-store-name">ชื่อร้าน/แอปที่แสดง</label><input id="set-store-name" value="${escapeAttr(s.storeName)}" maxlength="80"></div><div><label for="set-primary">สีหลัก</label><input id="set-primary" type="color" value="${escapeAttr(s.primaryColor)}"></div><div><label for="set-secondary">สีรอง</label><input id="set-secondary" type="color" value="${escapeAttr(s.secondaryColor)}"></div><div><label for="set-background">สีพื้นหลัง</label><input id="set-background" type="color" value="${escapeAttr(s.backgroundColor)}"></div><div><label for="set-font-scale">ขนาดตัวอักษร</label><select id="set-font-scale"><option value="0.9" ${s.fontScale==.9?'selected':''}>เล็ก</option><option value="1" ${s.fontScale==1?'selected':''}>ปกติ</option><option value="1.1" ${s.fontScale==1.1?'selected':''}>ใหญ่</option><option value="1.2" ${s.fontScale==1.2?'selected':''}>ใหญ่มาก</option></select></div><div><label for="set-logo">โลโก้ใหม่ (ไม่บังคับ)</label><input id="set-logo" type="file" accept="image/png,image/jpeg,image/webp"><button id="reset-logo" class="secondary small" type="button">กลับโลโก้เดิม</button></div></div>
  <h2>Dashboard และกฎยอดขาย</h2><div class="grid three"><div><label for="set-margin">สัดส่วนหลังหักต้นทุนสินค้า (%)</label><input id="set-margin" type="number" min="0" max="100" step="0.01" value="${Number(s.grossMarginRate)*100}"></div><label class="check-row"><input id="set-mismatch" type="checkbox" ${s.requirePaymentMismatchNote?'checked':''}> บังคับหมายเหตุเมื่อรายได้ไม่ตรงเงินสด+โอน</label><label class="check-row"><input id="set-rotating" type="checkbox" ${s.rotatingBonusRendoOnly?'checked':''}> พนักงานเวียนได้โบนัสเฉพาะวันที่ทำงานทั้งวันที่ Rendo</label></div>
  <h2>เรทค่าตอบแทน</h2><div class="grid four"><div><label>OT ต่อชั่วโมง<input id="set-ot" type="number" min="0" step="0.01" value="${fromCents(s.otRateCents)}"></label></div><div><label>OT นอกเวลาต่อชั่วโมง<input id="set-outside-ot" type="number" min="0" step="0.01" value="${fromCents(s.outsideOtRateCents)}"></label></div><div><label>รายวันทั้งวัน<input id="set-daily" type="number" min="0" step="0.01" value="${fromCents(s.dailyFullDayRateCents)}"></label></div><div><label>รายวันต่อชั่วโมง<input id="set-hourly" type="number" min="0" step="0.01" value="${fromCents(s.dailyHourlyRateCents)}"></label></div></div>
  <h2>โบนัส</h2><div class="grid four"><div><label>ครัวรายวัน: เกินยอดอาหาร<input id="set-dbk-th" type="number" min="0" step="0.01" value="${fromCents(s.dailyBonusKitchenThresholdCents)}"></label></div><div><label>ครัวรายวัน: ได้<input id="set-dbk-amt" type="number" min="0" step="0.01" value="${fromCents(s.dailyBonusKitchenAmountCents)}"></label></div><div><label>หน้าร้านรายวัน: เกินยอดเครื่องดื่ม<input id="set-dbf-th" type="number" min="0" step="0.01" value="${fromCents(s.dailyBonusFrontThresholdCents)}"></label></div><div><label>หน้าร้านรายวัน: ได้<input id="set-dbf-amt" type="number" min="0" step="0.01" value="${fromCents(s.dailyBonusFrontAmountCents)}"></label></div><div><label>เบียร์ต่อขวด<input id="set-beer" type="number" min="0" step="0.01" value="${fromCents(s.beerRateCents)}"></label></div><div><label>ครัวรายเดือน: เกินยอด<input id="set-mbk-th" type="number" min="0" step="0.01" value="${fromCents(s.monthlyBonusKitchenThresholdCents)}"></label></div><div><label>ครัวรายเดือน: ได้<input id="set-mbk-amt" type="number" min="0" step="0.01" value="${fromCents(s.monthlyBonusKitchenAmountCents)}"></label></div><div><label>หน้าร้านรายเดือน: เกินยอด<input id="set-mbf-th" type="number" min="0" step="0.01" value="${fromCents(s.monthlyBonusFrontThresholdCents)}"></label></div><div><label>หน้าร้านรายเดือน: ได้<input id="set-mbf-amt" type="number" min="0" step="0.01" value="${fromCents(s.monthlyBonusFrontAmountCents)}"></label></div></div>
  <h2>ประกันสังคม</h2><div class="grid three"><div><label>ลูกจ้าง (%)<input id="set-ss-employee" type="number" min="0" max="100" step="0.01" value="${Number(s.socialSecurityEmployeeRate)*100}"></label></div><div><label>นายจ้าง (%)<input id="set-ss-employer" type="number" min="0" max="100" step="0.01" value="${Number(s.socialSecurityEmployerRate)*100}"></label></div><div><label>เพดานฐานค่าจ้าง (บาท)<input id="set-ss-ceiling" type="number" min="0" step="0.01" value="${fromCents(s.socialSecurityWageCeilingCents)}"></label></div></div><p class="alert">กฎหมายอาจเปลี่ยน กรุณาตรวจอัตราและเพดานกับข้อมูลทางราชการปัจจุบันก่อน Finalize ทุกเดือน</p>
  <h2>ลำดับเมนู</h2><div id="menu-order-list" class="list">${menuOrder.map((key,i)=>`<div class="list-item" data-menu-key="${key}"><strong>${escapeHtml(MENU[key]?.label||key)}</strong><div class="button-row"><button class="secondary small" data-menu-move="up" type="button" ${i===0?'disabled':''}>↑ ขึ้น</button><button class="secondary small" data-menu-move="down" type="button" ${i===menuOrder.length-1?'disabled':''}>↓ ลง</button></div></div>`).join('')}</div>
  <div class="button-row"><button id="save-settings" class="primary" data-write-action type="submit">ดูตัวอย่างและบันทึก</button><button id="restore-settings-default" class="danger" type="button">คืนค่าเริ่มต้นทั้งหมด</button></div><p id="settings-message" class="form-message"></p></form></section>`);
  let logoData=s.customLogoDataUrl||'';const currentOrder=[...menuOrder];
  const preview=()=>{const temp={...state.settings,storeName:$('#set-store-name').value.trim()||'Rendo',primaryColor:$('#set-primary').value,secondaryColor:$('#set-secondary').value,backgroundColor:$('#set-background').value,fontScale:Number($('#set-font-scale').value),customLogoDataUrl:logoData};const old=state.settings;state.settings=temp;applyTheme();state.settings=old;};['set-store-name','set-primary','set-secondary','set-background','set-font-scale'].forEach(id=>$(`#${id}`).addEventListener('input',preview));
  $('#set-logo').onchange=async()=>{const file=$('#set-logo').files[0];if(!file)return;logoData=await resizeImageToDataUrl(file,256);preview();};$('#reset-logo').onclick=()=>{logoData='';preview();};
  function renderOrder(){const list=$('#menu-order-list');list.innerHTML=currentOrder.map((key,i)=>`<div class="list-item" data-menu-key="${key}"><strong>${escapeHtml(MENU[key]?.label||key)}</strong><div class="button-row"><button class="secondary small" data-menu-move="up" type="button" ${i===0?'disabled':''}>↑ ขึ้น</button><button class="secondary small" data-menu-move="down" type="button" ${i===currentOrder.length-1?'disabled':''}>↓ ลง</button></div></div>`).join('');$$('[data-menu-move]',list).forEach(b=>b.onclick=()=>{const row=b.closest('[data-menu-key]'),i=currentOrder.indexOf(row.dataset.menuKey),j=b.dataset.menuMove==='up'?i-1:i+1;if(j<0||j>=currentOrder.length)return;[currentOrder[i],currentOrder[j]]=[currentOrder[j],currentOrder[i]];renderOrder();});}renderOrder();
  $('#restore-settings-default').onclick=async()=>{if(!await confirmAction('คืนค่าเริ่มต้น','คืนสี เรท โบนัส ประกันสังคม และลำดับเมนูทั้งหมดหรือไม่'))return;state.settings={...DEFAULT_SETTINGS};applyTheme();await writeWithAudit({writes:[{collection:'appSettings',id:'main',data:{...DEFAULT_SETTINGS,updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'restore-defaults',area:'appSettings',targetId:'main',before:s,after:DEFAULT_SETTINGS}});toast('คืนค่าเริ่มต้นแล้ว','success');await renderSettingsPage();};
  $('#settings-form').onsubmit=async(e)=>{e.preventDefault();const data={storeName:$('#set-store-name').value.trim()||'Rendo',fullStoreName:'RENDO – RAMEN & GYOZA',primaryColor:$('#set-primary').value,secondaryColor:$('#set-secondary').value,backgroundColor:$('#set-background').value,fontScale:Number($('#set-font-scale').value),customLogoDataUrl:logoData,grossMarginRate:Number($('#set-margin').value)/100,requirePaymentMismatchNote:$('#set-mismatch').checked,rotatingBonusRendoOnly:$('#set-rotating').checked,otRateCents:toCents($('#set-ot').value),outsideOtRateCents:toCents($('#set-outside-ot').value),dailyFullDayRateCents:toCents($('#set-daily').value),dailyHourlyRateCents:toCents($('#set-hourly').value),dailyBonusKitchenThresholdCents:toCents($('#set-dbk-th').value),dailyBonusKitchenAmountCents:toCents($('#set-dbk-amt').value),dailyBonusFrontThresholdCents:toCents($('#set-dbf-th').value),dailyBonusFrontAmountCents:toCents($('#set-dbf-amt').value),beerRateCents:toCents($('#set-beer').value),monthlyBonusKitchenThresholdCents:toCents($('#set-mbk-th').value),monthlyBonusKitchenAmountCents:toCents($('#set-mbk-amt').value),monthlyBonusFrontThresholdCents:toCents($('#set-mbf-th').value),monthlyBonusFrontAmountCents:toCents($('#set-mbf-amt').value),socialSecurityEmployeeRate:Number($('#set-ss-employee').value)/100,socialSecurityEmployerRate:Number($('#set-ss-employer').value)/100,socialSecurityWageCeilingCents:toCents($('#set-ss-ceiling').value),menuOrder:currentOrder,appVersion:APP_VERSION,schemaVersion:SCHEMA_VERSION,updatedAt:F.serverTimestamp(),updatedBy:state.user.id};if(data.grossMarginRate<0||data.grossMarginRate>1||data.socialSecurityEmployeeRate<0||data.socialSecurityEmployeeRate>1||data.socialSecurityEmployerRate<0||data.socialSecurityEmployerRate>1)return $('#settings-message').textContent='อัตราร้อยละต้องอยู่ระหว่าง 0 ถึง 100';const ok=await confirmAction('บันทึกการตั้งค่า','ตรวจตัวอย่างสี ขนาดตัวอักษร และเรทแล้ว ยืนยันบันทึกหรือไม่');if(!ok)return;await writeWithAudit({writes:[{collection:'appSettings',id:'main',data}],audit:{action:'update',area:'appSettings',targetId:'main',before:s,after:data}});state.settings={...DEFAULT_SETTINGS,...data};applyTheme();renderNav();toast('บันทึกการตั้งค่าแล้ว','success');};
}

async function resizeImageToDataUrl(file,size){const bitmap=await createImageBitmap(file);const canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,size,size);const scale=Math.min(size/bitmap.width,size/bitmap.height);const w=bitmap.width*scale,h=bitmap.height*scale;ctx.drawImage(bitmap,(size-w)/2,(size-h)/2,w,h);return canvas.toDataURL('image/png',.9);}
async function collectFullBackup(){
  const collections={};for(const name of BACKUP_COLLECTIONS){const rows=await getCollectionData(name);collections[name]=rows.map(({id,...data})=>({id,data:serializeFirestore(data)}));}
  return {schemaVersion:BACKUP_SCHEMA_VERSION,dataSchemaVersion:SCHEMA_VERSION,appVersion:APP_VERSION,exportedAt:new Date().toISOString(),collections};
}
function backupToCsv(backup){const q=(v)=>`"${String(v??'').replace(/"/g,'""')}"`;const lines=[['collection','documentId','dataJson'].map(q).join(',')];lines.push(['__meta__','backup',JSON.stringify({schemaVersion:backup.schemaVersion,dataSchemaVersion:backup.dataSchemaVersion,appVersion:backup.appVersion,exportedAt:backup.exportedAt})].map(q).join(','));for(const [name,rows] of Object.entries(backup.collections)){for(const row of rows)lines.push([name,row.id,JSON.stringify(row.data)].map(q).join(','));}return '\ufeff'+lines.join('\r\n');}
function parseCsv(text){const rows=[];let row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=c;}if(field||row.length){row.push(field);rows.push(row);}return rows;}
function csvToBackup(text){const rows=parseCsv(text.replace(/^\ufeff/,''));if(!rows.length||rows[0][0]!=='collection'||rows[0][1]!=='documentId')throw new Error('หัวตาราง CSV ไม่ใช่รูปแบบ Rendo');const collections={};let meta={schemaVersion:BACKUP_SCHEMA_VERSION,dataSchemaVersion:SCHEMA_VERSION,appVersion:'จาก CSV',exportedAt:'ไม่ระบุ'};for(const r of rows.slice(1)){if(r.length<3||!r[0]||!r[1])continue;if(r[0]==='__meta__'){meta={...meta,...JSON.parse(r[2])};continue;}if(!collections[r[0]])collections[r[0]]=[];collections[r[0]].push({id:r[1],data:JSON.parse(r[2])});}return {...meta,collections};}
function downloadBlob(content,type,filename){const blob=content instanceof Blob?content:new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function base64FromText(text){const bytes=new TextEncoder().encode(text);let bin='';for(const b of bytes)bin+=String.fromCharCode(b);return btoa(bin);}
async function postAppsScript(url,token,action,payload={}){if(!url)throw new Error('ยังไม่ได้ใส่ Google Apps Script Web App URL');const response=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({token,action,...payload}),redirect:'follow'});const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error('Apps Script ตอบกลับไม่ใช่ JSON กรุณาตรวจ URL และสิทธิ์ Deploy');}if(!data.ok)throw new Error(data.error||'Apps Script แจ้งว่าทำรายการไม่สำเร็จ');return data;}
async function performRemoteBackup(settings){const backup=await collectFullBackup();const stamp=new Date().toISOString().replace(/[:.]/g,'-');const json=JSON.stringify(backup,null,2);const csv=backupToCsv(backup);await postAppsScript(settings.webAppUrl,settings.token,'save',{files:[{filename:`Rendo_Backup_${stamp}.json`,mimeType:'application/json',contentBase64:base64FromText(json)},{filename:`Rendo_Backup_${stamp}.csv`,mimeType:'text/csv',contentBase64:base64FromText(csv)}]});const metaId=F.doc(F.collection(db,'backupsMetadata')).id;await F.setDoc(F.doc(db,'backupsMetadata',metaId),{createdAt:F.serverTimestamp(),createdBy:state.user.id,status:'success',recordCount:Object.values(backup.collections).reduce((n,r)=>n+r.length,0),exportedAt:backup.exportedAt});return backup;}
async function renderBackupPage(){
  pageHeading('สำรอง / กู้คืนข้อมูล','เฉพาะเจ้าของ — JSON และ CSV ของ Rendo เท่านั้น');const cfg=await getDocData('privateSettings','backup')||{};const latest=(await getCollectionData('backupsMetadata',[F.orderBy('createdAt','desc'),F.limit(1)]))[0];
  setPageHtml(`<section class="card warning"><strong>ข้อเท็จจริงสำคัญ</strong><p>Auto Backup แบบทุกกี่นาทีทำงานเฉพาะตอนแอปเปิดอยู่ เจ้าของเข้าสู่ระบบ และออนไลน์เท่านั้น เมื่อพนักงานคนอื่นบันทึก ระบบทำเครื่องหมายว่าควรสำรอง และเจ้าของจะสำรองเมื่อเปิดแอปครั้งถัดไป ไม่ทำงานเบื้องหลังเมื่อปิดแอป</p></section>
  <section class="card"><h2>ตั้งค่า Google Apps Script</h2><form id="backup-settings-form"><label for="backup-url">Web App URL</label><input id="backup-url" type="url" value="${escapeAttr(cfg.webAppUrl||'')}" placeholder="https://script.google.com/macros/s/.../exec"><label for="backup-token">Backup Secret/Token</label><input id="backup-token" type="password" value="${escapeAttr(cfg.token||'')}" autocomplete="new-password"><div class="grid two"><div><label for="backup-mode">Auto Backup</label><select id="backup-mode"><option value="off" ${cfg.mode==='off'||!cfg.mode?'selected':''}>ปิด</option><option value="interval" ${cfg.mode==='interval'?'selected':''}>ทุกกี่นาที</option><option value="write" ${cfg.mode==='write'?'selected':''}>เมื่อมีการทำรายการ</option><option value="both" ${cfg.mode==='both'?'selected':''}>ทั้งสองแบบ</option></select></div><div><label for="backup-interval">ทุกกี่นาที (ขั้นต่ำ 5)</label><input id="backup-interval" type="number" min="5" max="1440" value="${Number(cfg.intervalMinutes||30)}"></div></div><div class="button-row"><button class="primary" data-write-action type="submit">บันทึกตั้งค่า</button><button id="test-backup-url" class="secondary" data-write-action type="button">ทดสอบ URL</button></div></form><p>Backup ล่าสุด: <strong>${latest?`${formatTimestamp(latest.createdAt)} — ${escapeHtml(latest.status)}`:'ยังไม่มี'}</strong></p></section>
  <section class="card"><h2>สำรองตอนนี้</h2><div class="button-row"><button id="download-json" class="secondary" data-write-action>ดาวน์โหลด JSON</button><button id="download-csv" class="secondary" data-write-action>ดาวน์โหลด CSV</button><button id="backup-drive-now" class="primary" data-write-action>Backup ไป Google Drive ตอนนี้</button></div><p id="backup-progress" role="status"></p></section>
  <section class="card danger"><h2>Restore</h2><p>รองรับเฉพาะ JSON/CSV ที่ Rendo สร้าง ค่าเริ่มต้นเป็น Merge ซึ่งปลอดภัยกว่า Replace</p><div class="button-row"><button id="choose-restore-file" class="secondary" type="button">เลือกไฟล์</button></div><div id="restore-preview" class="hidden"></div></section>`);
  $('#backup-settings-form').onsubmit=async e=>{e.preventDefault();const data={webAppUrl:$('#backup-url').value.trim(),token:$('#backup-token').value.trim(),mode:$('#backup-mode').value,intervalMinutes:Math.max(5,Number($('#backup-interval').value||30)),updatedAt:F.serverTimestamp(),updatedBy:state.user.id};await writeWithAudit({writes:[{collection:'privateSettings',id:'backup',data}],audit:{action:'update',area:'privateSettings',targetId:'backup',before:{...cfg,token:cfg.token?'[ซ่อน]':''},after:{...data,token:data.token?'[ซ่อน]':''}}});toast('บันทึกการตั้งค่า Backup แล้ว','success');setupAutoBackupTimer();};
  $('#test-backup-url').onclick=async()=>{try{await postAppsScript($('#backup-url').value.trim(),$('#backup-token').value.trim(),'ping');toast('ทดสอบ URL สำเร็จ','success');}catch(e){toast(friendlyError(e),'error');}};
  let cachedBackup=null;const getBackup=async()=>cachedBackup||(cachedBackup=await collectFullBackup());$('#download-json').onclick=async()=>{const b=await getBackup();downloadBlob(JSON.stringify(b,null,2),'application/json',`Rendo_Full_Backup_${dateToday()}.json`);};$('#download-csv').onclick=async()=>{const b=await getBackup();downloadBlob(backupToCsv(b),'text/csv;charset=utf-8',`Rendo_Full_Backup_${dateToday()}.csv`);};
  $('#backup-drive-now').onclick=async()=>{const p=$('#backup-progress');p.textContent='กำลังรวบรวมและส่ง JSON + CSV…';try{await performRemoteBackup({webAppUrl:$('#backup-url').value.trim(),token:$('#backup-token').value.trim()});p.textContent=`สำเร็จ ${new Date().toLocaleString('th-TH')}`;toast('Backup ไป Drive สำเร็จ','success');}catch(e){p.textContent=`ล้มเหลว: ${friendlyError(e)}`;toast(friendlyError(e),'error');}};
  $('#choose-restore-file').onclick=()=>$('#restore-file-input').click();$('#restore-file-input').onchange=async()=>{const file=$('#restore-file-input').files[0];if(!file)return;try{const text=await file.text();const backup=file.name.toLowerCase().endsWith('.csv')?csvToBackup(text):JSON.parse(text);validateBackup(backup);state.pendingRestore=backup;const counts=Object.entries(backup.collections).map(([k,v])=>`${escapeHtml(k)}: ${v.length}`).join('<br>');$('#restore-preview').classList.remove('hidden');$('#restore-preview').innerHTML=`<h3>ตัวอย่างก่อน Restore</h3><p>schemaVersion: ${escapeHtml(backup.schemaVersion)}<br>appVersion: ${escapeHtml(backup.appVersion)}<br>วันที่สำรอง: ${escapeHtml(backup.exportedAt)}</p><p>${counts}</p><label><input type="radio" name="restore-mode" value="merge" checked> Merge — เขียนทับเฉพาะ ID ที่ตรงและเพิ่มรายการใหม่</label><label><input type="radio" name="restore-mode" value="replace"> Replace — ลบข้อมูลใน collection ที่รองรับก่อน แล้วเขียนจากไฟล์</label><div class="alert error">Replace มีความเสี่ยงสูง ระบบจะไม่ลบ Authentication, system initialization, security keys หรือ owner secret</div><button id="run-restore" class="danger" data-write-action>เริ่ม Restore</button><p id="restore-progress"></p>`;$('#run-restore').onclick=runRestore;}catch(e){toast(`ไฟล์ไม่ถูกต้อง: ${friendlyError(e)}`,'error');}};
}
function validateBackup(backup){if(!backup||backup.schemaVersion!==BACKUP_SCHEMA_VERSION||!backup.collections||typeof backup.collections!=='object')throw new Error('schemaVersion ไม่รองรับ');for(const [name,rows] of Object.entries(backup.collections)){if(!Array.isArray(rows)||rows.some(r=>!r.id||typeof r.data!=='object'))throw new Error(`ข้อมูล collection ${name} ไม่ถูกต้อง`);}}
async function runRestore(){const backup=state.pendingRestore;if(!backup)return;const mode=$('input[name="restore-mode"]:checked').value;const progress=$('#restore-progress');try{await requestReauth('กรอก PIN เจ้าของก่อน Restore');progress.textContent='กำลังสร้าง pre-restore backup ในเครื่อง…';const pre=await collectFullBackup();downloadBlob(JSON.stringify(pre,null,2),'application/json',`Rendo_Pre_Restore_${new Date().toISOString().replace(/[:.]/g,'-')}.json`);const cfg=await getDocData('privateSettings','backup');if(cfg?.webAppUrl&&cfg?.token){progress.textContent='กำลังสำรองไป Drive ก่อน Restore…';try{await performRemoteBackup(cfg);}catch(e){if(!await confirmAction('Backup ไป Drive ไม่สำเร็จ',`สำรองในเครื่องแล้ว แต่ Drive ล้มเหลว: ${friendlyError(e)} ดำเนิน Restore ต่อหรือไม่`))return;}}
  if(mode==='replace'){progress.textContent='กำลังลบข้อมูลเดิมเฉพาะ collection ที่รองรับ…';for(const name of RESTORE_COLLECTIONS){const docs=await getCollectionData(name);for(let i=0;i<docs.length;i+=400){const batch=F.writeBatch(db);for(const row of docs.slice(i,i+400))batch.delete(F.doc(db,name,row.id));await batch.commit();}}}
  let total=0;for(const name of RESTORE_COLLECTIONS)total+=(backup.collections[name]||[]).length;let done=0;for(const name of RESTORE_COLLECTIONS){const rows=backup.collections[name]||[];for(let i=0;i<rows.length;i+=400){const batch=F.writeBatch(db);for(const row of rows.slice(i,i+400)){if(mode==='merge')batch.set(F.doc(db,name,row.id),deserializeFirestore(row.data),{merge:true});else batch.set(F.doc(db,name,row.id),deserializeFirestore(row.data));done++;}await batch.commit();progress.textContent=`เขียนแล้ว ${done}/${total} รายการ`;}}
  await F.setDoc(F.doc(F.collection(db,'auditLogs')),{...auditDoc({action:'restore',area:'backup',targetId:new Date().toISOString(),after:{mode,total,sourceVersion:backup.appVersion}}),createdAt:F.serverTimestamp()});progress.textContent=`Restore สำเร็จ ${done} รายการ กำลังโหลดใหม่…`;queueBackupAfterWrite();setTimeout(()=>location.reload(),1200);
 }catch(e){if(!String(e.message).includes('ยกเลิก')){progress.textContent=`ล้มเหลว: ${friendlyError(e)}`;toast(friendlyError(e),'error');}}}
async function queueBackupAfterWrite(){if(!state.user)return;try{await F.setDoc(F.doc(db,'system','backupQueue'),{needed:true,lastWriteAt:F.serverTimestamp(),lastWriteBy:state.user.id},{merge:true});}catch{}if(!isRole(ROLE.OWNER))return;const cfg=await getDocData('privateSettings','backup').catch(()=>null);if(!cfg||!['write','both'].includes(cfg.mode)||!cfg.webAppUrl||!cfg.token)return;clearTimeout(queueBackupAfterWrite.timer);queueBackupAfterWrite.timer=setTimeout(async()=>{try{await performRemoteBackup(cfg);await F.setDoc(F.doc(db,'system','backupQueue'),{needed:false,lastBackupAt:F.serverTimestamp()},{merge:true});}catch(e){console.warn('Auto backup failed',e);}},5000);}
function setupAutoBackupTimer(){clearInterval(state.lastBackupTimer);if(!isRole(ROLE.OWNER))return;getDocData('privateSettings','backup').then(cfg=>{if(!cfg||!['interval','both'].includes(cfg.mode)||!cfg.webAppUrl||!cfg.token)return;state.lastBackupTimer=setInterval(()=>{if(navigator.onLine&&state.user)performRemoteBackup(cfg).catch(e=>console.warn('Interval backup',e));},Math.max(5,Number(cfg.intervalMinutes||30))*60000);getDocData('system','backupQueue').then(q=>{if(q?.needed&&['write','both'].includes(cfg.mode))performRemoteBackup(cfg).then(()=>F.setDoc(F.doc(db,'system','backupQueue'),{needed:false,lastBackupAt:F.serverTimestamp()},{merge:true})).catch(()=>{});});}).catch(()=>{});}
async function renderChangePinPage(){
  pageHeading('เปลี่ยน PIN ของฉัน','ต้องกรอก PIN เก่าให้ถูกต้องก่อน และ PIN ใหม่ต้องเป็นตัวเลข 4 หลัก');
  setPageHtml(`<section class="card"><form id="change-pin-form"><label for="old-pin">PIN เก่า</label><input id="old-pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required><label for="new-pin">PIN ใหม่</label><input id="new-pin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required><label for="new-pin-confirm">ยืนยัน PIN ใหม่</label><input id="new-pin-confirm" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" required><button id="change-pin-button" class="primary" data-write-action type="submit">เปลี่ยน PIN</button><p id="change-pin-message" class="form-message"></p></form><p class="security-note">อย่าใช้ PIN เดียวกับธนาคาร โทรศัพท์ หรือบริการสำคัญ</p></section>`);
  $('#change-pin-form').onsubmit=async e=>{e.preventDefault();const oldPin=$('#old-pin').value,newPin=$('#new-pin').value,confirmPin=$('#new-pin-confirm').value;if(!/^\d{4}$/.test(oldPin)||!/^\d{4}$/.test(newPin)||newPin!==confirmPin)return $('#change-pin-message').textContent='PIN ต้องเป็นตัวเลข 4 หลัก และ PIN ใหม่ทั้งสองช่องต้องตรงกัน';if(oldPin===newPin)return $('#change-pin-message').textContent='PIN ใหม่ต้องต่างจาก PIN เก่า';const button=$('#change-pin-button');setBusy(button,true,'กำลังเปลี่ยน…');let authChange=null;try{const publicKey=await getDocData('securityKeys','pinPublic');const ciphertext=await encryptPin(publicKey.publicJwk,newPin);authChange=await updateCurrentPin(state.user.loginId,oldPin,newPin);await writeWithAudit({writes:[{collection:'userPins',id:state.user.id,data:{ciphertext,algorithm:'RSA-OAEP-SHA256',updatedAt:F.serverTimestamp(),updatedBy:state.user.id}}],audit:{action:'change-own-pin',area:'userPins',targetId:state.user.id,before:{pin:'[เดิม]'},after:{pin:'[เข้ารหัสใหม่]'}}});clearRememberedCredential();toast('เปลี่ยน PIN แล้ว กรุณาเข้าสู่ระบบใหม่','success');await signOutRendo();}catch(error){if(authChange)await authChange.rollback();$('#change-pin-message').textContent=friendlyError(error);}finally{setBusy(button,false);}};
}

initializeAppUi();
