# Test Checklist และผลตรวจ — Rendo v1.0

วันที่สร้างชุดทดสอบ: 15 กรกฎาคม 2569

## ผลที่ตรวจอัตโนมัติในสภาพแวดล้อมสร้างไฟล์

- PASS: `node --check` สำหรับ `app.js`, `calc.js`, `firebase.js`, `crypto-utils.js`
- PASS: Calculation tests 14/14 ใน `tests.mjs`
- PASS: ไอคอน PNG 16, 32, 180, 192, 512 และ maskable สร้างจากโลโก้ Rendo
- PASS: manifest JSON, version JSON และ firestore-indexes JSON parse ได้
- PASS: ZIP สร้างและทดสอบรายการไฟล์/CRC ก่อนส่ง
- PASS: ไม่มี Firebase API key, Project ID หรือ Apps Script URL จริงจากระบบอ้างอิง
- PASS: `config.js` มีแต่ placeholder และบังคับเปลี่ยน authPepper
- PASS: คำว่า Love Matcha ในโค้ดใช้อยู่เฉพาะสถานที่ทำงานของพนักงานเวียนและ test ของกฎนี้

## Calculation tests ที่ผ่าน

1. ยอดขายรวมและรายได้รวม
2. สมการเงินสดตรง
3. สมการเงินสดขาดและเกิน
4. Draft ไม่เข้า Dashboard
5. โบนัสรายวันครัวและโบนัสรายเดือน
6. โบนัสรายวันหน้าร้าน
7. โบนัสเบียร์หารลงตัว
8. โบนัสเบียร์หารไม่ลงตัวและผลรวมไม่เกินยอด
9. พนักงานเวียนที่ Love Matcha ไม่รับโบนัส Rendo ตามค่าเริ่มต้น
10. รายวันทั้งวัน รายชั่วโมง และจ่ายแล้ว
11. เงินเบิกล่วงหน้าไม่ลดต้นทุนซ้ำ
12. ประกันสังคมต่ำกว่าเพดานและชนเพดาน
13. ยอดโอนและต้นทุนร้านตามสูตร
14. Dashboard ใช้อัตรา 40%

รันซ้ำบนคอมพิวเตอร์ที่มี Node.js: เปิด Terminal ในโฟลเดอร์แล้วใช้ `node tests.mjs` ผู้ใช้ทั่วไปไม่ต้องรัน ขั้นตอนนี้มีไว้ให้ผู้ตรวจระบบ

เปิด `tests.html` ผ่าน local HTTP server เพื่อดู test ย่อยในเบราว์เซอร์

## Acceptance Test หลังเชื่อม Firebase จริง

ส่วนนี้ต้องทำหลังผู้ใช้สร้าง Firebase Project ใส่ config เปิด Authentication/Firestore และ Publish Rules เนื่องจากชุดไฟล์ที่ส่งไม่สามารถมี Project จริงหรือบัญชีจริงของร้านได้ จึงระบุสถานะเป็น “รอทดสอบใน Project ของร้าน” แทนการกล่าวอ้างว่าผ่าน

### บัญชี 8 role

- [ ] owner เห็นทุกหน้า ดู PIN ทุกคนได้ และแก้ role ตัวเองไม่ได้
- [ ] manager ไม่เห็น PIN และแก้/ลบ owner, manager ที่มีอยู่ หรือตัวเองไม่ได้
- [ ] supervisor สร้างได้เฉพาะ front_kitchen, back_kitchen, front_staff, rotating_staff, daily และแก้ role/ลบไม่ได้
- [ ] front_kitchen ไม่เห็นผู้ใช้/ค่าตอบแทน/ตั้งค่า
- [ ] back_kitchen ไม่เห็นผู้ใช้/ค่าตอบแทน/ตั้งค่า
- [ ] front_staff เห็นยอดขายและหน้าตามสิทธิ์
- [ ] rotating_staff เลือกสถานที่และช่วง OT ถูกต้อง
- [ ] daily เลือกทั้งวัน/รายชั่วโมง/หยุด และจำนวนชั่วโมงถูกต้อง

