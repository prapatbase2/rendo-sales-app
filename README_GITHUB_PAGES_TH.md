# คู่มือ GitHub Pages แบบไม่ใช้คำสั่ง — Rendo v1.0

## 1. เตรียมไฟล์

1. ดาวน์โหลด `Rendo_Sales_App_v1.0.zip`
2. คลิกขวา ZIP > Extract All / แตกไฟล์ทั้งหมด
3. เปิดโฟลเดอร์ `rendo_sales_app_v1_0`
4. ตรวจว่ามี `index.html`, `app.js`, `style.css`, `config.js`, `.nojekyll` และโฟลเดอร์ `icons`
5. ใส่ Firebase config ใน `config.js` ก่อนอัปโหลด หรือแก้ผ่าน GitHub ภายหลังก็ได้

## 2. สร้าง Repository

1. เข้า `https://github.com/`
2. เข้าสู่ระบบ
3. มุมขวาบนกด `+` > New repository
4. Repository name ใส่ `rendo-sales-app`
5. เลือก Private หรือ Public ตามแผน GitHub ที่รองรับ Pages ของบัญชีคุณ
6. ไม่ต้องเพิ่ม README จาก GitHub เพราะชุดนี้มีไฟล์แล้ว
7. กด Create repository

## 3. อัปโหลด

1. ในหน้า Repository กด uploading an existing file หรือ Add file > Upload files
2. ลาก **ไฟล์และโฟลเดอร์ทั้งหมดที่อยู่ข้างใน** `rendo_sales_app_v1_0` ลงหน้าเว็บ
3. ห้ามลากเฉพาะ ZIP เพราะ GitHub Pages ไม่แตก ZIP ให้
4. ตรวจว่า `index.html` อยู่ระดับบนสุด ไม่ได้ซ้อนเป็น `rendo_sales_app_v1_0/index.html`
5. ช่อง Commit changes ใส่ `อัปโหลด Rendo v1.0`
6. กด Commit changes

## 4. เปิด Pages

1. Repository > Settings
2. เมนูซ้าย Pages
3. Build and deployment > Source เลือก Deploy from a branch
4. Branch เลือก main
5. Folder เลือก / (root)
6. กด Save
7. รอ 1–5 นาที
8. รีเฟรชจนเห็นข้อความ Your site is live at…
9. กด Visit site

## 5. แก้ config.js ผ่าน GitHub

1. เปิดไฟล์ `config.js` ใน Repository
2. กดไอคอนดินสอ Edit
3. แทนค่าตัวอย่างด้วย Firebase config ของ Rendo
4. เปลี่ยน authPepper
5. กด Commit changes
6. รอ Pages deploy ใหม่
7. เปิดเว็บแล้วกด Ctrl+F5 หรือใช้โหมดไม่ระบุตัวตนครั้งแรก

## 6. อัปเดตภายหลัง

1. สำรองข้อมูลจากหน้า Backup ก่อน
2. อัปโหลดเฉพาะไฟล์เวอร์ชันใหม่โดยคง `config.js` ของร้านไว้
3. เปลี่ยน cache version ใน `sw.js` ทุกครั้งที่ออกเวอร์ชันจริง
4. ผู้ใช้จะเห็นแถบ “มีอัปเดต” เมื่อ Service Worker ติดตั้งไฟล์ใหม่
5. อย่าบังคับรีโหลดขณะกำลังกรอกข้อมูล

## 7. ติดตั้งบนมือถือ

Android Chrome: เปิดเว็บ > เมนู `⋮` > Install app / Add to Home screen > Install

iPhone Safari: เปิดเว็บ > Share > Add to Home Screen > Add

บน iPhone ควรเปิดผ่าน Safari โดยตรง ไม่ใช่เบราว์เซอร์ภายใน LINE
