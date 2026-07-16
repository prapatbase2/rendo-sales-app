/* Rendo Backup Web App v1.1.0 — บันทึก JSON ลง Google Drive */
const BACKUP_APP_VERSION = 'Rendo Backup v1.1.0';
const BACKUP_FOLDER_NAME = 'Rendo_Backups';
const BACKUP_FOLDER_ID = ''; // ใส่ Folder ID ได้ หรือปล่อยว่างให้ระบบสร้าง/ค้นหาโฟลเดอร์

function doGet(e) {
  try {
    const action = e && e.parameter ? String(e.parameter.action || '') : '';
    if (action === 'test') return json_(saveBackup_({app:'Rendo',version:'TEST',exportedAt:new Date().toISOString(),collections:{test:[{id:'test',data:{ok:true}}]}}, 'TEST'));
    const folder = getFolder_();
    return json_({ok:true,app:BACKUP_APP_VERSION,message:'พร้อมใช้งาน เติม ?action=test เพื่อสร้างไฟล์ทดสอบ',folderName:folder.getName(),folderId:folder.getId(),folderUrl:folder.getUrl(),time:new Date().toISOString()});
  } catch (err) { return json_(error_(err,'doGet')); }
}
function doPost(e) {
  try {
    const raw = e && e.parameter && e.parameter.payload ? String(e.parameter.payload) : (e && e.postData ? String(e.postData.contents || '') : '');
    if (!raw) throw new Error('ไม่พบ payload');
    return json_(saveBackup_(JSON.parse(raw), ''));
  } catch (err) { return json_(error_(err,'doPost')); }
}
function saveBackup_(obj, prefix) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const folder = getFolder_();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Bangkok', 'yyyy-MM-dd_HH-mm-ss');
    const name = 'Rendo_' + (prefix ? prefix + '_' : '') + 'Backup_' + stamp + '.json';
    const file = folder.createFile(name, JSON.stringify(obj || {}, null, 2), 'application/json');
    return {ok:true,app:BACKUP_APP_VERSION,fileName:name,fileId:file.getId(),fileUrl:file.getUrl(),folderUrl:folder.getUrl(),time:new Date().toISOString()};
  } finally { lock.releaseLock(); }
}
function getFolder_(){
  if (BACKUP_FOLDER_ID && BACKUP_FOLDER_ID.trim()) return DriveApp.getFolderById(BACKUP_FOLDER_ID.trim());
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER_NAME);
}
function error_(err, at){ return {ok:false,app:BACKUP_APP_VERSION,at:at,error:String(err && err.message ? err.message : err),time:new Date().toISOString()}; }
function json_(obj){ return ContentService.createTextOutput(JSON.stringify(obj,null,2)).setMimeType(ContentService.MimeType.JSON); }
