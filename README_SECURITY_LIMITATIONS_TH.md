# ข้อจำกัดด้านความปลอดภัยที่ต้องทราบ — Rendo v1.0

## 1. PIN 4 หลัก

PIN มีความเป็นไปได้เพียง 10,000 ค่า จึงเดาง่ายกว่ารหัสผ่านยาว แอปมีการพัก 60 วินาทีหลังกรอกผิด 5 ครั้งในเครื่อง และ Firebase อาจจำกัดคำขอเพิ่มเติม แต่ผู้ใช้ต้องไม่ใช้ PIN เดียวกับธนาคาร โทรศัพท์ อีเมล หรือบริการสำคัญ

## 2. การแปลง PIN เป็น Firebase password

แอปใช้ SHA-256 ร่วมกับรหัสผู้ใช้และ `authPepper` เพื่อสร้างรหัสผ่านที่ Firebase ยอมรับ แต่ `authPepper` อยู่ใน Static Web App จึงไม่ใช่ secret ที่ซ่อนจากผู้โจมตีได้ ประโยชน์หลักคือไม่ส่ง PIN 4 หลักตรง ๆ เป็น Firebase password ไม่ได้เพิ่ม entropy ของ PIN ให้เท่ารหัสผ่านยาว

## 3. Public sign-up ของ Email/Password ใน Static PWA

Firebase Client SDK ไม่มีสิทธิ์ Admin ในการสร้างบัญชีให้คนอื่น แอปจึงใช้ secondary app instance เพื่อสมัคร Auth account แล้วใช้ Firestore Rules อนุญาตเฉพาะผู้ดูแลให้สร้าง user profile

ผลคือคนที่รู้รูปแบบอีเมลภายในอาจสมัคร Auth account เปล่ามาจองรหัสผู้ใช้ได้ แม้บัญชีนั้นอ่าน/เขียนข้อมูลไม่ได้เพราะไม่มี `users/{uid}` ที่ Rules อนุญาต หากเกิดเหตุ ให้เจ้าของลบ orphan account ใน Firebase Authentication แล้วสร้างบัญชีใหม่

วิธีปิดช่องนี้จริงต้องมี trusted backend เช่น Cloud Functions/Admin SDK และปิด public sign-up ซึ่งไม่รวมใน Static PWA นี้

## 4. ปิดใช้งานบัญชี

ปุ่มปิดใช้งานเป็น soft delete ใน Firestore เพื่อรักษาประวัติ Client SDK ของผู้ดูแลไม่สามารถ disable Auth user คนอื่นได้ Rules ตรวจ `active == true` ก่อนให้เข้าข้อมูล บัญชีปิดใช้งานอาจยัง authenticate ได้ แต่จะอ่าน/เขียนข้อมูลไม่ได้และแอปจะออกจากระบบ

## 5. เจ้าของดู PIN

เพื่อทำตามข้อกำหนด เจ้าของสามารถถอด PIN ได้ ระบบเข้ารหัส PIN ด้วย RSA-OAEP; public key ใช้สร้าง ciphertext และ private key อยู่ใน `ownerSecrets` ที่ Rules ให้เจ้าของอ่านเท่านั้น

นี่หมายความว่าเจ้าของหรือผู้ที่ยึดบัญชีเจ้าของได้สามารถดู PIN ทุกคน จึงต้องป้องกันบัญชีเจ้าของและอุปกรณ์เจ้าของอย่างเข้มงวด

## 6. ความต่อเนื่องเมื่อเปลี่ยน PIN

Firebase Authentication และ Firestore เป็นคนละระบบ ไม่มี transaction ข้ามบริการ แอปอัปเดตรหัสผ่าน Auth แล้วเขียน PIN ciphertext; หาก Firestore ล้มเหลวจะพยายาม rollback รหัสผ่าน แต่ไม่รับประกัน 100% เมื่อเครือข่ายขาดกลางขั้นตอน หากพบว่าเจ้าของดู PIN ไม่ตรงแต่ล็อกอินด้วย PIN ใหม่ได้ ให้เปลี่ยน PIN ซ้ำเมื่ออินเทอร์เน็ตเสถียร

## 7. จำ PIN ในเครื่อง

แอปเก็บ ciphertext ใน localStorage และเก็บ AES CryptoKey แบบ non-extractable ใน IndexedDB เมื่อเบราว์เซอร์รองรับ ดีกว่าเก็บ PIN เป็นข้อความตรง ๆ แต่ script ที่รันใน origin เดียวกันยังอาจเรียกใช้ key ได้ จึงไม่ควรเปิด “จำ PIN” บนเครื่องสาธารณะ

## 8. Firebase API key

Firebase Web API key ไม่ใช่รหัสผ่านของฐานข้อมูลและมักต้องอยู่ในโค้ดเว็บ ความปลอดภัยขึ้นกับ Authentication, Firestore Rules, Authorized domains, การตรวจ role และการป้องกันบัญชีเจ้าของ

## 9. Offline

Firestore เปิด persistent local cache เพื่ออ่านข้อมูลที่เคยโหลด แอปปิดปุ่มเขียนเมื่อ `navigator.onLine == false` และทุก write ผ่าน `onlineRequired()` อย่างไรก็ตามสถานะเครือข่ายอาจเปลี่ยนหลังตรวจทันที ไม่มีระบบใดรับประกันความต่อเนื่อง 100% บน client-only app

## 10. PDF

ตัวสร้าง PDF โหลด jsPDF จาก CDN เมื่อใช้งานครั้งแรก และวาดข้อความไทยลง Canvas เป็นภาพก่อนใส่ PDF เพื่อไม่ต้องแจกไฟล์ฟอนต์ PDF อาจสร้างไม่ได้หาก offline และเครื่องยังไม่เคย cache ไลบรารี CDN

## 11. Backup

Backup JSON/CSV ไม่รวม Auth password, Firebase config, Apps Script token, owner private key และ private backup settings `userPins` ใน Backup เป็น ciphertext ผู้ที่ได้ไฟล์ Backup ยังเห็นข้อมูลเงินเดือน เลขบัญชี ยอดขาย และประวัติ จึงต้องเก็บไฟล์ใน Drive/เครื่องที่จำกัดสิทธิ์

## 12. Auto Backup

ไม่มี background server Auto Backup จึงไม่ทำงานเมื่อปิดแอป ต้องใช้ Cloud Functions หรือ server schedule หากต้องการสำรองโดยไม่พึ่งอุปกรณ์เจ้าของ

## 13. ไม่ใช่ระบบบัญชี/ธนาคารที่ผ่านการรับรอง

Dashboard ใช้อัตรากำไรขั้นต้นโดยประมาณ ค่าประกันสังคมปรับได้เพราะกฎหมายเปลี่ยน แอปไม่ใช่ระบบบัญชี ภาษี เงินเดือน หรือธนาคารที่ผ่านการรับรอง ควรตรวจยอดกับเอกสารจริงก่อนจ่ายเงินหรือยื่นข้อมูลทางราชการ
