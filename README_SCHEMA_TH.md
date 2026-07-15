# โครงสร้างข้อมูล Firestore — Rendo v1.0

- `system/initialization` — ล็อกการสร้างเจ้าของคนแรกและ schema version
- `system/backupQueue` — ธงว่ามี write ใหม่ที่เจ้าของควร Backup
- `users/{uid}` — ชื่อ รหัสผู้ใช้ role active วันที่เริ่ม/สิ้นสุด และสิทธิ์เบิก
- `userPins/{uid}` — RSA ciphertext ของ PIN; เจ้าของ/เจ้าของเอกสารตาม Rules
- `securityKeys/pinPublic` — public JWK สำหรับเข้ารหัส PIN
- `ownerSecrets/pinPrivate` — private JWK เฉพาะ owner
- `payrollProfiles/{uid}` — เงินเดือน ธนาคาร บัญชี เรทรายวัน และสถานะประกันสังคม
- `attendance/{date_uid}` — deterministic ID, date, monthKey, monthOrdinal, role snapshot, status, นาทีเริ่ม/สิ้นสุด/OT, paid
- `dailySales/{date}` — deterministic ID, Final เท่านั้น
- `dailySalesDrafts/{date}` — draft แยก ไม่เข้า calculation
- `salaryAdvances/{id}` — userId, date, monthKey, amountCents, soft-delete
- `compensationMonthSettings/{month}` — Draft/Finalized และ settings snapshot
- `compensationRecords/{month_uid}` — adjustments หรือ finalized calculation snapshot
- `recurringExpenses/{id}` — แม่แบบรายจ่ายประจำปัจจุบัน
- `recurringExpenseSnapshots/{month_id}` — snapshot รายเดือน
- `ownerExpenses/{id}` — รายจ่ายที่ owner/manager ลงเอง
- `appSettings/main` — theme, menu order, rates, bonus, social security
- `privateSettings/backup` — URL/token/mode เฉพาะ owner และไม่รวมใน Full Backup
- `auditLogs/{id}` — before/after, actor, server timestamp, hidden flag; ห้ามลบจากแอป
- `backupsMetadata/{id}` — เวลาและสถานะ Backup

จำนวนเงินใช้ integer cents เช่น 315.25 บาทเก็บเป็น `31525` เพื่อไม่ให้เกิด floating point error

วันที่หลักเก็บ ISO `YYYY-MM-DD`; ปี พ.ศ. ใช้เฉพาะตอนแสดงผล

เวลาที่ถึง 24:00 เก็บเป็น `1440` นาที ไม่ใช้ JavaScript Date จึงไม่เลื่อนไปวันถัดไปโดยไม่ตั้งใจ

ชื่อคนไม่ใช้เป็น key การคำนวณอ้าง `uid`/stable document ID เพื่อให้เปลี่ยนชื่อหรือเรียงรายการได้โดยข้อมูลเก่าไม่เสีย
