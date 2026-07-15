# คู่มือ Backup / Restore — Rendo v1.0

## สิ่งที่ระบบสำรอง

JSON Full Backup มี `schemaVersion`, `appVersion`, `exportedAt`, ชื่อ collection, document ID และข้อมูลเอกสาร ระบบแปลง Firestore Timestamp เป็นรูปแบบที่ Restore กลับได้

CSV Full Backup เป็น UTF-8 พร้อม BOM แต่ละแถวมี `collection`, `documentId`, `dataJson` จึงเก็บโครงสร้างซ้อนได้ครบกว่าตาราง CSV ทั่วไป

ไฟล์ไม่รวม Firebase config, Auth password, Apps Script URL/Token และ private key ที่เจ้าของใช้ถอด PIN เอกสาร `userPins` ที่อยู่ใน Backup เป็น ciphertext ไม่ใช่ PIN ตรง ๆ

## A. สร้าง Google Apps Script

1. เปิด `https://script.google.com/`
2. กด New project
3. ตั้งชื่อ `Rendo Backup Receiver`
4. เปิดไฟล์ `apps-script-backup.gs` จากชุดนี้
5. คัดลอกทั้งหมด
6. กลับ Apps Script ลบโค้ดเดิม แล้ววาง
7. กด Save

## B. ตั้ง Backup Token

1. ใน Apps Script กด Project Settings รูปเฟือง
2. เลื่อนหา Script properties
3. กด Add script property
4. Property ใส่ `BACKUP_TOKEN`
5. Value ใส่ข้อความลับยาวอย่างน้อย 32 ตัวอักษร
6. กด Save script properties
7. เก็บ token นี้ไว้ใส่ในหน้า Backup ของ Rendo

อย่าใส่ token ในไฟล์ GitHub และอย่าส่งในแชตสาธารณะ

## C. Deploy เป็น Web App

1. มุมขวาบนกด Deploy > New deployment
2. Select type > Web app
3. Description ใส่ `Rendo Backup v1`
4. Execute as เลือก Me
5. Who has access เลือก Anyone
6. กด Deploy
7. อนุญาตสิทธิ์ Google Drive ตามหน้าจอ
8. คัดลอก URL ที่ลงท้าย `/exec`

แม้ตั้ง Anyone แต่ทุกคำขอ `save` ต้องมี Token ตรงกับ Script Properties

## D. ใส่ค่าใน Rendo

1. เข้าระบบด้วยเจ้าของ
2. เปิดเมนู สำรอง / กู้คืนข้อมูล
3. วาง Web App URL
4. ใส่ Backup Secret/Token เดียวกับ Apps Script
5. เลือก Auto Backup
6. หากเลือกทุกกี่นาที ให้ใส่อย่างน้อย 5 นาที
7. กดบันทึกตั้งค่า
8. กดทดสอบ URL
9. เมื่อสำเร็จจะเห็นข้อความเชื่อมต่อสำเร็จ

## E. สำรองด้วยมือ

- กด ดาวน์โหลด JSON เพื่อเก็บไฟล์หลักในคอมพิวเตอร์
- กด ดาวน์โหลด CSV เพื่อเปิดตรวจใน Excel หรือใช้ Restore
- กด Backup ไป Google Drive ตอนนี้ เพื่อส่ง JSON และ CSV ไปโฟลเดอร์ `Rendo Backups`

CSV มี BOM เพื่อให้ Excel อ่านภาษาไทย แต่คอลัมน์ `dataJson` ยังเป็น JSON เพราะต้องรักษา array/object ทุก collection

## F. ความจริงของ Auto Backup

- แบบทุกกี่นาที: ทำงานเมื่อหน้าแอปของเจ้าของเปิดอยู่และออนไลน์
- แบบเมื่อมีการทำรายการ: ถ้าเจ้าของเป็นผู้ทำ ระบบรอรวมรายการใกล้กันประมาณ 5 วินาทีแล้วสำรอง
- ถ้าพนักงานคนอื่นทำรายการ ระบบตั้งธง `system/backupQueue`; เมื่อเจ้าของเปิดแอปและตั้งโหมด write/both จึงสำรอง
- เมื่อปิดเบราว์เซอร์ ปิด PWA ปิดเครื่อง หรือไม่มีอินเทอร์เน็ต ไม่มี JavaScript ทำงาน จึงไม่สำรองเบื้องหลัง
- หากต้องการ Backup ที่ทำงานแม้ไม่มีใครเปิดแอป ต้องเพิ่ม backend เช่น Cloud Functions หรือ scheduled server ซึ่งไม่ได้รวมใน Static PWA นี้

## G. Restore แบบ Merge

1. กดเลือกไฟล์
2. เลือก JSON หรือ CSV ที่ Rendo สร้าง
3. ตรวจ schemaVersion, appVersion, วันที่ และจำนวนเอกสาร
4. เลือก Merge
5. กดเริ่ม Restore
6. กรอก PIN เจ้าของ
7. ระบบดาวน์โหลด pre-restore JSON ก่อน
8. ถ้าตั้ง Drive ไว้ ระบบพยายาม Backup ไป Drive ก่อน
9. ระบบเขียนเป็น batch ไม่เกิน 400 เอกสารต่อครั้ง
10. รอ progress จนครบและหน้า reload

Merge เขียนทับเอกสารที่ ID ตรงกันและเพิ่มเอกสารใหม่ แต่ไม่ลบเอกสารอื่น

## H. Restore แบบ Replace

Replace ลบเอกสารเดิมใน collection ที่รองรับแล้วเขียนจากไฟล์ จึงเสี่ยงกว่า Merge

ระบบไม่ลบ Firebase Authentication, `system/initialization`, `securityKeys`, `ownerSecrets` หรือ Backup Token อย่างไรก็ตาม หากไฟล์ users ไม่ตรงกับ Auth ผู้ใช้อาจล็อกอินไม่ได้

ใช้ Replace เฉพาะเมื่อ:

- มี pre-restore backup แล้ว
- ตรวจไฟล์แล้ว
- ใช้ Firebase Project เดิม
- เข้าใจว่าการ Restore Firestore ไม่ได้สร้าง Authentication accounts

## I. ย้ายข้าม Firebase Project

Backup/Restore ชุดนี้สำรอง Firestore แต่ไม่สามารถ export/import Firebase Authentication password จากเบราว์เซอร์ได้ ผู้ใช้ใน Project ใหม่ต้องสร้าง Auth account ใหม่ให้ UID/ข้อมูลสอดคล้อง หรือใช้ Admin SDK/Cloud Functions โดยผู้เชี่ยวชาญ

จึงแนะนำ Restore เพื่อย้อนข้อมูลใน Project เดิม ไม่ใช่เครื่องมือย้ายระบบข้าม Project แบบอัตโนมัติ

## J. หาก Restore ล้มเหลว

1. อย่ากดซ้ำหลายครั้งทันที
2. เก็บไฟล์ pre-restore ที่ดาวน์โหลดไว้
3. อ่าน progress ว่าหยุด collection ใด
4. ตรวจอินเทอร์เน็ตและ Firestore Rules
5. เริ่มด้วย Merge แทน Replace
6. ถ้า Auth กับ users ไม่ตรง ให้แก้ใน Firebase Console โดยผู้ดูแลที่เข้าใจระบบ
