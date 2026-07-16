import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser as deleteAuthUser } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, enableIndexedDbPersistence, collection, doc, getDoc, getDocs, getDocFromCache, getDocsFromCache,
  addDoc, setDoc, updateDoc, deleteDoc, query, where, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const VERSION = "v1.2.0";
const STORAGE_KEY = "rendo_remember_v1";
const SESSION_KEY = "rendo_session_unlock_v1";
const COLLECTIONS = [
  "users","publicUsers","pinVault","attendance","dailySales","dailyDrafts","salaryAdvances","ownerExpenses",
  "recurringExpenseTemplates","recurringExpenseMonths","compensationRecords",
  "compensationMonthSettings","appSettings","auditLogs","backupsMetadata","system"
];

const ROLE_LABELS = {
  owner:"เจ้าของ", manager:"ผู้จัดการ", supervisor:"หัวหน้า",
  front_kitchen:"ครัวหน้าร้าน", back_kitchen:"ครัวหลังบ้าน",
  front_staff:"พนักงานหน้าร้าน", rotating:"พนักงานเวียน", daily:"รายวัน"
};
const ROLE_ORDER = {owner:1,manager:2,supervisor:3,front_kitchen:4,back_kitchen:5,front_staff:6,rotating:7,daily:8};
const WORKER_ROLES = ["front_kitchen","back_kitchen","front_staff","rotating","daily"];
const SALARIED_ROLES = ["front_kitchen","back_kitchen","front_staff","rotating"];
const KITCHEN_ROLES = ["front_kitchen","back_kitchen"];
const FRONT_BONUS_ROLES = ["front_staff","rotating"];
const FRONT_BEER_ROLES = ["front_staff","rotating","daily"];

const DEFAULT_COMP_SETTINGS = {
  otRates:{front_kitchen:0,back_kitchen:0,front_staff:0,rotating:0},
  dailyPay:{fullDay:0,hourly:0},
  dailyBonus:{kitchen:{threshold:10000,amount:100},front:{threshold:10000,amount:100}},
  monthlyBonus:{kitchen:{threshold:100000,amount:1000},front:{threshold:100000,amount:1000}},
  beerPerBottle:5,
  socialSecurity:{employeeRate:5,employerRate:5,maxSalaryBase:0}
};
const DEFAULT_SETTINGS = {
  storeName:"Rendo",
  primaryColor:"#b88942",
  secondaryColor:"#f5ead8",
  backgroundColor:"#f8f5ee",
  fontScale:1,
  dashboardMarginRate:0.40,
  hiddenPages:[],
  advanceAccessUserIds:[],
  autoBackup:{mode:"off",intervalMinutes:60,url:""},
  compensationDefaults:DEFAULT_COMP_SETTINGS
};

const clone = obj => typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
let state = {
  app:null, auth:null, db:null, authUid:null,
  users:[], publicUsers:[], pinVault:{}, settings:clone(DEFAULT_SETTINGS), currentUser:null, currentPage:"dashboard",
  online:navigator.onLine, charts:{}, backupTimer:null, backupDebounce:null, backupInProgress:false, backupQueued:false,
  saleLoaded:null, restorePreview:null, navRequestId:0,
  attendanceFormLoadSeq:0, attendanceResultLoadSeq:0, salesLoadSeq:0,
  dashboardLoadSeq:0, monthlyLoadSeq:0, advancesLoadSeq:0,
  compensationLoadSeq:0, ownerExpensesLoadSeq:0, historyLoadSeq:0,
  compSelectedIndex:0, compDrafts:{}, dataCache:new Map()
};

const $ = (sel,root=document)=>root.querySelector(sel);
const $$ = (sel,root=document)=>[...root.querySelectorAll(sel)];
const content = ()=>$("#pageContent");
const numberValue = v => { const n=Number(String(v ?? "").replaceAll(",","")); return Number.isFinite(n)?n:0; };
const money = n => numberValue(n).toLocaleString("th-TH",{minimumFractionDigits:0,maximumFractionDigits:2});
const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
const uid = (prefix="id")=>`${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
const safeClone = obj => JSON.parse(JSON.stringify(obj,(_,v)=>v?.toDate? v.toDate().toISOString() : (v===undefined?null:v)));

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
function withTimeout(promise,ms=15000,label="การทำรายการ") {
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(`${label} ใช้เวลานานเกินไป กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่`),{code:"app/timeout"})),ms);});
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}
function friendlyError(err){
  const code=err?.code||"";
  if(code==="permission-denied"||String(err?.message||"").includes("insufficient permissions")) return "ไม่มีสิทธิ์อ่านหรือบันทึกข้อมูลส่วนนี้ กรุณาตรวจ Firestore Rules";
  if(code==="unavailable"||code==="app/timeout") return "เชื่อมต่อฐานข้อมูลไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่";
  if(code==="failed-precondition"&&String(err?.message||"").includes("index")) return "Firestore ยังไม่มีดัชนีที่จำเป็น กรุณาสร้าง Index ตามลิงก์ที่ Firebase แสดง";
  return err?.message||"เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ";
}
async function getDocsResilient(ref,label="โหลดข้อมูล",timeoutMs=8000){
  // ใช้ cache ก่อนเมื่อมีข้อมูล เพื่อลดอาการค้างบนเน็ตช้า แล้วอัปเดต cache จากเครือข่ายเบื้องหลัง
  let cached=null;
  try{ cached=await getDocsFromCache(ref); }catch(_){ cached=null; }
  if(cached && !cached.empty){
    withTimeout(getDocs(ref),timeoutMs,label).catch(err=>{
      if(["permission-denied","failed-precondition"].includes(err?.code)) console.warn(label,err);
    });
    return cached;
  }
  try{return await withTimeout(getDocs(ref),timeoutMs,label);}
  catch(err){
    if(["permission-denied","failed-precondition"].includes(err?.code)) throw err;
    if(cached) return cached;
    try{return await getDocsFromCache(ref);}catch(_){throw err;}
  }
}
async function getDocResilient(ref,label="โหลดข้อมูล",timeoutMs=7000){
  let cached=null;
  try{ cached=await getDocFromCache(ref); }catch(_){ cached=null; }
  if(cached?.exists()){
    withTimeout(getDoc(ref),timeoutMs,label).catch(()=>null);
    return cached;
  }
  try{return await withTimeout(getDoc(ref),timeoutMs,label);}
  catch(err){
    if(["permission-denied","failed-precondition"].includes(err?.code)) throw err;
    if(cached) return cached;
    try{return await getDocFromCache(ref);}catch(_){throw err;}
  }
}
function pageStillActive(page,requestId){ return state.currentPage===page && state.navRequestId===requestId; }
function invalidateDataCache(collectionName){
  for(const key of state.dataCache.keys()) if(key.startsWith(`${collectionName}|`)) state.dataCache.delete(key);
}
function bindFriendlyNumberInputs(root=document){
  root.querySelectorAll('input[type="number"]:not([readonly]):not([data-friendly-number-bound])').forEach(input=>{
    input.dataset.friendlyNumberBound="1";
    input.addEventListener("focus",()=>{
      if(String(input.value).trim()!=="" && numberValue(input.value)===0){ input.value=""; }
      else requestAnimationFrame(()=>input.select?.());
    });
    input.addEventListener("blur",()=>{
      if(String(input.value).trim()===""){
        input.value="0";
        input.dispatchEvent(new Event("input",{bubbles:true}));
      }
    });
  });
}
function setButtonBusy(button,busy,text="กำลังบันทึก..."){
  if(!button)return;
  if(busy){button.dataset.oldText=button.textContent;button.disabled=true;button.textContent=text;}
  else{button.disabled=!state.online;button.textContent=button.dataset.oldText||button.textContent;delete button.dataset.oldText;}
}
window.addEventListener("unhandledrejection",event=>{console.error("Unhandled promise",event.reason);showToast(friendlyError(event.reason));});
window.addEventListener("error",event=>{console.error("Window error",event.error||event.message);});

async function sha256(text){ const bytes=new TextEncoder().encode(String(text)); const hash=await crypto.subtle.digest("SHA-256",bytes); return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function todayISO(){ const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
function monthOf(d){ return String(d||"").slice(0,7); }
function currentMonthKey(){ return todayISO().slice(0,7); }
function previousMonthKey(m=currentMonthKey()){ const [y,mo]=m.split("-").map(Number); const d=new Date(y,mo-2,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
function daysInMonth(m){ const [y,mo]=m.split("-").map(Number); return new Date(y,mo,0).getDate(); }
function dateOfMonth(m,day){ return `${m}-${String(day).padStart(2,"0")}`; }
function addDaysISO(iso,n){ const d=new Date(`${iso}T00:00:00`); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function thaiDate(iso){
  if(!iso) return "-"; const d=new Date(`${iso}T00:00:00`); if(Number.isNaN(d.getTime())) return iso;
  const days=["วันอาทิตย์","วันจันทร์","วันอังคาร","วันพุธ","วันพฤหัสบดี","วันศุกร์","วันเสาร์"];
  return `${days[d.getDay()]} ${d.getDate()} ${["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."][d.getMonth()]} ${d.getFullYear()+543}`;
}
function thaiMonth(m){ const [y,mo]=String(m||currentMonthKey()).split("-").map(Number); const names=["","มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"]; return `${names[mo]} ${y+543}`; }
function formatTs(v){ if(!v) return "-"; const d=v?.toDate?v.toDate():new Date(v); if(Number.isNaN(d.getTime())) return "-"; return `${thaiDate(d.toISOString().slice(0,10))} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
function minutesFromTime(t){ const [h,m]=String(t||"0:0").split(":").map(Number); return (h||0)*60+(m||0); }
function timeOptions(startHour,endHour,selected="",step=1){
  const out=[]; for(let h=startHour;h<=endHour;h+=step){ const v=`${String(h).padStart(2,"0")}:00`; out.push(`<option value="${v}" ${v===selected?"selected":""}>${v}</option>`); } return out.join("");
}
function showToast(msg){ const t=$("#toast"); if(!t) return; t.textContent=msg; t.classList.add("show"); clearTimeout(showToast._t); showToast._t=setTimeout(()=>t.classList.remove("show"),3400); }
function setLoading(msg="กำลังโหลด..."){ content().innerHTML=`<div class="loading">${escapeHtml(msg)}</div>`; }
function firebaseConfigReady(c){ return c?.apiKey && c?.projectId; }
function isOwner(){ return state.currentUser?.role==="owner"; }
function isManager(){ return state.currentUser?.role==="manager"; }
function isSupervisor(){ return state.currentUser?.role==="supervisor"; }
function isOwnerOrManager(){ return ["owner","manager"].includes(state.currentUser?.role); }
function isAdminViewer(){ return ["owner","manager","supervisor"].includes(state.currentUser?.role); }
function isWorker(user=state.currentUser){ return WORKER_ROLES.includes(user?.role); }
function requireOnline(){ if(!state.online){ showToast("ออฟไลน์อยู่ กรุณาต่ออินเทอร์เน็ตก่อน"); return false; } return true; }
function roleBadge(role){ return `<span class="badge-role">${escapeHtml(ROLE_LABELS[role]||role)}</span>`; }
function userName(id){ return state.users.find(u=>u.id===id)?.name || id || "-"; }
function deepMergeSettings(raw={}){
  return {
    ...clone(DEFAULT_SETTINGS), ...raw,
    autoBackup:{...DEFAULT_SETTINGS.autoBackup,...(raw.autoBackup||{})},
    compensationDefaults:{
      ...clone(DEFAULT_COMP_SETTINGS), ...(raw.compensationDefaults||{}),
      otRates:{...DEFAULT_COMP_SETTINGS.otRates,...(raw.compensationDefaults?.otRates||{})},
      dailyPay:{...DEFAULT_COMP_SETTINGS.dailyPay,...(raw.compensationDefaults?.dailyPay||{})},
      dailyBonus:{
        kitchen:{...DEFAULT_COMP_SETTINGS.dailyBonus.kitchen,...(raw.compensationDefaults?.dailyBonus?.kitchen||{})},
        front:{...DEFAULT_COMP_SETTINGS.dailyBonus.front,...(raw.compensationDefaults?.dailyBonus?.front||{})}
      },
      monthlyBonus:{
        kitchen:{...DEFAULT_COMP_SETTINGS.monthlyBonus.kitchen,...(raw.compensationDefaults?.monthlyBonus?.kitchen||{})},
        front:{...DEFAULT_COMP_SETTINGS.monthlyBonus.front,...(raw.compensationDefaults?.monthlyBonus?.front||{})}
      },
      socialSecurity:{...DEFAULT_COMP_SETTINGS.socialSecurity,...(raw.compensationDefaults?.socialSecurity||{})}
    }
  };
}
function applyTheme(){
  const s=state.settings;
  document.documentElement.style.setProperty("--primary",s.primaryColor);
  document.documentElement.style.setProperty("--primary-dark","#2b2113");
  document.documentElement.style.setProperty("--secondary",s.secondaryColor);
  document.documentElement.style.setProperty("--bg",s.backgroundColor||DEFAULT_SETTINGS.backgroundColor);
  document.documentElement.style.setProperty("--fontScale",String(s.fontScale||1));
  $("#loginStoreName").textContent=s.storeName||"Rendo"; $("#appTitle").textContent=s.storeName||"Rendo";
  $$(".version").forEach(x=>x.textContent=VERSION); if($("#appSub")) $("#appSub").textContent=VERSION;
}
function updateOnlineUi(){
  state.online=navigator.onLine; const p=$("#onlinePill");
  if(p){ p.textContent=state.online?"ออนไลน์":"ออฟไลน์"; p.className=`pill ${state.online?"ok":"danger"}`; }
  $("#offlineBanner")?.classList.toggle("hidden",state.online);
  document.body.classList.toggle("is-offline",!state.online);
  $$(".write-action").forEach(el=>el.disabled=!state.online);
  $$("#pageContent input,#pageContent select,#pageContent textarea").forEach(el=>{
    if(!state.online){ if(el.dataset.prevDisabled===undefined) el.dataset.prevDisabled=el.disabled?"1":"0"; el.disabled=true; el.classList.add("offline-locked"); }
    else if(el.dataset.prevDisabled!==undefined){ el.disabled=el.dataset.prevDisabled==="1"; delete el.dataset.prevDisabled; el.classList.remove("offline-locked"); }
  });
}
window.addEventListener("online",updateOnlineUi); window.addEventListener("offline",updateOnlineUi);

async function registerServiceWorker(){
  if("serviceWorker" in navigator && location.protocol!=="file:"){
    try{
      const reg=await navigator.serviceWorker.register("./sw.js",{updateViaCache:"none"}); await reg.update().catch(()=>null);
      const activate=()=>reg.waiting?.postMessage("SKIP_WAITING"); if(reg.waiting)activate(); reg.addEventListener("updatefound",()=>reg.installing?.addEventListener("statechange",()=>{if(reg.waiting)activate();}));
      navigator.serviceWorker.addEventListener("controllerchange",()=>{if(sessionStorage.getItem("rendo_sw_reloaded_120"))return;sessionStorage.setItem("rendo_sw_reloaded_120","1");location.reload();});
    }catch(e){ console.warn("SW",e); }
  }
}
async function loadPublicUsers(){
  const snap=await getDocsResilient(collection(state.db,"publicUsers"),"โหลดรายชื่อผู้ใช้");
  state.publicUsers=snap.docs.map(d=>({id:d.id,...d.data()})).filter(u=>u.active!==false).sort((a,b)=>(ROLE_ORDER[a.role]||99)-(ROLE_ORDER[b.role]||99)||String(a.name).localeCompare(String(b.name),"th"));
  state.users=state.publicUsers.slice();
}
function makeLoginIdentity(){ const loginKey=Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); return {loginKey,authEmail:`rendo.${loginKey}@rendo-app.local`}; }
function authPassword(pin,loginKey){ return `Rendo#${String(pin).trim()}#${String(loginKey).slice(0,12)}`; }
async function boot(){
  window.__RENDO_APP_BOOTED=true; await registerServiceWorker();
  const config=window.RENDO_FIREBASE_CONFIG;
  if(!firebaseConfigReady(config)){ $("#loginScreen").classList.add("hidden"); $("#configScreen").classList.remove("hidden"); return; }
  try{
    state.app=initializeApp(config); state.auth=getAuth(state.app); state.db=getFirestore(state.app);
    try{ await enableIndexedDbPersistence(state.db); }catch(e){ console.warn("IndexedDB persistence",e.code||e); }
    await loadPublicUsers();
    state.publicUsers.length?renderLogin():renderFirstSetup();
    applyTheme(); updateOnlineUi();
  }catch(e){ console.error(e); $("#loginArea").innerHTML=`<div class="state error"><b>เริ่มระบบไม่สำเร็จ</b><br>${escapeHtml(e.message)}<br><small>ตรวจว่าเปิด Email/Password Authentication สร้าง Firestore และวาง Rules แล้ว</small></div>`; }
}
async function loadBaseData(){
  const [uSnap,sSnap]=await Promise.all([getDocsResilient(collection(state.db,"users"),"โหลดผู้ใช้"),getDocResilient(doc(state.db,"appSettings","main"),"โหลดการตั้งค่า")]);
  state.users=uSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(ROLE_ORDER[a.role]||99)-(ROLE_ORDER[b.role]||99)||String(a.name).localeCompare(String(b.name),"th"));
  state.settings=deepMergeSettings(sSnap.exists()?sSnap.data():{});
  if(isOwner()){
    try{ const p=await getDocsResilient(collection(state.db,"pinVault"),"โหลด PIN"); state.pinVault=Object.fromEntries(p.docs.map(d=>[d.id,d.data().pin||""])); }catch(_){ state.pinVault={}; }
  }else state.pinVault={};
  applyTheme();
}
function renderFirstSetup(){
  $("#loginArea").innerHTML=`<div class="state warn"><b>ตั้งค่าครั้งแรก</b><br>สร้างบัญชีเจ้าของคนแรก</div>
  <form id="firstSetup" class="grid"><div class="field"><label>ชื่อเจ้าของ</label><input id="firstName" required autocomplete="name" placeholder="เช่น คุณเอ"></div>
  <div class="field"><label>PIN ตัวเลข 4 ตัว</label><input id="firstPin" required inputmode="numeric" maxlength="4" type="password" placeholder="••••"></div>
  <button class="btn full write-action">สร้างระบบ Rendo</button></form>`;
  $("#firstSetup").onsubmit=setupFirstOwner;
}
async function setupFirstOwner(e){
  e.preventDefault(); if(!requireOnline()) return; const name=$("#firstName").value.trim(),pin=$("#firstPin").value.trim();
  if(!name||!/^\d{4}$/.test(pin)) return showToast("กรอกชื่อและ PIN ตัวเลข 4 ตัว");
  const identity=makeLoginIdentity(); let cred;
  try{
    cred=await createUserWithEmailAndPassword(state.auth,identity.authEmail,authPassword(pin,identity.loginKey)); state.authUid=cred.user.uid;
    const id=cred.user.uid,batch=writeBatch(state.db);
    const secure={name,role:"owner",active:true,salary:0,bankName:"",bankAccountNumber:"",authEmail:identity.authEmail,loginKey:identity.loginKey,createdAt:serverTimestamp(),createdBy:"first_setup",updatedAt:serverTimestamp()};
    const pub={name,role:"owner",active:true,authEmail:identity.authEmail,loginKey:identity.loginKey,updatedAt:serverTimestamp()};
    batch.set(doc(state.db,"users",id),secure); batch.set(doc(state.db,"publicUsers",id),pub); batch.set(doc(state.db,"pinVault",id),{pin,createdBy:id,updatedAt:serverTimestamp()});
    batch.set(doc(state.db,"system","bootstrap"),{ownerUid:id,createdAt:serverTimestamp()});
    batch.set(doc(state.db,"appSettings","main"),{...clone(DEFAULT_SETTINGS),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    await batch.commit(); state.currentUser={id,...secure}; await audit("สร้างระบบครั้งแรก",{user:name},null,null,state.currentUser,"system");
    await signOut(state.auth); state.currentUser=null; state.authUid=null; await loadPublicUsers(); showToast("สร้างระบบสำเร็จ กรุณาเข้าสู่ระบบ"); renderLogin();
  }catch(err){ console.error(err); if(cred?.user) await deleteAuthUser(cred.user).catch(()=>null); showToast(err.code==="auth/email-already-in-use"?"เกิดรหัสซ้ำ กรุณาลองใหม่":`สร้างระบบไม่สำเร็จ: ${err.message}`); }
}
function renderLogin(){
  const remembered=JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}"); const users=state.publicUsers.filter(u=>u.active!==false);
  $("#loginArea").innerHTML=`<form id="loginForm" class="grid">
    <div class="field"><label>เลือกผู้ใช้</label><select id="loginUser">${users.map(u=>`<option value="${u.id}" ${remembered.userId===u.id?"selected":""}>${escapeHtml(u.name)} — ${escapeHtml(ROLE_LABELS[u.role])}</option>`).join("")}</select></div>
    <div class="field"><label>PIN 4 ตัว</label><input id="loginPin" inputmode="numeric" maxlength="4" type="password" value="${escapeHtml(remembered.pin||"")}" placeholder="••••" autocomplete="current-password"></div>
    <label class="check-item"><input id="rememberLogin" type="checkbox" ${remembered.userId?"checked":""}> จดจำผู้ใช้และ PIN ในเครื่องนี้</label>
    <button class="btn full write-action">เข้าสู่ระบบ</button></form>`;
  $("#loginForm").onsubmit=login;
}
async function login(e){
  e.preventDefault(); const id=$("#loginUser").value,pin=$("#loginPin").value.trim(),pub=state.publicUsers.find(u=>u.id===id&&u.active!==false);
  if(!pub||!/^\d{4}$/.test(pin)) return showToast("เลือกผู้ใช้และกรอก PIN 4 ตัว");
  try{
    let authUser;
    if(!state.online){
      const session=JSON.parse(localStorage.getItem(SESSION_KEY)||"{}");
      if(!state.auth.currentUser || state.auth.currentUser.uid!==id || session.userId!==id || session.pinHash!==await sha256(pin)) throw new Error("offline_unlock_failed");
      authUser=state.auth.currentUser;
    }else{
      const cred=await signInWithEmailAndPassword(state.auth,pub.authEmail,authPassword(pin,pub.loginKey)); authUser=cred.user;
    }
    state.authUid=authUser.uid; await loadBaseData(); const user=state.users.find(u=>u.id===authUser.uid&&u.active!==false); if(!user)throw new Error("บัญชีถูกปิดหรือลบแล้ว"); state.currentUser=user;
    localStorage.setItem(SESSION_KEY,JSON.stringify({userId:id,pinHash:await sha256(pin)}));
    if($("#rememberLogin").checked) localStorage.setItem(STORAGE_KEY,JSON.stringify({userId:id,pin})); else localStorage.removeItem(STORAGE_KEY);
    if(isOwner()){ try{ const p=await getDocsResilient(collection(state.db,"pinVault"),"โหลด PIN"); state.pinVault=Object.fromEntries(p.docs.map(d=>[d.id,d.data().pin||""])); }catch(_){ state.pinVault={}; } }
    if(state.online) await audit("เข้าสู่ระบบ",{user:user.name},null,null,user,"system"); $("#loginScreen").classList.add("hidden"); $("#mainApp").classList.remove("hidden"); buildNav(); setupAutoBackupTimer(); navigate(visibleNavItems()[0]?.id||"monthly");
  }catch(err){ console.warn("login",err); if(state.online)await signOut(state.auth).catch(()=>null); state.authUid=null; showToast(state.online?"PIN ไม่ถูกต้อง หรือบัญชีถูกปิดใช้งาน":"ออฟไลน์: เครื่องนี้ยังไม่มีสิทธิ์ปลดล็อกบัญชีนี้ กรุณาออนไลน์และเข้าสู่ระบบก่อน"); }
}
async function logout(){ clearTimeout(state.backupDebounce);clearInterval(state.backupTimer);state.currentUser=null;state.authUid=null;localStorage.removeItem(SESSION_KEY);await signOut(state.auth).catch(()=>null);await loadPublicUsers();$("#mainApp").classList.add("hidden");$("#loginScreen").classList.remove("hidden");renderLogin(); }
$("#logoutBtn").onclick=logout;
async function confirmCurrentPin(pin){
  const u=state.currentUser;if(!u||!/^\d{4}$/.test(String(pin).trim()))return false;
  try{const credential=EmailAuthProvider.credential(u.authEmail,authPassword(pin,u.loginKey));await reauthenticateWithCredential(state.auth.currentUser,credential);return true;}catch(_){return false;}
}
$("#changePinTopBtn").onclick=async()=>{
  if(!state.currentUser||!requireOnline()) return; const oldPin=prompt("กรอก PIN เดิม"); if(oldPin===null)return; const newPin=prompt("กรอก PIN ใหม่เป็นตัวเลข 4 ตัว"); if(newPin===null)return;
  if(!/^\d{4}$/.test(String(newPin).trim()))return showToast("PIN ใหม่ต้องเป็นตัวเลข 4 ตัว"); if(!await confirmCurrentPin(oldPin))return showToast("PIN เดิมไม่ถูกต้อง");
  await updatePassword(state.auth.currentUser,authPassword(newPin,state.currentUser.loginKey)); await setDoc(doc(state.db,"pinVault",state.currentUser.id),{pin:String(newPin).trim(),updatedAt:serverTimestamp(),updatedBy:state.currentUser.id},{merge:true});
  if(isOwner())state.pinVault[state.currentUser.id]=String(newPin).trim(); localStorage.setItem(SESSION_KEY,JSON.stringify({userId:state.currentUser.id,pinHash:await sha256(String(newPin).trim())})); const r=JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}");if(r.userId===state.currentUser.id)localStorage.setItem(STORAGE_KEY,JSON.stringify({...r,pin:String(newPin).trim()}));
  await audit("เปลี่ยน PIN",{user:state.currentUser.name},null,null,null,"system");showToast("เปลี่ยน PIN แล้ว");
};

