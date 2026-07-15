# เริ่มตรงนี้ก่อน — Rendo v1.0

ไฟล์ชุดนี้เป็นแอปใหม่ของ **RENDO – RAMEN & GYOZA** แยกจากระบบอื่นโดยสิ้นเชิง ห้ามนำ Firebase config ของร้านอื่นมาใส่

## ช่วงที่ 1 — สร้าง Firebase Project ใหม่สำหรับ Rendo

1. เปิด `https://console.firebase.google.com/`
2. กด **Create a project** หรือ **เพิ่มโปรเจ็กต์**
3. ตั้งชื่อ เช่น `rendo-sales`
4. กดทำต่อจนสร้างสำเร็จ
5. กดไอคอนเว็บ `</>` แล้วตั้งชื่อแอปเว็บว่า `Rendo Web`
6. ค้างหน้าที่แสดง `firebaseConfig` ไว้

เมื่อสำเร็จ: คุณจะเห็นค่า `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId` และ `appId`

## ช่วงที่ 2 — เปิด Authentication และ Firestore

1. เมนูซ้ายกด **Authentication** > **Get started**
2. กด **Sign-in method** > **Email/Password**
3. เปิดสวิตช์ **Email/Password** แล้วกด **Save**
4. เมนูซ้ายกด **Firestore Database** > **Create database**
5. เลือก Production mode
6. เลือกตำแหน่งฐานข้อมูลใกล้ผู้ใช้ เช่นภูมิภาคเอเชีย แล้วกดสร้าง

เมื่อสำเร็จ: Authentication มี Email/Password เป็น Enabled และ Firestore เปิดแล้ว

## ช่วงที่ 3 — วาง Rules/Index และใส่ Firebase config

1. เปิดไฟล์ `firebase-rules.txt` แล้วคัดลอกทั้งหมด
2. Firebase Console > Firestore Database > **Rules**
3. ลบข้อความเดิม วางข้อความใหม่ แล้วกด **Publish**
4. Firestore > **Indexes** > **Composite** > **Create index**
5. Collection ID ใส่ `auditLogs`
6. เพิ่มฟิลด์ `hidden` แบบ Ascending และ `createdAt` แบบ Descending แล้วกดสร้าง
7. เปิดไฟล์ `config.js`
8. แทนค่าใน `firebaseConfig` ด้วยค่าจาก Firebase Project ใหม่ของ Rendo
9. เปลี่ยน `authPepper` เป็นข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษร ห้ามใช้ข้อความตัวอย่าง

เมื่อสำเร็จ: `config.js` ไม่มีคำว่า `ใส่-` และ `authPepper` ไม่ใช่ข้อความตัวอย่าง

## ช่วงที่ 4 — อัปโหลดขึ้น GitHub Pages

1. สร้าง Repository ใหม่ใน GitHub เช่น `rendo-sales-app`
2. แตก ZIP บนคอมพิวเตอร์
3. อัปโหลด **ไฟล์ที่อยู่ข้างในโฟลเดอร์** ขึ้น Repository รวม `.nojekyll` และโฟลเดอร์ `icons`
4. Repository > **Settings** > **Pages**
5. Source เลือก **Deploy from a branch**
6. Branch เลือก `main` และโฟลเดอร์ `/ (root)` แล้วกด **Save**
7. รอจน GitHub แสดง URL เว็บไซต์

เมื่อสำเร็จ: เปิด URL แล้วเห็นหน้า Rendo ไม่ใช่รายชื่อไฟล์

## ช่วงที่ 5 — เปิดครั้งแรก สร้างเจ้าของ และติดตั้งเป็นแอป

1. เปิด URL GitHub Pages
2. หากฐานข้อมูลใหม่ จะเห็นหน้า **สร้างเจ้าของคนแรก**
3. กรอกชื่อ รหัสผู้ใช้ และ PIN 4 หลัก
4. กด **สร้างเจ้าของและเริ่มใช้งาน** เพียงครั้งเดียว
5. Android/Chrome: เมนู `⋮` > **Install app** หรือ **Add to Home screen**
6. iPhone/Safari: ปุ่ม Share > **Add to Home Screen**

เมื่อสำเร็จ: เข้าสู่ Dashboard และมีไอคอน Rendo บนหน้าจอมือถือ

## ต้องใส่เองแน่นอน

- Firebase config ของ Project **Rendo ใหม่** ใน `config.js`
- `authPepper` ใหม่ของร้าน
- Google Apps Script URL และ Backup Token หากต้องการสำรองขึ้น Drive
- ข้อมูลพนักงาน เงินเดือน ธนาคาร เรท โบนัส และประกันสังคมจริง

## คำเตือนสั้น ๆ

PIN 4 หลักเดาง่ายกว่ารหัสผ่านยาว แม้ระบบใช้ Firebase Authentication และ Firestore Rules แล้วก็ไม่ใช่ความปลอดภัยระดับธนาคาร ห้ามใช้ PIN เดียวกับบัญชีสำคัญ

Auto Backup แบบทุกกี่นาทีทำงานเฉพาะเมื่อแอปของเจ้าของเปิดอยู่และออนไลน์ ไม่ทำงานเมื่อปิดแอปหรือปิดเครื่อง

อ่านต่อ: `README_FIREBASE_TH.md`, `README_GITHUB_PAGES_TH.md`, `README_USER_GUIDE_TH.md`, `README_BACKUP_RESTORE_TH.md`, `README_SECURITY_LIMITATIONS_TH.md`
