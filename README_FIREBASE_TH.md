# คู่มือตั้งค่า Firebase แบบทีละคลิก — Rendo v1.0

## A. สร้าง Project ใหม่

1. เปิด Firebase Console
2. กด **Create a project**
3. ชื่อ Project แนะนำ `rendo-sales`
4. Google Analytics จะเปิดหรือปิดก็ได้ แอปนี้ไม่จำเป็นต้องใช้
5. กด **Create project**
6. รอคำว่า Your new project is ready แล้วกด Continue

ห้ามเลือก Project ของร้านอื่น เพราะข้อมูลจะปะปนกัน

## B. เพิ่ม Web App และคัดลอก config

1. หน้า Project Overview กดไอคอน `</>`
2. App nickname ใส่ `Rendo Web`
3. ไม่ต้องเลือก Firebase Hosting เพราะใช้ GitHub Pages
4. กด Register app
5. จะเห็นข้อความลักษณะนี้:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

6. เปิด `config.js`
7. เปลี่ยนเฉพาะข้อความหลังเครื่องหมาย `:` ให้ตรงกับ Project นี้
8. อย่าลบ comma และเครื่องหมายคำพูด
9. เปลี่ยน `authPepper` เป็นข้อความสุ่มยาว ตัวอย่างรูปแบบที่ดี: ใช้ตัวอักษร ตัวเลข และสัญลักษณ์รวมกันมากกว่า 32 ตัว
10. บันทึกไฟล์

Firebase Web API key ปรากฏในไฟล์เว็บได้ตามรูปแบบของ Firebase ความปลอดภัยหลักต้องมาจาก Authentication, Firestore Rules และการจำกัดโดเมน ไม่ใช่การซ่อน API key

## C. เปิด Email/Password Authentication

1. เมนูซ้ายกด Build > Authentication
2. กด Get started
3. แท็บ Sign-in method
4. กด Email/Password
5. เปิดสวิตช์ Email/Password อันแรก
6. ไม่ต้องเปิด Email link
7. กด Save

แอปจะแปลงรหัสผู้ใช้เป็นอีเมลภายในและแปลง PIN เป็นรหัสผ่านที่ Firebase รับได้ ผู้ใช้ยังเห็นเพียงรหัสผู้ใช้กับ PIN

## D. สร้าง Firestore

1. เมนูซ้ายกด Build > Firestore Database
2. กด Create database
3. เลือก Production mode
4. เลือก Location ใกล้ร้าน
5. กด Enable

Location เปลี่ยนภายหลังไม่ได้ง่าย ควรเลือกให้ถูกก่อนเริ่มเก็บข้อมูลจริง

## E. วาง Firestore Rules

1. เปิดไฟล์ `firebase-rules.txt`
2. กด Ctrl+A แล้ว Ctrl+C
3. Firebase Console > Firestore Database > Rules
4. คลิกในกล่องกฎ
5. กด Ctrl+A เพื่อลบกฎเดิม
6. กด Ctrl+V
7. กด Publish
8. รอข้อความ Rules published

กฎนี้ตรวจ role จาก `users/{uid}` ทุกครั้ง แยก PIN, เงินเดือน/ธนาคาร, Backup settings และ Audit Log ตามสิทธิ์

## F. สร้าง Composite Index สำหรับประวัติ

วิธีไม่ใช้คำสั่ง:

1. Firestore Database > Indexes
2. แท็บ Composite
3. กด Create index
4. Collection ID: `auditLogs`
5. Field path: `hidden`, เลือก Ascending
6. Add field
7. Field path: `createdAt`, เลือก Descending
8. Query scope: Collection
9. กด Create
10. รอ Status เปลี่ยนเป็น Enabled

ไฟล์ `firestore-indexes.json` เก็บข้อมูลเดียวกันไว้สำหรับผู้เชี่ยวชาญที่ใช้ Firebase CLI แต่ผู้ใช้ทั่วไปไม่จำเป็นต้องติดตั้ง CLI

## G. Authorized domains

1. Authentication > Settings
2. Authorized domains
3. ตรวจว่ามีโดเมน GitHub Pages ของคุณ เช่น `ชื่อผู้ใช้.github.io`
4. ถ้ายังไม่มี กด Add domain แล้วใส่เฉพาะชื่อโดเมน ไม่ใส่ `https://` และไม่ใส่ path

## H. สร้างเจ้าของคนแรก

1. เปิด URL GitHub Pages
2. หน้าแรกควรแสดง “สร้างเจ้าของคนแรก”
3. กรอกชื่อ
4. รหัสผู้ใช้ใช้ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง
5. PIN ต้องเป็นเลข 4 หลัก
6. กดยืนยัน

ระบบสร้าง Auth account ก่อน แล้วใช้ Firestore transaction สร้าง `system/initialization`, owner user, PIN ciphertext, public/private key และ app settings พร้อมกัน ถ้ามีอุปกรณ์สองเครื่องแข่งกัน จะมีเพียง transaction แรกที่ตั้ง initialization สำเร็จ

## I. ตรวจว่าตั้งค่าสำเร็จ

- Authentication > Users มีบัญชีเจ้าของ 1 ราย
- Firestore > Data มี `system/initialization`
- มี `users`, `userPins`, `securityKeys`, `ownerSecrets`, `appSettings`, `auditLogs`
- เจ้าของล็อกอินและเห็น Dashboard

## ปัญหาที่พบบ่อย

**ขึ้น “ต้องใส่ Firebase config ก่อน”** — `config.js` ยังมีค่าตัวอย่างหรือ `authPepper` ยังไม่เปลี่ยน

**permission-denied ตอนสร้างเจ้าของ** — Rules ยังไม่ได้ Publish หรือวางไม่ครบ

**รหัสผู้ใช้ถูกใช้แล้วแต่ Firestore ไม่มีผู้ใช้** — อาจเป็น Auth account ที่สร้างค้าง/ถูกจองไว้ ต้องลบรายการนั้นใน Authentication > Users แล้วสร้างใหม่

**ประวัติเปิดไม่ได้และ Firebase ให้ลิงก์สร้าง index** — สร้าง index `auditLogs: hidden ASC + createdAt DESC`
