import { initializeApp } from "firebase/app";
import {
    getFirestore, collection, doc,
    getDocs, getDoc, addDoc, setDoc, updateDoc, deleteDoc,
    query, where, writeBatch
} from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyBMUVrjTXoIQVy6NMaeBYVwor4STbyXmaw",
    authDomain: "agency-app-db.firebaseapp.com",
    databaseURL: "https://agency-app-db-default-rtdb.firebaseio.com",
    projectId: "agency-app-db",
    storageBucket: "agency-app-db.firebasestorage.app",
    messagingSenderId: "672668419469",
    appId: "1:672668419469:web:40f5a57bd04961b5cf69c4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ── Helpers ──────────────────────────────────────────
function serialize(obj) {
    const o = { ...obj };
    // Convert Date objects to ISO strings for Firestore
    if (o.date instanceof Date) o.date = o.date.toISOString();
    if (o.submittedAt instanceof Date) o.submittedAt = o.submittedAt.toISOString();
    return o;
}

function deserialize(obj) {
    const o = { ...obj };
    // Convert ISO strings back to Date objects
    if (typeof o.date === "string" && o.date) {
        const d = new Date(o.date);
        if (!isNaN(d)) o.date = d;
    }
    if (typeof o.submittedAt === "string" && o.submittedAt) {
        const d = new Date(o.submittedAt);
        if (!isNaN(d)) o.submittedAt = d;
    }
    return o;
}

// ── Income (approved) ────────────────────────────────
const incomeCol = () => collection(db, "income");

export async function fetchAllIncome() {
    const snap = await getDocs(incomeCol());
    return snap.docs.map(d => deserialize({ ...d.data(), id: d.id }));
}

export async function addIncome(record) {
    const data = serialize(record);
    const { id, ...rest } = data;
    if (id && !id.startsWith("I-chatter-")) {
        // Use existing ID as doc ID
        await setDoc(doc(db, "income", id), rest);
        return { ...record, id };
    }
    const ref = await addDoc(incomeCol(), rest);
    return { ...record, id: ref.id };
}

export async function updateIncome(id, updates) {
    await updateDoc(doc(db, "income", id), serialize(updates));
}

export async function removeIncome(id) {
    await deleteDoc(doc(db, "income", id));
}

// Batch save for migration (500 per batch = Firestore limit)
export async function saveAllIncome(records, onProgress) {
    const BATCH_SIZE = 400;
    let saved = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        const chunk = records.slice(i, i + BATCH_SIZE);
        chunk.forEach(r => {
            const { id, ...rest } = serialize(r);
            const docId = id || `inc-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            batch.set(doc(db, "income", docId), rest);
        });
        await batch.commit();
        saved += chunk.length;
        if (onProgress) onProgress(saved, records.length);
    }
    return saved;
}

export async function clearAllIncome() {
    const snap = await getDocs(incomeCol());
    const BATCH_SIZE = 400;
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
}

// ── Pending Income ───────────────────────────────────
const pendingCol = () => collection(db, "pendingIncome");

export async function fetchPending() {
    const snap = await getDocs(pendingCol());
    return snap.docs.map(d => deserialize({ ...d.data(), id: d.id }));
}

export async function addPending(record) {
    const data = serialize({ ...record, submittedAt: new Date() });
    const { id, ...rest } = data;
    const ref = await addDoc(pendingCol(), rest);
    return { ...record, id: ref.id, submittedAt: new Date() };
}

export async function removePending(id) {
    await deleteDoc(doc(db, "pendingIncome", id));
}

// Approve: move from pending → income
export async function approvePending(pendingRecord) {
    const { submittedAt, ...incomeData } = pendingRecord;
    const saved = await addIncome({ ...incomeData, verified: "V" });
    await removePending(pendingRecord.id);
    return saved;
}

// ── Users ────────────────────────────────────────────
const usersCol = () => collection(db, "users");

export async function fetchUsers() {
    const snap = await getDocs(usersCol());
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

export async function addUser(name, password, role) {
    const ref = await addDoc(usersCol(), { name, password, role });
    return { id: ref.id, name, password, role };
}

export async function removeUser(id) {
    await deleteDoc(doc(db, "users", id));
}

export async function findUser(name, password) {
    const snap = await getDocs(usersCol());
    return snap.docs.map(d => ({ ...d.data(), id: d.id }))
        .find(u => u.name === name && u.password === password) || null;
}

// Batch save users for migration
export async function saveAllUsers(users) {
    const batch = writeBatch(db);
    users.forEach(u => {
        const { id, _rowIndex, ...rest } = u;
        const docId = `user-${rest.name.replace(/\s+/g, '-')}`;
        batch.set(doc(db, "users", docId), rest);
    });
    await batch.commit();
}

// ── Expenses ─────────────────────────────────────────
const expensesCol = () => collection(db, "expenses");

export async function fetchAllExpenses() {
    const snap = await getDocs(expensesCol());
    return snap.docs.map(d => deserialize({ ...d.data(), id: d.id }));
}

export async function addExpense(record) {
    const data = serialize(record);
    const { id, ...rest } = data;
    const ref = await addDoc(expensesCol(), rest);
    return { ...record, id: ref.id };
}

export async function updateExpense(id, updates) {
    await updateDoc(doc(db, "expenses", id), serialize(updates));
}

export async function removeExpense(id) {
    await deleteDoc(doc(db, "expenses", id));
}

// Batch save for migration
export async function saveAllExpenses(records, onProgress) {
    const BATCH_SIZE = 400;
    let saved = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        const chunk = records.slice(i, i + BATCH_SIZE);
        chunk.forEach((r, j) => {
            const { id, ...rest } = serialize(r);
            const docId = `exp-${i + j}-${Date.now()}`;
            batch.set(doc(db, "expenses", docId), rest);
        });
        await batch.commit();
        saved += chunk.length;
        if (onProgress) onProgress(saved, records.length);
    }
    return saved;
}
