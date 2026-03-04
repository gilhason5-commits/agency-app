// One-time migration script: Google Sheets → Firebase Firestore
import { initializeApp } from "firebase/app";
import { getFirestore, collection, writeBatch, doc, getDocs } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyBMUVrjTXoIQVy6NMaeBYVwor4STbyXmaw",
    authDomain: "agency-app-db.firebaseapp.com",
    projectId: "agency-app-db",
    storageBucket: "agency-app-db.firebasestorage.app",
    messagingSenderId: "672668419469",
    appId: "1:672668419469:web:40f5a57bd04961b5cf69c4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === "number") return new Date((v - 25569) * 86400e3);
    const s = String(v).trim().replace(/\./g, '/');
    const dIso = new Date(v);
    if (!isNaN(dIso) && s.includes("T")) return dIso;
    const p = s.split("/");
    if (p.length === 3 && +p[0] <= 31) return new Date(+p[2], +p[1] - 1, +p[0]);
    return isNaN(dIso) ? null : dIso;
}

function sanitizeName(name) {
    if (!name) return "";
    return String(name).replace(/׳/g, "'").replace(/\s+/g, " ").trim();
}

function mapInc(row, idx) {
    const rawILS = +row[5] || 0;
    const rawUSD = +row[4] || 0;
    const activeRate = parseFloat(row[3]) > 0 ? parseFloat(row[3]) : 3.6;
    const computedILS = rawILS + (rawUSD > 0 ? Math.round(rawUSD * activeRate) : 0);
    const cancelled = String(row[14] || "").toUpperCase() === "V";
    const d = parseDate(row[8]);
    return {
        id: `inc-${idx}-${Date.now()}`,
        chatterName: sanitizeName(row[0]),
        modelName: sanitizeName(row[1]),
        clientName: sanitizeName(row[2]),
        usdRate: activeRate,
        rawILS: cancelled ? 0 : rawILS,
        amountUSD: cancelled ? 0 : rawUSD,
        amountILS: cancelled ? 0 : computedILS,
        originalAmount: computedILS,
        originalRawILS: rawILS,
        originalRawUSD: rawUSD,
        incomeType: String(row[6] || ""),
        platform: String(row[7] || ""),
        date: d ? d.toISOString() : null,
        hour: String(row[9] || ""),
        notes: String(row[10] || ""),
        verified: "V",
        shiftLocation: String(row[12] || ""),
        paidToClient: String(row[13] || "").toUpperCase() === "V",
        cancelled
    };
}

async function migrate() {
    console.log("📥 Fetching income from Google Sheets...");
    const URL = "https://script.google.com/macros/s/AKfycbyj2mD6Gu6TRezxs10xsn6KnvRUWyie9XrOqwOgHYZZbxw0RW9VLAjQab_ksAK5azdMzg/exec";
    const resp = await fetch(`${URL}?action=read&sheet=${encodeURIComponent("הכנסות ארכיון")}`);
    const data = await resp.json();
    const rows = data.data || [];
    console.log(`Got ${rows.length} rows (including header)`);

    const parsed = rows.slice(1).map((r, i) => mapInc(r, i));
    console.log(`Parsed ${parsed.length} income records`);

    // Clear existing income in Firebase
    console.log("🗑️ Clearing existing Firebase income...");
    const snap = await getDocs(collection(db, "income"));
    const existingDocs = snap.docs;
    if (existingDocs.length > 0) {
        for (let i = 0; i < existingDocs.length; i += 400) {
            const batch = writeBatch(db);
            existingDocs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log(`  Deleted ${Math.min(i + 400, existingDocs.length)}/${existingDocs.length}`);
        }
    }
    console.log(`Cleared ${existingDocs.length} existing docs`);

    // Save all parsed records to Firebase
    console.log("🔥 Saving to Firebase...");
    let saved = 0;
    for (let i = 0; i < parsed.length; i += 400) {
        const batch = writeBatch(db);
        const chunk = parsed.slice(i, i + 400);
        chunk.forEach((r, j) => {
            const { id, ...rest } = r;
            batch.set(doc(db, "income", `inc-${i + j}`), rest);
        });
        await batch.commit();
        saved += chunk.length;
        console.log(`  Saved ${saved}/${parsed.length}`);
    }

    console.log(`\n✅ Done! ${saved} income records migrated to Firebase.`);

    // Also migrate users
    console.log("\n👤 Migrating users...");
    const usersResp = await fetch(`${URL}?action=read&sheet=users`);
    const usersData = await usersResp.json();
    const userRows = usersData.data || [];
    const users = userRows.slice(1).map(r => ({
        name: String(r[0] || "").trim(),
        password: String(r[1] || "").trim(),
        role: String(r[2] || "chatter").trim()
    })).filter(u => u.name && u.password);

    if (users.length > 0) {
        const batch = writeBatch(db);
        users.forEach(u => {
            const docId = `user-${u.name.replace(/\s+/g, '-')}`;
            batch.set(doc(db, "users", docId), u);
        });
        await batch.commit();
        console.log(`✅ ${users.length} users migrated to Firebase.`);
    } else {
        console.log("⚠️ No users found in Sheets.");
    }

    process.exit(0);
}

migrate().catch(e => { console.error("❌ Migration failed:", e); process.exit(1); });
