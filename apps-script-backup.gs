/**
 * Rendo v1.0 — Google Apps Script Backup Receiver
 * 1) Project Settings > Script properties > เพิ่ม BACKUP_TOKEN
 * 2) Deploy > New deployment > Web app
 * 3) Execute as: Me, Who has access: Anyone
 * เก็บ URL /exec ไปใส่หน้า Backup ของ Rendo
 */
const RENDO_FOLDER_NAME = 'Rendo Backups';
const MAX_FILES_PER_REQUEST = 4;
const MAX_BASE64_LENGTH = 45 * 1024 * 1024;

function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function getToken_() {
  return PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN') || '';
}

function secureEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  var mismatch = a.length ^ b.length;
  var length = Math.max(a.length, b.length);
  for (var i = 0; i < length; i++) mismatch |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  return mismatch === 0 && a.length > 0;
}

function getFolder_() {
  var folders = DriveApp.getFoldersByName(RENDO_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(RENDO_FOLDER_NAME);
}

function safeFilename_(name) {
  return String(name || 'Rendo_Backup').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
}

function doGet() {
  return jsonOutput_({ ok: true, app: 'Rendo Backup Receiver', message: 'ใช้คำขอ POST พร้อม token จากแอป Rendo' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!secureEquals_(body.token, getToken_())) return jsonOutput_({ ok: false, error: 'Token ไม่ถูกต้อง' });
    if (body.action === 'ping') return jsonOutput_({ ok: true, message: 'เชื่อมต่อ Rendo Backup สำเร็จ', serverTime: new Date().toISOString() });
    if (body.action !== 'save') return jsonOutput_({ ok: false, error: 'action ไม่รองรับ' });
    if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > MAX_FILES_PER_REQUEST) {
      return jsonOutput_({ ok: false, error: 'จำนวนไฟล์ไม่ถูกต้อง' });
    }
    var folder = getFolder_();
    var saved = [];
    body.files.forEach(function(file) {
      if (!file.contentBase64 || file.contentBase64.length > MAX_BASE64_LENGTH) throw new Error('ไฟล์ว่างหรือใหญ่เกินกำหนด');
      var bytes = Utilities.base64Decode(file.contentBase64);
      var blob = Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream', safeFilename_(file.filename));
      var driveFile = folder.createFile(blob);
      saved.push({ name: driveFile.getName(), id: driveFile.getId(), size: bytes.length });
    });
    return jsonOutput_({ ok: true, saved: saved, folder: RENDO_FOLDER_NAME, savedAt: new Date().toISOString() });
  } catch (error) {
    return jsonOutput_({ ok: false, error: String(error && error.message ? error.message : error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
