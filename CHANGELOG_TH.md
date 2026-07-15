# CHANGELOG — Rendo

## v1.0.0 — 15 กรกฎาคม 2569

- สร้าง Static PWA ใหม่สำหรับ RENDO – RAMEN & GYOZA
- Firebase Email/Password ผ่านรหัสผู้ใช้ + PIN ที่แปลงเป็น password
- secondary Firebase Auth สำหรับสร้างผู้ใช้โดยไม่ออกจากบัญชีผู้ดูแล
- RSA-OAEP PIN vault แยก public/private key และ Firestore Rules ตาม role
- ผู้ใช้ 8 role, soft deactivate, วันที่เริ่ม/สิ้นสุด และสิทธิ์เบิก
- เช็คชื่อ deterministic ID, พนักงานเวียน, รายวัน, OT และ 24:00 = 1440 นาที
- ยอดขาย Final/Draft, สมการเงินสด, รายจ่ายกะ, opening cash suggestion และ audit
- รายเดือนแบบปี พ.ศ. สำหรับแสดงผล
- เงินเบิกล่วงหน้า
- calculation กลางแบบ integer cents สำหรับโบนัส ประกันสังคม ยอดโอน และ shop cost
- ค่าตอบแทน Draft/Finalized snapshot และ PDF ไทยผ่าน Canvas + jsPDF on demand
- รายจ่ายประจำ snapshot, รายจ่ายอื่น และ reorder stable ID
- Dashboard พร้อมสูตร gross margin โดยประมาณ
- Audit Log ซ่อนจาก manager ได้แต่ไม่ลบ
- Backup/Restore JSON/CSV, Apps Script Drive receiver, merge/replace และ pre-restore backup
- PWA manifest, service worker, offline read-only, update prompt และไอคอน maskable
- คู่มือภาษาไทยและ calculation tests 14 รายการ
