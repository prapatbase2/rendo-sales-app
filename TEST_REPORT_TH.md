# รายงานตรวจสอบ Rendo PWA v1.0

วันที่จัดทำ: 16 กรกฎาคม 2569

## การตรวจสอบอัตโนมัติที่ทำแล้ว

- ตรวจ JavaScript syntax ด้วย `node --check app.js` — ผ่าน
- ตรวจ JSON syntax ของ `manifest.webmanifest`, `version.json`, `firebase.json`, `.firebaserc`, `firestore.indexes.json` — ผ่าน
- ตรวจ JavaScript syntax ของ `sw.js` และ `apps-script-backup.gs` — ผ่าน
- ตรวจไฟล์ PWA หลักครบ: index, manifest, service worker, icons 16/32/180/192/512 — ผ่าน
- ตรวจว่า Firebase config ของโครงการ `rendo-sales` อยู่ใน `index.html` — ผ่าน
- ตรวจว่าไม่มีการใช้ Anonymous Authentication ในโค้ด — ผ่าน
- ตรวจว่า PIN ไม่ได้เก็บใน `publicUsers` — ผ่าน
- ตรวจ Rules ให้ผู้จัดการอ่านได้เฉพาะประวัติการทำรายการที่ไม่ถูกซ่อน และพนักงานอ่านรายการเบิกได้เฉพาะของตนเมื่อได้รับสิทธิ์ — ผ่านการตรวจโครงสร้างไฟล์
- ตรวจ Service Worker ไม่ดัก Firestore/Auth request และใช้ network-first สำหรับไฟล์แอป — ผ่าน
- ตรวจ JavaScript รองรับ offline read-only โดยปิด input/write actions เมื่อออฟไลน์ — ผ่าน

## การทดสอบที่ต้องทำกับ Firebase จริงหลังติดตั้ง

สภาพแวดล้อมสร้างไฟล์ไม่มีอินเทอร์เน็ตและไม่มีสิทธิ์เข้าโครงการ Firebase ของร้าน จึงยังไม่สามารถทดสอบ End-to-End กับฐานข้อมูลจริงได้ ต้องทำ Checklist ใน `README_SETUP_TH.md` หลังเปิด Authentication, Firestore และ Publish Rules

จุดที่ต้องยืนยันเป็นพิเศษ:

1. First setup สร้าง owner ครบใน users, publicUsers, pinVault, system และ appSettings และ Login ได้
2. Firestore Rules ของ manager/supervisor/worker ตรงสิทธิ์
3. PDF แสดงฟอนต์ไทยบนอุปกรณ์จริง
4. Google Apps Script Web App สร้างไฟล์ใน Drive
5. PWA install และ offline cache บน Android/iOS
6. ค่าอัตราประกันสังคมและฐานสูงสุดตรงกฎหมาย ณ เดือนที่จ่ายจริง
7. Composite Indexes ทั้ง 2 รายการขึ้นสถานะ Enabled

หมายเหตุ: ยังไม่ได้ทดสอบ Browser แบบ Headless ในสภาพแวดล้อมนี้ เนื่องจาก Chromium ของระบบทดสอบไม่สามารถเริ่มทำงานได้อย่างเสถียร จึงต้องทำ Smoke Test บนอุปกรณ์จริงตาม Checklist ในคู่มือ
