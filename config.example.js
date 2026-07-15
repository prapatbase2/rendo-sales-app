/** คัดลอกไฟล์นี้เป็น config.js แล้วแทนค่าจาก Firebase Console ของโครงการ Rendo ใหม่ */
export const firebaseConfig = {
  apiKey: "ใส่-apiKey-ของ-Rendo",
  authDomain: "ใส่-project-id.firebaseapp.com",
  projectId: "ใส่-project-id",
  storageBucket: "ใส่-project-id.firebasestorage.app",
  messagingSenderId: "ใส่-messagingSenderId",
  appId: "ใส่-appId"
};

export const rendoConfig = {
  appVersion: "1.0.0",
  schemaVersion: "rendo-schema-1",
  internalEmailDomain: "rendo.local",
  // สร้างข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษรใหม่สำหรับร้าน Rendo ห้ามใช้ตัวอย่างนี้จริง
  authPepper: "เปลี่ยนเป็นข้อความสุ่มยาวอย่างน้อย-32-ตัวอักษร-ก่อนใช้งานจริง",
  firebaseSdkVersion: "11.10.0",
  pdfLibraryUrl: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
};
