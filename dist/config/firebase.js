import admin from "firebase-admin";
import "dotenv/config";
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// normalización de la key por las dudas
if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: "personal-file-manager-7043c.firebasestorage.app",
    });
}
console.log("Firebase connected.");
export const bucket = admin.storage().bucket();