async function audit(action,details={},before=null,after=null,actorOverride=null,category="activity"){
  try{ const a=actorOverride||state.currentUser||{}; await withTimeout(addDoc(collection(state.db,"auditLogs"),{
    action,details:safeClone(details),before:safeClone(before),after:safeClone(after),category,
    actorId:a.id||null,actorName:a.name||"ไม่ทราบชื่อ",role:a.role||null,hidden:false,
    createdAt:serverTimestamp(),createdAtISO:new Date().toISOString(),authUid:state.authUid
  }),5000,"บันทึกประวัติ"); }catch(e){ console.warn("audit",e); }
}
async function afterWrite(name){
  const mode=state.settings.autoBackup?.mode||"off"; if(mode!=="onAction"&&mode!=="both") return;
  if(isOwner()){
    clearTimeout(state.backupDebounce);state.backupDebounce=setTimeout(()=>performBackup(`auto_${name}`,true).catch(console.warn),12000);
  }else{
    // ไม่รอการสร้างคำขอสำรอง เพื่อไม่ให้หน้าบันทึกค้าง
    addDoc(collection(state.db,"backupsMetadata"),{pending:true,reason:`action_${name}`,createdAt:serverTimestamp(),createdBy:state.currentUser?.id||null,createdByName:state.currentUser?.name||"ระบบ"}).catch(e=>console.warn("backup request",e));
  }
}

