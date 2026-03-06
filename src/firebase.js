import { initializeApp } from "firebase/app";
import {
    getFirestore, collection, getDocs, addDoc, updateDoc,
    deleteDoc, doc, writeBatch
} from "firebase/firestore";

// Firebase configuration (hardcoded to work without env vars, as it was before)
const firebaseConfig = {
    apiKey: "AIzaSyBMUVrjTXoIQVy6NMaeBYVwor4STbyXmaw",
    authDomain: "agency-app-db.firebaseapp.com",
    databaseURL: "https://agency-app-db-default-rtdb.firebaseio.com",
    projectId: "agency-app-db",
    storageBucket: "agency-app-db.firebasestorage.app",
    messagingSenderId: "672668419469",
    appId: "1:672668419469:web:40f5a57bd04961b5cf69c4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ═══════════════════════════════════════════════════════
// INCOME API
// ═══════════════════════════════════════════════════════
export async function fetchAllIncome() {
    const querySnapshot = await getDocs(collection(db, "income"));
    return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), date: doc.data().date ? new Date(doc.data().date) : null }));
}

export async function addIncome(record) {
    const cleanRecord = { ...record };
    if (cleanRecord.date instanceof Date) {
        cleanRecord.date = cleanRecord.date.toISOString();
    }
    const docRef = await addDoc(collection(db, "income"), cleanRecord);
    return { id: docRef.id, ...cleanRecord, date: record.date };
}

export async function updateIncome(id, updates) {
    const docRef = doc(db, "income", id);
    const cleanUpdates = { ...updates };
    if (cleanUpdates.date instanceof Date) {
        cleanUpdates.date = cleanUpdates.date.toISOString();
    }
    await updateDoc(docRef, cleanUpdates);
    return { id, ...updates };
}

export async function removeIncome(id) {
    await deleteDoc(doc(db, "income", id));
}

export async function saveAllIncome(records, onProgress) {
    const batch = writeBatch(db);
    const colRef = collection(db, "income");
    let i = 0;
    for (const record of records) {
        const cleanRecord = { ...record };
        if (cleanRecord.date instanceof Date) {
            cleanRecord.date = cleanRecord.date.toISOString();
        }
        const newDoc = doc(colRef);
        batch.set(newDoc, cleanRecord);
        i++;
        if (i % 100 === 0 && onProgress) onProgress(i, records.length);
    }
    await batch.commit();
    if (onProgress) onProgress(records.length, records.length);
    return records;
}

export async function addIncome(record) {
    const cleanRecord = { ...record };
    if (cleanRecord.date instanceof Date) {
        cleanRecord.date = cleanRecord.date.toISOString();
    }
    const docRef = await addDoc(collection(db, "income"), cleanRecord);
    return { id: docRef.id, ...cleanRecord, date: record.date };
}

export async function clearAllIncome() {
    const querySnapshot = await getDocs(collection(db, "income"));
    const batch = writeBatch(db);
    querySnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();
}

// ═══════════════════════════════════════════════════════
// PENDING INCOME API
// ═══════════════════════════════════════════════════════
export async function fetchPending() {
    const querySnapshot = await getDocs(collection(db, "pendingIncome"));
    return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), date: doc.data().date ? new Date(doc.data().date) : null }));
}

export async function addPending(record) {
    const cleanRecord = { ...record, submittedAt: new Date().toISOString() };
    if (cleanRecord.date instanceof Date) {
        cleanRecord.date = cleanRecord.date.toISOString();
    }
    const docRef = await addDoc(collection(db, "pendingIncome"), cleanRecord);
    return { id: docRef.id, ...cleanRecord, date: record.date };
}

export async function removePending(id) {
    await deleteDoc(doc(db, "pendingIncome", id));
}

export async function approvePending(id, pendingData) {
    const cleanData = { ...pendingData };
    delete cleanData.id;
    delete cleanData.submittedAt;

    if (cleanData.date instanceof Date) {
        cleanData.date = cleanData.date.toISOString();
    }

    const batch = writeBatch(db);
    const newIncomeRef = doc(collection(db, "income"));
    batch.set(newIncomeRef, cleanData);

    const pendingRef = doc(db, "pendingIncome", id);
    batch.delete(pendingRef);

    await batch.commit();
    return { id: newIncomeRef.id, ...pendingData };
}

// ═══════════════════════════════════════════════════════
// USERS API
// ═══════════════════════════════════════════════════════
export async function fetchUsers() {
    const querySnapshot = await getDocs(collection(db, "users"));
    return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function addUser(name, pass, role) {
    const docRef = await addDoc(collection(db, "users"), { name, password: pass, role });
    return { id: docRef.id, name, password: pass, role };
}

export async function removeUser(id) {
    await deleteDoc(doc(db, "users", id));
}

export async function saveAllUsers(users) {
    const batch = writeBatch(db);
    const colRef = collection(db, "users");
    for (const user of users) {
        const newDoc = doc(colRef);
        batch.set(newDoc, { name: user.name, password: user.pass || user.password, role: user.role });
    }
    await batch.commit();
}

export async function findUser(name, pass) {
    const users = await fetchUsers();
    return users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.password === pass);
}

// ═══════════════════════════════════════════════════════
// EXPENSES API
// ═══════════════════════════════════════════════════════
export async function fetchAllExpenses() {
    const querySnapshot = await getDocs(collection(db, "expenses"));
    return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), date: doc.data().date ? new Date(doc.data().date) : null }));
}

export async function addExpense(record) {
    const cleanRecord = { ...record };
    if (cleanRecord.date instanceof Date) {
        cleanRecord.date = cleanRecord.date.toISOString();
    }
    const docRef = await addDoc(collection(db, "expenses"), cleanRecord);
    return { id: docRef.id, ...cleanRecord, date: record.date };
}

export async function updateExpense(id, updates) {
    const docRef = doc(db, "expenses", id);
    const cleanUpdates = { ...updates };
    if (cleanUpdates.date instanceof Date) {
        cleanUpdates.date = cleanUpdates.date.toISOString();
    }
    await updateDoc(docRef, cleanUpdates);
    return { id, ...updates };
}

export async function removeExpense(id) {
    await deleteDoc(doc(db, "expenses", id));
}

export async function saveAllExpenses(records) {
    const batch = writeBatch(db);
    const colRef = collection(db, "expenses");
    for (const record of records) {
        const cleanRecord = { ...record };
        if (cleanRecord.date instanceof Date) {
            cleanRecord.date = cleanRecord.date.toISOString();
        }
        const newDoc = doc(colRef);
        batch.set(newDoc, cleanRecord);
    }
    await batch.commit();
    return records;
}

// ═══════════════════════════════════════════════════════
// SETTLEMENTS API (העברות כספים וקיזוזים)
// ═══════════════════════════════════════════════════════
export async function fetchSettlements() {
    const querySnapshot = await getDocs(collection(db, "settlements"));
    return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        date: doc.data().date ? new Date(doc.data().date) : null
    }));
}

export async function addSettlement(data) {
    const cleanRecord = { ...data };
    if (cleanRecord.date instanceof Date) {
        cleanRecord.date = cleanRecord.date.toISOString();
    } else if (!cleanRecord.date) {
        cleanRecord.date = new Date().toISOString();
    }
    const docRef = await addDoc(collection(db, "settlements"), cleanRecord);
    return { id: docRef.id, ...cleanRecord, date: new Date(cleanRecord.date) };
}

export async function removeSettlement(id) {
    await deleteDoc(doc(db, "settlements", id));
}
