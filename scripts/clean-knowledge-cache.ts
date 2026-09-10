// Maintenance script to clean up legacy (v1) or expired entries from chatbotKnowledgeCache.
// Run with: npx tsx scripts/clean-knowledge-cache.ts
import { initializeApp } from "firebase/app";
import {
    collection,
    deleteDoc,
    doc,
    getDocs,
    getFirestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || "AIzaSyCRNcZFWVFW-xOVGL846_CmpFMzPyGVjXg",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN || "bonded-app-c8483.firebaseapp.com",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || "bonded-app-c8483",
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || "bonded-app-c8483.firebasestorage.app",
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "577448221286",
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID || "1:577448221286:web:52bdad092f2a81bb9c2ba7",
};

const app = initializeApp(firebaseConfig, "cache-cleaner");
const db = getFirestore(app);

const COLLECTION = "chatbotKnowledgeCache";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function cleanCache() {
  console.log(`Scanning collection "${COLLECTION}"...`);
  try {
    const snap = await getDocs(collection(db, COLLECTION));
    console.log(`Found ${snap.size} documents in ${COLLECTION}.`);

    let deleted = 0;
    let kept = 0;
    const now = Date.now();

    for (const d of snap.docs) {
      const data = d.data();
      const id = d.id;
      const isLegacy = !id.startsWith("v2_");
      const createdMs = Number(data.createdAtMs || 0);
      const isExpired = createdMs > 0 && now - createdMs > TTL_MS;

      if (isLegacy || isExpired) {
        console.log(`Deleting ${id} (legacy=${isLegacy}, expired=${isExpired})...`);
        try {
          await deleteDoc(doc(db, COLLECTION, id));
          deleted++;
        } catch (e: any) {
          console.warn(`Could not delete doc ${id} (rules may require staff auth):`, e?.message || e);
        }
      } else {
        kept++;
      }
    }

    console.log(`\nCleanup complete: ${deleted} deleted, ${kept} valid retained.`);
  } catch (err: any) {
    console.error("Cache cleanup failed:", err?.message || err);
  }
}

cleanCache();