const NAV=[
  {id:"dashboard",label:"แดชบอร์ด",icon:"🏠",roles:["owner","manager"]},
  {id:"sales",label:"ยอดขาย",icon:"🧾",roles:["owner","manager","supervisor","front_staff"]},
  {id:"attendance",label:"ลงทำงาน",icon:"✅",roles:Object.keys(ROLE_LABELS)},
  {id:"monthly",label:"รายเดือน",icon:"📅",roles:Object.keys(ROLE_LABELS)},
  {id:"advances",label:"เบิกล่วงหน้า",icon:"💸",roles:Object.keys(ROLE_LABELS)},
  {id:"compensation",label:"ค่าตอบแทน",icon:"💰",roles:["owner","manager"]},
  {id:"ownerExpenses",label:"ลงรายจ่าย",icon:"🗂️",roles:["owner","manager"]},
  {id:"history",label:"ประวัติ",icon:"🕘",roles:["owner","manager"]},
  {id:"systemHistory",label:"ประวัติระบบ",icon:"🔒",roles:["owner"]},
  {id:"backup",label:"สำรอง",icon:"☁️",roles:["owner"]},
  {id:"users",label:"ผู้ใช้",icon:"👥",roles:["owner","manager","supervisor"]},
  {id:"settings",label:"ตั้งค่า",icon:"⚙️",roles:["owner"]}
];
function canAccessAdvances(user=state.currentUser){ return ["owner","manager"].includes(user?.role)||(state.settings.advanceAccessUserIds||[]).includes(user?.id); }
function visibleNavItems(){ return NAV.filter(n=>n.roles.includes(state.currentUser?.role)&&!(state.settings.hiddenPages||[]).includes(n.id)&&(n.id!=="advances"||canAccessAdvances())); }
function buildNav(){ const items=visibleNavItems(); $("#bottomNav").innerHTML=items.map(n=>`<button class="nav-item" data-page="${n.id}"><span>${n.icon}</span><b>${n.label}</b></button>`).join(""); $$(".nav-item").forEach(b=>b.onclick=()=>navigate(b.dataset.page)); }
async function navigate(page){
  const allowed=visibleNavItems().some(n=>n.id===page); if(!allowed) page=visibleNavItems()[0]?.id||"monthly";
  state.currentPage=page; const requestId=++state.navRequestId;
  // ยกเลิกผลลัพธ์จากหน้าก่อนหน้า ไม่ให้คำตอบช้ามาเขียนทับหน้าปัจจุบัน
  state.attendanceFormLoadSeq++; state.attendanceResultLoadSeq++; state.salesLoadSeq++;
  state.dashboardLoadSeq++; state.monthlyLoadSeq++; state.advancesLoadSeq++;
  state.compensationLoadSeq++; state.ownerExpensesLoadSeq++; state.historyLoadSeq++;
  $$(".nav-item").forEach(b=>{b.classList.toggle("active",b.dataset.page===page);b.disabled=b.dataset.page===page;});
  const map={dashboard:renderDashboard,sales:renderSales,attendance:renderAttendance,monthly:renderMonthly,advances:renderAdvances,compensation:renderCompensation,ownerExpenses:renderOwnerExpenses,history:()=>renderHistory("activity"),systemHistory:()=>renderHistory("system"),backup:renderBackup,users:renderUsers,settings:renderSettings};
  setLoading();
  try{ await withTimeout(Promise.resolve().then(()=>((map[page]||renderMonthly)())),30000,`โหลดหน้า ${page}`); }
  catch(e){
    console.error("navigate",page,e);
    if(requestId===state.navRequestId&&state.currentPage===page) content().innerHTML=`<div class="state error"><b>โหลดหน้านี้ไม่สำเร็จ</b><br>${escapeHtml(friendlyError(e))}<div style="margin-top:12px"><button class="btn secondary retry-page" type="button">ลองใหม่</button></div></div>`;
    $(".retry-page")&&($(".retry-page").onclick=()=>navigate(page));
  }finally{
    if(requestId===state.navRequestId){
      $$(".nav-item").forEach(b=>b.disabled=false);
      bindFriendlyNumberInputs(content());
      updateOnlineUi();
    }
  }
}
function pageTitle(title,sub=""){ return `<div class="page-title"><div><h2>${escapeHtml(title)}</h2>${sub?`<p>${escapeHtml(sub)}</p>`:""}</div><span class="pill muted">${escapeHtml(ROLE_LABELS[state.currentUser.role])}: ${escapeHtml(state.currentUser.name)}</span></div>`; }
function metricCards(items){ return `<div class="metrics">${items.map(x=>`<div class="metric"><small>${escapeHtml(x.label)}</small><b>${escapeHtml(x.value)}</b>${x.sub?`<span>${escapeHtml(x.sub)}</span>`:""}</div>`).join("")}</div>`; }
function drawBar(id,labels,values,label){ const el=document.getElementById(id); if(!el) return; if(window.Chart){ state.charts[id]?.destroy(); state.charts[id]=new Chart(el,{type:"bar",data:{labels,datasets:[{label,data:values}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}); } }
async function cachedQuery(key,loader,maxAgeMs=30000){
  const hit=state.dataCache.get(key),now=Date.now();
  if(hit?.data && now-hit.time<maxAgeMs) return hit.data.map(x=>({...x}));
  if(hit?.promise) return hit.promise;
  const promise=Promise.resolve().then(loader).then(data=>{
    state.dataCache.set(key,{data,time:Date.now()});
    return data.map(x=>({...x}));
  }).catch(err=>{ state.dataCache.delete(key); throw err; });
  state.dataCache.set(key,{promise,time:now});
  return promise;
}
async function docsByMonth(name,monthKey,{force=false}={}){
  const key=`${name}|month|${monthKey}`; if(force) state.dataCache.delete(key);
  return cachedQuery(key,async()=>{ const snap=await getDocsResilient(query(collection(state.db,name),where("monthKey","==",monthKey)),`โหลด ${name} เดือน ${monthKey}`); return snap.docs.map(d=>({id:d.id,...d.data()})); });
}
async function docsByMonthForUser(name,monthKey,userId,{force=false}={}){
  // ใช้ query เดือนเดียวแล้วกรองพนักงานในเครื่อง เพื่อลดจุดล้มเหลวและไม่บังคับสร้าง Composite Index เพิ่ม
  // ร้านมีประมาณ 10 คน ข้อมูลสูงสุดราว 310 รายการ/เดือน จึงยังโหลดเร็วและเสถียรกว่าการรอ index ที่อาจยังไม่ได้ Deploy
  const key=`${name}|month-user|${monthKey}|${userId}`; if(force) state.dataCache.delete(key);
  return cachedQuery(key,async()=>{
    const rows=await docsByMonth(name,monthKey,{force});
    return rows.filter(row=>row.userId===userId);
  });
}
async function allDocs(name,{force=false}={}){
  const key=`${name}|all`; if(force) state.dataCache.delete(key);
  return cachedQuery(key,async()=>{ const snap=await getDocsResilient(collection(state.db,name),`โหลด ${name}`); return snap.docs.map(d=>({id:d.id,...d.data()})); });
}
function saleExpenseCash(s){ return (s.expenses||[]).filter(e=>!e.ownerTransfer).reduce((a,e)=>a+numberValue(e.amount),0); }
function saleExpenseTotal(s){ return (s.expenses||[]).reduce((a,e)=>a+numberValue(e.amount),0); }

async function renderDashboard(){
  if(!isOwnerOrManager()) return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์</div>`;
  const start=`${currentMonthKey()}-01`,end=todayISO();
  content().innerHTML=`${pageTitle("แดชบอร์ด","ภาพรวมรายได้และค่าใช้จ่ายของร้าน")}
  <div class="panel"><div class="grid three"><div class="field"><label>ตั้งแต่วันที่</label><input id="dashStart" type="date" value="${start}"></div><div class="field"><label>ถึงวันที่</label><input id="dashEnd" type="date" value="${end}"></div><div class="field"><label>&nbsp;</label><button id="dashLoad" type="button" class="btn">แสดงผล</button></div></div></div><div id="dashResult"><div class="loading">กำลังคำนวณ...</div></div>`;
  $("#dashLoad").onclick=()=>loadDashboard().catch(err=>showToast(friendlyError(err)));
  loadDashboard().catch(err=>{if(state.currentPage==="dashboard"&&$("#dashResult"))$("#dashResult").innerHTML=`<div class="state error">${escapeHtml(friendlyError(err))}</div>`;});
}

async function recurringTotalForMonth(monthKey){
  const monthly=await docsByMonth("recurringExpenseMonths",monthKey);
  if(monthly.length) return monthly.reduce((s,x)=>s+numberValue(x.amount),0);
  const templates=(await allDocs("recurringExpenseTemplates")).filter(x=>x.active!==false);
  return templates.reduce((s,x)=>s+numberValue(x.amount),0);
}
async function compensationCostForMonth(monthKey){
  const data=await calculateCompensationMonth(monthKey,{includeManual:true});
  return data.rows.reduce((s,x)=>s+numberValue(x.totalCost),0);
}
async function loadDashboard(){
  const start=$("#dashStart")?.value,end=$("#dashEnd")?.value,result=$("#dashResult"); if(!result)return;
  if(!start||!end||start>end) return showToast("ช่วงวันที่ไม่ถูกต้อง");
  const seq=++state.dashboardLoadSeq,requestId=state.navRequestId; result.innerHTML=`<div class="loading">กำลังคำนวณ...</div>`;
  const months=[]; for(let m=monthOf(start);m<=monthOf(end);m=nextMonthKey(m)) months.push(m);
  const [allSales,otherExp]=await Promise.all([Promise.all(months.map(m=>docsByMonth("dailySales",m))),Promise.all(months.map(m=>docsByMonth("ownerExpenses",m)))]);
  if(seq!==state.dashboardLoadSeq||!pageStillActive("dashboard",requestId)||!$("#dashResult"))return;
  const sales=allSales.flat().filter(s=>s.date>=start&&s.date<=end&&!s.closed);
  const ownerOther=otherExp.flat().filter(x=>x.date>=start&&x.date<=end).reduce((sum,x)=>sum+numberValue(x.amount),0);
  const monthlyCosts=await Promise.all(months.map(async m=>({recurring:await recurringTotalForMonth(m),comp:await compensationCostForMonth(m)})));
  if(seq!==state.dashboardLoadSeq||!pageStillActive("dashboard",requestId)||!$("#dashResult"))return;
  const recurring=monthlyCosts.reduce((sum,x)=>sum+x.recurring,0),compCost=monthlyCosts.reduce((sum,x)=>sum+x.comp,0);
  const income=sales.reduce((sum,x)=>sum+numberValue(x.netIncome),0),saleExpenses=sales.reduce((sum,x)=>sum+saleExpenseTotal(x),0),ownerCash=sales.reduce((sum,x)=>sum+numberValue(x.ownerCashOut),0);
  const ownerEntered=ownerOther+recurring+compCost,margin=numberValue(state.settings.dashboardMarginRate||.4),net=income*margin-saleExpenses-ownerEntered;
  const dayMap={}; sales.forEach(s=>dayMap[s.date]=(dayMap[s.date]||0)+numberValue(s.netIncome)); const dates=Object.keys(dayMap).sort();
  $("#dashResult").innerHTML=`${metricCards([
    {label:"รายได้รวม",value:`${money(income)} บาท`,sub:`${thaiDate(start)} – ${thaiDate(end)}`},
    {label:"รายจ่ายจากยอดขาย",value:`${money(saleExpenses)} บาท`},
    {label:"รายจ่ายเจ้าของลง",value:`${money(ownerEntered)} บาท`,sub:"รวมรายจ่ายประจำ ค่าตอบแทน และรายจ่ายอื่น"},
    {label:"เอาเงินสดให้เจ้าของ",value:`${money(ownerCash)} บาท`},
    {label:"รายได้หลังหักค่าใช้จ่าย",value:`${money(net)} บาท`,sub:`คิดส่วนคงเหลือ ${(margin*100).toFixed(0)}% ของรายได้`}
  ])}<div class="panel"><h3>รายได้รายวัน</h3><div class="canvas-box"><canvas id="dashChart"></canvas></div></div>
  <div class="panel"><h3>รายการยอดขายล่าสุด</h3>${salesTable(sales.sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,10))}</div>`;
  drawBar("dashChart",dates.map(d=>d.slice(8)),dates.map(d=>dayMap[d]),"รายได้");
}

function nextMonthKey(m){ const [y,mo]=m.split("-").map(Number); const d=new Date(y,mo,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }

/* ----------------------------- ยอดขายรายวัน ----------------------------- */
function salesTable(rows,{details=false}={}){
  if(!rows.length) return `<div class="empty">ยังไม่มีข้อมูล</div>`;
  return `<div class="table-wrap sales-table-wrap"><table class="sales-table"><thead><tr><th>วันที่</th><th>สถานะ</th><th class="money">อาหาร</th><th class="money">เครื่องดื่ม</th><th class="money">รายได้รวม</th><th class="money">รายจ่าย</th><th class="money">เงินสดให้เจ้าของ</th>${details?"<th>รายละเอียด</th>":""}</tr></thead><tbody>${rows.map((r,i)=>{
    if(r.closed) return `<tr class="sales-main-row closed-short-row"><td data-label="วันที่">${thaiDate(r.date)}</td><td data-label="สถานะ"><span class="pill warn">หยุดร้าน</span></td><td data-label="สรุป" colspan="${details?6:5}" class="closed-short-cell">${escapeHtml(r.note||"หยุดร้าน")}</td></tr>`;
    return `<tr class="sales-main-row"><td data-label="วันที่">${thaiDate(r.date)}</td><td data-label="สถานะ"><span class="pill ok">เปิดร้าน</span></td><td data-label="อาหาร" class="money">${money(r.foodSales)}</td><td data-label="เครื่องดื่ม" class="money">${money(r.drinkSales)}</td><td data-label="รายได้รวม" class="money"><b>${money(r.netIncome)}</b></td><td data-label="รายจ่าย" class="money">${money(saleExpenseTotal(r))}</td><td data-label="เงินสดให้เจ้าของ" class="money">${money(r.ownerCashOut)}</td>${details?`<td data-label="รายละเอียด"><button class="btn secondary small monthly-detail-btn" data-detail="${i}">แสดงรายละเอียด</button></td>`:""}</tr>
    ${details?`<tr class="monthly-detail-row hidden" data-detail="${i}"><td colspan="8" class="monthly-detail-cell">${saleDetailHtml(r)}</td></tr>`:""}`;
  }).join("")}</tbody></table></div>`;
}
function saleDetailHtml(r){
  const expenses=(r.expenses||[]);
  return `<div class="monthly-detail-card"><div class="monthly-detail-toolbar"><b>${thaiDate(r.date)}</b><button class="btn ghost small monthly-detail-close">ปิด</button></div>
  <div class="grid three detail-grid">
    <div class="detail-box"><small>ยอดขายรวม</small><b>${money(r.totalSales)} บาท</b><span>อาหาร ${money(r.foodSales)} · เครื่องดื่ม ${money(r.drinkSales)}</span></div>
    <div class="detail-box"><small>รายได้หลังส่วนลด</small><b>${money(r.netIncome)} บาท</b><span>ส่วนลด ${money(r.discount)}</span></div>
    <div class="detail-box"><small>ช่องทางรับเงิน</small><b>สด ${money(r.cashSales)} · โอน ${money(r.transferSales)}</b><span>ต่าง ${money(numberValue(r.cashSales)+numberValue(r.transferSales)-numberValue(r.netIncome))}</span></div>
    <div class="detail-box"><small>เบียร์</small><b>${money(r.beerBottles)} ขวด</b></div>
    <div class="detail-box"><small>เงินสดเปิด/ปิด</small><b>${money(r.cashOpen)} → ${money(r.cashClose)}</b><span>ขาด/เกิน ${money(r.cashDiff)}</span></div>
    <div class="detail-box"><small>เอาเงินสดให้เจ้าของ</small><b>${money(r.ownerCashOut)} บาท</b></div>
  </div>
  <div class="detail-section"><h4>รายจ่าย</h4>${expenses.length?`<div class="detail-mini-list">${expenses.map(e=>`<div class="detail-mini-item"><b>${escapeHtml(e.name||"รายจ่าย")}</b><span>${money(e.amount)} บาท</span><small>${e.ownerTransfer?"เจ้าของโอนเอง — ไม่หักเงินสด":"หักจากเงินสดในกะ"}${e.note?` · ${escapeHtml(e.note)}`:""}</small></div>`).join("")}</div>`:`<div class="empty compact">ไม่มีรายจ่าย</div>`}</div>
  ${(r.cashDiffReason||r.note)?`<div class="detail-notes">${r.cashDiffReason?`<div><b>สาเหตุเงินสดไม่ตรง:</b> ${escapeHtml(r.cashDiffReason)}</div>`:""}${r.note?`<div><b>หมายเหตุ:</b> ${escapeHtml(r.note)}</div>`:""}</div>`:""}</div>`;
}
function bindMonthlyDetails(){
  $$(".monthly-detail-btn").forEach(btn=>btn.onclick=()=>{ const row=$(`.monthly-detail-row[data-detail="${btn.dataset.detail}"]`); if(!row)return; const hidden=row.classList.toggle("hidden"); btn.textContent=hidden?"แสดงรายละเอียด":"ซ่อนรายละเอียด"; });
  $$(".monthly-detail-close").forEach(btn=>btn.onclick=()=>{ const row=btn.closest(".monthly-detail-row"); if(!row)return; row.classList.add("hidden"); const open=$(`.monthly-detail-btn[data-detail="${row.dataset.detail}"]`); if(open) open.textContent="แสดงรายละเอียด"; });
}
async function yesterdaySaleWarning(){
  const y=addDaysISO(todayISO(),-1); const s=await getDocResilient(doc(state.db,"dailySales",y),"ตรวจยอดขายเมื่อวาน");
  return s.exists()?"":`<div class="state warn"><b>เมื่อวานยังไม่ได้บันทึกยอดขายหรือกดหยุดร้าน</b><br>กรุณาย้อนกลับไปลงข้อมูลวันที่ ${thaiDate(y)}</div>`;
}
async function renderSales(){
  if(!["owner","manager","supervisor","front_staff"].includes(state.currentUser.role)) return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์ลงยอดขาย</div>`;
  const requestId=state.navRequestId;
  content().innerHTML=`${pageTitle("ยอดขาย","บันทึกยอดอาหาร เครื่องดื่ม เงินสด และรายจ่ายประจำวัน")}<div id="saleWarning"></div>
  <div class="panel daily-panel"><div class="grid three"><div class="field"><label>วันที่</label><input id="saleDate" type="date" value="${todayISO()}"><small id="saleThaiDate">${thaiDate(todayISO())}</small></div><div class="field"><label>&nbsp;</label><button id="loadSale" type="button" class="btn secondary">โหลดวันที่นี้</button></div><div class="field"><label>&nbsp;</label><span id="saleState" class="pill muted">กำลังตรวจข้อมูล...</span></div></div></div>
  <form id="saleForm">
    <section class="panel daily-section"><label class="check-item"><input id="saleClosed" type="checkbox"> วันนี้หยุดร้าน</label><div id="closedNoteBox" class="field hidden" style="margin-top:10px"><label>หมายเหตุวันหยุด</label><input id="closedNote" placeholder="เช่น หยุดประจำสัปดาห์"></div></section>
    <div id="openSaleFields">
      <section class="panel daily-section sales-section"><h3>🍜 ยอดขาย</h3><div class="grid three">
        <div class="field"><label>ยอดขายอาหาร</label><input id="foodSales" inputmode="decimal" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>ยอดขายเครื่องดื่ม</label><input id="drinkSales" inputmode="decimal" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>ยอดขายรวม</label><input id="totalSales" readonly value="0"></div>
        <div class="field"><label>ส่วนลด</label><input id="discount" inputmode="decimal" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>รายได้รวม</label><input id="netIncome" readonly value="0"></div>
        <div class="field"><label>ยอดขายเบียร์ (ขวด)</label><input id="beerBottles" inputmode="numeric" type="number" min="0" step="1" value="0"></div>
        <div class="field"><label>เงินสด</label><input id="cashSales" inputmode="decimal" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>เงินโอน</label><input id="transferSales" inputmode="decimal" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>เงินสด + โอน ต่างจากรายได้</label><input id="paymentDiff" readonly value="0"></div>
      </div></section>
      <section class="panel daily-section cash-section"><h3>💵 เงินสดในกะ</h3><div class="grid three">
        <div class="field important-field"><label>เงินสดเปิดกะ</label><input id="cashOpen" inputmode="decimal" type="number" step="0.01" value="0"><small>ระบบดึงจากยอดปิดกะล่าสุดก่อนหน้านี้ และแก้ไขได้</small></div>
        <div class="field"><label>เอาเงินสดให้เจ้าของ</label><input id="ownerCashOut" inputmode="decimal" type="number" min="0" step="0.01" value="0"></div>
        <div class="field"><label>เงินสดปิดกะ</label><input id="cashClose" inputmode="decimal" type="number" step="0.01" value="0"></div>
        <div class="field"><label>รายจ่ายหักเงินสด</label><input id="cashExpenses" readonly value="0"></div>
        <div class="field"><label>เงินสดที่ควรปิด</label><input id="cashShould" readonly value="0"></div>
        <div class="field"><label>ขาด / เกิน</label><input id="cashDiff" readonly value="0"></div>
      </div><div id="cashReasonBox" class="field hidden"><label>สาเหตุที่เงินสดไม่ตรง (จำเป็นก่อนบันทึกจริง)</label><textarea id="cashDiffReason" rows="2" placeholder="ระบุสาเหตุ"></textarea></div></section>
      <section class="panel daily-section"><div class="flex"><h3>🧾 รายจ่ายในวันนั้น</h3><button id="addExpense" type="button" class="btn secondary small">+ เพิ่มรายจ่าย</button></div><div id="expenseRows" class="expense-list"></div></section>
      <section class="panel"><div class="field"><label>หมายเหตุเพิ่มเติม</label><textarea id="saleNote" rows="2"></textarea></div></section>
    </div>
    <div class="sticky-save grid two"><button id="saveDraft" type="button" class="btn secondary write-action">บันทึกชั่วคราว</button><button id="saveSaleFinalBtn" type="submit" class="btn write-action">บันทึกยอดขายจริง</button></div>
  </form>`;
  $("#saleDate").onchange=()=>{ $("#saleThaiDate").textContent=thaiDate($("#saleDate").value); };
  $("#loadSale").onclick=()=>loadSaleDate().catch(showSaleLoadError); $("#saleClosed").onchange=toggleSaleClosed;
  ["foodSales","drinkSales","discount","cashSales","transferSales","cashOpen","ownerCashOut","cashClose"].forEach(id=>$("#"+id).addEventListener("input",recalcSale));
  $("#addExpense").onclick=()=>addExpenseRow(); $("#saveDraft").onclick=saveSaleDraft; $("#saleForm").onsubmit=saveSaleFinal;
  bindFriendlyNumberInputs($("#saleForm"));
  // แสดงหน้าให้ใช้ได้ทันที แล้วโหลดคำเตือน/ข้อมูลวันที่แบบไม่ขวางการเปลี่ยนหน้า
  yesterdaySaleWarning().then(html=>{ if(pageStillActive("sales",requestId)&&$("#saleWarning")) $("#saleWarning").innerHTML=html; }).catch(err=>console.warn("yesterday warning",err));
  loadSaleDate().catch(showSaleLoadError);
}
function showSaleLoadError(err){
  console.error("sale load",err); if(state.currentPage!=="sales") return;
  const stateEl=$("#saleState"); if(stateEl){ stateEl.textContent="โหลดไม่สำเร็จ — กดลองใหม่"; stateEl.className="pill warn"; }
  showToast(friendlyError(err));
}

function toggleSaleClosed(){ const closed=$("#saleClosed").checked; $("#openSaleFields").classList.toggle("hidden",closed); $("#closedNoteBox").classList.toggle("hidden",!closed); }
function expenseRowHtml(e={}){ return `<div class="expense-row panel inner-panel" data-id="${escapeHtml(e.id||uid("exp"))}"><div class="grid three"><div class="field"><label>รายการ</label><input class="expense-name" value="${escapeHtml(e.name||"")}" placeholder="เช่น ซื้อวัตถุดิบ"></div><div class="field"><label>จำนวนเงิน</label><input class="expense-amount" type="number" min="0" step="0.01" value="${numberValue(e.amount)}"></div><div class="field"><label>หมายเหตุ</label><input class="expense-note" value="${escapeHtml(e.note||"")}"></div></div><div class="flex"><label class="check-item compact-check"><input class="expense-owner-transfer" type="checkbox" ${e.ownerTransfer?"checked":""}> เจ้าของโอนเอง ไม่หักเงินสด</label><button type="button" class="btn danger small remove-expense right">ลบ</button></div></div>`; }
function addExpenseRow(e={}){ $("#expenseRows").insertAdjacentHTML("beforeend",expenseRowHtml(e)); const row=$("#expenseRows .expense-row:last-child"); row.querySelectorAll("input").forEach(i=>i.addEventListener("input",recalcSale)); bindFriendlyNumberInputs(row); row.querySelector(".remove-expense").onclick=()=>{row.remove();recalcSale();}; }
function collectExpenses(){ return $$("#expenseRows .expense-row").map(r=>({id:r.dataset.id,name:r.querySelector(".expense-name").value.trim(),amount:numberValue(r.querySelector(".expense-amount").value),note:r.querySelector(".expense-note").value.trim(),ownerTransfer:r.querySelector(".expense-owner-transfer").checked})).filter(e=>e.name||e.amount); }
function recalcSale(){
  const food=numberValue($("#foodSales")?.value),drink=numberValue($("#drinkSales")?.value),discount=numberValue($("#discount")?.value),cash=numberValue($("#cashSales")?.value),transfer=numberValue($("#transferSales")?.value);
  const total=food+drink,net=total-discount,expenses=collectExpenses(),cashExp=expenses.filter(e=>!e.ownerTransfer).reduce((s,e)=>s+e.amount,0);
  const should=numberValue($("#cashOpen")?.value)+cash-cashExp-numberValue($("#ownerCashOut")?.value),diff=numberValue($("#cashClose")?.value)-should;
  if($("#totalSales")) $("#totalSales").value=money(total); if($("#netIncome")) $("#netIncome").value=money(net); if($("#paymentDiff")) $("#paymentDiff").value=money(cash+transfer-net);
  if($("#cashExpenses")) $("#cashExpenses").value=money(cashExp); if($("#cashShould")) $("#cashShould").value=money(should); if($("#cashDiff")) $("#cashDiff").value=money(diff);
  $("#cashReasonBox")?.classList.toggle("hidden",Math.abs(diff)<0.005);
}
async function previousCashClose(date){
  // ค้นยอดปิดกะล่าสุดที่ร้านเปิด ย้อนหลังได้ถึง 12 เดือน แต่โหลดครั้งละ 3 เดือนเพื่อลดการรอ/จำนวนครั้งอ่าน
  let month=monthOf(date);
  for(let batch=0;batch<4;batch++){
    const months=[]; for(let i=0;i<3;i++){months.push(month);month=previousMonthKey(month);}
    const groups=await Promise.all(months.map(m=>docsByMonth("dailySales",m)));
    const prev=groups.flat().filter(r=>r.date<date&&!r.closed).sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
    if(prev) return numberValue(prev.cashClose);
  }
  return 0;
}
function fillSaleForm(d={}){
  const set=(id,v)=>{if($("#"+id)) $("#"+id).value=v??"";};
  $("#saleClosed").checked=!!d.closed; set("closedNote",d.note||""); set("foodSales",numberValue(d.foodSales)); set("drinkSales",numberValue(d.drinkSales)); set("discount",numberValue(d.discount)); set("beerBottles",numberValue(d.beerBottles)); set("cashSales",numberValue(d.cashSales)); set("transferSales",numberValue(d.transferSales)); set("cashOpen",numberValue(d.cashOpen)); set("ownerCashOut",numberValue(d.ownerCashOut)); set("cashClose",numberValue(d.cashClose)); set("cashDiffReason",d.cashDiffReason||""); set("saleNote",d.note||"");
  $("#expenseRows").innerHTML=""; (d.expenses||[]).forEach(addExpenseRow); toggleSaleClosed(); recalcSale();
}
async function loadSaleDate(){
  const date=$("#saleDate")?.value; if(!date) return;
  const seq=++state.salesLoadSeq,requestId=state.navRequestId,loadBtn=$("#loadSale"),form=$("#saleForm");
  setButtonBusy(loadBtn,true,"กำลังโหลด..."); form?.classList.add("is-busy");
  if($("#saleState")){ $("#saleState").textContent="กำลังโหลด"; $("#saleState").className="pill muted"; }
  try{
    const [finalSnap,draftSnap]=await Promise.all([
      getDocResilient(doc(state.db,"dailySales",date),"โหลดยอดขายจริง",6500),
      getDocResilient(doc(state.db,"dailyDrafts",date),"โหลดยอดขายชั่วคราว",6500)
    ]);
    if(seq!==state.salesLoadSeq||!pageStillActive("sales",requestId)||$("#saleDate")?.value!==date) return;
    if(finalSnap.exists()){
      state.saleLoaded={type:"final",id:date,data:finalSnap.data()}; fillSaleForm(finalSnap.data());
      $("#saleState").textContent="มีข้อมูลจริง — แก้ไขได้"; $("#saleState").className="pill ok";
    }else if(draftSnap.exists()){
      state.saleLoaded={type:"draft",id:date,data:draftSnap.data()}; fillSaleForm(draftSnap.data());
      $("#saleState").textContent="มีฉบับชั่วคราว"; $("#saleState").className="pill warn";
    }else{
      const open=await previousCashClose(date);
      if(seq!==state.salesLoadSeq||!pageStillActive("sales",requestId)||$("#saleDate")?.value!==date) return;
      state.saleLoaded=null; fillSaleForm({cashOpen:open,cashClose:open,expenses:[]});
      $("#saleState").textContent=`รายการใหม่ · เปิดกะ ${money(open)} บาท`; $("#saleState").className="pill muted";
    }
    bindFriendlyNumberInputs($("#saleForm"));
  }finally{
    if(seq===state.salesLoadSeq&&pageStillActive("sales",requestId)){
      form?.classList.remove("is-busy"); setButtonBusy(loadBtn,false);
    }
  }
}

function collectSaleData({draft=false}={}){
  const date=$("#saleDate").value,closed=$("#saleClosed").checked;
  if(closed) return {date,monthKey:monthOf(date),closed:true,note:$("#closedNote").value.trim(),foodSales:0,drinkSales:0,totalSales:0,discount:0,netIncome:0,cashSales:0,transferSales:0,beerBottles:0,cashOpen:0,cashClose:0,ownerCashOut:0,expenses:[],cashDiff:0,cashDiffReason:"",draft,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id,updatedByName:state.currentUser.name};
  const food=numberValue($("#foodSales").value),drink=numberValue($("#drinkSales").value),discount=numberValue($("#discount").value),cash=numberValue($("#cashSales").value),transfer=numberValue($("#transferSales").value),expenses=collectExpenses(),cashOpen=numberValue($("#cashOpen").value),cashClose=numberValue($("#cashClose").value),ownerCashOut=numberValue($("#ownerCashOut").value),cashExp=expenses.filter(e=>!e.ownerTransfer).reduce((s,e)=>s+e.amount,0),cashShould=cashOpen+cash-cashExp-ownerCashOut,cashDiff=cashClose-cashShould;
  return {date,monthKey:monthOf(date),closed:false,foodSales:food,drinkSales:drink,totalSales:food+drink,discount,netIncome:food+drink-discount,cashSales:cash,transferSales:transfer,paymentDiff:cash+transfer-(food+drink-discount),beerBottles:numberValue($("#beerBottles").value),cashOpen,cashClose,ownerCashOut,expenses,cashExpenseTotal:cashExp,totalExpense:saleExpenseTotal({expenses}),cashShould,cashDiff,cashDiffReason:$("#cashDiffReason").value.trim(),note:$("#saleNote").value.trim(),draft,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id,updatedByName:state.currentUser.name};
}
async function saveSaleDraft(){
  if(!requireOnline()) return; const button=$("#saveDraft"); setButtonBusy(button,true,"กำลังบันทึก...");
  try{
    const d=collectSaleData({draft:true}); if(!d.date) return showToast("เลือกวันที่");
    const ref=doc(state.db,"dailyDrafts",d.date),before=await getDocResilient(ref,"ตรวจฉบับชั่วคราว",6000);
    await withTimeout(setDoc(ref,d,{merge:true}),12000,"บันทึกยอดขายชั่วคราว");
    invalidateDataCache("dailyDrafts");
    audit("บันทึกยอดขายชั่วคราว",{date:d.date},before.exists()?before.data():null,d).catch(console.warn);
    afterWrite("sale_draft").catch(console.warn);
    showToast("บันทึกชั่วคราวแล้ว ยังไม่รวมรายเดือน/ค่าตอบแทน"); state.saleLoaded={type:"draft",id:d.date,data:d};
    if($("#saleState")){ $("#saleState").textContent="มีฉบับชั่วคราว"; $("#saleState").className="pill warn"; }
  }catch(err){ console.error("saveSaleDraft",err); showToast(friendlyError(err)); }
  finally{ setButtonBusy(button,false); }
}
async function saveSaleFinal(e){
  e.preventDefault(); if(!requireOnline()) return; const button=e.submitter||$("#saveSaleFinalBtn"); setButtonBusy(button,true,"กำลังบันทึก...");
  try{
    const d=collectSaleData(); if(!d.date) return showToast("เลือกวันที่");
    if(!d.closed&&d.netIncome<0) return showToast("ส่วนลดมากกว่ายอดขายไม่ได้");
    if(!d.closed&&Math.abs(d.cashDiff)>=0.005&&!d.cashDiffReason) return showToast("เงินสดไม่ตรง กรุณากรอกสาเหตุ");
    const ref=doc(state.db,"dailySales",d.date),before=await getDocResilient(ref,"ตรวจยอดขายเดิม",6000);
    if(before.exists()&&!confirm(`วันที่ ${thaiDate(d.date)} มีข้อมูลแล้ว ยืนยันแก้ไขหรือไม่`)) return;
    const batch=writeBatch(state.db); batch.set(ref,d,{merge:false}); batch.delete(doc(state.db,"dailyDrafts",d.date));
    await withTimeout(batch.commit(),12000,"บันทึกยอดขายจริง");
    invalidateDataCache("dailySales"); invalidateDataCache("dailyDrafts");
    audit(before.exists()?"แก้ไขยอดขาย":"บันทึกยอดขาย",{date:d.date,closed:d.closed},before.exists()?before.data():null,d).catch(console.warn);
    afterWrite("sale").catch(console.warn);
    showToast("บันทึกยอดขายจริงแล้ว"); state.saleLoaded={type:"final",id:d.date,data:d};
    if($("#saleState")){ $("#saleState").textContent="มีข้อมูลจริง — แก้ไขได้"; $("#saleState").className="pill ok"; }
  }catch(err){ console.error("saveSaleFinal",err); showToast(friendlyError(err)); }
  finally{ setButtonBusy(button,false); }
}

/* ------------------------------ ลงวันทำงาน ------------------------------ */
function attendanceStatusLabel(v){ return ({full_day:"ทำงานทั้งวัน",hourly:"ทำงานรายชั่วโมง",off:"หยุด",vacation:"ลาพักผ่อน",sick:"ลาป่วย",personal:"ลากิจ",other:"อื่น ๆ"})[v]||v; }
function attendanceReasonRequired(v){ return ["sick","personal","other"].includes(v); }
function missingAttendanceDates(monthKey,rows){
  const today=todayISO(),current=monthOf(today); if(monthKey>current) return [];
  const end=monthKey===current?addDaysISO(today,-1):dateOfMonth(monthKey,daysInMonth(monthKey));
  const have=new Set(rows.map(r=>r.date)); const out=[]; for(let d=dateOfMonth(monthKey,1);d<=end;d=addDaysISO(d,1)) if(!have.has(d)) out.push(d); return out;
}
function workerOptions(selected=""){ return state.users.filter(u=>u.active!==false&&WORKER_ROLES.includes(u.role)).map(u=>`<option value="${u.id}" ${u.id===selected?"selected":""}>${escapeHtml(u.name)} — ${escapeHtml(ROLE_LABELS[u.role])}</option>`).join(""); }
function attendanceFormHtml(user){
  const daily=user.role==="daily",rotating=user.role==="rotating",regular=["front_kitchen","back_kitchen","front_staff"].includes(user.role);
  const statusOptions=daily
    ? `<option value="full_day">ทำงานทั้งวัน</option><option value="hourly">ทำงานรายชั่วโมง</option><option value="off">หยุด</option>`
    : `<option value="full_day">ทำงานทั้งวัน</option><option value="off">หยุด</option><option value="vacation">ลาพักผ่อน</option><option value="sick">ลาป่วย</option><option value="personal">ลากิจ</option><option value="other">อื่น ๆ</option>`;
  return `<form id="attendanceForm" class="panel"><h3>บันทึกวันทำงาน — ${escapeHtml(user.name)}</h3>
    <div class="grid three"><div class="field"><label>วันที่</label><input id="attDate" type="date" value="${todayISO()}"><small id="attThaiDate">${thaiDate(todayISO())}</small></div><div class="field"><label>สถานะ</label><select id="attStatus">${statusOptions}</select></div><div id="attReasonBox" class="field hidden"><label>สาเหตุ</label><input id="attReason" placeholder="กรุณาระบุสาเหตุ"></div></div>
    ${daily?`<div id="dailyHourBox" class="panel inner-panel hidden"><h3>เวลาทำงานรายชั่วโมง</h3><div class="grid two"><div class="field"><label>เริ่มงาน</label><select id="attStart">${timeOptions(11,24,"11:00")}</select></div><div class="field"><label>เลิกงาน</label><select id="attEnd">${timeOptions(11,24,"12:00")}</select></div></div></div>`:""}
    ${rotating?`<div id="rotatingBox" class="panel inner-panel"><h3>ร้านที่ทำงาน</h3><div class="field"><label>เลือกสถานที่</label><select id="workStore"><option value="Rendo">Rendo</option><option value="Love Matcha">Love Matcha</option></select></div></div>`:""}
    ${(regular||rotating)?`<div id="otBox" class="panel inner-panel"><label class="check-item"><input id="hasOT" type="checkbox"> ทำ OT Rendo ต่อ</label><div id="otTimeBox" class="grid two hidden" style="margin-top:10px"><div class="field"><label>เริ่ม OT</label><select id="otStart"></select></div><div class="field"><label>เลิก OT</label><select id="otEnd"></select></div></div><small id="otHint"></small></div>`:""}
    <div class="sticky-save"><button class="btn full write-action">บันทึกวันทำงาน</button></div></form>`;
}
async function renderAttendance(){
  const canViewAll=isAdminViewer(),canAdminEdit=isOwnerOrManager(),worker=isWorker();
  if(!canViewAll&&!worker) return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์</div>`;
  const first=canViewAll?state.users.find(u=>u.active!==false&&WORKER_ROLES.includes(u.role)):state.currentUser;
  content().innerHTML=`${pageTitle("ลงวันทำงาน",canViewAll?"ตรวจสอบการลงวันทำงานของพนักงานทุกคน":"เห็นเฉพาะข้อมูลของตัวเอง")}
    <div class="panel"><div class="grid three"><div class="field"><label>เดือน</label><input id="attMonth" type="month" value="${currentMonthKey()}"></div><div class="field"><label>พนักงาน</label><select id="attUser" ${canViewAll?"":"disabled"}>${canViewAll?workerOptions(first?.id):`<option value="${state.currentUser.id}">${escapeHtml(state.currentUser.name)}</option>`}</select></div><div class="field"><label>&nbsp;</label><button id="loadAttendance" type="button" class="btn secondary">โหลดข้อมูล</button></div></div></div>
    <div id="attFormBox">${(worker||canAdminEdit)&&first?attendanceFormHtml(first):`<div class="state ok">หัวหน้าดูข้อมูลได้ แต่ไม่ต้องลงวันทำงานของตนเอง</div>`}</div><div id="attResult"><div class="loading">กำลังโหลดรายการ...</div></div>`;
  const requestId=state.navRequestId;
  $("#loadAttendance").onclick=()=>refreshAttendancePage().catch(showAttendanceError);
  $("#attMonth").onchange=()=>loadAttendanceResult().catch(showAttendanceError);
  $("#attUser").onchange=()=>refreshAttendancePage().catch(showAttendanceError);
  bindFriendlyNumberInputs(content());
  // ไม่บล็อกการเปิดหน้า: แบบฟอร์มและรายการโหลดแยกกันโดยมีเลขลำดับคนละชุด
  bindAttendanceForm().catch(showAttendanceError);
  loadAttendanceResult().catch(showAttendanceError);
  if(!pageStillActive("attendance",requestId)) return;
}
function showAttendanceError(err){
  console.error("attendance",err);
  if(state.currentPage!=="attendance") return;
  const box=$("#attResult");
  if(box && box.querySelector(".loading")) box.innerHTML=`<div class="state error"><b>โหลดรายการไม่สำเร็จ</b><br>${escapeHtml(friendlyError(err))}<div style="margin-top:10px"><button id="retryAttendance" type="button" class="btn secondary">ลองใหม่</button></div></div>`;
  $("#retryAttendance")&&($("#retryAttendance").onclick=()=>loadAttendanceResult().catch(showAttendanceError));
  showToast(friendlyError(err));
}
function selectedAttendanceUser(){ return state.users.find(u=>u.id===$("#attUser")?.value)||state.currentUser; }
async function bindAttendanceForm(){
  const form=$("#attendanceForm"); if(!form) return;
  const dateInput=$("#attDate"),status=$("#attStatus");
  dateInput.onchange=()=>{
    const label=$("#attThaiDate"); if(label) label.textContent=thaiDate(dateInput.value);
    loadAttendanceIntoForm().catch(showAttendanceError);
  };
  status.onchange=updateAttendanceFields;
  $("#workStore")&&($("#workStore").onchange=updateAttendanceFields);
  $("#hasOT")&&($("#hasOT").onchange=updateAttendanceFields);
  form.onsubmit=saveAttendance;
  updateAttendanceFields();
  bindFriendlyNumberInputs(form);
  await loadAttendanceIntoForm();
}
async function refreshAttendancePage(){
  const pageRequest=state.navRequestId,user=selectedAttendanceUser(); if(!user||state.currentPage!=="attendance") return;
  const canEdit=isOwnerOrManager()||user.id===state.currentUser.id,box=$("#attFormBox"); if(!box) return;
  // ยกเลิกเฉพาะงานโหลดแบบฟอร์มเก่า ไม่แตะงานโหลดรายการ
  state.attendanceFormLoadSeq++;
  box.innerHTML=canEdit?attendanceFormHtml(user):`<div class="state ok">หัวหน้าดูข้อมูลของ ${escapeHtml(user.name)} ได้ แต่การแก้ไขให้เจ้าของหรือผู้จัดการดำเนินการ</div>`;
  bindFriendlyNumberInputs(box);
  const jobs=[]; if(canEdit) jobs.push(bindAttendanceForm()); jobs.push(loadAttendanceResult());
  await Promise.allSettled(jobs);
  if(!pageStillActive("attendance",pageRequest)) return;
}
function updateAttendanceFields(){
  const user=selectedAttendanceUser(),status=$("#attStatus")?.value; if(!user) return;
  $("#attReasonBox")?.classList.toggle("hidden",!attendanceReasonRequired(status));
  $("#dailyHourBox")?.classList.toggle("hidden",!(user.role==="daily"&&status==="hourly"));
  $("#rotatingBox")?.classList.toggle("hidden",!(user.role==="rotating"&&status==="full_day"));
  const mayOT=["front_kitchen","back_kitchen","front_staff","rotating"].includes(user.role)&&status==="full_day";
  $("#otBox")?.classList.toggle("hidden",!mayOT); const has=mayOT&&$("#hasOT")?.checked; $("#otTimeBox")?.classList.toggle("hidden",!has);
  if(mayOT&&$("#otStart")&&$("#otEnd")){
    const startHour=user.role==="rotating"&&$("#workStore")?.value==="Love Matcha"?18:22;
    const currentStart=$("#otStart").value,currentEnd=$("#otEnd").value;
    $("#otStart").innerHTML=timeOptions(startHour,24,currentStart||`${String(startHour).padStart(2,"0")}:00`);
    $("#otEnd").innerHTML=timeOptions(startHour,24,currentEnd||`${String(Math.min(startHour+1,24)).padStart(2,"0")}:00`);
    $("#otHint").textContent=`เลือกเวลาได้ทีละ 1 ชั่วโมง ตั้งแต่ ${String(startHour).padStart(2,"0")}:00–24:00`;
  }
}
function resetAttendanceFormDefaults(){
  if(!$("#attendanceForm")) return;
  $("#attStatus").value="full_day"; $("#attReason").value="";
  if($("#attStart")) $("#attStart").value="11:00"; if($("#attEnd")) $("#attEnd").value="12:00";
  if($("#workStore")) $("#workStore").value="Rendo"; if($("#hasOT")) $("#hasOT").checked=false;
  updateAttendanceFields();
}
async function loadAttendanceIntoForm(){
  const form=$("#attendanceForm"),user=selectedAttendanceUser(),date=$("#attDate")?.value;
  if(!form||!user||!date) return;
  const seq=++state.attendanceFormLoadSeq,requestId=state.navRequestId,button=form.querySelector('button[type="submit"]');
  let statusLine=form.querySelector(".att-record-state");
  if(!statusLine){ statusLine=document.createElement("div");statusLine.className="att-record-state loading-inline";form.querySelector("h3")?.insertAdjacentElement("afterend",statusLine); }
  statusLine.textContent="กำลังตรวจข้อมูลวันที่นี้..."; statusLine.className="att-record-state loading-inline";
  if(button) button.disabled=true;
  try{
    const snap=await getDocResilient(doc(state.db,"attendance",`${user.id}_${date}`),"โหลดวันทำงาน",6000);
    if(seq!==state.attendanceFormLoadSeq||!pageStillActive("attendance",requestId)||!$("#attendanceForm")) return;
    if(!snap.exists()){
      resetAttendanceFormDefaults(); statusLine.textContent="ยังไม่มีข้อมูลวันที่นี้ — พร้อมบันทึก"; statusLine.className="att-record-state ok-inline"; return;
    }
    const d=snap.data();
    $("#attStatus").value=d.status||"full_day"; $("#attReason").value=d.reason||"";
    if($("#attStart")) $("#attStart").value=d.startTime||"11:00"; if($("#attEnd")) $("#attEnd").value=d.endTime||"12:00";
    if($("#workStore")) $("#workStore").value=d.workStore||"Rendo"; if($("#hasOT")) $("#hasOT").checked=!!d.hasOT;
    updateAttendanceFields(); if($("#otStart")) $("#otStart").value=d.otStart||$("#otStart").value; if($("#otEnd")) $("#otEnd").value=d.otEnd||$("#otEnd").value;
    statusLine.textContent="พบข้อมูลเดิม — แก้ไขแล้วกดบันทึกได้"; statusLine.className="att-record-state warn-inline";
  }catch(err){
    if(seq!==state.attendanceFormLoadSeq||!pageStillActive("attendance",requestId)) return;
    statusLine.textContent=`โหลดข้อมูลเดิมไม่สำเร็จ: ${friendlyError(err)}`; statusLine.className="att-record-state error-inline";
    throw err;
  }finally{
    if(seq===state.attendanceFormLoadSeq&&pageStillActive("attendance",requestId)&&button) button.disabled=!state.online;
  }
}
async function saveAttendance(e){
  e.preventDefault(); if(!requireOnline()) return;
  const button=e.submitter||e.currentTarget.querySelector("button[type=submit]"); setButtonBusy(button,true,"กำลังบันทึก...");
  try{
    const user=selectedAttendanceUser(); if(!user) return showToast("ไม่พบพนักงาน");
    if(!(isOwnerOrManager()||user.id===state.currentUser.id)) return showToast("ไม่มีสิทธิ์แก้ไข");
    const date=$("#attDate")?.value,status=$("#attStatus")?.value,reason=$("#attReason")?.value.trim()||"";
    if(!date) return showToast("เลือกวันที่"); if(attendanceReasonRequired(status)&&!reason) return showToast("กรุณาระบุสาเหตุ");
    const d={userId:user.id,userName:user.name,role:user.role,date,monthKey:monthOf(date),status,reason,workStore:"",startTime:"",endTime:"",hasOT:false,otStart:"",otEnd:"",otHours:0,paidDaily:false,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id,updatedByName:state.currentUser.name};
    const ref=doc(state.db,"attendance",`${user.id}_${date}`),existing=await getDocResilient(ref,"ตรวจข้อมูลวันทำงาน",6000); if(existing.exists()) d.paidDaily=!!existing.data().paidDaily;
    if(user.role==="daily"&&status==="hourly"){
      d.startTime=$("#attStart").value; d.endTime=$("#attEnd").value;
      if(minutesFromTime(d.endTime)<=minutesFromTime(d.startTime)) return showToast("เวลาเลิกงานต้องมากกว่าเวลาเริ่ม");
    }
    if(user.role==="rotating"&&status==="full_day") d.workStore=$("#workStore").value;
    if(["front_kitchen","back_kitchen","front_staff","rotating"].includes(user.role)&&status==="full_day"&&$("#hasOT")?.checked){
      d.hasOT=true; d.otStart=$("#otStart").value; d.otEnd=$("#otEnd").value;
      if(minutesFromTime(d.otEnd)<=minutesFromTime(d.otStart)) return showToast("เวลาเลิก OT ต้องมากกว่าเวลาเริ่ม");
      d.otHours=(minutesFromTime(d.otEnd)-minutesFromTime(d.otStart))/60;
    }
    await withTimeout(setDoc(ref,d,{merge:false}),12000,"บันทึกวันทำงาน");
    invalidateDataCache("attendance");
    showToast("บันทึกวันทำงานแล้ว");
    audit(existing.exists()?"แก้ไขวันทำงาน":"ลงวันทำงาน",{user:user.name,date,status:attendanceStatusLabel(status)},existing.exists()?existing.data():null,d).catch(console.warn);
    afterWrite("attendance").catch(console.warn);
    loadAttendanceResult({force:true}).catch(err=>{console.warn(err);showToast("บันทึกแล้ว แต่โหลดรายการใหม่ไม่สำเร็จ กดโหลดข้อมูลอีกครั้งได้");});
    loadAttendanceIntoForm().catch(console.warn);
  }catch(err){ console.error("saveAttendance",err); showToast(friendlyError(err)); }
  finally{ setButtonBusy(button,false); }
}
async function loadAttendanceResult({force=false}={}){
  const result=$("#attResult"),month=$("#attMonth")?.value||currentMonthKey(),user=selectedAttendanceUser(); if(!result||!user) return;
  const seq=++state.attendanceResultLoadSeq,requestId=state.navRequestId;
  result.innerHTML=`<div class="loading">กำลังโหลดรายการ...</div>`;
  try{
    // โหลดเฉพาะพนักงานที่เลือก ลดจำนวนข้อมูลและไม่แย่งกับการโหลดแบบฟอร์ม
    const rows=(await docsByMonthForUser("attendance",month,user.id,{force})).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    if(seq!==state.attendanceResultLoadSeq||!pageStillActive("attendance",requestId)||!$("#attResult")) return;
    const missing=missingAttendanceDates(month,rows);
    const summary={full:rows.filter(r=>r.status==="full_day").length,hourly:rows.filter(r=>r.status==="hourly").length,off:rows.filter(r=>r.status==="off").length,leave:rows.filter(r=>["vacation","sick","personal","other"].includes(r.status)).length,ot:rows.reduce((sum,r)=>sum+numberValue(r.otHours),0)};
    $("#attResult").innerHTML=`${missing.length?`<div class="state warn"><b>ยังไม่ได้ลงวันที่:</b> ${missing.map(d=>Number(d.slice(8))).join(", ")}</div>`:`<div class="state ok">ลงข้อมูลครบตามวันที่ผ่านมาแล้ว</div>`}
      ${metricCards([{label:"ทำงานทั้งวัน",value:`${summary.full} วัน`},{label:"รายชั่วโมง",value:`${summary.hourly} วัน`},{label:"หยุด",value:`${summary.off} วัน`},{label:"ลา/อื่น ๆ",value:`${summary.leave} วัน`},{label:"OT",value:`${money(summary.ot)} ชม.`}])}
      <div class="panel"><h3>รายการ ${thaiMonth(month)}</h3>${rows.length?`<div class="table-wrap"><table class="mobile-card-table"><thead><tr><th>วันที่</th><th>สถานะ</th><th>ร้าน/เวลา</th><th>OT</th><th>สาเหตุ</th></tr></thead><tbody>${rows.map(r=>`<tr><td data-label="วันที่">${thaiDate(r.date)}</td><td data-label="สถานะ">${attendanceStatusLabel(r.status)}</td><td data-label="ร้าน/เวลา">${r.status==="hourly"?`${escapeHtml(r.startTime)}–${escapeHtml(r.endTime)}`:escapeHtml(r.workStore||"-")}</td><td data-label="OT">${r.hasOT?`${escapeHtml(r.otStart)}–${escapeHtml(r.otEnd)} (${money(r.otHours)} ชม.)`:"-"}</td><td data-label="สาเหตุ">${escapeHtml(r.reason||"")}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ยังไม่มีข้อมูล</div>`}</div>`;
  }catch(err){
    if(seq!==state.attendanceResultLoadSeq||!pageStillActive("attendance",requestId)||!$("#attResult")) return;
    $("#attResult").innerHTML=`<div class="state error"><b>โหลดรายการไม่สำเร็จ</b><br>${escapeHtml(friendlyError(err))}<div style="margin-top:10px"><button id="retryAttendance" type="button" class="btn secondary">ลองใหม่</button></div></div>`;
    $("#retryAttendance").onclick=()=>loadAttendanceResult({force:true}).catch(showAttendanceError);
    throw err;
  }
}

/* -------------------------------- รายเดือน -------------------------------- */
async function renderMonthly(){
  const month=currentMonthKey(); content().innerHTML=`${pageTitle("รายเดือน","สรุปพนักงานที่ทำงานทั้งวัน ยอดขาย และเงินสดรายวัน")}
  <div class="panel"><div class="grid three"><div class="field"><label>เดือน</label><input id="monthlyMonth" type="month" value="${month}" ${isAdminViewer()?"":`min="${previousMonthKey()}" max="${currentMonthKey()}"`}></div><div class="field"><label>&nbsp;</label><button id="loadMonthly" class="btn secondary">แสดงรายเดือน</button></div><div class="field"><label>&nbsp;</label><span class="pill muted">ดูย้อนหลัง ${isAdminViewer()?"ได้ตลอด":"ไม่เกิน 1 เดือนก่อนหน้า"}</span></div></div></div><div id="monthlyResult"></div>`;
  const fail=e=>{console.error("monthly",e);if(state.currentPage==="monthly"&&$("#monthlyResult"))$("#monthlyResult").innerHTML=`<div class="state error"><b>โหลดรายเดือนไม่สำเร็จ</b><br>${escapeHtml(friendlyError(e))}</div>`;showToast(friendlyError(e));};
  $("#loadMonthly").onclick=()=>loadMonthly().catch(fail); $("#monthlyMonth").onchange=()=>loadMonthly().catch(fail); loadMonthly().catch(fail);
}
async function loadMonthly(){
  const month=$("#monthlyMonth")?.value; if(!month)return; if(!isAdminViewer()&&month<previousMonthKey()) return showToast("พนักงานดูย้อนหลังได้ไม่เกิน 1 เดือนก่อนหน้า");
  const seq=++state.monthlyLoadSeq; $("#monthlyResult").innerHTML=`<div class="loading">กำลังโหลดรายเดือน...</div>`;
  const [sales,attendance]=await Promise.all([docsByMonth("dailySales",month),docsByMonth("attendance",month)]); if(seq!==state.monthlyLoadSeq||state.currentPage!=="monthly"||!$("#monthlyResult"))return; const saleMap=Object.fromEntries(sales.map(s=>[s.date,s]));
  const rows=[]; for(let day=1;day<=daysInMonth(month);day++){
    const date=dateOfMonth(month,day),s=saleMap[date],att=attendance.filter(a=>a.date===date&&a.status==="full_day");
    const kitchen=att.filter(a=>KITCHEN_ROLES.includes(a.role)).map(a=>a.userName); const front=att.filter(a=>["front_staff","rotating","daily"].includes(a.role)).map(a=>a.userName);
    rows.push({date,s,kitchen,front});
  }
  const open=sales.filter(s=>!s.closed),tot={food:open.reduce((a,x)=>a+numberValue(x.foodSales),0),drink:open.reduce((a,x)=>a+numberValue(x.drinkSales),0),income:open.reduce((a,x)=>a+numberValue(x.netIncome),0),expenses:open.reduce((a,x)=>a+saleExpenseTotal(x),0),ownerCash:open.reduce((a,x)=>a+numberValue(x.ownerCashOut),0),beer:open.reduce((a,x)=>a+numberValue(x.beerBottles),0)};
  $("#monthlyResult").innerHTML=`${metricCards([{label:"ยอดขายอาหาร",value:`${money(tot.food)} บาท`},{label:"ยอดขายเครื่องดื่ม",value:`${money(tot.drink)} บาท`},{label:"รายได้รวม",value:`${money(tot.income)} บาท`},{label:"รายจ่ายรวม",value:`${money(tot.expenses)} บาท`},{label:"เงินสดให้เจ้าของ",value:`${money(tot.ownerCash)} บาท`},{label:"เบียร์",value:`${money(tot.beer)} ขวด`}])}
  <div class="panel"><h3>${thaiMonth(month)}</h3><div class="table-wrap monthly-rendo-wrap"><table class="monthly-rendo-table"><thead><tr><th>วันที่</th><th>ครัว (ทำงานทั้งวัน)</th><th>หน้าร้าน (ทำงานทั้งวัน)</th><th class="money">อาหาร</th><th class="money">เครื่องดื่ม</th><th class="money">รายได้รวม</th><th class="money">รายจ่าย</th><th class="money">เงินสดให้เจ้าของ</th><th>รายละเอียด</th></tr></thead><tbody>${rows.map((r,i)=>{
    const s=r.s;
    if(s?.closed) return `<tr class="closed-short-row"><td>${thaiDate(r.date)}</td><td colspan="8" class="closed-short-cell"><b>หยุดร้าน</b>${s.note?` · ${escapeHtml(s.note)}`:""}</td></tr>`;
    return `<tr><td>${thaiDate(r.date)}</td><td>${r.kitchen.map(escapeHtml).join(", ")||"-"}</td><td>${r.front.map(escapeHtml).join(", ")||"-"}</td><td class="money">${s?money(s.foodSales):"-"}</td><td class="money">${s?money(s.drinkSales):"-"}</td><td class="money">${s?money(s.netIncome):"-"}</td><td class="money">${s?money(saleExpenseTotal(s)):"-"}</td><td class="money">${s?money(s.ownerCashOut):"-"}</td><td>${s?`<button class="btn secondary small monthly-detail-btn" data-detail="${i}">แสดงรายละเอียด</button>`:`<span class="pill muted">ยังไม่ลง</span>`}</td></tr>
    ${s?`<tr class="monthly-detail-row hidden" data-detail="${i}"><td colspan="9" class="monthly-detail-cell">${saleDetailHtml(s)}</td></tr>`:""}`;
  }).join("")}</tbody><tfoot><tr><th colspan="3">รวมทั้งเดือน</th><th class="money">${money(tot.food)}</th><th class="money">${money(tot.drink)}</th><th class="money">${money(tot.income)}</th><th class="money">${money(tot.expenses)}</th><th class="money">${money(tot.ownerCash)}</th><th></th></tr></tfoot></table></div></div>`;
  bindMonthlyDetails();
}

/* ----------------------------- เบิกเงินล่วงหน้า ----------------------------- */
async function renderAdvances(){
  if(!canAccessAdvances()) return content().innerHTML=`<div class="state error">เจ้าของยังไม่ได้เปิดสิทธิ์หน้านี้</div>`;
  const admin=isOwnerOrManager(),selected=admin?(state.users.find(u=>u.active!==false&&WORKER_ROLES.includes(u.role))?.id||""):state.currentUser.id;
  content().innerHTML=`${pageTitle("เบิกเงินล่วงหน้า","เก็บวันที่ จำนวนเงิน และประวัติการเบิก")}
  <form id="advanceForm" class="panel"><h3>เพิ่มรายการ</h3><div class="grid four"><div class="field"><label>พนักงาน</label><select id="advanceUser" ${admin?"":"disabled"}>${admin?workerOptions(selected):`<option value="${state.currentUser.id}">${escapeHtml(state.currentUser.name)}</option>`}</select></div><div class="field"><label>วันที่</label><input id="advanceDate" type="date" value="${todayISO()}"></div><div class="field"><label>จำนวนเงิน</label><input id="advanceAmount" type="number" min="0" step="0.01" value="0" required></div><div class="field"><label>หมายเหตุ</label><input id="advanceNote" placeholder="ถ้ามี"></div></div><button class="btn write-action">บันทึกการเบิก</button></form>
  <div class="panel"><div class="grid three"><div class="field"><label>เดือน</label><input id="advanceMonth" type="month" value="${currentMonthKey()}"></div><div class="field"><label>กรองพนักงาน</label><select id="advanceFilter" ${admin?"":"disabled"}>${admin?`<option value="ALL">ทุกคน</option>${workerOptions("")}`:`<option value="${state.currentUser.id}">${escapeHtml(state.currentUser.name)}</option>`}</select></div><div class="field"><label>&nbsp;</label><button id="loadAdvances" type="button" class="btn secondary">โหลด</button></div></div><div id="advanceResult"><div class="loading">กำลังโหลด...</div></div></div>`;
  const fail=e=>{console.error("advances",e);if(state.currentPage==="advances"&&$("#advanceResult"))$("#advanceResult").innerHTML=`<div class="state error">${escapeHtml(friendlyError(e))}</div>`;showToast(friendlyError(e));};
  $("#advanceForm").onsubmit=saveAdvance; $("#loadAdvances").onclick=()=>loadAdvances().catch(fail); $("#advanceMonth").onchange=()=>loadAdvances().catch(fail); $("#advanceFilter").onchange=()=>loadAdvances().catch(fail);
  bindFriendlyNumberInputs($("#advanceForm")); loadAdvances().catch(fail);
}
async function saveAdvance(e){
  e.preventDefault(); if(!requireOnline()) return; const button=e.submitter||e.currentTarget.querySelector('button[type="submit"]');setButtonBusy(button,true,"กำลังบันทึก...");
  try{
    const user=state.users.find(u=>u.id===$("#advanceUser")?.value),date=$("#advanceDate")?.value,amount=numberValue($("#advanceAmount")?.value),note=$("#advanceNote")?.value.trim()||"";
    if(!user||!date||amount<=0) return showToast("กรอกข้อมูลให้ครบ");
    const d={userId:user.id,userName:user.name,date,monthKey:monthOf(date),amount,note,createdBy:state.currentUser.id,createdByName:state.currentUser.name,createdAt:serverTimestamp(),createdAtISO:new Date().toISOString()};
    const ref=await withTimeout(addDoc(collection(state.db,"salaryAdvances"),d),12000,"บันทึกเงินเบิกล่วงหน้า");
    invalidateDataCache("salaryAdvances"); audit("บันทึกเบิกเงินล่วงหน้า",{user:user.name,date,amount},null,{id:ref.id,...d}).catch(console.warn); afterWrite("advance").catch(console.warn);
    $("#advanceAmount").value="0"; $("#advanceNote").value=""; showToast("บันทึกแล้ว"); loadAdvances({force:true}).catch(console.warn);
  }catch(err){console.error("saveAdvance",err);showToast(friendlyError(err));}
  finally{setButtonBusy(button,false);}
}
async function loadAdvances({force=false}={}){
  const result=$("#advanceResult"),month=$("#advanceMonth")?.value,filter=$("#advanceFilter")?.value;if(!result||!month)return;
  const seq=++state.advancesLoadSeq,requestId=state.navRequestId;result.innerHTML=`<div class="loading">กำลังโหลด...</div>`;
  let rows=isOwnerOrManager()?await docsByMonth("salaryAdvances",month,{force}):await docsByMonthForUser("salaryAdvances",month,state.currentUser.id,{force});
  if(seq!==state.advancesLoadSeq||!pageStillActive("advances",requestId)||!$("#advanceResult"))return;
  if(isOwnerOrManager()&&filter!=="ALL") rows=rows.filter(r=>r.userId===filter);
  rows.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const total=rows.reduce((sum,x)=>sum+numberValue(x.amount),0); $("#advanceResult").innerHTML=`${metricCards([{label:"ยอดเบิกรวม",value:`${money(total)} บาท`},{label:"จำนวนรายการ",value:`${rows.length} รายการ`}])}${rows.length?`<div class="table-wrap"><table class="mobile-card-table"><thead><tr><th>วันที่</th><th>พนักงาน</th><th class="money">จำนวน</th><th>หมายเหตุ</th><th>ผู้บันทึก</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td data-label="วันที่">${thaiDate(r.date)}</td><td data-label="พนักงาน">${escapeHtml(r.userName)}</td><td data-label="จำนวน" class="money">${money(r.amount)}</td><td data-label="หมายเหตุ">${escapeHtml(r.note||"")}</td><td data-label="ผู้บันทึก">${escapeHtml(r.createdByName||"")}</td><td data-label="จัดการ">${isOwnerOrManager()||r.createdBy===state.currentUser.id?`<button class="btn danger small delete-advance" data-id="${r.id}">ลบ</button>`:"-"}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ยังไม่มีรายการ</div>`}`;
  $$(".delete-advance").forEach(b=>b.onclick=async()=>{
    if(!requireOnline()||!confirm("ยืนยันลบรายการเบิกเงินนี้"))return; const row=rows.find(x=>x.id===b.dataset.id);
    try{await withTimeout(deleteDoc(doc(state.db,"salaryAdvances",b.dataset.id)),12000,"ลบรายการเบิกเงิน");invalidateDataCache("salaryAdvances");audit("ลบรายการเบิกเงิน",{user:row?.userName,date:row?.date,amount:row?.amount},row,null).catch(console.warn);afterWrite("delete_advance").catch(console.warn);await loadAdvances({force:true});}catch(err){showToast(friendlyError(err));}
  });
}

/* ------------------------------- ค่าตอบแทน ------------------------------- */
function mergeCompSettings(raw={}){
  const base=clone(state.settings.compensationDefaults||DEFAULT_COMP_SETTINGS);
  return {
    ...base,...raw,
    otRates:{...base.otRates,...(raw.otRates||{})},dailyPay:{...base.dailyPay,...(raw.dailyPay||{})},
    dailyBonus:{kitchen:{...base.dailyBonus.kitchen,...(raw.dailyBonus?.kitchen||{})},front:{...base.dailyBonus.front,...(raw.dailyBonus?.front||{})}},
    monthlyBonus:{kitchen:{...base.monthlyBonus.kitchen,...(raw.monthlyBonus?.kitchen||{})},front:{...base.monthlyBonus.front,...(raw.monthlyBonus?.front||{})}},
    socialSecurity:{...base.socialSecurity,...(raw.socialSecurity||{})}
  };
}
async function getCompMonthSettings(monthKey){ const snap=await getDocResilient(doc(state.db,"compensationMonthSettings",monthKey),"โหลดเรทค่าตอบแทน"); return mergeCompSettings(snap.exists()?snap.data():{}); }
function isRendoFullDay(a){ return a.status==="full_day" && (a.role!=="rotating" || a.workStore==="Rendo"); }
function dailyAttendancePay(a,settings){ if(a.status==="full_day") return numberValue(settings.dailyPay.fullDay); if(a.status==="hourly") return Math.max(0,(minutesFromTime(a.endTime)-minutesFromTime(a.startTime))/60)*numberValue(settings.dailyPay.hourly); return 0; }
async function calculateCompensationMonth(monthKey,{includeManual=true}={}){
  const [settings,attendance,sales,advances,saved]=await Promise.all([
    getCompMonthSettings(monthKey),docsByMonth("attendance",monthKey),docsByMonth("dailySales",monthKey),docsByMonth("salaryAdvances",monthKey),docsByMonth("compensationRecords",monthKey)
  ]);
  const savedMap=Object.fromEntries(saved.map(x=>[x.userId,x])),saleMap=Object.fromEntries(sales.filter(x=>!x.closed).map(x=>[x.date,x]));
  const beerShare={};
  for(const sale of sales.filter(x=>!x.closed&&numberValue(x.beerBottles)>0)){
    const workers=attendance.filter(a=>a.date===sale.date&&FRONT_BEER_ROLES.includes(a.role)&&isRendoFullDay(a));
    if(!workers.length) continue; const each=numberValue(sale.beerBottles)*numberValue(settings.beerPerBottle)/workers.length;
    workers.forEach(a=>beerShare[a.userId]=(beerShare[a.userId]||0)+each);
  }
  const userIds=new Set([...state.users.filter(u=>u.active!==false&&WORKER_ROLES.includes(u.role)).map(u=>u.id),...attendance.map(a=>a.userId),...saved.map(s=>s.userId)]);
  const rows=[];
  for(const userId of userIds){
    const user=state.users.find(u=>u.id===userId)||{id:userId,name:savedMap[userId]?.userName||userName(userId),role:savedMap[userId]?.role||"daily"}; if(!WORKER_ROLES.includes(user.role)) continue;
    const rec=includeManual?(savedMap[userId]||{}):{},att=attendance.filter(a=>a.userId===userId),fullDays=att.filter(isRendoFullDay);
    const isDaily=user.role==="daily";
    const salary=isDaily?0:numberValue(rec.salary ?? user.salary);
    const dailyWageBefore=att.reduce((s,a)=>s+dailyAttendancePay(a,settings),0);
    const dailyPaid=att.filter(a=>a.paidDaily).reduce((s,a)=>s+dailyAttendancePay(a,settings),0);
    const dailyWage=Math.max(0,dailyWageBefore-dailyPaid);
    const autoOT=SALARIED_ROLES.includes(user.role)?att.reduce((s,a)=>s+numberValue(a.otHours)*numberValue(settings.otRates[user.role]),0):0;
    let dailyBonus=0,dailyBonusEligibleDays=0,monthlySalesEligible=0,monthlyBonus=0;
    if(KITCHEN_ROLES.includes(user.role)){
      fullDays.forEach(a=>{ const sale=saleMap[a.date]; if(!sale)return; const amount=numberValue(sale.foodSales); monthlySalesEligible+=amount; if(amount>numberValue(settings.dailyBonus.kitchen.threshold)){dailyBonus+=numberValue(settings.dailyBonus.kitchen.amount);dailyBonusEligibleDays++;} });
      if(monthlySalesEligible>numberValue(settings.monthlyBonus.kitchen.threshold)) monthlyBonus=numberValue(settings.monthlyBonus.kitchen.amount);
    }else if(FRONT_BONUS_ROLES.includes(user.role)){
      fullDays.forEach(a=>{ const sale=saleMap[a.date]; if(!sale)return; const amount=numberValue(sale.drinkSales); monthlySalesEligible+=amount; if(amount>numberValue(settings.dailyBonus.front.threshold)){dailyBonus+=numberValue(settings.dailyBonus.front.amount);dailyBonusEligibleDays++;} });
      if(monthlySalesEligible>numberValue(settings.monthlyBonus.front.threshold)) monthlyBonus=numberValue(settings.monthlyBonus.front.amount);
    }
    const beerBonus=numberValue(beerShare[userId]);
    const extraOther=numberValue(rec.extraOther),outsideOT=numberValue(rec.outsideOT),deduction=numberValue(rec.deduction);
    const advancesTotal=advances.filter(a=>a.userId===userId).reduce((s,a)=>s+numberValue(a.amount),0);
    const fullDayAttendance=att.filter(a=>a.status==="full_day"),hourlyAttendance=att.filter(a=>a.status==="hourly");
    const fullDayCount=fullDayAttendance.length,hourlyDayCount=hourlyAttendance.length,hourlyHours=hourlyAttendance.reduce((sum,a)=>sum+Math.max(0,(minutesFromTime(a.endTime)-minutesFromTime(a.startTime))/60),0),otHours=att.reduce((sum,a)=>sum+numberValue(a.otHours),0),paidDailyCount=att.filter(a=>a.paidDaily&&["full_day","hourly"].includes(a.status)).length;
    const dailyFullDayEarned=fullDayAttendance.reduce((sum,a)=>sum+dailyAttendancePay(a,settings),0),dailyHourlyEarned=hourlyAttendance.reduce((sum,a)=>sum+dailyAttendancePay(a,settings),0);
    const ssBase=isDaily?0:Math.min(salary,numberValue(settings.socialSecurity.maxSalaryBase));
    const employeeSS=ssBase*numberValue(settings.socialSecurity.employeeRate)/100,employerSS=ssBase*numberValue(settings.socialSecurity.employerRate)/100;
    const basePay=isDaily?dailyWage:salary;
    const gross=basePay+autoOT+extraOther+outsideOT+dailyBonus+monthlyBonus+beerBonus;
    const netTransfer=gross-deduction-advancesTotal-employeeSS;
    const totalCost=gross-deduction+employerSS;
    rows.push({
      userId,userName:user.name,role:user.role,isDaily,monthKey,settings,
      salary,dailyWageBefore,dailyPaid,dailyWage,dailyFullDayEarned,dailyHourlyEarned,fullDayCount,hourlyDayCount,hourlyHours,paidDailyCount,otHours,
      dailyAttendance:att.filter(a=>["full_day","hourly"].includes(a.status)).sort((a,b)=>String(a.date).localeCompare(String(b.date))),
      autoOT,extraOther,extraOtherNote:rec.extraOtherNote||"",outsideOT,outsideOTNote:rec.outsideOTNote||"",
      dailyBonus,dailyBonusEligibleDays,monthlyBonus,monthlySalesEligible,beerBonus,deduction,deductionNote:rec.deductionNote||"",advances:advancesTotal,
      ssBase,employeeSS,employerSS,gross,netTransfer,totalCost,
      bankName:rec.bankName??user.bankName??"",bankAccountNumber:rec.bankAccountNumber??user.bankAccountNumber??"",
      updatedAt:rec.updatedAt||null
    });
  }
  rows.sort((a,b)=>(ROLE_ORDER[a.role]||99)-(ROLE_ORDER[b.role]||99)||String(a.userName).localeCompare(String(b.userName),"th"));
  return {monthKey,settings,rows,sales,attendance,advances};
}
function compSettingsHtml(s){
  return `<details class="panel comp-settings-panel"><summary><b>ตั้งค่าเรทและประกันสังคมของเดือนนี้</b><span>แตะเพื่อเปิด/ปิด</span></summary>
  <form id="compSettingsForm" class="comp-settings-form"><div class="state warn"><b>สำคัญ:</b> เจ้าของกรอกอัตราและเพดานฐานเงินเดือนประกันสังคมให้ตรงกฎหมายของเดือนนั้นได้เอง เมื่อกฎหมายเปลี่ยนให้แก้ช่องนี้แล้วกดบันทึก</div>
  <h4>ประกันสังคม</h4><div class="grid three social-security-grid"><div class="field"><label>อัตราฝ่ายลูกจ้าง (%)</label><input id="employeeSSRate" type="number" min="0" max="100" step="0.01" value="${numberValue(s.socialSecurity.employeeRate)}"></div><div class="field"><label>อัตราฝ่ายนายจ้าง (%)</label><input id="employerSSRate" type="number" min="0" max="100" step="0.01" value="${numberValue(s.socialSecurity.employerRate)}"></div><div class="field important-field"><label>เพดานฐานเงินเดือนสูงสุดที่ใช้คิดประกันสังคม (บาท)</label><input id="ssMaxBase" type="number" min="0" step="0.01" value="${numberValue(s.socialSecurity.maxSalaryBase)}" placeholder="กรอกเพดานตามกฎหมาย"><small>ตัวอย่าง: หากเงินเดือนสูงกว่าเพดาน ระบบจะคิดจากเพดานนี้</small></div></div>
  <h4>OT และค่าจ้างรายวัน</h4><div class="grid four"><div class="field"><label>OT ครัวหน้าร้าน / ชม.</label><input id="otFrontKitchen" type="number" min="0" value="${numberValue(s.otRates.front_kitchen)}"></div><div class="field"><label>OT ครัวหลังบ้าน / ชม.</label><input id="otBackKitchen" type="number" min="0" value="${numberValue(s.otRates.back_kitchen)}"></div><div class="field"><label>OT พนักงานหน้าร้าน / ชม.</label><input id="otFrontStaff" type="number" min="0" value="${numberValue(s.otRates.front_staff)}"></div><div class="field"><label>OT พนักงานเวียน / ชม.</label><input id="otRotating" type="number" min="0" value="${numberValue(s.otRates.rotating)}"></div></div>
  <div class="grid three"><div class="field"><label>ค่าจ้างรายวันทั้งวัน</label><input id="dailyFullRate" type="number" min="0" value="${numberValue(s.dailyPay.fullDay)}"></div><div class="field"><label>ค่าจ้างรายวันต่อชั่วโมง</label><input id="dailyHourRate" type="number" min="0" value="${numberValue(s.dailyPay.hourly)}"></div><div class="field"><label>โบนัสเบียร์ต่อขวด</label><input id="beerRate" type="number" min="0" step="0.01" value="${numberValue(s.beerPerBottle)}"></div></div>
  <h4>โบนัส</h4><div class="grid four"><div class="field"><label>โบนัสรายวันครัว: ยอดเกิน</label><input id="dailyKitchenThreshold" type="number" min="0" value="${numberValue(s.dailyBonus.kitchen.threshold)}"></div><div class="field"><label>ครัวได้ / วัน</label><input id="dailyKitchenAmount" type="number" min="0" value="${numberValue(s.dailyBonus.kitchen.amount)}"></div><div class="field"><label>โบนัสรายวันหน้าร้าน: ยอดเกิน</label><input id="dailyFrontThreshold" type="number" min="0" value="${numberValue(s.dailyBonus.front.threshold)}"></div><div class="field"><label>หน้าร้านได้ / วัน</label><input id="dailyFrontAmount" type="number" min="0" value="${numberValue(s.dailyBonus.front.amount)}"></div></div>
  <div class="grid four"><div class="field"><label>โบนัสรายเดือนครัว: ยอดเกิน</label><input id="monthlyKitchenThreshold" type="number" min="0" value="${numberValue(s.monthlyBonus.kitchen.threshold)}"></div><div class="field"><label>ครัวได้ / เดือน</label><input id="monthlyKitchenAmount" type="number" min="0" value="${numberValue(s.monthlyBonus.kitchen.amount)}"></div><div class="field"><label>โบนัสรายเดือนหน้าร้าน: ยอดเกิน</label><input id="monthlyFrontThreshold" type="number" min="0" value="${numberValue(s.monthlyBonus.front.threshold)}"></div><div class="field"><label>หน้าร้านได้ / เดือน</label><input id="monthlyFrontAmount" type="number" min="0" value="${numberValue(s.monthlyBonus.front.amount)}"></div></div>
  <div class="sticky-save"><button class="btn write-action">บันทึกเรท คำนวณใหม่ และใช้ต่อเดือนถัดไป</button></div></form></details>`;
}
function compCardHtml(r){
  return `<article class="panel comp-card" data-user-id="${r.userId}">
    <div class="flex comp-head"><div><h3>${escapeHtml(r.userName)}</h3>${roleBadge(r.role)}</div><div class="right"><span class="pill ok">โอน ${money(r.netTransfer)} บาท</span></div></div>
    <div class="grid four">
      ${r.isDaily?`<div class="field"><label>ค่าจ้างค้างจ่ายปลายเดือน</label><input class="comp-base" readonly value="${money(r.dailyWage)}"><small>ทั้งหมด ${money(r.dailyWageBefore)} · จ่ายรายวันแล้ว ${money(r.dailyPaid)}</small></div>`:`<div class="field"><label>เงินเดือน</label><input class="comp-salary" type="number" min="0" step="0.01" value="${r.salary}"></div>`}
      <div class="field"><label>OT จากวันทำงาน</label><input class="comp-auto-ot" readonly value="${money(r.autoOT)}"></div>
      <div class="field"><label>OT/เพิ่มอื่น ๆ</label><input class="comp-extra" type="number" step="0.01" value="${r.extraOther}"><input class="comp-extra-note" value="${escapeHtml(r.extraOtherNote)}" placeholder="รายละเอียด"></div>
      <div class="field"><label>OT นอกเวลา</label><input class="comp-outside" type="number" step="0.01" value="${r.outsideOT}"><input class="comp-outside-note" value="${escapeHtml(r.outsideOTNote)}" placeholder="รายละเอียด"></div>
    </div>
    <div class="grid four"><div class="field"><label>โบนัสรายวัน</label><input readonly value="${money(r.dailyBonus)}"></div><div class="field"><label>โบนัสรายเดือน</label><input readonly value="${money(r.monthlyBonus)}"><small>ยอดวันที่มีสิทธิ์ ${money(r.monthlySalesEligible)}</small></div><div class="field"><label>โบนัสเบียร์</label><input readonly value="${money(r.beerBonus)}"></div><div class="field"><label>เบิกล่วงหน้า</label><input readonly value="${money(r.advances)}"></div></div>
    <div class="grid four"><div class="field"><label>หักเงิน</label><input class="comp-deduction" type="number" min="0" step="0.01" value="${r.deduction}"><input class="comp-deduction-note" value="${escapeHtml(r.deductionNote)}" placeholder="รายละเอียดการหัก"></div><div class="field"><label>ประกันสังคมลูกจ้าง</label><input readonly value="${money(r.employeeSS)}"></div><div class="field"><label>ธนาคาร</label><input class="comp-bank" value="${escapeHtml(r.bankName)}" placeholder="ชื่อธนาคาร"></div><div class="field"><label>เลขบัญชี</label><input class="comp-account" inputmode="numeric" value="${escapeHtml(r.bankAccountNumber)}" placeholder="เลขบัญชี"></div></div>
    <div class="comp-summary-strip"><div><small>รวมรายรับ</small><b>${money(r.gross)}</b></div><div><small>ยอดโอนปลายเดือน</small><b>${money(r.netTransfer)}</b></div><div><small>ต้นทุนรวม + ปกส. นายจ้าง</small><b>${money(r.totalCost)}</b></div></div>
    <div class="flex comp-actions"><button class="btn save-comp write-action" type="button">บันทึกคนนี้</button><button class="btn secondary comp-pdf" type="button">ดู/แชร์ PDF</button>${r.isDaily?`<button class="btn secondary manage-paid-daily" type="button">จัดการวันที่จ่ายแล้ว</button>`:""}</div>
  </article>`;
}
function compPersonNavigatorHtml(data){
  const index=Math.min(Math.max(0,state.compSelectedIndex||0),Math.max(0,data.rows.length-1));
  return `<section class="panel comp-person-panel"><div class="comp-person-toolbar"><button id="compPrev" class="btn secondary" type="button" ${index<=0?"disabled":""}>← คนก่อนหน้า</button><div><small>กำลังดู</small><b id="compPersonCounter">${data.rows.length?`${index+1} / ${data.rows.length}`:"0 / 0"}</b></div><button id="compNext" class="btn secondary" type="button" ${index>=data.rows.length-1?"disabled":""}>คนถัดไป →</button></div><div id="compPersonTabs" class="comp-person-tabs" aria-label="เลือกพนักงาน">${data.rows.map((r,i)=>`<button class="comp-person-tab ${i===index?"active":""}" type="button" data-index="${i}"><span>${escapeHtml(r.userName)}</span><small>${escapeHtml(ROLE_LABELS[r.role]||r.role)}</small></button>`).join("")}</div><div id="compPersonContainer"></div></section>`;
}
function rememberCurrentCompDraft(){
  const card=$("#compPersonContainer .comp-card"); if(!card||!state.compData)return;
  try{state.compDrafts[card.dataset.userId]=rowFromCard(card);}catch(e){console.warn("remember draft",e);}
}
function bindCurrentCompCard(){
  const card=$("#compPersonContainer .comp-card"); if(!card)return;
  bindFriendlyNumberInputs(card);
  card.querySelector(".save-comp")?.addEventListener("click",()=>saveCompCard(card));
  card.querySelector(".comp-pdf")?.addEventListener("click",()=>openCompPdf(card));
  card.querySelector(".manage-paid-daily")?.addEventListener("click",()=>openPaidDailyModal(card.dataset.userId));
  card.querySelectorAll("input:not([readonly])").forEach(i=>i.addEventListener("input",()=>{refreshCompCard(card);state.compDrafts[card.dataset.userId]=rowFromCard(card);}));
}
function showCompPerson(index,{remember=true}={}){
  if(!state.compData||!$("#compPersonContainer"))return; if(remember)rememberCurrentCompDraft();
  const max=Math.max(0,state.compData.rows.length-1); state.compSelectedIndex=Math.min(Math.max(0,Number(index)||0),max);
  const base=state.compData.rows[state.compSelectedIndex];
  $("#compPersonContainer").innerHTML=base?compCardHtml(state.compDrafts[base.userId]||base):`<div class="empty">ยังไม่มีพนักงาน</div>`;
  $$(".comp-person-tab").forEach(b=>b.classList.toggle("active",Number(b.dataset.index)===state.compSelectedIndex));
  const active=$(`.comp-person-tab[data-index="${state.compSelectedIndex}"]`); active?.scrollIntoView({behavior:"smooth",block:"nearest",inline:"center"});
  if($("#compPersonCounter"))$("#compPersonCounter").textContent=state.compData.rows.length?`${state.compSelectedIndex+1} / ${state.compData.rows.length}`:"0 / 0";
  if($("#compPrev"))$("#compPrev").disabled=state.compSelectedIndex<=0;
  if($("#compNext"))$("#compNext").disabled=state.compSelectedIndex>=max;
  bindCurrentCompCard(); updateOnlineUi();
}
function bindCompPersonNavigation(){
  $$(".comp-person-tab").forEach(b=>b.onclick=()=>showCompPerson(Number(b.dataset.index)));
  $("#compPrev")&&($("#compPrev").onclick=()=>showCompPerson(state.compSelectedIndex-1));
  $("#compNext")&&($("#compNext").onclick=()=>showCompPerson(state.compSelectedIndex+1));
}
async function renderCompensation(){
  if(!isOwnerOrManager()) return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์</div>`;
  content().innerHTML=`${pageTitle("ค่าตอบแทน","ดูและแก้ไขทีละคน เลื่อนชื่อซ้าย–ขวาได้ พร้อม PDF และแชร์เข้า LINE")}
  <div class="panel"><div class="grid three"><div class="field"><label>เดือน</label><input id="compMonth" type="month" value="${currentMonthKey()}"></div><div class="field"><label>&nbsp;</label><button id="loadComp" class="btn secondary">คำนวณใหม่</button></div><div class="field"><label>&nbsp;</label><button id="saveAllComp" class="btn write-action">บันทึกทุกคน</button></div></div></div><div id="compResult"></div>`;
  const fail=e=>{console.error("compensation",e);if(state.currentPage==="compensation"&&$("#compResult"))$("#compResult").innerHTML=`<div class="state error"><b>โหลดค่าตอบแทนไม่สำเร็จ</b><br>${escapeHtml(friendlyError(e))}</div>`;showToast(friendlyError(e));};
  $("#loadComp").onclick=()=>loadCompensation().catch(fail); $("#compMonth").onchange=()=>{state.compSelectedIndex=0;state.compDrafts={};loadCompensation().catch(fail);}; $("#saveAllComp").onclick=saveAllCompensation; loadCompensation().catch(fail);
}
async function loadCompensation(){
  const month=$("#compMonth")?.value;if(!month)return;const seq=++state.compensationLoadSeq; $("#compResult").innerHTML=`<div class="loading">กำลังคำนวณค่าตอบแทน...</div>`; const data=await calculateCompensationMonth(month); if(seq!==state.compensationLoadSeq||state.currentPage!=="compensation"||!$("#compResult"))return; state.compData=data; state.compDrafts={}; state.compSelectedIndex=Math.min(state.compSelectedIndex||0,Math.max(0,data.rows.length-1));
  const totalNet=data.rows.reduce((s,r)=>s+r.netTransfer,0),totalCost=data.rows.reduce((s,r)=>s+r.totalCost,0);
  const legalWarning=numberValue(data.settings.socialSecurity.maxSalaryBase)<=0?`<div class="state error"><b>ยังไม่ได้กรอกเพดานฐานเงินเดือนสูงสุดสำหรับประกันสังคม</b><br>${isOwner()?"เปิดส่วนตั้งค่าเรทด้านล่าง กรอกเพดานตามกฎหมายของเดือนนี้ แล้วกดบันทึก":"กรุณาให้เจ้าของเป็นผู้ตั้งค่า"}</div>`:"";
  $("#compResult").innerHTML=`${legalWarning}${isOwner()?compSettingsHtml(data.settings):""}${metricCards([{label:"ยอดโอนรวมปลายเดือน",value:`${money(totalNet)} บาท`},{label:"ต้นทุนค่าตอบแทนรวม + ปกส. นายจ้าง",value:`${money(totalCost)} บาท`},{label:"พนักงาน",value:`${data.rows.length} คน`}])}${compPersonNavigatorHtml(data)}`;
  $("#compSettingsForm")&&($("#compSettingsForm").onsubmit=saveCompSettings); if($("#compSettingsForm"))bindFriendlyNumberInputs($("#compSettingsForm")); bindCompPersonNavigation(); showCompPerson(state.compSelectedIndex,{remember:false});
}
function rowFromCard(card){
  const base=state.compData.rows.find(r=>r.userId===card.dataset.userId),salary=base.isDaily?0:numberValue(card.querySelector(".comp-salary")?.value),extraOther=numberValue(card.querySelector(".comp-extra").value),outsideOT=numberValue(card.querySelector(".comp-outside").value),deduction=numberValue(card.querySelector(".comp-deduction").value);
  const ssBase=base.isDaily?0:Math.min(salary,numberValue(base.settings.socialSecurity.maxSalaryBase)),employeeSS=ssBase*numberValue(base.settings.socialSecurity.employeeRate)/100,employerSS=ssBase*numberValue(base.settings.socialSecurity.employerRate)/100,basePay=base.isDaily?base.dailyWage:salary,gross=basePay+base.autoOT+extraOther+outsideOT+base.dailyBonus+base.monthlyBonus+base.beerBonus,netTransfer=gross-deduction-base.advances-employeeSS,totalCost=gross-deduction+employerSS;
  return {...base,salary,extraOther,extraOtherNote:card.querySelector(".comp-extra-note").value.trim(),outsideOT,outsideOTNote:card.querySelector(".comp-outside-note").value.trim(),deduction,deductionNote:card.querySelector(".comp-deduction-note").value.trim(),bankName:card.querySelector(".comp-bank").value.trim(),bankAccountNumber:card.querySelector(".comp-account").value.trim(),ssBase,employeeSS,employerSS,gross,netTransfer,totalCost};
}
function refreshCompCard(card){ const r=rowFromCard(card),vals=card.querySelectorAll(".comp-summary-strip b"); vals[0].textContent=money(r.gross); vals[1].textContent=money(r.netTransfer); vals[2].textContent=money(r.totalCost); card.querySelector(".comp-head .pill").textContent=`โอน ${money(r.netTransfer)} บาท`; }
async function saveCompSettings(e){
  e.preventDefault(); if(!isOwner()||!requireOnline()) return; const button=e.submitter||e.currentTarget.querySelector("button[type=submit]"),month=$("#compMonth").value;setButtonBusy(button,true,"กำลังบันทึกเรท...");
  try{
    const s=mergeCompSettings({otRates:{front_kitchen:numberValue($("#otFrontKitchen").value),back_kitchen:numberValue($("#otBackKitchen").value),front_staff:numberValue($("#otFrontStaff").value),rotating:numberValue($("#otRotating").value)},dailyPay:{fullDay:numberValue($("#dailyFullRate").value),hourly:numberValue($("#dailyHourRate").value)},beerPerBottle:numberValue($("#beerRate").value),dailyBonus:{kitchen:{threshold:numberValue($("#dailyKitchenThreshold").value),amount:numberValue($("#dailyKitchenAmount").value)},front:{threshold:numberValue($("#dailyFrontThreshold").value),amount:numberValue($("#dailyFrontAmount").value)}},monthlyBonus:{kitchen:{threshold:numberValue($("#monthlyKitchenThreshold").value),amount:numberValue($("#monthlyKitchenAmount").value)},front:{threshold:numberValue($("#monthlyFrontThreshold").value),amount:numberValue($("#monthlyFrontAmount").value)}},socialSecurity:{employeeRate:numberValue($("#employeeSSRate").value),employerRate:numberValue($("#employerSSRate").value),maxSalaryBase:numberValue($("#ssMaxBase").value)}});
    if((s.socialSecurity.employeeRate>0||s.socialSecurity.employerRate>0)&&s.socialSecurity.maxSalaryBase<=0)return showToast("กรุณากรอกเพดานฐานเงินเดือนสูงสุดประกันสังคม");
    const batch=writeBatch(state.db); batch.set(doc(state.db,"compensationMonthSettings",month),{...s,monthKey:month,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id},{merge:false}); batch.set(doc(state.db,"appSettings","main"),{compensationDefaults:s,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id},{merge:true}); await withTimeout(batch.commit(),18000,"บันทึกเรทค่าตอบแทน"); invalidateDataCache("compensationMonthSettings"); state.settings.compensationDefaults=s; audit("แก้เรทค่าตอบแทน",{monthKey:month},null,s).catch(console.warn); afterWrite("comp_settings").catch(console.warn); showToast("บันทึกเรทและเพดานประกันสังคมแล้ว"); await loadCompensation();
  }catch(err){console.error("saveCompSettings",err);showToast(friendlyError(err));}
  finally{setButtonBusy(button,false);}
}
async function saveCompRecord(r,{silent=false,button=null}={}){
  if(!requireOnline()) return; if(!r.isDaily&&r.salary>0&&numberValue(r.settings.socialSecurity.maxSalaryBase)<=0){showToast("เจ้าของต้องตั้งค่าเพดานฐานเงินเดือนสูงสุดประกันสังคมก่อน");return;}
  setButtonBusy(button,true,"กำลังบันทึก...");
  try{
    const id=`${r.monthKey}_${r.userId}`,ref=doc(state.db,"compensationRecords",id),before=await getDocResilient(ref,"ตรวจค่าตอบแทนเดิม");
    const data={userId:r.userId,userName:r.userName,role:r.role,monthKey:r.monthKey,isDaily:r.isDaily,salary:r.salary,dailyWageBefore:r.dailyWageBefore,dailyPaid:r.dailyPaid,dailyWage:r.dailyWage,dailyFullDayEarned:r.dailyFullDayEarned||0,dailyHourlyEarned:r.dailyHourlyEarned||0,fullDayCount:r.fullDayCount||0,hourlyDayCount:r.hourlyDayCount||0,hourlyHours:r.hourlyHours||0,paidDailyCount:r.paidDailyCount||0,otHours:r.otHours||0,autoOT:r.autoOT,extraOther:r.extraOther,extraOtherNote:r.extraOtherNote,outsideOT:r.outsideOT,outsideOTNote:r.outsideOTNote,dailyBonus:r.dailyBonus,dailyBonusEligibleDays:r.dailyBonusEligibleDays||0,monthlyBonus:r.monthlyBonus,monthlySalesEligible:r.monthlySalesEligible,beerBonus:r.beerBonus,deduction:r.deduction,deductionNote:r.deductionNote,advances:r.advances,ssBase:r.ssBase||0,employeeSS:r.employeeSS,employerSS:r.employerSS,gross:r.gross,netTransfer:r.netTransfer,totalCost:r.totalCost,bankName:r.bankName,bankAccountNumber:r.bankAccountNumber,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id,updatedByName:state.currentUser.name};
    const batch=writeBatch(state.db); batch.set(ref,data,{merge:true}); batch.set(doc(state.db,"users",r.userId),{salary:r.salary,bankName:r.bankName,bankAccountNumber:r.bankAccountNumber,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id},{merge:true}); await withTimeout(batch.commit(),18000,"บันทึกค่าตอบแทน"); invalidateDataCache("compensationRecords");
    const u=state.users.find(u=>u.id===r.userId); if(u){u.salary=r.salary;u.bankName=r.bankName;u.bankAccountNumber=r.bankAccountNumber;}
    state.compDrafts[r.userId]=r; const idx=state.compData?.rows.findIndex(x=>x.userId===r.userId)??-1;if(idx>=0)state.compData.rows[idx]=r;
    audit("บันทึกค่าตอบแทน",{monthKey:r.monthKey,user:r.userName,netTransfer:r.netTransfer},before.exists()?before.data():null,data).catch(console.warn); afterWrite("compensation").catch(console.warn); if(!silent) showToast(`บันทึก ${r.userName} แล้ว`); return data;
  }catch(err){console.error("saveCompRecord",err);showToast(friendlyError(err));}
  finally{setButtonBusy(button,false);}
}
async function saveCompCard(card,{silent=false}={}){
  if(!card)return; const r=rowFromCard(card); state.compDrafts[r.userId]=r; return saveCompRecord(r,{silent,button:silent?null:card.querySelector(".save-comp")});
}
async function saveAllCompensation(){
  if(!requireOnline()||!state.compData) return; rememberCurrentCompDraft(); const button=$("#saveAllComp");setButtonBusy(button,true,"กำลังบันทึกทุกคน...");
  try{
    const rows=state.compData.rows.map(r=>state.compDrafts[r.userId]||r);
    if(rows.some(r=>!r.isDaily&&r.salary>0&&numberValue(r.settings.socialSecurity.maxSalaryBase)<=0)) return showToast("เจ้าของต้องตั้งค่าเพดานฐานเงินเดือนสูงสุดประกันสังคมก่อนบันทึกทุกคน");
    for(let i=0;i<rows.length;i++){button.textContent=`กำลังบันทึก ${i+1}/${rows.length}`;const saved=await saveCompRecord(rows[i],{silent:true});if(!saved)throw new Error(`บันทึก ${rows[i].userName} ไม่สำเร็จ`);}
    showToast("บันทึกค่าตอบแทนทุกคนแล้ว"); await loadCompensation();
  }catch(err){console.error(err);showToast(friendlyError(err));}
  finally{setButtonBusy(button,false);}
}
function openPaidDailyModal(userId){
  const r=state.compData.rows.find(x=>x.userId===userId); if(!r) return; const modal=document.createElement("div"); modal.className="modal-backdrop"; modal.id="paidDailyModal";
  modal.innerHTML=`<div class="modal-card"><div class="modal-head"><div><h3>รายวัน — วันที่ได้รับเงินแล้ว</h3><p>${escapeHtml(r.userName)} · ${thaiMonth(r.monthKey)}</p></div><button class="btn ghost small close-modal">ปิด</button></div><div class="check-list">${r.dailyAttendance.map(a=>{const pay=dailyAttendancePay(a,r.settings);return `<label class="check-item"><input type="checkbox" data-id="${a.id}" ${a.paidDaily?"checked":""}> ${thaiDate(a.date)} · ${attendanceStatusLabel(a.status)} · ${money(pay)} บาท</label>`;}).join("")||`<div class="empty">ไม่มีวันทำงาน</div>`}</div><div class="modal-actions"><button class="btn save-paid-daily write-action">บันทึกสถานะการจ่าย</button></div></div>`;
  document.body.appendChild(modal); modal.querySelector(".close-modal").onclick=()=>modal.remove(); modal.addEventListener("click",e=>{if(e.target===modal)modal.remove();});
  modal.querySelector(".save-paid-daily").onclick=async()=>{ if(!requireOnline())return; const btn=modal.querySelector(".save-paid-daily");setButtonBusy(btn,true,"กำลังบันทึก...");try{const batch=writeBatch(state.db); modal.querySelectorAll("input[type=checkbox]").forEach(ch=>batch.set(doc(state.db,"attendance",ch.dataset.id),{paidDaily:ch.checked,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id},{merge:true})); await withTimeout(batch.commit(),12000,"บันทึกสถานะการจ่ายรายวัน"); invalidateDataCache("attendance"); audit("แก้สถานะรายวันได้รับเงินแล้ว",{user:r.userName,monthKey:r.monthKey}).catch(console.warn); afterWrite("paid_daily").catch(console.warn); modal.remove(); showToast("บันทึกแล้ว"); loadCompensation().catch(console.warn);}catch(err){showToast(friendlyError(err));}finally{setButtonBusy(btn,false);} };
}
function compShareText(r){
  return `Rendo — สรุปค่าตอบแทน ${thaiMonth(r.monthKey)}\n${r.userName} (${ROLE_LABELS[r.role]||r.role})\nธนาคาร: ${r.bankName||"-"}\nเลขบัญชี: ${r.bankAccountNumber||"-"}\nยอดที่ต้องโอนปลายเดือน: ${money(r.netTransfer)} บาท`;
}
function compPdfHtml(r){
  const role=ROLE_LABELS[r.role]||r.role,madeAt=new Date().toLocaleString("th-TH"),ss=r.settings.socialSecurity||{};
  const row=(label,detail,value,cls="")=>`<tr class="${cls}"><td>${escapeHtml(label)}</td><td>${escapeHtml(detail||"-")}</td><td class="pdf-money">${money(value)}</td></tr>`;
  const earnings=[];
  if(r.isDaily){
    earnings.push(row("ค่าจ้างทำงานทั้งวัน",`${numberValue(r.fullDayCount)} วัน × ${money(r.settings.dailyPay.fullDay)} บาท`,r.dailyFullDayEarned));
    earnings.push(row("ค่าจ้างรายชั่วโมง",`${money(r.hourlyHours)} ชม. × ${money(r.settings.dailyPay.hourly)} บาท`,r.dailyHourlyEarned));
    earnings.push(row("หักค่าจ้างที่รับไปแล้วระหว่างเดือน",`${numberValue(r.paidDailyCount)} รายการ`,-Math.abs(r.dailyPaid)));
    earnings.push(row("ค่าจ้างคงเหลือที่นำมาคิดปลายเดือน","ค่าจ้างทั้งหมด − จ่ายแล้ว",r.dailyWage,"pdf-subtotal"));
  }else earnings.push(row("เงินเดือน","เงินเดือนประจำ",r.salary));
  earnings.push(row("OT จากวันทำงาน",`${money(r.otHours)} ชม. × ${money(r.settings.otRates[r.role]||0)} บาท`,r.autoOT));
  earnings.push(row("OT / เพิ่มอื่น ๆ",r.extraOtherNote||"ไม่มีรายละเอียด",r.extraOther));
  earnings.push(row("OT นอกเวลา",r.outsideOTNote||"ไม่มีรายละเอียด",r.outsideOT));
  earnings.push(row("โบนัสรายวัน",`${numberValue(r.dailyBonusEligibleDays)} วันที่ผ่านเงื่อนไข`,r.dailyBonus));
  earnings.push(row("โบนัสรายเดือน",`ยอดขายที่มีสิทธิ์ ${money(r.monthlySalesEligible)} บาท`,r.monthlyBonus));
  earnings.push(row("โบนัสเบียร์","คำนวณแบ่งตามวันที่มีสิทธิ์",r.beerBonus));
  const workRows=(r.dailyAttendance||[]).map(a=>`<tr><td>${thaiDate(a.date)}</td><td>${escapeHtml(attendanceStatusLabel(a.status))}${a.workStore?` · ${escapeHtml(a.workStore)}`:""}${a.status==="hourly"?` · ${escapeHtml(a.startTime)}–${escapeHtml(a.endTime)}`:""}</td><td class="pdf-money">${r.isDaily?money(dailyAttendancePay(a,r.settings)):"-"}</td><td class="pdf-money">${money(a.otHours||0)}</td><td>${r.isDaily?(a.paidDaily?"จ่ายแล้ว":"ยังไม่ติ๊กว่าจ่ายแล้ว"):"-"}</td></tr>`).join("");
  return `<div class="pdf-document pdf-one-page"><div class="pdf-header"><img src="./icons/logo.png" alt="Rendo"><div><h1>Rendo</h1><p>สรุปค่าตอบแทน ${thaiMonth(r.monthKey)}</p></div></div>
  <div class="pdf-info-grid"><div><small>ชื่อพนักงาน</small><b>${escapeHtml(r.userName)}</b></div><div><small>ตำแหน่ง</small><b>${escapeHtml(role)}</b></div><div><small>ธนาคาร</small><b>${escapeHtml(r.bankName||"-")}</b></div><div><small>เลขบัญชี</small><b>${escapeHtml(r.bankAccountNumber||"-")}</b></div><div><small>จัดทำโดย</small><b>${escapeHtml(state.currentUser.name)}</b></div><div><small>วันที่จัดทำ</small><b>${escapeHtml(madeAt)}</b></div></div>
  <div class="pdf-summary-grid"><div><small>วันทำงานทั้งวัน</small><b>${money(r.fullDayCount)} วัน</b></div><div><small>ชั่วโมงรายวัน</small><b>${money(r.hourlyHours)} ชม.</b></div><div><small>ชั่วโมง OT</small><b>${money(r.otHours)} ชม.</b></div></div>
  <table class="pdf-table pdf-comp-table"><thead><tr><th>รายการ</th><th>รายละเอียดการคำนวณ</th><th>จำนวนเงิน (บาท)</th></tr></thead><tbody>${earnings.join("")}<tr class="pdf-subtotal"><td>รวมรายรับก่อนหัก</td><td>รวมค่าตอบแทนทั้งหมดก่อนรายการหัก</td><td class="pdf-money">${money(r.gross)}</td></tr>${row("หักเงิน",r.deductionNote||"ไม่มีรายละเอียด",-Math.abs(r.deduction))}${row("เงินเบิกล่วงหน้า","รวมรายการเบิกในเดือนนี้",-Math.abs(r.advances))}${row("ประกันสังคมฝ่ายลูกจ้าง",`${money(ss.employeeRate)}% ของฐาน ${money(r.ssBase)} บาท · เพดานฐาน ${money(ss.maxSalaryBase)} บาท`,-Math.abs(r.employeeSS))}<tr class="pdf-total"><td>ยอดที่ต้องโอนปลายเดือน</td><td>รวมรายรับ − หักเงิน − เงินเบิก − ประกันสังคมลูกจ้าง</td><td class="pdf-money">${money(r.netTransfer)}</td></tr></tbody></table>
  ${(r.dailyAttendance||[]).length?`<section class="pdf-work-section"><h3>รายละเอียดวันทำงานและการจ่ายรายวัน</h3><table class="pdf-table pdf-work-table"><thead><tr><th>วันที่</th><th>สถานะ / เวลา / ร้าน</th><th>ค่าจ้างรายวัน</th><th>OT ชม.</th><th>สถานะจ่ายรายวัน</th></tr></thead><tbody>${workRows}</tbody></table></section>`:""}
  <div class="pdf-note-box"><b>หมายเหตุ:</b> รายงานนี้แสดงรายการค่าตอบแทนและรายการหักครบจนถึงยอดที่ต้องโอนปลายเดือน</div></div>`;
}
function openCompPdf(card){
  const r=rowFromCard(card);state.compDrafts[r.userId]=r;const modal=document.createElement("div"); modal.className="modal-backdrop"; modal.id="compPdfModal";
  modal.innerHTML=`<div class="modal-card comp-pdf-modal"><div class="modal-head"><div><h3>รายงานค่าตอบแทน</h3><p>${escapeHtml(r.userName)} · ${thaiMonth(r.monthKey)}</p></div><button class="btn ghost small close-modal">ปิด</button></div><div class="pdf-sheet">${compPdfHtml(r)}</div><div class="modal-actions"><button class="btn secondary copy-comp">คัดลอกสรุป</button><button class="btn secondary download-comp">ดาวน์โหลด PDF</button><button class="btn share-comp">แชร์ PDF เข้า LINE</button></div></div>`;
  document.body.appendChild(modal); modal.querySelector(".close-modal").onclick=()=>modal.remove(); modal.addEventListener("click",e=>{if(e.target===modal)modal.remove();});
  modal.querySelector(".copy-comp").onclick=async()=>{const text=compShareText(r);try{await navigator.clipboard.writeText(text);showToast("คัดลอกสรุปแล้ว");}catch(_){alert(text);}};
  modal.querySelector(".download-comp").onclick=e=>downloadCompPdf(r,e.currentTarget); modal.querySelector(".share-comp").onclick=e=>shareCompPdf(r,e.currentTarget);
}
async function waitForPdfLibrary(){
  for(let i=0;i<40;i++){if(window.html2pdf)return;await sleep(200);}throw new Error("โหลดตัวสร้าง PDF ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วเปิดแอปใหม่");
}
async function waitForImages(root){
  const images=[...root.querySelectorAll("img")];await Promise.all(images.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;setTimeout(resolve,3000);}))); 
}
async function makeCompPdfFile(r){
  await waitForPdfLibrary(); const name=`Rendo_ค่าตอบแทน_${String(r.userName).replace(/[\\/:*?"<>|\s]+/g,"_")}_${r.monthKey}.pdf`;
  const overlay=document.createElement("div");overlay.className="pdf-generating-overlay";overlay.innerHTML=`<div><div class="loading-spinner"></div><b>กำลังสร้าง PDF...</b><small>กรุณารอสักครู่</small></div>`;
  const root=document.createElement("div");root.className="pdf-export-root pdf-export-active";root.innerHTML=compPdfHtml(r);document.body.append(root,overlay);
  try{
    await waitForImages(root);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const worker=window.html2pdf().set({margin:[6,6,7,6],filename:name,image:{type:"jpeg",quality:.96},html2canvas:{scale:1.7,useCORS:true,allowTaint:false,backgroundColor:"#ffffff",logging:false,windowWidth:794,scrollX:0,scrollY:0},jsPDF:{unit:"mm",format:"a4",orientation:"portrait",compress:true},pagebreak:{mode:["css","legacy"],avoid:["tr",".pdf-info-grid",".pdf-summary-grid"]}}).from(root.firstElementChild).toPdf();
    const pdf=await worker.get("pdf"),blob=pdf.output("blob");if(!blob||blob.size<1500)throw new Error("ไฟล์ PDF ที่สร้างไม่สมบูรณ์ กรุณาลองใหม่");return new File([blob],name,{type:"application/pdf"});
  }finally{root.remove();overlay.remove();}
}
function saveFileToDevice(file){const a=document.createElement("a"),url=URL.createObjectURL(file);a.href=url;a.download=file.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);}
async function downloadCompPdf(r,button=null){
  setButtonBusy(button,true,"กำลังสร้าง PDF...");try{const file=await makeCompPdfFile(r);saveFileToDevice(file);showToast("ดาวน์โหลด PDF แล้ว");return file;}catch(e){console.error("pdf",e);showToast(friendlyError(e));}finally{setButtonBusy(button,false);}
}
async function shareCompPdf(r,button=null){
  setButtonBusy(button,true,"กำลังเตรียมแชร์...");
  try{
    const file=await makeCompPdfFile(r),shareData={files:[file],title:`ค่าตอบแทน ${r.userName}`,text:`Rendo ${thaiMonth(r.monthKey)} · ยอดโอน ${money(r.netTransfer)} บาท`};
    if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){await navigator.share(shareData);showToast("เลือก LINE จากหน้าต่างแชร์ได้เลย");}
    else{saveFileToDevice(file);try{await navigator.clipboard.writeText(compShareText(r));}catch(_){}alert("อุปกรณ์หรือเบราว์เซอร์นี้ส่งไฟล์ตรงเข้า LINE ไม่ได้\nระบบดาวน์โหลด PDF และคัดลอกข้อความสรุปให้แล้ว กรุณาเปิด LINE แล้วแนบไฟล์ PDF ที่ดาวน์โหลด");}
  }catch(e){if(e?.name!=="AbortError"){console.error("share pdf",e);showToast(friendlyError(e));}}
  finally{setButtonBusy(button,false);}
}
/* ------------------------------- ลงรายจ่าย ------------------------------- */
async function renderOwnerExpenses(){
  if(!isOwnerOrManager()) return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์</div>`;
  content().innerHTML=`${pageTitle("ลงรายจ่าย","ช่องกรอกอยู่ด้านบน แยกรายจ่ายประจำและรายจ่ายอื่น")}
  <form id="otherExpenseForm" class="panel expense-entry-top"><h3>เพิ่มรายจ่ายอื่น</h3><div class="grid four"><div class="field"><label>วันที่</label><input id="ownerExpenseDate" type="date" value="${todayISO()}"></div><div class="field"><label>รายการ</label><input id="ownerExpenseName" required placeholder="เช่น ค่าวัตถุดิบ / ซ่อมอุปกรณ์"></div><div class="field"><label>จำนวนเงิน</label><input id="ownerExpenseAmount" type="number" min="0" step="0.01" required></div><div class="field"><label>หมายเหตุ</label><input id="ownerExpenseNote"></div></div><button class="btn write-action">บันทึกรายจ่าย</button></form>
  <section class="panel"><div class="flex"><h3>รายจ่ายประจำ</h3><button id="addRecurring" class="btn secondary small" type="button">+ เพิ่มรายการประจำ</button></div><div id="recurringTemplates"></div></section>
  <section class="panel"><div class="grid three"><div class="field"><label>เดือน</label><input id="ownerExpenseMonth" type="month" value="${currentMonthKey()}"></div><div class="field"><label>&nbsp;</label><button id="loadOwnerExpenses" class="btn secondary">โหลดเดือน</button></div><div class="field"><label>&nbsp;</label><button id="snapshotRecurring" class="btn write-action">บันทึกรายจ่ายประจำของเดือนนี้</button></div></div></section><div id="ownerExpenseResult"></div>`;
  const fail=e=>{console.error("owner expenses",e);if(state.currentPage==="ownerExpenses"&&$("#ownerExpenseResult"))$("#ownerExpenseResult").innerHTML=`<div class="state error">${escapeHtml(friendlyError(e))}</div>`;showToast(friendlyError(e));};
  $("#otherExpenseForm").onsubmit=saveOwnerExpense; $("#addRecurring").onclick=addRecurringTemplatePrompt; $("#loadOwnerExpenses").onclick=()=>loadOwnerExpenses().catch(fail); $("#ownerExpenseMonth").onchange=()=>loadOwnerExpenses().catch(fail); $("#snapshotRecurring").onclick=snapshotRecurringMonth;
  bindFriendlyNumberInputs($("#otherExpenseForm"));
  loadRecurringTemplates().then(()=>loadOwnerExpenses()).catch(fail);
}
async function saveOwnerExpense(e){
  e.preventDefault(); if(!requireOnline())return; const button=e.submitter||e.currentTarget.querySelector('button[type="submit"]');setButtonBusy(button,true,"กำลังบันทึก...");
  try{const date=$("#ownerExpenseDate")?.value,name=$("#ownerExpenseName")?.value.trim(),amount=numberValue($("#ownerExpenseAmount")?.value),note=$("#ownerExpenseNote")?.value.trim()||""; if(!date||!name||amount<=0)return showToast("กรอกวันที่ รายการ และจำนวนเงิน");
  const d={date,monthKey:monthOf(date),name,amount,note,createdAt:serverTimestamp(),createdAtISO:new Date().toISOString(),createdBy:state.currentUser.id,createdByName:state.currentUser.name}; const ref=await withTimeout(addDoc(collection(state.db,"ownerExpenses"),d),12000,"บันทึกรายจ่าย"); invalidateDataCache("ownerExpenses"); audit("เพิ่มรายจ่ายเจ้าของลง",{date,name,amount},null,{id:ref.id,...d}).catch(console.warn); afterWrite("owner_expense").catch(console.warn); $("#ownerExpenseName").value="";$("#ownerExpenseAmount").value="0";$("#ownerExpenseNote").value="";showToast("บันทึกรายจ่ายแล้ว");loadOwnerExpenses({force:true}).catch(console.warn);}catch(err){showToast(friendlyError(err));}finally{setButtonBusy(button,false);}
}

async function loadRecurringTemplates(){
  const requestId=state.navRequestId,rows=(await allDocs("recurringExpenseTemplates")).filter(x=>x.active!==false).sort((a,b)=>numberValue(a.order)-numberValue(b.order)||String(a.name).localeCompare(String(b.name),"th")); if(!pageStillActive("ownerExpenses",requestId)||!$("#recurringTemplates"))return; state.recurringTemplates=rows;
  $("#recurringTemplates").innerHTML=rows.length?`<div class="table-wrap"><table class="mobile-card-table"><thead><tr><th>ลำดับ</th><th>รายการ</th><th class="money">จำนวนเงิน</th><th>จัดการ</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td data-label="ลำดับ">${i+1}</td><td data-label="รายการ"><input class="rec-name" data-id="${r.id}" value="${escapeHtml(r.name)}"></td><td data-label="จำนวนเงิน"><input class="rec-amount" data-id="${r.id}" type="number" min="0" step="0.01" value="${numberValue(r.amount)}"></td><td data-label="จัดการ"><div class="row-actions"><button class="btn secondary small rec-up" data-id="${r.id}" ${i===0?"disabled":""}>↑</button><button class="btn secondary small rec-down" data-id="${r.id}" ${i===rows.length-1?"disabled":""}>↓</button><button class="btn small save-rec write-action" data-id="${r.id}">บันทึก</button><button class="btn danger small delete-rec write-action" data-id="${r.id}">ลบ</button></div></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ยังไม่มีรายจ่ายประจำ</div>`;
  bindFriendlyNumberInputs($("#recurringTemplates")); $$(".save-rec").forEach(b=>b.onclick=()=>saveRecurringTemplate(b.dataset.id)); $$(".delete-rec").forEach(b=>b.onclick=()=>deleteRecurringTemplate(b.dataset.id)); $$(".rec-up").forEach(b=>b.onclick=()=>moveRecurring(b.dataset.id,-1)); $$(".rec-down").forEach(b=>b.onclick=()=>moveRecurring(b.dataset.id,1));
}
async function addRecurringTemplatePrompt(){ if(!requireOnline())return; const name=prompt("ชื่อรายจ่ายประจำ"); if(!name?.trim())return; const amount=numberValue(prompt("จำนวนเงินต่อเดือน","0")); const order=(state.recurringTemplates?.length||0)+1; const d={name:name.trim(),amount,order,active:true,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),updatedBy:state.currentUser.id}; const ref=await addDoc(collection(state.db,"recurringExpenseTemplates"),d); invalidateDataCache("recurringExpenseTemplates"); await audit("เพิ่มรายจ่ายประจำ",{name:d.name,amount},null,{id:ref.id,...d}); await afterWrite("recurring_expense"); await loadRecurringTemplates(); }
async function saveRecurringTemplate(id){ if(!requireOnline())return; const name=$(`.rec-name[data-id="${id}"]`).value.trim(),amount=numberValue($(`.rec-amount[data-id="${id}"]`).value),before=state.recurringTemplates.find(x=>x.id===id); if(!name)return showToast("กรอกชื่อรายการ"); const after={name,amount,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id}; await updateDoc(doc(state.db,"recurringExpenseTemplates",id),after); invalidateDataCache("recurringExpenseTemplates"); await audit("แก้รายจ่ายประจำ",{name,amount},before,{...before,...after}); await afterWrite("recurring_expense");showToast("บันทึกแล้ว");await loadRecurringTemplates(); }
async function deleteRecurringTemplate(id){ if(!requireOnline()||!confirm("ยืนยันลบรายการประจำนี้"))return; const before=state.recurringTemplates.find(x=>x.id===id); await updateDoc(doc(state.db,"recurringExpenseTemplates",id),{active:false,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id}); invalidateDataCache("recurringExpenseTemplates"); await audit("ลบรายจ่ายประจำ",{name:before?.name},before,null); await afterWrite("recurring_expense");await loadRecurringTemplates(); }
async function moveRecurring(id,delta){ if(!requireOnline())return; const rows=state.recurringTemplates.slice(),i=rows.findIndex(x=>x.id===id),j=i+delta;if(i<0||j<0||j>=rows.length)return;[rows[i],rows[j]]=[rows[j],rows[i]];const batch=writeBatch(state.db);rows.forEach((r,k)=>batch.set(doc(state.db,"recurringExpenseTemplates",r.id),{order:k+1,updatedAt:serverTimestamp()},{merge:true}));await batch.commit();invalidateDataCache("recurringExpenseTemplates");await audit("เรียงรายจ่ายประจำ",{item:userName(id)});await loadRecurringTemplates(); }
async function snapshotRecurringMonth(){
  if(!requireOnline())return; const month=$("#ownerExpenseMonth").value,templates=(state.recurringTemplates||[]); if(!confirm(`บันทึกรายจ่ายประจำ ${templates.length} รายการสำหรับ ${thaiMonth(month)} หรือไม่`))return;
  const old=await docsByMonth("recurringExpenseMonths",month),batch=writeBatch(state.db); old.forEach(x=>batch.delete(doc(state.db,"recurringExpenseMonths",x.id))); templates.forEach((t,i)=>batch.set(doc(state.db,"recurringExpenseMonths",`${month}_${t.id}`),{monthKey:month,templateId:t.id,name:t.name,amount:numberValue(t.amount),order:i+1,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id})); await batch.commit(); invalidateDataCache("recurringExpenseMonths"); await audit("บันทึกรายจ่ายประจำของเดือน",{monthKey:month,count:templates.length}); await afterWrite("recurring_month");showToast("บันทึกรายจ่ายประจำของเดือนแล้ว");await loadOwnerExpenses();
}
async function loadOwnerExpenses({force=false}={}){
  const result=$("#ownerExpenseResult"),month=$("#ownerExpenseMonth")?.value;if(!result||!month)return;const seq=++state.ownerExpensesLoadSeq,requestId=state.navRequestId; result.innerHTML=`<div class="loading">กำลังคำนวณ...</div>`;
  const [other,monthlyRec,comp]=await Promise.all([docsByMonth("ownerExpenses",month,{force}),docsByMonth("recurringExpenseMonths",month,{force}),calculateCompensationMonth(month)]); if(seq!==state.ownerExpensesLoadSeq||!pageStillActive("ownerExpenses",requestId)||!$("#ownerExpenseResult"))return; const rec=monthlyRec.length?monthlyRec:(state.recurringTemplates||[]); const compRows=comp.rows;
  const otherTotal=other.reduce((s,x)=>s+numberValue(x.amount),0),recTotal=rec.reduce((s,x)=>s+numberValue(x.amount),0),compTotal=compRows.reduce((s,x)=>s+numberValue(x.totalCost),0),grand=otherTotal+recTotal+compTotal;
  $("#ownerExpenseResult").innerHTML=`${metricCards([{label:"ค่าตอบแทนพนักงาน (ต้นทุนรวม + ปกส.)",value:`${money(compTotal)} บาท`},{label:"รายจ่ายประจำ",value:`${money(recTotal)} บาท`,sub:monthlyRec.length?"บันทึกเป็นของเดือนนี้แล้ว":"ตัวอย่างจากรายการประจำล่าสุด"},{label:"รายจ่ายอื่น",value:`${money(otherTotal)} บาท`},{label:"รายจ่ายเจ้าของลงรวม",value:`${money(grand)} บาท`}])}
  <div class="grid two"><section class="panel"><h3>ค่าตอบแทนพนักงาน</h3>${compRows.length?`<div class="table-wrap"><table><thead><tr><th>พนักงาน</th><th class="money">ต้นทุนรวม + ปกส.</th></tr></thead><tbody>${compRows.map(r=>`<tr><td>${escapeHtml(r.userName)}</td><td class="money">${money(r.totalCost)}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ไม่มีข้อมูล</div>`}</section>
  <section class="panel"><h3>รายจ่ายประจำของเดือน</h3>${rec.length?`<div class="table-wrap"><table><thead><tr><th>รายการ</th><th class="money">จำนวน</th></tr></thead><tbody>${rec.sort((a,b)=>numberValue(a.order)-numberValue(b.order)).map(r=>`<tr><td>${escapeHtml(r.name)}</td><td class="money">${money(r.amount)}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ไม่มีข้อมูล</div>`}</section></div>
  <section class="panel"><h3>รายจ่ายอื่น ${thaiMonth(month)}</h3>${other.length?`<div class="table-wrap"><table class="mobile-card-table"><thead><tr><th>วันที่</th><th>รายการ</th><th class="money">จำนวน</th><th>หมายเหตุ</th><th></th></tr></thead><tbody>${other.sort((a,b)=>String(b.date).localeCompare(String(a.date))).map(r=>`<tr><td data-label="วันที่">${thaiDate(r.date)}</td><td data-label="รายการ">${escapeHtml(r.name)}</td><td data-label="จำนวน" class="money">${money(r.amount)}</td><td data-label="หมายเหตุ">${escapeHtml(r.note||"")}</td><td data-label="จัดการ"><button class="btn danger small delete-owner-expense" data-id="${r.id}">ลบ</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ยังไม่มีรายจ่ายอื่น</div>`}</section>`;
  $$(".delete-owner-expense").forEach(b=>b.onclick=async()=>{if(!requireOnline()||!confirm("ยืนยันลบรายจ่ายนี้"))return;const row=other.find(x=>x.id===b.dataset.id);await deleteDoc(doc(state.db,"ownerExpenses",b.dataset.id));invalidateDataCache("ownerExpenses");await audit("ลบรายจ่ายเจ้าของลง",{name:row?.name,date:row?.date,amount:row?.amount},row,null);await afterWrite("owner_expense");await loadOwnerExpenses();});
}

/* -------------------------------- ประวัติ -------------------------------- */
function auditDetailText(r){ const d=r.details||{},parts=[]; if(d.user)parts.push(`ผู้เกี่ยวข้อง: ${d.user}`);if(d.date)parts.push(`วันที่: ${thaiDate(d.date)}`);if(d.monthKey)parts.push(`เดือน: ${thaiMonth(d.monthKey)}`);if(d.status)parts.push(`สถานะ: ${d.status}`);if(d.amount!==undefined)parts.push(`จำนวน: ${money(d.amount)} บาท`);if(d.name)parts.push(`รายการ: ${d.name}`);if(d.role)parts.push(`ระดับ: ${ROLE_LABELS[d.role]||d.role}`);if(d.selectedUser)parts.push(`เลือกชื่อ: ${d.selectedUser}`);if(d.netTransfer!==undefined)parts.push(`ยอดโอน: ${money(d.netTransfer)} บาท`);return parts.join(" · ")||"-"; }
async function renderHistory(category){
  if(category==="system"&&!isOwner())return content().innerHTML=`<div class="state error">เฉพาะเจ้าของ</div>`; if(category==="activity"&&!isOwnerOrManager())return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์</div>`;
  const page=category==="system"?"systemHistory":"history",seq=++state.historyLoadSeq,requestId=state.navRequestId;
  content().innerHTML=`${pageTitle(category==="system"?"ประวัติระบบ":"ประวัติการทำรายการ",category==="system"?"Login สร้าง/แก้ไข/ลบผู้ใช้ และการเปลี่ยน PIN":"รายการสำคัญ เช่น ยอดขาย วันทำงาน เบิกเงิน ค่าตอบแทน และรายจ่าย")}<div id="historyResult" class="panel"><div class="loading">กำลังโหลด...</div></div>`;
  let rows;
  if(isOwner()) rows=(await allDocs("auditLogs")).filter(r=>r.category===category);
  else {
    const snap=await getDocsResilient(query(collection(state.db,"auditLogs"),where("category","==","activity"),where("hidden","==",false)),"โหลดประวัติ");
    rows=snap.docs.map(d=>({id:d.id,...d.data()}));
  }
  if(seq!==state.historyLoadSeq||!pageStillActive(page,requestId)||!$("#historyResult"))return;
  rows=rows.sort((a,b)=>String(b.createdAtISO||"").localeCompare(String(a.createdAtISO||""))).slice(0,400);
  $("#historyResult").innerHTML=rows.length?`<div class="table-wrap"><table class="mobile-card-table"><thead><tr><th>วันเวลา</th><th>ผู้ทำ</th><th>รายการ</th><th>รายละเอียด</th>${isOwner()?"<th>ซ่อน/แสดง</th>":""}</tr></thead><tbody>${rows.map(r=>`<tr class="${r.hidden?"hidden-log":""}"><td data-label="วันเวลา">${formatTs(r.createdAt||r.createdAtISO)}</td><td data-label="ผู้ทำ">${escapeHtml(r.actorName)} · ${escapeHtml(ROLE_LABELS[r.role]||r.role||"")}</td><td data-label="รายการ"><b>${escapeHtml(r.action)}</b></td><td data-label="รายละเอียด">${escapeHtml(auditDetailText(r))}</td>${isOwner()?`<td data-label="ซ่อน/แสดง"><button class="btn ${r.hidden?"secondary":"ghost"} small toggle-history" data-id="${r.id}" data-hidden="${r.hidden?"1":"0"}">${r.hidden?"แสดงกลับ":"ซ่อน"}</button></td>`:""}</tr>`).join("")}</tbody></table></div>`:`<div class="empty">ยังไม่มีประวัติ</div>`;
  $$(".toggle-history").forEach(b=>b.onclick=async()=>{if(!requireOnline())return;const hidden=b.dataset.hidden!=="1";await updateDoc(doc(state.db,"auditLogs",b.dataset.id),{hidden,hiddenAt:serverTimestamp(),hiddenBy:state.currentUser.id});invalidateDataCache("auditLogs");showToast(hidden?"ซ่อนแล้ว — เจ้าของยังเห็นเป็นตัวจาง":"แสดงกลับแล้ว");await renderHistory(category);});
}

/* ------------------------------- สำรองข้อมูล ------------------------------- */
async function processPendingBackupRequests(){
  if(!isOwner()) return;
  try{ const rows=await allDocs("backupsMetadata"),pending=rows.filter(x=>x.pending===true); if(!pending.length)return; await performBackup("queued_actions",true); const batch=writeBatch(state.db); pending.slice(0,400).forEach(x=>batch.set(doc(state.db,"backupsMetadata",x.id),{pending:false,processedAt:serverTimestamp()},{merge:true})); await batch.commit(); }catch(e){ console.warn("pending backup",e); }
}
function setupAutoBackupTimer(){
  clearInterval(state.backupTimer); const a=state.settings.autoBackup||{}; if(!isOwner())return;
  if(a.mode==="onAction"||a.mode==="both") setTimeout(()=>processPendingBackupRequests(),15000);
  if(!["interval","both"].includes(a.mode)||!a.url)return; const mins=Math.max(5,numberValue(a.intervalMinutes||60)); state.backupTimer=setInterval(()=>performBackup("auto_interval",true).catch(console.warn),mins*60*1000);
}
async function exportAllData(){
  const out={app:"Rendo",version:VERSION,exportedAt:new Date().toISOString(),projectId:window.RENDO_FIREBASE_CONFIG?.projectId||"",collections:{}};
  for(let i=0;i<COLLECTIONS.length;i+=4){const names=COLLECTIONS.slice(i,i+4),results=await Promise.all(names.map(name=>getDocsResilient(collection(state.db,name),`สำรอง ${name}`,20000)));results.forEach((snap,j)=>{out.collections[names[j]]=snap.docs.map(d=>({id:d.id,data:safeClone(d.data())}));});}
  return out;
}
function downloadBlob(blob,name){ const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500); }
function csvEscape(v){ const s=String(v??"");return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s; }
function backupToCsv(data){ const rows=[["collection","id","dataJSON"]]; Object.entries(data.collections||{}).forEach(([name,items])=>(items||[]).forEach(x=>rows.push([name,x.id,JSON.stringify(x.data)]))); return rows.map(r=>r.map(csvEscape).join(",")).join("\r\n"); }
async function performBackup(reason="manual",silent=false){
  if(!state.online)throw new Error("ออฟไลน์"); const url=String(state.settings.autoBackup?.url||"").trim(); if(!url){if(!silent)showToast("ยังไม่ได้ใส่ Google Apps Script Web App URL");return;}
  if(state.backupInProgress){state.backupQueued=true;if(!silent)showToast("กำลังสำรองข้อมูลอยู่ ระบบจะทำรอบถัดไปให้อัตโนมัติ");return;}
  state.backupInProgress=true;
  try{
    const data=await exportAllData(); data.backupReason=reason; const form=new FormData();form.append("payload",JSON.stringify(data)); await withTimeout(fetch(url,{method:"POST",body:form,mode:"no-cors"}),30000,"ส่งข้อมูลสำรอง");
    await withTimeout(addDoc(collection(state.db,"backupsMetadata"),{reason,exportedAt:data.exportedAt,createdAt:serverTimestamp(),createdBy:state.currentUser?.id||null,createdByName:state.currentUser?.name||"ระบบ"}),12000,"บันทึกประวัติสำรอง"); if(!silent)showToast("ส่งข้อมูลสำรองไป Google Drive แล้ว");
  }finally{
    state.backupInProgress=false;if(state.backupQueued){state.backupQueued=false;setTimeout(()=>performBackup("queued_after_busy",true).catch(console.warn),5000);}
  }
}
async function renderBackup(){
  if(!isOwner())return content().innerHTML=`<div class="state error">เฉพาะเจ้าของ</div>`; const a=state.settings.autoBackup||DEFAULT_SETTINGS.autoBackup;
  content().innerHTML=`${pageTitle("สำรองและกู้คืนข้อมูล","รองรับ Google Drive ผ่าน Apps Script และไฟล์ JSON/CSV")}
  <form id="backupSettingsForm" class="panel"><h3>Auto Backup</h3><div class="grid three"><div class="field"><label>รูปแบบ</label><select id="backupMode"><option value="off" ${a.mode==="off"?"selected":""}>ปิด</option><option value="interval" ${a.mode==="interval"?"selected":""}>ทุกกี่นาที</option><option value="onAction" ${a.mode==="onAction"?"selected":""}>เมื่อมีการทำรายการ</option><option value="both" ${a.mode==="both"?"selected":""}>ทั้งสองแบบ</option></select></div><div class="field"><label>ทุกกี่นาที (ขั้นต่ำ 5)</label><input id="backupInterval" type="number" min="5" value="${numberValue(a.intervalMinutes||60)}"></div><div class="field"><label>Google Apps Script Web App URL</label><input id="backupUrl" type="url" value="${escapeHtml(a.url||"")}" placeholder="https://script.google.com/macros/s/.../exec"></div></div><div class="flex"><button class="btn write-action">บันทึกการตั้งค่า</button><button id="testBackupUrl" type="button" class="btn secondary">เปิด URL ทดสอบ</button><button id="backupNow" type="button" class="btn secondary write-action">สำรองไป Drive ตอนนี้</button></div></form>
  <section class="panel"><h3>ดาวน์โหลดไฟล์สำรอง</h3><div class="flex"><button id="downloadJson" class="btn secondary">ดาวน์โหลด JSON</button><button id="downloadCsv" class="btn secondary">ดาวน์โหลด CSV</button></div></section>
  <section class="panel"><h3>Restore จาก JSON หรือ CSV</h3><div class="state warn"><b>คำเตือน:</b> ระบบจะเขียนทับเอกสารที่มี ID ตรงกัน ควรสำรองข้อมูลปัจจุบันก่อนทุกครั้ง</div><div class="field"><label>เลือกไฟล์</label><input id="restoreFile" type="file" accept=".json,.csv,application/json,text/csv"></div><div id="restorePreview"></div><button id="restoreBtn" class="btn danger write-action" disabled>ยืนยัน Restore</button></section>
  <section class="panel"><h3>ไฟล์ที่ต้องใช้</h3><p>นำโค้ดจาก <b>apps-script-backup.gs</b> ไปวางใน Google Apps Script แล้ว Deploy เป็น Web App แบบ Execute as: Me และ Who has access: Anyone</p></section>`;
  $("#backupSettingsForm").onsubmit=saveBackupSettings; $("#testBackupUrl").onclick=()=>{const url=$("#backupUrl").value.trim();if(!url)return showToast("ใส่ URL ก่อน");window.open(`${url}${url.includes("?")?"&":"?"}action=test`,"_blank","noopener");}; $("#backupNow").onclick=()=>performBackup("manual").catch(e=>showToast(e.message));
  $("#downloadJson").onclick=async()=>{const data=await exportAllData();downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),`Rendo_Backup_${new Date().toISOString().replace(/[:.]/g,"-")}.json`);};
  $("#downloadCsv").onclick=async()=>{const data=await exportAllData();downloadBlob(new Blob(["\ufeff"+backupToCsv(data)],{type:"text/csv;charset=utf-8"}),`Rendo_Backup_${new Date().toISOString().replace(/[:.]/g,"-")}.csv`);};
  $("#restoreFile").onchange=previewRestoreFile; $("#restoreBtn").onclick=restoreData;
}
async function saveBackupSettings(e){ e.preventDefault();if(!requireOnline())return;const autoBackup={mode:$("#backupMode").value,intervalMinutes:Math.max(5,numberValue($("#backupInterval").value)),url:$("#backupUrl").value.trim()};await updateDoc(doc(state.db,"appSettings","main"),{autoBackup,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id});state.settings.autoBackup=autoBackup;setupAutoBackupTimer();await audit("แก้ตั้งค่าสำรองข้อมูล",{mode:autoBackup.mode},null,{...autoBackup,url:autoBackup.url?"มี URL":"ไม่มี URL"},null,"system");showToast("บันทึกการตั้งค่าแล้ว"); }
function parseCsv(text){
  const rows=[];let row=[],cell="",quoted=false;for(let i=0;i<text.length;i++){const ch=text[i],next=text[i+1];if(ch==='"'){if(quoted&&next==='"'){cell+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){row.push(cell);cell="";}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&next==='\n')i++;row.push(cell);if(row.some(x=>x!==""))rows.push(row);row=[];cell="";}else cell+=ch;}row.push(cell);if(row.some(x=>x!==""))rows.push(row);return rows;
}
async function previewRestoreFile(){ const file=$("#restoreFile").files[0];state.restorePreview=null;$("#restoreBtn").disabled=true;if(!file)return;try{const text=await file.text();let data;if(file.name.toLowerCase().endsWith(".csv")){const rows=parseCsv(text.replace(/^\ufeff/,"")),head=rows.shift();if(!head||head[0]!=="collection")throw new Error("หัวตาราง CSV ไม่ถูกต้อง");data={app:"Rendo CSV",collections:{}};rows.forEach(r=>{const [name,id,json]=r;if(!name||!id)return;(data.collections[name]??=[]).push({id,data:JSON.parse(json||"{}")} );});}else data=JSON.parse(text);if(!data.collections||typeof data.collections!=="object")throw new Error("ไม่พบ collections ในไฟล์");state.restorePreview=data;const counts=Object.entries(data.collections).map(([k,v])=>`${k}: ${Array.isArray(v)?v.length:0}`).join(" · ");$("#restorePreview").innerHTML=`<div class="state ok"><b>อ่านไฟล์สำเร็จ</b><br>${escapeHtml(counts)}</div>`;$("#restoreBtn").disabled=false;}catch(e){$("#restorePreview").innerHTML=`<div class="state error">อ่านไฟล์ไม่ได้: ${escapeHtml(e.message)}</div>`;} }
async function restoreData(){
  if(!isOwner()||!requireOnline()||!state.restorePreview)return;const pin=prompt("กรอก PIN ของเจ้าของเพื่อยืนยัน Restore");if(pin===null)return;if(!await confirmCurrentPin(pin))return showToast("PIN ไม่ถูกต้อง");if(!confirm("ยืนยันเขียนทับข้อมูลตามไฟล์ Restore หรือไม่"))return;
  const ops=[];Object.entries(state.restorePreview.collections).forEach(([name,items])=>(items||[]).forEach(x=>ops.push({name,id:x.id,data:x.data||{}})));for(let i=0;i<ops.length;i+=400){const batch=writeBatch(state.db);ops.slice(i,i+400).forEach(x=>batch.set(doc(state.db,x.name,x.id),x.data,{merge:false}));await batch.commit();}
  await audit("Restore ข้อมูล",{count:ops.length},null,{source:state.restorePreview.app||"file"},null,"system");showToast("Restore สำเร็จ กำลังโหลดใหม่");setTimeout(()=>location.reload(),900);
}

/* -------------------------------- ผู้ใช้งาน -------------------------------- */
function creatableRoles(){ if(isOwner())return Object.keys(ROLE_LABELS);if(isManager())return ["manager","supervisor",...WORKER_ROLES];if(isSupervisor())return WORKER_ROLES;return[]; }
function roleOptions(roles,selected=""){ return roles.map(r=>`<option value="${r}" ${r===selected?"selected":""}>${escapeHtml(ROLE_LABELS[r])}</option>`).join(""); }
function canEditUser(u){ if(isOwner())return true;if(isManager())return u.id!==state.currentUser.id&&!['owner','manager'].includes(u.role);return false; }
function canDeleteUser(u){ if(u.id===state.currentUser.id)return false;if(isOwner())return true;if(isManager())return !['owner','manager'].includes(u.role);return false; }
function editableRoleOptions(u){ if(isOwner())return Object.keys(ROLE_LABELS);if(isManager())return ["supervisor",...WORKER_ROLES];return[u.role]; }
async function renderUsers(){
  if(!["owner","manager","supervisor"].includes(state.currentUser.role))return content().innerHTML=`<div class="state error">ไม่มีสิทธิ์</div>`;
  const roles=creatableRoles();content().innerHTML=`${pageTitle("ผู้ใช้งาน","จัดการสิทธิ์ตามระดับเจ้าของ ผู้จัดการ หัวหน้า และพนักงาน")}
  <form id="createUserForm" class="panel"><h3>สร้างผู้ใช้ใหม่</h3><div class="grid four"><div class="field"><label>ชื่อ</label><input id="newUserName" required></div><div class="field"><label>PIN 4 ตัว</label><input id="newUserPin" type="password" inputmode="numeric" maxlength="4" required></div><div class="field"><label>ระดับ</label><select id="newUserRole">${roleOptions(roles)}</select></div><div class="field"><label>เงินเดือนเริ่มต้น</label><input id="newUserSalary" type="number" min="0" step="0.01" value="0"></div></div><div class="grid two"><div class="field"><label>ธนาคาร</label><input id="newUserBank"></div><div class="field"><label>เลขบัญชี</label><input id="newUserAccount" inputmode="numeric"></div></div><button class="btn write-action">สร้างผู้ใช้</button></form>
  <section class="panel"><h3>รายชื่อทั้งหมด</h3><div id="userList"></div></section>`;
  $("#createUserForm").onsubmit=createUser;renderUserList();
}
function renderUserList(){
  const users=state.users.slice().sort((a,b)=>(ROLE_ORDER[a.role]||99)-(ROLE_ORDER[b.role]||99)||String(a.name).localeCompare(String(b.name),"th"));
  $("#userList").innerHTML=users.length?`<div class="table-wrap"><table class="mobile-card-table"><thead><tr><th>ชื่อ</th><th>ระดับ</th>${isOwner()?"<th>PIN</th>":""}<th>เงินเดือน</th><th>ธนาคาร / บัญชี</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody>${users.map(u=>`<tr><td data-label="ชื่อ"><b>${escapeHtml(u.name)}</b>${u.id===state.currentUser.id?` <span class="pill muted">คุณ</span>`:""}</td><td data-label="ระดับ">${roleBadge(u.role)}</td>${isOwner()?`<td data-label="PIN"><code>${escapeHtml(state.pinVault[u.id]||"—")}</code></td>`:""}<td data-label="เงินเดือน" class="money">${money(u.salary)}</td><td data-label="ธนาคาร / บัญชี">${escapeHtml(u.bankName||"-")}<br><small>${escapeHtml(u.bankAccountNumber||"-")}</small></td><td data-label="สถานะ"><span class="pill ${u.active===false?"danger":"ok"}">${u.active===false?"ปิดใช้งาน":"ใช้งาน"}</span></td><td data-label="จัดการ"><div class="row-actions">${canEditUser(u)?`<button class="btn secondary small edit-user" data-id="${u.id}">แก้ไข</button>`:""}${canDeleteUser(u)?`<button class="btn danger small delete-user" data-id="${u.id}">ลบ</button>`:""}</div></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty">ไม่มีผู้ใช้</div>`;
  $$(".edit-user").forEach(b=>b.onclick=()=>openEditUser(b.dataset.id));$$(".delete-user").forEach(b=>b.onclick=()=>deleteUserById(b.dataset.id));
}
async function createUser(e){
  e.preventDefault();if(!requireOnline())return;const name=$("#newUserName").value.trim(),pin=$("#newUserPin").value.trim(),role=$("#newUserRole").value,salary=numberValue($("#newUserSalary").value),bankName=$("#newUserBank").value.trim(),bankAccountNumber=$("#newUserAccount").value.trim();
  if(!name||!/^\d{4}$/.test(pin))return showToast("กรอกชื่อและ PIN ตัวเลข 4 ตัว");if(!creatableRoles().includes(role))return showToast("ไม่มีสิทธิ์สร้างระดับนี้");
  const identity=makeLoginIdentity(),secondary=initializeApp(window.RENDO_FIREBASE_CONFIG,`rendo_create_${Date.now()}`);let cred;
  try{
    const secondaryAuth=getAuth(secondary);cred=await createUserWithEmailAndPassword(secondaryAuth,identity.authEmail,authPassword(pin,identity.loginKey));const id=cred.user.uid;
    const secure={name,role,salary,bankName,bankAccountNumber,active:true,authEmail:identity.authEmail,loginKey:identity.loginKey,createdAt:serverTimestamp(),createdBy:state.currentUser.id,createdByName:state.currentUser.name,updatedAt:serverTimestamp()};
    const pub={name,role,active:true,authEmail:identity.authEmail,loginKey:identity.loginKey,updatedAt:serverTimestamp()};
    const batch=writeBatch(state.db);batch.set(doc(state.db,"users",id),secure);batch.set(doc(state.db,"publicUsers",id),pub);batch.set(doc(state.db,"pinVault",id),{pin,createdBy:state.currentUser.id,updatedAt:serverTimestamp()});await batch.commit();
    await signOut(secondaryAuth);await audit("สร้างผู้ใช้",{user:name,role},null,{id,...secure},null,"system");await afterWrite("create_user");showToast("สร้างผู้ใช้แล้ว");await loadBaseData();await renderUsers();
  }catch(err){console.error(err);if(cred?.user)await deleteAuthUser(cred.user).catch(()=>null);showToast(`สร้างผู้ใช้ไม่สำเร็จ: ${err.message}`);}finally{await deleteApp(secondary).catch(()=>null);}
}

function openEditUser(id){
  const u=state.users.find(x=>x.id===id);if(!u||!canEditUser(u))return;const canRole=u.id!==state.currentUser.id&&(isOwner()||isManager());const modal=document.createElement("div");modal.className="modal-backdrop";modal.id="editUserModal";
  modal.innerHTML=`<div class="modal-card"><div class="modal-head"><div><h3>แก้ไขผู้ใช้</h3><p>${escapeHtml(u.name)}</p></div><button class="btn ghost small close-modal">ปิด</button></div><form id="editUserForm"><div class="grid two"><div class="field"><label>ชื่อ</label><input id="editUserName" value="${escapeHtml(u.name)}"></div><div class="field"><label>ระดับ</label><select id="editUserRole" ${canRole?"":"disabled"}>${roleOptions(editableRoleOptions(u),u.role)}</select></div><div class="field"><label>เงินเดือน</label><input id="editUserSalary" type="number" min="0" step="0.01" value="${numberValue(u.salary)}"></div><div class="field"><label>สถานะ</label><select id="editUserActive"><option value="1" ${u.active!==false?"selected":""}>ใช้งาน</option><option value="0" ${u.active===false?"selected":""}>ปิดใช้งาน</option></select></div><div class="field"><label>ธนาคาร</label><input id="editUserBank" value="${escapeHtml(u.bankName||"")}"></div><div class="field"><label>เลขบัญชี</label><input id="editUserAccount" value="${escapeHtml(u.bankAccountNumber||"")}" inputmode="numeric"></div></div><div class="modal-actions"><button class="btn write-action">บันทึก</button></div></form></div>`;
  document.body.appendChild(modal);modal.querySelector(".close-modal").onclick=()=>modal.remove();modal.addEventListener("click",e=>{if(e.target===modal)modal.remove();});modal.querySelector("#editUserForm").onsubmit=async e=>{e.preventDefault();if(!requireOnline())return;const role=canRole?modal.querySelector("#editUserRole").value:u.role;if(isManager()&&!editableRoleOptions(u).includes(role))return showToast("ไม่มีสิทธิ์เปลี่ยนเป็นระดับนี้");const after={name:modal.querySelector("#editUserName").value.trim(),role,salary:numberValue(modal.querySelector("#editUserSalary").value),active:modal.querySelector("#editUserActive").value==="1",bankName:modal.querySelector("#editUserBank").value.trim(),bankAccountNumber:modal.querySelector("#editUserAccount").value.trim(),updatedAt:serverTimestamp(),updatedBy:state.currentUser.id,updatedByName:state.currentUser.name};if(!after.name)return showToast("กรอกชื่อ");const batch=writeBatch(state.db);batch.update(doc(state.db,"users",u.id),after);batch.set(doc(state.db,"publicUsers",u.id),{name:after.name,role:after.role,active:after.active,authEmail:u.authEmail,loginKey:u.loginKey,updatedAt:serverTimestamp()},{merge:true});await batch.commit();await audit("แก้ไขผู้ใช้",{user:after.name,role:after.role},u,{...u,...after},null,"system");await afterWrite("edit_user");modal.remove();showToast("บันทึกแล้ว");await loadBaseData();await renderUsers();};
}
async function deleteUserById(id){
  const u=state.users.find(x=>x.id===id);if(!u||!canDeleteUser(u)||!requireOnline())return;const pin=prompt(`กรอก PIN ของคุณเพื่อยืนยันลบ ${u.name}`);if(pin===null)return;if(!await confirmCurrentPin(pin))return showToast("PIN ไม่ถูกต้อง");if(!confirm(`ยืนยันลบไอดี ${u.name} หรือไม่`))return;
  if(isOwner()&&state.pinVault[id]&&u.authEmail&&u.loginKey){
    const secondary=initializeApp(window.RENDO_FIREBASE_CONFIG,`rendo_delete_${Date.now()}`);try{const a=getAuth(secondary);const cred=await signInWithEmailAndPassword(a,u.authEmail,authPassword(state.pinVault[id],u.loginKey));await deleteAuthUser(cred.user);}catch(err){console.warn("ลบบัญชี Auth ไม่สำเร็จ แต่จะตัดสิทธิ์ในระบบ",err);}finally{await deleteApp(secondary).catch(()=>null);}
  }
  const batch=writeBatch(state.db);batch.delete(doc(state.db,"users",id));batch.delete(doc(state.db,"publicUsers",id));batch.delete(doc(state.db,"pinVault",id));await batch.commit();await audit("ลบผู้ใช้",{user:u.name,role:u.role},u,null,null,"system");await afterWrite("delete_user");showToast("ลบผู้ใช้แล้ว");await loadBaseData();await renderUsers();
}


/* --------------------------------- ตั้งค่า --------------------------------- */
async function renderSettings(){
  if(!isOwner())return content().innerHTML=`<div class="state error">เฉพาะเจ้าของ</div>`;const s=state.settings,workers=state.users.filter(u=>u.active!==false&&WORKER_ROLES.includes(u.role));
  content().innerHTML=`${pageTitle("ตั้งค่า","ปรับสี ขนาดตัวอักษร หน้า เมนู และสิทธิ์เบิกเงิน")}
  <form id="settingsForm"><section class="panel"><h3>หน้าตาแอป</h3><div class="grid four"><div class="field"><label>ชื่อร้าน</label><input id="settingStoreName" value="${escapeHtml(s.storeName)}"></div><div class="field"><label>สีหลัก</label><input id="settingPrimary" type="color" value="${escapeHtml(s.primaryColor)}"></div><div class="field"><label>สีพื้นรอง</label><input id="settingSecondary" type="color" value="${escapeHtml(s.secondaryColor)}"></div><div class="field"><label>สีพื้นหลัง</label><input id="settingBackground" type="color" value="${escapeHtml(s.backgroundColor)}"></div><div class="field"><label>ขนาดตัวอักษร</label><select id="settingFont"><option value="0.9" ${s.fontScale==.9?"selected":""}>เล็ก</option><option value="1" ${s.fontScale==1?"selected":""}>มาตรฐาน</option><option value="1.1" ${s.fontScale==1.1?"selected":""}>ใหญ่</option><option value="1.2" ${s.fontScale==1.2?"selected":""}>ใหญ่มาก</option></select></div><div class="field"><label>สัดส่วนรายได้หลังต้นทุนวัตถุดิบ (%)</label><input id="settingMargin" type="number" min="0" max="100" step="1" value="${numberValue(s.dashboardMarginRate)*100}"><small>ค่าเริ่มต้น 40% หมายถึงต้นทุนประมาณ 60%</small></div></div></section>
  <section class="panel"><h3>เปิด/ปิดหน้าในเมนู</h3><div class="check-list">${NAV.filter(n=>!["settings"].includes(n.id)).map(n=>`<label class="check-item"><input class="page-visible" data-page="${n.id}" type="checkbox" ${!(s.hiddenPages||[]).includes(n.id)?"checked":""}> ${n.icon} ${escapeHtml(n.label)}</label>`).join("")}</div></section>
  <section class="panel"><h3>สิทธิ์เข้าหน้าเบิกเงินล่วงหน้า</h3><p>เจ้าของและผู้จัดการเข้าได้เสมอ เลือกเพิ่มสำหรับพนักงานที่ต้องการ</p><div class="check-list">${workers.map(u=>`<label class="check-item"><input class="advance-access" data-user="${u.id}" type="checkbox" ${(s.advanceAccessUserIds||[]).includes(u.id)?"checked":""}> ${escapeHtml(u.name)} — ${escapeHtml(ROLE_LABELS[u.role])}</label>`).join("")}</div></section>
  <div class="sticky-save"><button class="btn full write-action">บันทึกการตั้งค่า</button></div></form>`;
  $("#settingsForm").onsubmit=saveSettings;
}
async function saveSettings(e){
  e.preventDefault();if(!requireOnline())return;const hiddenPages=$$(".page-visible").filter(x=>!x.checked).map(x=>x.dataset.page),advanceAccessUserIds=$$(".advance-access").filter(x=>x.checked).map(x=>x.dataset.user);const after={...state.settings,storeName:$("#settingStoreName").value.trim()||"Rendo",primaryColor:$("#settingPrimary").value,secondaryColor:$("#settingSecondary").value,backgroundColor:$("#settingBackground").value,fontScale:numberValue($("#settingFont").value)||1,dashboardMarginRate:Math.max(0,Math.min(1,numberValue($("#settingMargin").value)/100)),hiddenPages,advanceAccessUserIds,updatedAt:serverTimestamp(),updatedBy:state.currentUser.id};const before=safeClone(state.settings);await setDoc(doc(state.db,"appSettings","main"),after,{merge:true});state.settings=deepMergeSettings(after);applyTheme();buildNav();await audit("แก้การตั้งค่าแอป",{name:"หน้าตา เมนู และสิทธิ์"},before,state.settings,null,"system");await afterWrite("settings");showToast("บันทึกการตั้งค่าแล้ว");if(hiddenPages.includes(state.currentPage))navigate(visibleNavItems()[0]?.id||"monthly");else await renderSettings();
}

boot();