### สิทธิ์และข้อมูลหลายเครื่อง

- [ ] เปิด 2 เครื่อง ลง dailySales วันที่เดียวกัน ได้ document ID เดียว ไม่มี duplicate
- [ ] attendance ใช้ `{date}_{uid}` ไม่มี duplicate
- [ ] manager query audit hidden=false ทำงานหลัง index Enabled
- [ ] พนักงานดูรายเดือนได้เฉพาะเดือนปัจจุบันและย้อนหลัง 1 เดือน
- [ ] Hidden audit เจ้าของยังเห็น ผู้จัดการไม่เห็น
- [ ] บัญชี active=false ล็อกอินแล้วถูกออกและ Rules ปฏิเสธข้อมูล
- [ ] ผู้ไม่มีสิทธิ์อ่าน payrollProfiles, userPins, privateSettings และ compensation ไม่ได้

### ยอดขาย

- [ ] เปิดกะใช้ยอดปิดจากวันเปิดร้านล่าสุดแม้มีวันหยุดคั่น
- [ ] แก้ยอดปิดย้อนหลังทำเครื่องหมายวันถัดไปให้ตรวจ
- [ ] Draft ไม่เข้า Dashboard, รายเดือน, โบนัส, compensation
- [ ] เงินสดขาด/เกินบังคับสาเหตุก่อน Final
- [ ] หยุดร้านซ่อนยอดและเก็บ Before/After

### Compensation/PDF

- [ ] profile เงินเดือน/ธนาคารใช้ต่อเดือนถัดไป
- [ ] Finalized เก็บ settings/profile/calculation snapshot
- [ ] เปิดแก้ Finalized ต้อง owner PIN
- [ ] daily paid ไม่เข้ายอดโอน แต่ยังเข้าต้นทุนร้าน
- [ ] advance หักยอดโอนครั้งเดียวและไม่ลด shop cost ซ้ำ
- [ ] PDF ภาษาไทยอ่านได้
- [ ] PDF ไม่มีประกันสังคมนายจ้าง
- [ ] PDF ไม่มีต้นทุนร้าน
- [ ] PDF แสดงยอดที่ต้องโอนปลายเดือนและบัญชีที่ยืนยันแล้ว

### Offline/PWA

- [ ] เปิดออนไลน์และโหลดข้อมูลอย่างน้อยหนึ่งครั้ง
- [ ] ตัดอินเทอร์เน็ต แถบ Offline ปรากฏ
- [ ] ดูข้อมูลที่ cache แล้วได้
- [ ] ปุ่ม write ถูก disable
- [ ] Restore/Backup ทำไม่ได้ offline
- [ ] ติดตั้ง Android และ Add to Home Screen บน iPhone
- [ ] อัปเดต Service Worker แล้วมีแถบอัปเดตโดยไม่บังคับ reload

### Backup/Restore

- [ ] Apps Script ping สำเร็จ
- [ ] Drive มี JSON และ CSV ภาษาไทย
- [ ] Preview JSON แสดง schema/appVersion/date/count
- [ ] Preview CSV แสดง collection/count และระบุ metadata ตามไฟล์
- [ ] Pre-restore JSON ดาวน์โหลดก่อนเขียน
- [ ] Merge สำเร็จ
- [ ] Replace ไม่ลบ Auth/system/security keys/owner secret
- [ ] Audit Log มี restore action

## หน้าจอและ Accessibility ที่ต้องดูบนอุปกรณ์จริง

- [ ] 320 px ไม่มี horizontal overflow ของหน้า (ตารางเลื่อนเฉพาะใน table-wrap)
- [ ] 375 px และ 430 px ปุ่มสูงอย่างน้อยประมาณ 44 px
- [ ] Desktop เมนูซ้ายและตารางอ่านง่าย
- [ ] ใช้ Tab เข้าทุกช่องและเห็น focus outline
- [ ] label เชื่อมกับช่องสำคัญ
- [ ] ข้อความไทยไม่ล้น
- [ ] สีที่เจ้าของเลือกยังมี contrast เพียงพอ; แอปไม่สามารถรับประกันสี custom ทุกคู่
