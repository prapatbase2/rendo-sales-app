/** คัดลอกไฟล์นี้เป็น config.js แล้วแทนค่าจาก Firebase Console ของโครงการ Rendo ใหม่ */
export const firebaseConfig = {
  apiKey: "AIzaSyB0yv0m7brx8WXyw8zTK8tqVm4K9I1EmzM",
  authDomain: "rendo-sales.firebaseapp.com",
  projectId: "rendo-sales",
  storageBucket: "rendo-sales.firebasestorage.app",
  messagingSenderId: "1088583610974",
  appId: "1:1088583610974:web:e1aa7525fd2c4dc58a7acf"
};

export const rendoConfig = {
  appVersion: "1.0.0",
  schemaVersion: "rendo-schema-1",
  internalEmailDomain: "rendo.local",
  // สร้างข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษรใหม่สำหรับร้าน Rendo ห้ามใช้ตัวอย่างนี้จริง
  authPepper: "rendo@562absceseratyeraet265rendo",
  firebaseSdkVersion: "11.10.0",
  pdfLibraryUrl: "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
};
