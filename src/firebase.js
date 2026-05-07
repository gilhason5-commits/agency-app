import { initializeApp } from "firebase/app";
import {
    getFirestore, collection, getDocs, getDoc, addDoc, updateDoc,
    deleteDoc, doc, writeBatch, setDoc
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
export const db = getFirestore(app);

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
    return { id: docRef.id, ...cleanRecord, date: cleanRecord.date ? new Date(cleanRecord.date) : null };
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



// Retroactively apply commissions to all records that don't have it yet.
// Mirrors the logic of resolveCommissionPct in App.jsx.
// Returns the count of updated records.
const PLATFORM_COMMISSIONS_MAP = { "אונלי": 20 };
const INCOME_TYPE_COMMISSIONS_MAP = { "ווישלי": 8, "קארדקום": 13 };
function resolveCommissionPct(platform, incomeType) {
    return PLATFORM_COMMISSIONS_MAP[platform] || INCOME_TYPE_COMMISSIONS_MAP[incomeType] || 0;
}
export async function migrateCommissions() {
    const colNames = ["income", "pendingIncome"];
    let updated = 0;
    for (const colName of colNames) {
        const snapshot = await getDocs(collection(db, colName));
        const toUpdate = snapshot.docs.filter(d => {
            const r = d.data();
            const pct = resolveCommissionPct(r.platform, r.incomeType);
            return pct && !r.cancelled && !(r.commissionPct > 0 && r.preCommissionILS != null);
        });
        for (let i = 0; i < toUpdate.length; i += 490) {
            const chunk = toUpdate.slice(i, i + 490);
            const batch = writeBatch(db);
            for (const docSnap of chunk) {
                const r = docSnap.data();
                const pct = resolveCommissionPct(r.platform, r.incomeType);
                const factor = 1 - pct / 100;
                const preILS = r.amountILS || 0;
                const preUSD = r.originalRawUSD || r.amountUSD || 0;
                batch.update(docSnap.ref, {
                    commissionPct: pct,
                    preCommissionILS: preILS,
                    preCommissionUSD: preUSD,
                    amountILS: Math.round(preILS * factor),
                    amountUSD: preUSD > 0 ? Math.round(preUSD * factor * 100) / 100 : (r.amountUSD || 0),
                    originalAmount: preILS,
                });
            }
            await batch.commit();
            updated += chunk.length;
        }
    }
    return updated;
}

// Restore records corrupted by a previous retroRecalculate run that used rate=0 for USD records.
// For commission records: restore preCommissionILS = rawILS + rawUSD * fallbackRate, then re-apply commission.
// For non-commission records: restore originalAmount = rawILS + rawUSD * fallbackRate and amountILS = same.
export async function restoreCorruptedRecords(fallbackRate) {
    const colNames = ["income", "pendingIncome"];
    let fixed = 0;
    for (const colName of colNames) {
        const snapshot = await getDocs(collection(db, colName));
        const toFix = snapshot.docs.filter(d => {
            const r = d.data();
            if (r.cancelled) return false;
            const rawUSD = r.originalRawUSD !== undefined ? r.originalRawUSD : (r.amountUSD || 0);
            const rate = parseFloat(r.usdRate) || 0;
            // Only fix records where USD exists but rate was 0 (USD portion was zeroed out)
            return rawUSD > 0 && rate === 0;
        });
        for (let i = 0; i < toFix.length; i += 490) {
            const chunk = toFix.slice(i, i + 490);
            const batch = writeBatch(db);
            for (const docSnap of chunk) {
                const r = docSnap.data();
                const rawILS = r.rawILS !== undefined ? r.rawILS : (r.originalRawILS || 0);
                const rawUSD = r.originalRawUSD !== undefined ? r.originalRawUSD : (r.amountUSD || 0);
                const combinedILS = rawILS + rawUSD * fallbackRate;
                const pct = resolveCommissionPct(r.platform, r.incomeType);
                const factor = pct > 0 ? 1 - pct / 100 : 1;
                const updates = {
                    amountILS: combinedILS * factor,
                    originalAmount: combinedILS,
                };
                if (rawUSD > 0) updates.amountUSD = rawUSD * factor;
                if (pct > 0) {
                    updates.preCommissionILS = combinedILS;
                    updates.preCommissionUSD = rawUSD;
                    updates.commissionPct = pct;
                }
                batch.update(docSnap.ref, updates);
                fixed++;
            }
            await batch.commit();
        }
    }
    return fixed;
}

// Retroactively recalculate all stored amounts with full decimal precision (no Math.round).
// Uses the raw stored components (rawILS, originalRawUSD, usdRate) to recompute exact values.
// Records with rawUSD > 0 but usdRate = 0 are skipped (cannot compute without rate).
export async function retroRecalculate() {
    const colNames = ["income", "pendingIncome"];
    let updated = 0;
    for (const colName of colNames) {
        const snapshot = await getDocs(collection(db, colName));
        for (let i = 0; i < snapshot.docs.length; i += 490) {
            const chunk = snapshot.docs.slice(i, i + 490);
            const batch = writeBatch(db);
            for (const docSnap of chunk) {
                const r = docSnap.data();
                if (r.cancelled) continue;

                const rawILS = r.rawILS !== undefined ? r.rawILS : (r.originalRawILS || 0);
                const rawUSD = r.originalRawUSD !== undefined ? r.originalRawUSD
                             : (r.preCommissionUSD > 0 ? r.preCommissionUSD : (r.amountUSD || 0));
                const rate = parseFloat(r.usdRate) || 0;

                // Skip records with USD but no stored rate — would zero out the USD portion
                if (rawUSD > 0 && rate === 0) continue;

                // Compute exact combined pre-commission ILS
                const combinedILS = rawILS + rawUSD * rate;

                const pct = resolveCommissionPct(r.platform, r.incomeType);
                const factor = pct > 0 ? 1 - pct / 100 : 1;

                const updates = {
                    amountILS: combinedILS * factor,
                    originalAmount: combinedILS,
                };
                if (rawUSD > 0) updates.amountUSD = rawUSD * factor;
                if (pct > 0) {
                    updates.preCommissionILS = combinedILS;
                    updates.preCommissionUSD = rawUSD;
                    updates.commissionPct = pct;
                }
                batch.update(docSnap.ref, updates);
                updated++;
            }
            await batch.commit();
        }
    }
    return updated;
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
    const allDocs = querySnapshot.docs.map(d => ({ _docId: d.id, ...d.data() }));

    // Separate decision docs (have _approvesId) from actual pending records
    const decisions = {}; // pendingId -> "approve" | "reject"
    const actualPending = [];
    allDocs.forEach(r => {
        if (r._approvesId) {
            decisions[r._approvesId] = r.action;
        } else {
            actualPending.push(r);
        }
    });

    // Also read old-style approvals from the legacy approvedPending collection
    // (records approved before the new system was deployed)
    try {
        const oldSnap = await getDocs(collection(db, "approvedPending"));
        oldSnap.docs.forEach(d => {
            const r = d.data();
            if (r.pendingId && !decisions[r.pendingId]) {
                decisions[r.pendingId] = r.action || "approve";
            }
        });
    } catch (e) {
        console.warn("approvedPending read failed (legacy):", e?.code);
    }

    // Apply decisions: filter rejected, mark approved
    return actualPending
        .filter(r => decisions[r._docId] !== "reject")
        .map(r => ({
            ...r,
            id: r._docId,
            _docId: undefined,
            date: r.date ? new Date(r.date) : null,
            verified: decisions[r._docId] === "approve" ? "V" : (r.verified || "")
        }));
}

export async function addPending(record) {
    const cleanRecord = { ...record, submittedAt: new Date().toISOString() };
    if (cleanRecord.date instanceof Date) {
        cleanRecord.date = cleanRecord.date.toISOString();
    }
    const docRef = await addDoc(collection(db, "pendingIncome"), cleanRecord);
    return { id: docRef.id, ...cleanRecord, date: record.date };
}

export async function updatePending(id, updates) {
    const docRef = doc(db, "pendingIncome", id);
    const cleanUpdates = { ...updates };
    if (cleanUpdates.date instanceof Date) {
        cleanUpdates.date = cleanUpdates.date.toISOString();
    }
    await updateDoc(docRef, cleanUpdates);
    return { id, ...updates };
}

export async function removePending(id) {
    await deleteDoc(doc(db, "pendingIncome", id));
}

// Save approval/rejection decision as a new doc in pendingIncome.
// Uses only addDoc (create) — works even when update/delete are restricted.
export async function approvePending(id, pendingData) {
    await addDoc(collection(db, "pendingIncome"), {
        _approvesId: id,
        action: "approve",
        decidedAt: new Date().toISOString()
    });
    const dateVal = pendingData.date instanceof Date ? pendingData.date
        : (pendingData.date ? new Date(pendingData.date) : null);
    return { ...pendingData, id, verified: "V", date: dateVal };
}

export async function rejectPending(id) {
    await addDoc(collection(db, "pendingIncome"), {
        _approvesId: id,
        action: "reject",
        decidedAt: new Date().toISOString()
    });
}

// Fix income records that were approved before the verified flag was added.
// Any record in the income collection with _fromPending=true is already approved.
export async function fixOrphanedApprovals() {
    const snapshot = await getDocs(collection(db, "income"));
    const corrupted = snapshot.docs.filter(d => {
        const r = d.data();
        return r._fromPending === true && r.verified !== "V" && r.verified !== "מאומת";
    });
    if (corrupted.length === 0) return 0;
    for (let i = 0; i < corrupted.length; i += 490) {
        const batch = writeBatch(db);
        corrupted.slice(i, i + 490).forEach(d => {
            batch.update(d.ref, { verified: "V", _fromPending: false });
        });
        await batch.commit();
    }
    return corrupted.length;
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

export async function updateUserPassword(id, newPassword) {
    await updateDoc(doc(db, "users", id), { password: newPassword });
}

export async function getAdminPassword() {
    const snap = await getDoc(doc(db, "config", "admin"));
    return snap.exists() ? snap.data().password : null;
}

export async function setAdminPassword(newPassword) {
    await setDoc(doc(db, "config", "admin"), { password: newPassword });
}

export async function forceLogoutAll() {
    await setDoc(doc(db, "config", "forceLogout"), { at: Date.now() });
}

export async function getForceLogoutAt() {
    const snap = await getDoc(doc(db, "config", "forceLogout"));
    return snap.exists() ? snap.data().at : 0;
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

// ═══════════════════════════════════════════════════════
// CHATTER TARGETS API
// ═══════════════════════════════════════════════════════
export async function fetchChatterTargets() {
    const snap = await getDocs(collection(db, "chatterTargets"));
    const result = {};
    snap.forEach(d => { result[d.id] = d.data(); });
    return result;
}

export async function setChatterTarget(chatterName, targets) {
    await setDoc(doc(db, "chatterTargets", chatterName), targets);
}

// ═══════════════════════════════════════════════════════
// CLIENT RATES API
// ═══════════════════════════════════════════════════════
export async function fetchClientRates() {
    try {
        const snap = await getDocs(collection(db, "clientRates"));
        const result = {};
        snap.forEach(d => { result[d.id] = d.data(); });
        return result;
    } catch { return {}; }
}

export async function saveClientRate(clientName, ymi, pct) {
    await setDoc(doc(db, "clientRates", clientName), { [ymi]: pct }, { merge: true });
}

// ═══════════════════════════════════════════════════════
// CHATTER SETTINGS API (salary type, rates, hourly pay)
// ═══════════════════════════════════════════════════════
export async function fetchAllChatterSettings() {
    try {
        const snap = await getDocs(collection(db, "chatterSettings"));
        const result = {};
        snap.forEach(d => { result[d.id] = d.data(); });
        return result;
    } catch { return {}; }
}

export async function saveChatterSettings(chatterName, settings) {
    await setDoc(doc(db, "chatterSettings", chatterName), settings, { merge: true });
}

// ═══════════════════════════════════════════════════════
// CLIENT SETTINGS API (vat, etc.)
// ═══════════════════════════════════════════════════════
export async function fetchAllClientSettings() {
    try {
        const snap = await getDocs(collection(db, "clientSettings"));
        const result = {};
        snap.forEach(d => { result[d.id] = d.data(); });
        return result;
    } catch { return {}; }
}

export async function saveClientSettings(clientName, settings) {
    await setDoc(doc(db, "clientSettings", clientName), settings, { merge: true });
}

// ═══════════════════════════════════════════════════════
// COMMISSION SETTINGS API (synced across devices)
// ═══════════════════════════════════════════════════════
export async function fetchCommissionSettings() {
    try {
        const snap = await getDoc(doc(db, "config", "commissions"));
        return snap.exists() ? snap.data().types || {} : {};
    } catch { return {}; }
}

export async function saveCommissionSettings(commissions) {
    await setDoc(doc(db, "config", "commissions"), { types: commissions }, { merge: true });
}

// ═══════════════════════════════════════════════════════
// AGENCY SETTINGS API (all shared config synced via Firebase)
// ═══════════════════════════════════════════════════════
export async function fetchAgencySettings() {
    try {
        const snap = await getDoc(doc(db, "config", "agencySettings"));
        return snap.exists() ? snap.data() : {};
    } catch { return {}; }
}

export async function saveAgencySettings(settings) {
    await setDoc(doc(db, "config", "agencySettings"), settings, { merge: true });
}

// ═══════════════════════════════════════════════════════
// FIXED EXPENSES API
// ═══════════════════════════════════════════════════════
export async function fetchFixedExpenses() {
    const snap = await getDocs(collection(db, "fixedExpenses"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addFixedExpense(record) {
    const docRef = await addDoc(collection(db, "fixedExpenses"), record);
    return { id: docRef.id, ...record };
}

export async function updateFixedExpense(id, updates) {
    await updateDoc(doc(db, "fixedExpenses", id), updates);
}

export async function removeFixedExpense(id) {
    await deleteDoc(doc(db, "fixedExpenses", id));
}

// ═══════════════════════════════════════════════════════
// EMPLOYEES API
// ═══════════════════════════════════════════════════════
export async function fetchEmployees() {
    const snap = await getDocs(collection(db, "employees"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addEmployee(record) {
    const docRef = await addDoc(collection(db, "employees"), record);
    return { id: docRef.id, ...record };
}

export async function removeEmployee(id) {
    await deleteDoc(doc(db, "employees", id));
}

// ═══════════════════════════════════════════════════════
// SHIFT SLOTS API (configurable time slot definitions)
// ═══════════════════════════════════════════════════════
export async function fetchShiftSlots() {
    const snap = await getDocs(collection(db, "shiftSlots"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function saveShiftSlot(slot) {
    if (slot.id) {
        const { id, ...data } = slot;
        await setDoc(doc(db, "shiftSlots", id), data, { merge: true });
        return slot;
    }
    const docRef = await addDoc(collection(db, "shiftSlots"), slot);
    return { id: docRef.id, ...slot };
}

export async function removeShiftSlot(id) {
    await deleteDoc(doc(db, "shiftSlots", id));
}

// ═══════════════════════════════════════════════════════
// SHIFTS API (daily shift assignments/requests)
// ═══════════════════════════════════════════════════════
export async function fetchShifts() {
    const snap = await getDocs(collection(db, "shifts"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addShift(data) {
    const cleanData = { ...data, requestedAt: new Date().toISOString() };
    const docRef = await addDoc(collection(db, "shifts"), cleanData);
    return { id: docRef.id, ...cleanData };
}

export async function updateShift(id, updates) {
    await updateDoc(doc(db, "shifts", id), updates);
    return { id, ...updates };
}

export async function removeShift(id) {
    await deleteDoc(doc(db, "shifts", id));
}

// ═══════════════════════════════════════════════════════
// MODELS API (content generator models)
// ═══════════════════════════════════════════════════════
export async function fetchModels() {
    const snap = await getDocs(collection(db, "models"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addModel(model) {
    const docRef = await addDoc(collection(db, "models"), model);
    return { id: docRef.id, ...model };
}

export async function updateModel(id, updates) {
    await updateDoc(doc(db, "models", id), updates);
    return { id, ...updates };
}

export async function removeModel(id) {
    await deleteDoc(doc(db, "models", id));
}

// ═══════════════════════════════════════════════════════
// GENERATION HISTORY API
// ═══════════════════════════════════════════════════════
export async function fetchHistory() {
    const snap = await getDocs(collection(db, "generationHistory"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addHistory(record) {
    const docRef = await addDoc(collection(db, "generationHistory"), record);
    return { id: docRef.id, ...record };
}

// ═══════════════════════════════════════════════════════
// GENERATION PARAMS API
// ═══════════════════════════════════════════════════════
export async function fetchGenParams() {
    try {
        const snap = await getDoc(doc(db, "config", "genParams"));
        return snap.exists() ? snap.data() : null;
    } catch { return null; }
}

export async function saveGenParams(params) {
    await setDoc(doc(db, "config", "genParams"), params, { merge: true });
}

// ═══════════════════════════════════════════════════════
// ASSETS/EQUIPMENT API
// ═══════════════════════════════════════════════════════
export async function fetchAssets() {
    const snap = await getDocs(collection(db, "assets"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addAssetRecord(record) {
    const docRef = await addDoc(collection(db, "assets"), record);
    return { id: docRef.id, ...record };
}

export async function updateAssetRecord(id, updates) {
    await updateDoc(doc(db, "assets", id), updates);
    return { id, ...updates };
}

export async function removeAssetRecord(id) {
    await deleteDoc(doc(db, "assets", id));
}

// ═══════════════════════════════════════════════════════
// TEAM LEAD LOGS API
// ═══════════════════════════════════════════════════════
export async function fetchTeamLeadLogs() {
    const snap = await getDocs(collection(db, "teamLeadLogs"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addTeamLeadLog(data) {
    const docRef = await addDoc(collection(db, "teamLeadLogs"), data);
    return { id: docRef.id, ...data };
}

export async function updateTeamLeadLog(id, updates) {
    await updateDoc(doc(db, "teamLeadLogs", id), updates);
    return { id, ...updates };
}
