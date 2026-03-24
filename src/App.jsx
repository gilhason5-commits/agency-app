import { useState, useEffect, useCallback, createContext, useContext, useMemo, useRef } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart, Area, LabelList } from "recharts";
import {
  fetchAllIncome, addIncome, updateIncome, removeIncome, saveAllIncome, clearAllIncome, migrateCommissions, retroRecalculate, restoreCorruptedRecords,
  fetchPending, addPending, updatePending, removePending, approvePending, rejectPending, fixOrphanedApprovals,
  fetchUsers, addUser, removeUser, findUser, saveAllUsers, updateUserPassword, getAdminPassword, setAdminPassword,
  fetchAllExpenses, addExpense, updateExpense, removeExpense, saveAllExpenses,
  fetchSettlements, addSettlement, removeSettlement,
  fetchChatterTargets, setChatterTarget,
  fetchClientRates, saveClientRate,
  fetchAllChatterSettings, saveChatterSettings,
  fetchAllClientSettings, saveClientSettings,
  fetchFixedExpenses, addFixedExpense, updateFixedExpense, removeFixedExpense,
  fetchEmployees, addEmployee, removeEmployee,
  forceLogoutAll, getForceLogoutAt
} from "./firebase.js";

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
const APPS_SCRIPT_URL = import.meta.env.VITE_APPS_SCRIPT_URL || "";
const EXPENSES_URL = import.meta.env.VITE_EXPENSES_URL || "";
const GROK_API_KEY_DEFAULT = import.meta.env.VITE_GROK_API_KEY || "";
const TELEGRAM_BOT_TOKEN = import.meta.env.VITE_TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = import.meta.env.VITE_TELEGRAM_CHAT_ID || "";

// ═══════════════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS
// ═══════════════════════════════════════════════════════
const TelegramSvc = {
  async send(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      });
    } catch (e) {
      console.warn("Telegram notification failed:", e.message);
    }
  },
  notifyIncomeSubmitted(row) {
    const amount = row.amountILS ? `₪${Number(row.amountILS).toLocaleString("he-IL")}` : "";
    return this.send(`📥 <b>עסקה חדשה ממתינה לאישור</b>\nצ'אטר: ${row.chatterName || "—"}\nלקוחה: ${row.modelName || "—"}\nסכום: ${amount}\nפלטפורמה: ${row.platform || "—"}\nתאריך: ${row.date instanceof Date ? row.date.toLocaleDateString("he-IL") : row.date || "—"}`);
  },
  notifyIncomeApproved(row) {
    const amount = row.amountILS ? `₪${Number(row.amountILS).toLocaleString("he-IL")}` : "";
    return this.send(`✅ <b>עסקה אושרה</b>\nצ'אטר: ${row.chatterName || "—"}\nלקוחה: ${row.modelName || "—"}\nסכום: ${amount}\nפלטפורמה: ${row.platform || "—"}`);
  },
  notifyIncomeAdded(row) {
    const amount = row.amountILS ? `₪${Number(row.amountILS).toLocaleString("he-IL")}` : "";
    return this.send(`💰 <b>הכנסה נוספה ידנית</b>\nצ'אטר: ${row.chatterName || "—"}\nלקוחה: ${row.modelName || "—"}\nסכום: ${amount}\nפלטפורמה: ${row.platform || "—"}`);
  },
  notifyExpenseAdded(exp) {
    const amount = exp.amount ? `₪${Number(exp.amount).toLocaleString("he-IL")}` : "";
    return this.send(`💳 <b>הוצאה תועדה</b>\nקטגוריה: ${exp.category || "—"}\nתיאור: ${exp.name || "—"}\nסכום: ${amount}\nשילם: ${exp.paidBy || "—"}`);
  },
};

// Income type commission rates (hardcoded, always applied)
const INCOME_TYPE_COMMISSIONS = { "אונלי": 20 };
// Income type commission rates (editable via settings)
const _incomeTypeCommissions = (() => {
  try { return JSON.parse(localStorage.getItem("INCOME_TYPE_COMMISSIONS_DB") || '{"ווישלי":8,"קארדקום":13}'); }
  catch { return { "ווישלי": 8, "קארדקום": 13 }; }
})();
function saveIncomeTypeCommission(typeName, pct) {
  if (pct > 0) _incomeTypeCommissions[typeName] = pct;
  else delete _incomeTypeCommissions[typeName];
  try { localStorage.setItem("INCOME_TYPE_COMMISSIONS_DB", JSON.stringify(_incomeTypeCommissions)); } catch {}
}

// Resolve commission % for a given platform + incomeType
function resolveCommissionPct(platform, incomeType) {
  return INCOME_TYPE_COMMISSIONS[incomeType] || _incomeTypeCommissions[incomeType] || 0;
}

// Compute commission fields when saving income.
// Returns fields to spread onto the saved record.
function computeCommissionFields(platform, incomeType, inputILS, inputUSD, rate) {
  const pct = resolveCommissionPct(platform, incomeType);
  const combinedILS = inputILS + inputUSD * rate;
  if (!pct) {
    return {
      commissionPct: 0,
      preCommissionILS: combinedILS,
      preCommissionUSD: inputUSD,
      amountILS: combinedILS,
      amountUSD: inputUSD,
    };
  }
  const factor = 1 - pct / 100;
  return {
    commissionPct: pct,
    preCommissionILS: combinedILS,
    preCommissionUSD: inputUSD,
    amountILS: combinedILS * factor,
    amountUSD: inputUSD > 0 ? inputUSD * factor : 0,
  };
}

// Apply platform/income-type commission to a record (for display in ClientPortal for legacy records)
function applyCommission(r, rate) {
  // If commission was already calculated and stored, use stored values
  if (r.commissionPct > 0 && r.preCommissionILS != null) return r;
  const pct = resolveCommissionPct(r.platform, r.incomeType);
  if (!pct) return r;
  const factor = 1 - pct / 100;
  const preILS = r.originalAmount || r.amountILS;
  const preUSD = r.originalRawUSD || r.amountUSD || 0;
  return {
    ...r,
    commissionPct: pct,
    preCommissionILS: preILS,
    preCommissionUSD: preUSD,
    amountILS: preILS * factor,
    amountUSD: preUSD > 0 ? preUSD * factor : 0,
    originalAmount: preILS,
  };
}

const EXPENSE_CATEGORIES = [
  "עלות רו״ח", "חיובי בנק", "Directors Pay", "Financing Costs", "ביטוח", "אחר", "שכירות",
  "חשמל", "מים", "ארנונה", "עלויות אתר", "שיווק", "הוצאות משרד", "תוכנות", "תשלומים כוח אדם",
  "דלק והוצאות רכב", "הזמנות אינטרנט", "ביגוד"
];
const MONTHS_HE = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const MONTHS_SHORT = ["ינו", "פבר", "מרץ", "אפר", "מאי", "יונ", "יול", "אוג", "ספט", "אוק", "נוב", "דצמ"];
const C = { bg: "#0f172a", card: "#1e293b", cardH: "#334155", bdr: "#334155", pri: "#3b82f6", priL: "#60a5fa", grn: "#22c55e", red: "#ef4444", ylw: "#eab308", org: "#f97316", txt: "#f8fafc", dim: "#94a3b8", mut: "#64748b", purple: "#a855f7", cyan: "#06b6d4", pink: "#ec4899" };
const CHART_COLORS = [C.pri, C.grn, C.org, C.purple, C.cyan, C.pink, C.ylw, C.red];

// ═══════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════
function sanitizeName(name) {
  if (!name) return "";
  return String(name).replace(/׳/g, "'").replace(/\s+/g, " ").trim();
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "number") return new Date((v - 25569) * 86400e3);
  const s = String(v).trim().replace(/\./g, '/');
  const dIso = new Date(v);
  if (!isNaN(dIso) && s.includes("T")) return dIso;

  const sl = s.split("/");
  if (sl.length === 3) {
    let yr = +sl[2];
    if (yr < 100) yr += 2000; // 26 → 2026
    const d = new Date(yr, +sl[1] - 1, +sl[0]);
    return isNaN(d) ? null : d;
  }
  const ds = s.split("-");
  if (ds.length === 3) {
    let yr = +ds[0];
    if (yr < 100) yr += 2000;
    const d = new Date(yr, +ds[1] - 1, parseInt(ds[2], 10));
    return isNaN(d) ? null : d;
  }
  return null;
}
function fmtD(d) { if (!d) return ""; return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; }
function fmtC(n) { if (n == null || isNaN(n)) return "₪0"; return `${n < 0 ? "-" : ""}₪${Math.abs(n).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }
function fmtUSD(n) { if (!n || isNaN(n)) return "—"; return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; }
function renderDateHour(r) {
  let h = r.hour;
  if (h && typeof h === "string" && h.includes("1899-") && h.includes("T")) {
    h = h.split("T")[1].substring(0, 5);
  }
  return <span style={{ whiteSpace: "nowrap" }}>{fmtD(r.date)} {h ? <span style={{ fontSize: 11, color: C.mut }}>{h}</span> : ""}</span>;
}
function ym(y, m) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
function ymFromDate(date) { if (!date) return null; return ym(date.getFullYear(), date.getMonth()); }
// Returns effective pcts for a given month — looks up monthlyPcts[ymi], falls back to prev month, then global
function getMonthlyPcts(settings, ymi) {
  const monthly = settings?.monthlyPcts || {};
  if (monthly[ymi]) return monthly[ymi];
  const prev = Object.keys(monthly).filter(k => k < ymi).sort();
  if (prev.length > 0) return monthly[prev[prev.length - 1]];
  return { officePct: settings?.officePct ?? 17, fieldPct: settings?.fieldPct ?? 15, salaryType: settings?.salaryType ?? "sales", hourlyRate: settings?.hourlyRate ?? 0 };
}
function useWin() { const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200); useEffect(() => { const h = () => setW(window.innerWidth); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []); return w; }

// ═══════════════════════════════════════════════════════
// APPS SCRIPT API — DIRECT FETCH (fixed CORS approach)
// ═══════════════════════════════════════════════════════
const API = {
  async read(sheetName, customUrl = null) {
    const baseUrl = customUrl || APPS_SCRIPT_URL;
    const url = `${baseUrl}?action=read&sheet=${encodeURIComponent(sheetName)}`;
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.data || [];
  },
  async getSheetNames(customUrl = null) {
    const baseUrl = customUrl || APPS_SCRIPT_URL;
    const url = `${baseUrl}?action=sheets`;
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.sheets || [];
  },
  async grok(prompt, apiKey) {
    if (!apiKey) throw new Error("לא הוזן מפתח API של Grok");
    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are an expert OF script generation AI." },
          { role: "user", content: prompt }
        ],
        model: "grok-4-latest",
        stream: false
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("Grok API Error Payload:", data);
      throw new Error(data.error?.message || (typeof data.error === "string" ? data.error : JSON.stringify(data)) || "Grok API Error");
    }
    return data;
  },
  async append(sheetName, rows, customUrl = null) {
    const baseUrl = customUrl || APPS_SCRIPT_URL;
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "append", sheet: sheetName, rows }),
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data;
  },
  async update(sheetName, rowIndex, rowData, customUrl = null) {
    const baseUrl = customUrl || APPS_SCRIPT_URL;
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "update", sheet: sheetName, rowIndex, rowData }),
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data;
  },
  async deleteRow(sheetName, rowIndex, customUrl = null) {
    const baseUrl = customUrl || APPS_SCRIPT_URL;
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "delete", sheet: sheetName, rowIndex }),
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data;
  },
};

// ═══════════════════════════════════════════════════════
// EXCHANGE RATE
// ═══════════════════════════════════════════════════════
const ExRate = {
  _rate: null,
  async fetchUsdIls() {
    // Check localStorage cache (valid for current calendar day)
    const today = new Date().toISOString().slice(0, 10);
    const cached = localStorage.getItem("USD_ILS_RATE");
    if (cached) {
      const { rate, day } = JSON.parse(cached);
      if (day === today) { this._rate = rate; return rate; }
    }
    // Try Bank of Israel official representative rate first
    const sources = [
      async () => {
        const r = await fetch(`https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_USD_ILS?startperiod=${today}&endperiod=${today}&format=sdmx-json`);
        const d = await r.json();
        return +d?.data?.dataSets?.[0]?.series?.["0:0:0:0"]?.observations?.[Object.keys(d.data.dataSets[0].series["0:0:0:0"].observations).pop()]?.[0];
      },
      async () => {
        const r = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
        const d = await r.json();
        return d.rates?.ILS;
      },
    ];
    for (const src of sources) {
      try {
        const rate = await src();
        if (rate && rate > 2 && rate < 6) {
          this._rate = rate;
          localStorage.setItem("USD_ILS_RATE", JSON.stringify({ rate, day: today }));
          return rate;
        }
      } catch {}
    }
    this._rate = this._rate || 3.14;
    return this._rate;
  },
  get() {
    if (this._rate) return this._rate;
    try {
      const cached = JSON.parse(localStorage.getItem("USD_ILS_RATE"));
      if (cached?.rate) { this._rate = cached.rate; return cached.rate; }
    } catch {}
    return 3.14;
  }
};

// ═══════════════════════════════════════════════════════
// LOCAL DATABASE (localStorage persistence)
// ═══════════════════════════════════════════════════════
const LocalDB = {
  _key: "AGENCY_INCOME_DB",
  load() {
    try {
      const raw = localStorage.getItem(this._key);
      if (!raw) return [];
      const data = JSON.parse(raw);
      // Re-hydrate date strings back to Date objects
      return data.map(r => ({ ...r, date: r.date ? new Date(r.date) : null }));
    } catch { return []; }
  },
  save(records) {
    localStorage.setItem(this._key, JSON.stringify(records));
  },
  add(record) {
    const all = this.load();
    all.push(record);
    this.save(all);
    return record;
  },
  update(id, updates) {
    const all = this.load();
    const idx = all.findIndex(r => r.id === id);
    if (idx >= 0) { all[idx] = { ...all[idx], ...updates }; this.save(all); }
    return all[idx] || null;
  },
  remove(id) {
    const all = this.load().filter(r => r.id !== id);
    this.save(all);
  },
  clear() { localStorage.removeItem(this._key); },
  hasData() { return !!localStorage.getItem(this._key); }
};

// ═══════════════════════════════════════════════════════
// DATA MAPPING
// ═══════════════════════════════════════════════════════
// Columns: A=chatter(0), B=model(1), C=client(2), D=rate(3), E=usd(4), F=ils(5), G=type(6), H=platform(7), I=date(8), J=hour(9), K=notes(10), L=verified(11), M=location(12), N=paidToClient(13), O=cancelled(14)
function mapInc(row, i) {
  const cancelled = String(row[14]).trim() === "V" || false;
  const hourRaw = row[9] || "";
  const hour = (typeof hourRaw === "string" && hourRaw.includes("T")) ? hourRaw.split("T")[1].slice(0, 5) : hourRaw;
  const typeRaw = row[6] || "";
  const incomeType = (typeRaw instanceof Date || (typeof typeRaw === "number" && typeRaw < 2)) ? "" : typeRaw;

  const rawILS = +row[5] || 0;
  const rawUSD = +row[4] || 0;
  const rate = +row[3] || 0;
  const activeRate = rate > 0 ? rate : ExRate.get();
  const computedILS = rawILS + rawUSD * activeRate;

  return {
    id: `I-${i}-${Date.now()}`,
    _rowIndex: i + 2,
    chatterName: sanitizeName(row[0]), modelName: sanitizeName(row[1]), clientName: sanitizeName(row[2]),
    usdRate: rate,
    rawILS: cancelled ? 0 : rawILS,
    amountUSD: cancelled ? 0 : rawUSD,
    amountILS: cancelled ? 0 : computedILS,
    originalAmount: computedILS,
    originalRawILS: rawILS,
    originalRawUSD: rawUSD,
    incomeType, platform: row[7] || "",
    date: parseDate(row[8]), hour,
    notes: row[10] || "", verified: row[11] || "", shiftLocation: row[12] || "",
    paidToClient: String(row[13]).trim() === "V",
    cancelled
  };
}
// Combined income per row: rawILS + (USD × liveRate), avoids double-counting
function mapExp(row, i) {
  const d = parseDate(row[0]);
  return {
    id: `E-${i}-${Date.now()}`,
    category: row[6] || "",
    name: row[2] || "ללא פירוט",
    amount: +row[3] || 0,
    date: d,
    hour: row[8] || "",
    paidBy: row[7] || "לא צוין",
    vatRecognized: row[4] === "כן",
    taxRecognized: row[5] === "כן",
    year: d ? d.getFullYear() : 0,
    month: d ? d.getMonth() + 1 : 0,
    classification: row[12] || "",
    source: row[12] || "ידני", // keep for backward compat just in case
    receiptImage: row[9] || null,
    _rowIndex: i + 2,
    docType: row[1] || "—",
  };
}


function mapHistory(row, i) {
  return {
    id: `H-${i}-${Date.now()}`,
    date: row[0] || "",
    modelName: row[1] || "",
    type: row[2] || "",
    parameters: row[3] || "", // JSON string
    reference: row[4] || "",
    script: row[5] || "",
    _rowIndex: i + 2
  };
}

const IncSvc = {
  // Read all approved income from Firebase
  async fetchAll() {
    try {
      const records = await fetchAllIncome();
      console.log("Loaded income from Firebase:", records.length);
      return records;
    } catch (e) {
      console.error("Firebase fetch failed:", e);
      return [];
    }
  },
  // Add income directly (Admin manual entry)
  async addDirect(incRow) {
    const saved = await addIncome(incRow);
    return saved;
  },
  // One-time migration: import from Sheets → Firebase
  async migrateFromSheets(onProgress) {
    const rows = await API.read("הכנסות ארכיון");
    const parsed = rows.slice(1).map((r, i) => mapInc(r, i));
    const withApproval = parsed.map(r => ({ ...r, verified: "V" }));
    await clearAllIncome();
    const saved = await saveAllIncome(withApproval, onProgress);
    return withApproval;
  },
  async togglePaidToClient(incRow) {
    const updated = { ...incRow, paidToClient: !incRow.paidToClient };
    await updateIncome(incRow.id, { paidToClient: updated.paidToClient });
    return updated;
  },
  async setPaymentTarget(incRow, target) {
    const updated = { ...incRow, paymentTarget: target };
    if (incRow._fromPending) {
      await updatePending(incRow.id, { paymentTarget: target });
    } else {
      await updateIncome(incRow.id, { paymentTarget: target });
    }
    return updated;
  },
  async cancelTransaction(incRow) {
    const updated = { ...incRow, cancelled: true, amountILS: 0, amountUSD: 0 };
    if (incRow._fromPending) {
      await updatePending(incRow.id, { cancelled: true, amountILS: 0, amountUSD: 0 });
    } else {
      await updateIncome(incRow.id, { cancelled: true, amountILS: 0, amountUSD: 0 });
    }
    return updated;
  },
  async uncancelTransaction(incRow) {
    const updated = { ...incRow, cancelled: false, amountILS: incRow.originalAmount };
    if (incRow._fromPending) {
      await updatePending(incRow.id, { cancelled: false, amountILS: incRow.originalAmount });
    } else {
      await updateIncome(incRow.id, { cancelled: false, amountILS: incRow.originalAmount });
    }
    return updated;
  },
  async deleteTransaction(incRow) {
    if (incRow._fromPending) {
      await removePending(incRow.id);
    } else {
      await removeIncome(incRow.id);
    }
  },
  async retroApplyCommissions() {
    return await migrateCommissions();
  },
  async retroRecalculate() {
    return await retroRecalculate();
  },
  async restoreCorruptedRecords(fallbackRate) {
    return await restoreCorruptedRecords(fallbackRate);
  }
};
const ExpSvc = {
  // Generate a unique key for dedup
  _key(e) {
    const d = e.date instanceof Date ? e.date.toISOString().split('T')[0] : String(e.date || '').split('T')[0];
    return `${d}|${e.name}|${e.amount}`;
  },
  async fetchAll() {
    try {
      // 1. Read existing expenses from Firebase
      const fbExpenses = await fetchAllExpenses();
      console.log("Firebase expenses:", fbExpenses.length);

      // 2. Read new invoices from Sheets
      let sheetsExpenses = [];
      try {
        const rows = await API.read("כל החשבוניות", EXPENSES_URL);
        sheetsExpenses = rows.slice(1).map((r, i) => mapExp(r, i));
        console.log("Sheets expenses:", sheetsExpenses.length);
      } catch (e) { console.log("Sheets expenses not available:", e.message); }

      // 3. Find new items: in Sheets but not in Firebase
      const existingKeys = new Set(fbExpenses.map(e => this._key(e)));
      const newItems = sheetsExpenses.filter(e => !existingKeys.has(this._key(e)));

      if (newItems.length > 0) {
        console.log(`Adding ${newItems.length} new expenses to Firebase...`);
        for (const item of newItems) {
          const { _rowIndex, id, ...rest } = item;
          await addExpense(rest);
        }
        // Return combined list
        const updated = await fetchAllExpenses();
        return updated;
      }

      return fbExpenses.length > 0 ? fbExpenses : sheetsExpenses;
    } catch (e) {
      console.error("ExpSvc.fetchAll failed:", e);
      // Fallback to Sheets only
      try {
        const rows = await API.read("כל החשבוניות", EXPENSES_URL);
        return rows.slice(1).map((r, i) => mapExp(r, i));
      } catch { return []; }
    }
  },
  async add(e) {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    const record = { ...e, date: d };
    return addExpense(record);
  },
  async edit(e) {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    await updateExpense(e.id, { ...e, date: d });
  },
  async remove(e) {
    return removeExpense(e.id);
  },
};

const UserSvc = {
  async fetchAll() {
    try {
      const users = await fetchUsers();
      return users.map(u => ({ ...u, pass: u.password, _rowIndex: u.id }));
    } catch (e) {
      console.error("Firebase users fetch failed:", e);
      return [];
    }
  },
  async add(name, pass, role) {
    return addUser(name, pass, role);
  },
  async remove(id) {
    return removeUser(id);
  },
  async updatePassword(id, newPass) {
    await updateUserPassword(id, newPass);
  }
};

const GROQ_API_KEY = import.meta.env.VITE_GROK_API_KEY || "";

const GroqSvc = {
  async pdfToImage(file) {
    // Dynamically load PDF.js from CDN if not already loaded
    if (!window.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
        script.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          resolve();
        };
        script.onerror = () => reject(new Error("Failed to load PDF.js"));
        document.head.appendChild(script);
      });
    }
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);
    const scale = 2; // Higher resolution for better OCR
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.9);
  },

  async scanReceipt(base64Image) {
    if (!GROQ_API_KEY) throw new Error("מפתח API חסר. אנא הגדר VITE_GROK_API_KEY ב-.env או ב-Vercel.");

    // Remove data:image/...;base64, prefix if present
    const cleanBase64 = base64Image.split(",")[1] || base64Image;

    const body = {
      model: "grok-2-vision-latest",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the following details from this receipt image in JSON format: Provider (name), Amount (number, ILS), Date (DD/MM/YYYY), and Category (one of: אוכל, תחבורה, שיווק, מגורים, אחר). Return ONLY the JSON object."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${cleanBase64}`
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" }
    };

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "שגיאת תקשורת עם xAI");
    }

    const data = await res.json();
    try {
      return JSON.parse(data.choices[0].message.content);
    } catch (e) {
      throw new Error("לא ניתן היה לפענח את תוצאות הסריקה");
    }

  }
};
const ModelSvc = {
  async fetchAll() {
    try { const data = localStorage.getItem("MODELS_DB"); return data ? JSON.parse(data) : []; }
    catch (e) { return []; }
  },
  async add(m) {
    const d = await this.fetchAll();
    m.id = `M-${Date.now()}`;
    d.push(m);
    localStorage.setItem("MODELS_DB", JSON.stringify(d));
    return m;
  },
  async edit(m) {
    const d = await this.fetchAll();
    const nd = d.map(x => x.id === m.id ? m : x);
    localStorage.setItem("MODELS_DB", JSON.stringify(nd));
  },
  async remove(m) {
    const d = await this.fetchAll();
    const nd = d.filter(x => x.id !== m.id);
    localStorage.setItem("MODELS_DB", JSON.stringify(nd));
  }
};
const HistorySvc = {
  async fetchAll() {
    try { const data = localStorage.getItem("HISTORY_DB"); return data ? JSON.parse(data) : []; }
    catch (e) { return []; }
  },
  async add(h) {
    const d = await this.fetchAll();
    h.id = `H-${Date.now()}`;
    d.unshift(h);
    localStorage.setItem("HISTORY_DB", JSON.stringify(d));
    return h;
  }
};
const DEFAULT_PARAMS = {
  location: ["מיטה", "ספה", "רצפה", "חלון", "וילון", "מראה", "חדר שינה", "סלון", "מסדרון ביתי", "דלת כניסה", "חדר ארונות", "חדר כביסה", "כביסה וחבלים", "פינת עבודה", "שולחן אוכל", "מקלחת", "אמבטיה", "כיור אמבטיה", "מראה עם אדים", "חדר אדים", "סאונה", "שיש מטבח", "מקרר פתוח", "תנור פתוח", "שולחן מטבח", "מרפסת", "גג בניין", "חצר בית", "גינה", "מעלית", "חדר מדרגות", "לובי בניין", "מסדרון בניין", "חניון תת קרקעי", "רחוב בלילה", "מעבר חציה", "תחנת אוטובוס", "תחנת דלק", "שטיפת רכב", "קיר גרפיטי", "אתר בניה", "רכב", "אופנוע", "אופניים", "קורקינט", "אוטובוס ריק", "רכבת", "תחנת רכבת", "חדר כושר", "פארק כושר", "מסלול ריצה", "מגרש כדורסל", "מגרש כדורגל", "מגרש טניס", "סקייטפארק", "טריבונות", "פארק ציבורי", "מתקני שעשועים", "ים", "חוף חולי", "חוף סלעי", "מקלחת חוף", "בריכה", "ג׳קוזי", "מקלחת חיצונית", "יער", "חורשה", "שדה פתוח", "שדה חיטה", "שדה פרחים", "שביל עפר", "סלעים בטבע", "הר", "תצפית הרים", "צוק", "מערה", "נחל", "מפל", "אגם", "מדבר", "דיונות חול", "אוהל קמפינג", "קרוואן", "פיקניק בטבע", "שוק פתוח", "מחסן", "סטודיו ריק", "חדר עם מראות מכל הכיוונים"],
  outfit: ["חולצה לבנה רטובה", "גופיה רטובה", "חולצת כפתורים רטובה", "חולצה אוברסייז רטובה", "בד רטוב שנצמד לגוף", "סט תחרה", "חזיית תחרה", "בגד גוף תחרה", "חלוק תחרה", "פרטי תחרה בקלוז אפ", "מגבת כרוכה על הגוף", "מגבת על הראש", "מגבת שמסתירה קדימה", "חלוק פתוח", "חלוק רפוי ונשפך", "בגד ים מלא", "בגד ים שלם", "בגד ים רק תחתון עם מגבת", "בגד ים בלי טופ עם יד מסתירה", "בגד ים רטוב אחרי ים", "חוטיני", "תחתון כותנה פשוט", "תחתון גבוה", "תחתון עם חולצה אוברסייז", "תחתון עם שמיכה עוטפת", "חולצה אוברסייז בלי מכנס", "טיץ צמוד", "טופ ספורט", "ג׳ינס פתוח", "ג׳ינס נמוך", "חצאית טניס קצרה", "גופיה צמודה סיידבוב", "חולצת אנדרבוב", "חולצה שנופלת מהכתף", "מכנס בית רפוי נמוך", "חזייה מציצה מחולצה פתוחה", "כפתור פתוח בחולצה", "רוכסן חצי פתוח", "כתף חשופה", "גב חשוף", "חלוק פתוח עם הצצה", "חולצת כפתורים פתוחה", "ג׳קט פתוח", "קפוצ׳ון פתוח חצי", "מעיל פתוח מעל לבוש מינימלי", "חולצת שינה מקומטת", "שיער מבולגן", "שמיכה כרוכה", "חולצה בלי מכנס במטבח", "סדינים מקומטים", "טיץ שמבליט", "טניסאית עם חצאית", "תלמידה עם חצאית וחולצה", "ספרנית עם משקפיים וקרדיגן", "מאמנת כושר עם טופ ספורט ומשרוקית", "סינר מטבח שובב", "גרביים ארוכות", "עקבים", "נעלי ספורט", "כובע", "משקפיים", "תכשיטים עדינים", "תיק יד קטן", "אוזניות", "כרית", "שמיכה"],
  hairstyle: ["פזור חלק מסודר", "פזור מבולגן של בוקר", "פזור לצד אחד", "פזור עם רוח", "פזור שמכסה חלק מהפנים", "גולגול נקי", "גולגול מבולגן", "קוקו גבוה ספורטיבי", "קוקו נמוך עדין", "אסוף מתוח ומסודר", "קוקיות שובבות", "שתי צמות", "צמה אחת על הכתף", "צמה רפויה", "קוקיות עם סלפי מראה", "רטוב אחרי מקלחת", "רטוב משוך אחורה", "רטוב על הפנים", "רטוב מהים בשקיעה", "סחיטת מים מהשיער", "תלתלים מודגשים", "גלים רכים", "תלתלים מבולגנים", "גלים בשקיעה במרפסת", "תלתלים מול חלון בצללית", "שיער שמכסה עין", "שיער שמסתיר חזה", "שיער שנשפך קדימה", "תנועה של זריקת שיער", "שיער שמכסה חצי פנים"],
  lighting: ["אור חלון רך", "אור דרך וילון שקוף", "אור יום שמייצר צללים טבעיים", "אור מרפסת בצהריים", "מראה באור יום", "אור כתום עדין", "הילה רכה סביב הגוף", "שמיים פסטליים בים", "חדר עם גוון חמים של בוקר", "אור זורח דרך וילון", "צללית זהובה", "אור חם דרמטי", "גב לחלון בשקיעה", "גג בניין באור ערב", "שדה באור זהוב", "מנורת לילה חמה", "נרות ואדים", "מנורה ליד מיטה", "אור מקרר פתוח בלילה", "מרפסת עם אורות עיר", "פלאש מול מראה", "פלאש במעלית", "פלאש בחדר חשוך", "פלאש ברכב בלילה", "פלאש באמבטיה מול מראה"],
  props: ["ויברטור רוטט", "דילדו Realistic", "פלאג אנאלי עם זנב", "כיסוי עיניים שחור", "אזיקי פרווה", "שוט/פלוגר", "שמן עיסוי מחמם", "נרות שעווה (low temp)", "קוביות קרח", "קצפת/שוקולד נוזלי", "גרבי רשת שחורים", "נעלי עקב סטילטו", "חזייה פתוחה (open cup)", "תחתוני חוטיני עם פתח", "צווארון BDSM עם טבעת", "קליפסים לפטמות", "נוצה ארוכה", "מראה גדולה עומדת", "כורסה/כיסא עץ", "פאה בלונד/שחורה ארוכה"],
  angle: ["תקריב מלא (extreme close-up)", "מלמטה – זווית נמוכה (worm’s eye)", "מלמעלה – זווית גבוהה (high angle)", "צדדי מלא (side profile)", "POV – נקודת מבט של הצופה", "מעל הכתף (over the shoulder)", "זווית הולנדית (מצלמה מוטה)", "רחבה – כל הגוף (full body wide)", "בינונית – חזה עד ירכיים", "עין רמה (eye level)", "מבט ציפור (bird’s eye – מלמעלה ישר)", "דרך המראה (mirror shot)", "השתקפות במים/שמן", "זום איטי פנימה", "זום איטי החוצה", "ידני רועד (handheld shaky)", "מעקב איטי סביב הגוף", "ספליט סקרין (2 זוויות בו זמנית)", "Low angle + תנועה למעלה", "זווית אלכסונית מלמעלה (45°)"],
  action: ["הפשטה איטית מאוד (striptease)", "ליטוף חזה + פטמות", "אוננות עם אצבעות", "ריקוד טוורקינג", "נשיקת אוויר + ליקוק שפתיים", "פישוק רגליים מול המצלמה", "קימור גב + ישבן מורם", "משחק בשיער + גניחות", "עיסוי שמן על כל הגוף", "שימוש בוויברטור על הדגדגן", "מציצה איטית לדילדו", "רכיבה על כרית/דילדו", "טיזינג – נוגעים אבל לא נכנסים", "חדירה באצבעות + גניחות", "משחק עם קרח על הפטמות", "שפיכת שמן על הישבן", "תנוחת יוגה סקסית (downward dog)", "מקלחת – סבון על הגוף", "משחק תפקידים (סקול גירל / אחות / וכו')", "סיום עם אורגזמה + מבט ישיר למצלמה"]
};

const GenParamsSvc = {
  async fetch() {
    try {
      const data = localStorage.getItem("GEN_PARAMS_DB");
      if (data) {
        let parsed = JSON.parse(data);
        return { ...DEFAULT_PARAMS, ...parsed };
      }
      return DEFAULT_PARAMS;
    } catch (e) { return DEFAULT_PARAMS; }
  },
  async save(p) {
    localStorage.setItem("GEN_PARAMS_DB", JSON.stringify(p));
    return p;
  }
};


// ═══════════════════════════════════════════════════════
// CALCULATIONS
// ═══════════════════════════════════════════════════════
const Calc = {
  chatterSalary(rows, settings, ymi) {
    let o = 0, r = 0;
    rows.forEach(x => { if (x.shiftLocation === "משרד") o += x.amountILS; else r += x.amountILS; });
    const pcts = getMonthlyPcts(settings, ymi);
    const officePct = (pcts.officePct ?? 17) / 100;
    const fieldPct = (pcts.fieldPct ?? 15) / 100;
    const salaryType = pcts.salaryType ?? "sales";
    const hourlyRate = pcts.hourlyRate ?? 0;
    const hours = (settings?.monthlyHours && ymi) ? (settings.monthlyHours[ymi] ?? 0) : 0;
    const oSal = o * officePct; const rSal = r * fieldPct;
    const salesSalary = oSal + rSal;
    const hourlySalary = hours * hourlyRate;
    const total = salaryType === "hourly" ? hourlySalary : salaryType === "sales" ? salesSalary : salesSalary + hourlySalary;
    return { oSales: o, rSales: r, oSal, rSal, officePct: officePct * 100, fieldPct: fieldPct * 100, salesSalary, hourlySalary, hours, hourlyRate, salaryType, total };
  },
  clientBal(rows, cn, agencyPct, settlements = [], chatterSettings = {}) {
    const clRows = rows.filter(r => r.modelName === cn);
    const tot = clRows.reduce((s, r) => s + r.amountILS, 0);
    const direct = clRows.filter(r => r.paymentTarget === "client" || (!r.paymentTarget && r.paidToClient)).reduce((s, r) => s + r.amountILS, 0);
    // Agency takes agencyPct% of total income
    const agencyShare = tot * (agencyPct / 100);
    // Chatter salary for this client's transactions
    let chatterSalaryForClient = 0;
    clRows.forEach(r => {
      const cfg = chatterSettings[r.chatterName] || {};
      const rowYmi = ymFromDate(r.date);
      const pcts = getMonthlyPcts(cfg, rowYmi);
      const oPct = (pcts.officePct ?? 17) / 100;
      const fPct = (pcts.fieldPct ?? 15) / 100;
      chatterSalaryForClient += r.amountILS * (r.shiftLocation === "משרד" ? oPct : fPct);
    });
    // Client entitlement = total income - agency share - chatter salary
    const ent = tot - agencyShare - chatterSalaryForClient;

    // settlements logic:
    // AgencyToClient decreases the agency's debt to the client (or increases client debt to agency)
    // ClientToAgency decreases the client's debt to the agency (or increases agency debt to client)
    // Positive actualDue = Agency owes client. Negative = Client owes agency.
    let netSettled = 0; // The amount the agency has paid towards its debt via settlements
    settlements.filter(s => s.modelName === cn).forEach(s => {
      if (s.direction === "AgencyToClient") netSettled += s.amount;
      if (s.direction === "ClientToAgency") netSettled -= s.amount;
    });

    // actualDue is the pure mathematical debt before settlements: (entitlement - what they already got directly)
    // then subtract the net amount the agency has manually settled
    const actualDue = ent - direct - netSettled;
    return { totalIncome: tot, direct, through: tot - direct, pct: agencyPct, ent, bal: ent - direct, netSettled, actualDue, agencyShare, chatterSalaryForClient };
  },
  offset(exps) {
    const d = exps.filter(e => e.paidBy === "דור").reduce((s, e) => s + e.amount, 0);
    const y = exps.filter(e => e.paidBy === "יוראי").reduce((s, e) => s + e.amount, 0);
    const ag = exps.filter(e => e.paidBy === "סוכנות").reduce((s, e) => s + e.amount, 0);
    const total = d + y + ag;
    const fair = total / 3;
    const netD = d - fair, netY = y - fair, netAg = ag - fair;
    // Compute minimal transfers: debtors pay creditors
    const people = [{ n: "דור", v: netD }, { n: "יוראי", v: netY }, { n: "סוכנות", v: netAg }];
    const transfers = [];
    const pos = people.filter(p => p.v > 0.5).sort((a, b) => b.v - a.v);
    const neg = people.filter(p => p.v < -0.5).sort((a, b) => a.v - b.v);
    const posQ = pos.map(p => ({ ...p })), negQ = neg.map(p => ({ ...p }));
    let pi = 0, ni = 0;
    while (pi < posQ.length && ni < negQ.length) {
      const amt = Math.min(posQ[pi].v, -negQ[ni].v);
      if (amt > 0.5) transfers.push({ from: negQ[ni].n, to: posQ[pi].n, amt: Math.round(amt * 10) / 10 });
      posQ[pi].v -= amt; negQ[ni].v += amt;
      if (posQ[pi].v < 0.5) pi++; else ni++;
    }
    return { dor: d, yurai: y, agency: ag, total, netDor: netD, netYurai: netY, netAgency: netAg, transfers };
  },
  profit(inc, exp) { const i = inc.reduce((s, r) => s + r.amountILS, 0); const e = exp.reduce((s, x) => s + x.amount, 0); return { inc: i, exp: e, profit: i - e }; },
  targets(prevInc, prevDays, nextDays) {
    if (!prevDays || !nextDays) return { t1: 0, t2: 0, t3: 0, daily: 0 };
    const daily = prevInc / prevDays;
    return { daily, t1: daily * 1.05 * nextDays, t2: daily * 1.10 * nextDays, t3: daily * 1.15 * nextDays };
  }
};
const _rates = (() => { try { return JSON.parse(localStorage.getItem("CLIENT_RATES_DB") || "{}"); } catch { return {}; } })();
function getRate(n, ymi) { return _rates[n]?.[ymi] ?? 0; }
function setRate(n, ymi, p) {
  if (!_rates[n]) _rates[n] = {};
  _rates[n][ymi] = p;
  try { localStorage.setItem("CLIENT_RATES_DB", JSON.stringify(_rates)); } catch {}
  saveClientRate(n, ymi, p).catch(() => {});
}
async function loadRatesFromFirebase() {
  try {
    const data = await fetchClientRates();
    Object.entries(data).forEach(([name, months]) => {
      Object.entries(months).forEach(([ymi, pct]) => {
        if (!_rates[name]) _rates[name] = {};
        _rates[name][ymi] = pct;
      });
    });
    try { localStorage.setItem("CLIENT_RATES_DB", JSON.stringify(_rates)); } catch {}
  } catch {}
}

// ═══════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════
const Ctx = createContext(null);
function Prov({ children }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [view, setView] = useState("monthly");
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const [page, setPage] = useState("dashboard");
  const [income, setIncome] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [chatterTargets, setChatterTargets] = useState({});
  const [chatterSettings, setChatterSettings] = useState({});
  const [clientSettings, setClientSettings] = useState({});
  const [models, setModels] = useState([]);
  const [history, setHistory] = useState([]);
  const [genParams, setGenParams] = useState(DEFAULT_PARAMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(() => localStorage.getItem("AGENCY_CONNECTED") === "true");
  const [demo, setDemo] = useState(false);
  const [rv, setRv] = useState(0);
  const [loadStep, setLoadStep] = useState("");
  const [liveRate, setLiveRate] = useState(ExRate.get());
  const updRate = useCallback((n, ymi, p) => { setRate(n, ymi, p); setRv(v => v + 1); }, []);

  // Fetch live exchange rate on mount
  useEffect(() => { ExRate.fetchUsdIls().then(r => setLiveRate(r)); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setLoadStep("טוען נתונים...");
    try {
      setLoadStep("טוען הכנסות מ-Firebase...");
      fixOrphanedApprovals().catch(() => {});
      const [inc, pending] = await Promise.all([IncSvc.fetchAll(), fetchPending()]);
      // fetchPending already applies approval decisions stored inside pendingIncome collection
      const fixedInc = inc.map(r => r._fromPending ? { ...r, verified: "V", _fromPending: false } : r);
      const pendingMarked = pending.map(r => ({
        ...r,
        _fromPending: true,
        // Use stored amountILS if rawILS is missing (chatter-submitted records)
        rawILS: r.rawILS !== undefined ? r.rawILS : r.amountILS,
      }));

      console.log(`Loaded: ${inc.length} income, ${pending.length} pending`);
      setIncome([...fixedInc, ...pendingMarked]);
      setLoadStep("");
      try { const exp = await ExpSvc.fetchAll(); console.log("Fetched expenses:", exp); setExpenses(exp); } catch (e) { console.error(e); }
      try { const sets = await fetchSettlements(); console.log("Fetched settlements:", sets); setSettlements(sets); } catch (e) { console.error("Error fetching settlements:", e); }
      try { const ct = await fetchChatterTargets(); setChatterTargets(ct); } catch (e) { console.error("Error fetching chatterTargets:", e); }
      try { const cs = await fetchAllChatterSettings(); setChatterSettings(cs); } catch (e) { console.error("Error fetching chatterSettings:", e); }
      try { const cls = await fetchAllClientSettings(); setClientSettings(cls); } catch (e) { console.error("Error fetching clientSettings:", e); }
      try { const u = await UserSvc.fetchAll(); setSheetUsers(u); } catch (e) { console.error("Error fetching users:", e); }
      setConnected(true);
      setTimeout(() => setLoadStep(""), 3000);
    } catch (e) {
      setError(e.message);
      setLoadStep("");
    }
    setLoading(false);
  }, [year]);

  useEffect(() => {
    if (demo) loadDemo();
    else if (connected || !import.meta.env.VITE_USE_AUTH || localStorage.getItem("AGENCY_USER")) {
      load();
    }
  }, [demo, load]);

  useEffect(() => {
    // Load local DBs automatically
    ModelSvc.fetchAll().then(setModels);
    HistorySvc.fetchAll().then(setHistory);
    GenParamsSvc.fetch().then(setGenParams);
    loadRatesFromFirebase().then(() => setRv(v => v + 1));
    fetchFixedExpenses().then(setFixedExps).catch(() => {});
    fetchEmployees().then(setEmployees).catch(() => {});
  }, []);

  const loadDemo = useCallback(() => {
    setDemo(true);
    const ch = ["נועם", "שירה", "דנה", "אלון", "מיכל"], cl = ["יעל", "רוני", "נועה", "תמר", "ליאת"], pl = ["OnlyFans", "Fansly", "Instagram", "TikTok"], lo = ["משרד", "חוץ"];
    const di = []; for (let m = 0; m < 12; m++) { const cnt = 30 + Math.floor(Math.random() * 40); for (let i = 0; i < cnt; i++) { const day = Math.floor(Math.random() * 28) + 1, ils = Math.floor(Math.random() * 3000) + 200, c = cl[Math.floor(Math.random() * cl.length)]; di.push({ id: `demo-I-${m}-${i}-${Date.now()}`, chatterName: ch[Math.floor(Math.random() * ch.length)], modelName: c, clientName: c, usdRate: 3.6, amountUSD: Math.round(ils / 3.6), amountILS: ils, originalAmount: ils, incomeType: Math.random() < .25 ? c : "", platform: pl[Math.floor(Math.random() * pl.length)], date: new Date(year, m, day), hour: `${Math.floor(Math.random() * 24)}:00`, notes: "", verified: "", shiftLocation: lo[Math.floor(Math.random() * lo.length)] }); } }
    const de = []; EXPENSE_CATEGORIES.forEach(cat => { for (let m = 0; m < 12; m++) { const n = Math.floor(Math.random() * 3) + 1; for (let i = 0; i < n; i++) { de.push({ id: `E${Date.now()}-${Math.random()}`, category: cat, name: `${cat} #${i + 1}`, amount: Math.floor(Math.random() * 5000) + 100, date: new Date(year, m, Math.floor(Math.random() * 28) + 1), hour: "12:00", paidBy: Math.random() > .5 ? "דור" : "יוראי", vatRecognized: Math.random() > .4, taxRecognized: Math.random() > .2, year, month: m + 1, source: Math.random() > .5 ? "אוטומטי" : "ידני", receiptImage: null, _rowIndex: 0 }); } } });
    cl.forEach(c => { for (let m = 0; m < 12; m++)setRate(c, ym(year, m), Math.floor(Math.random() * 20) + 25); });
    setIncome(di); setExpenses(de); setSettlements([]); setConnected(true); setRv(v => v + 1);
  }, [year]);

  // Parse chatters from env var: "name1:pass1,name2:pass2"
  const CHATTERS_MAP = useMemo(() => {
    const raw = import.meta.env.VITE_CHATTERS || "";
    const map = {};
    raw.split(",").filter(Boolean).forEach(pair => {
      const [name, pass] = pair.split(":");
      if (name && pass) map[name.trim()] = pass.trim();
    });
    return map;
  }, []);

  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("AGENCY_USER");
    if (saved) try { return JSON.parse(saved); } catch { return null; }
    return null;
  });
  const [sheetUsers, setSheetUsers] = useState([]);
  const loadSheetUsers = async () => { try { const u = await UserSvc.fetchAll(); setSheetUsers(u); return u; } catch { return []; } };

  const login = async (pass, entityName = "") => {
    const cleanName = entityName.trim().toLowerCase();
    const cleanPass = pass.trim();

    // Admin login
    if (cleanName === "אדמין") {
      let adminPass = "11220099";
      try { const fb = await getAdminPassword(); if (fb) adminPass = fb; } catch {}
      if (cleanPass === adminPass) {
        const u = { role: "admin", name: "admin", loginAt: Date.now() };
        setUser(u); localStorage.setItem("AGENCY_USER", JSON.stringify(u)); return { ok: true };
      }
      return { ok: false, Debug: "שם משתמש או סיסמה שגויים." };
    }

    // Chatter/Client login — check Firebase users
    if (entityName) {
      try {
        const users = await UserSvc.fetchAll();
        setSheetUsers(users);

        const match = users.find(u =>
          u.name.toLowerCase() === cleanName &&
          u.pass === cleanPass
        );

        if (match) {
          const u = { role: match.role, name: match.name, loginAt: Date.now() };
          setUser(u); localStorage.setItem("AGENCY_USER", JSON.stringify(u)); return { ok: true };
        }

        return {
          ok: false,
          Debug: `שם משתמש או סיסמה שגויים.`
        };
      } catch (e) {
        console.error("Firebase login check failed:", e);
        return { ok: false, Debug: "שגיאה בבדיקת משתמשים" };
      }
    }
    return { ok: false, Debug: "נא להזין שם משתמש" };
  };
  const logout = () => { setUser(null); localStorage.removeItem("AGENCY_USER"); };

  // Check if admin forced all users to re-login
  useEffect(() => {
    if (!user || !user.loginAt) return;
    getForceLogoutAt().then(forceAt => {
      if (forceAt && user.loginAt < forceAt) {
        logout();
      }
    }).catch(() => {});
  }, []);

  const [fixedExps, setFixedExps] = useState([]);
  const [employees, setEmployees] = useState([]);
  const addFixedExp = useCallback(async (record) => {
    const saved = await addFixedExpense(record);
    setFixedExps(prev => [...prev, saved]);
    return saved;
  }, []);
  const removeFixedExp = useCallback(async (id) => {
    await removeFixedExpense(id);
    setFixedExps(prev => prev.filter(e => e.id !== id));
  }, []);
  const updateFixedExp = useCallback(async (id, updates) => {
    await updateFixedExpense(id, updates);
    setFixedExps(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
  }, []);
  const addEmployeeCtx = useCallback(async (record) => {
    const saved = await addEmployee(record);
    setEmployees(prev => [...prev, saved]);
    return saved;
  }, []);
  const removeEmployeeCtx = useCallback(async (id) => {
    await removeEmployee(id);
    setEmployees(prev => prev.filter(e => e.id !== id));
  }, []);

  const [customCats, setCustomCats] = useState(() => { try { const saved = localStorage.getItem("ALL_CATS_V2"); if (saved !== null) return JSON.parse(saved); const oldCustom = JSON.parse(localStorage.getItem("CUSTOM_CATS") || "[]"); const merged = [...EXPENSE_CATEGORIES]; oldCustom.forEach(c => { if (!merged.includes(c)) merged.push(c); }); return merged; } catch { return [...EXPENSE_CATEGORIES]; } });
  const addCustomCat = (name) => { const n = name.trim(); if (!n || customCats.includes(n)) return false; const updated = [...customCats, n]; setCustomCats(updated); try { localStorage.setItem("ALL_CATS_V2", JSON.stringify(updated)); } catch {} return true; };
  const removeCustomCat = (name) => { const updated = customCats.filter(c => c !== name); setCustomCats(updated); try { localStorage.setItem("ALL_CATS_V2", JSON.stringify(updated)); } catch {}; };
  const renameCustomCat = (oldName, newName) => { const n = newName.trim(); if (!n || n === oldName || customCats.includes(n)) return false; const updated = customCats.map(c => c === oldName ? n : c); setCustomCats(updated); try { localStorage.setItem("ALL_CATS_V2", JSON.stringify(updated)); } catch {} return true; };

  const val = useMemo(() => ({
    year, setYear, month, setMonth, view, setView, dateRange, setDateRange, page, setPage,
    income, setIncome, expenses, setExpenses, settlements, setSettlements, models, setModels,
    history, setHistory, genParams, setGenParams, loading, error,
    connected, setConnected, demo, setDemo, load, loadDemo, rv, updRate,
    loadStep, user, login, logout, sheetUsers, loadSheetUsers, liveRate,
    chatterTargets, setChatterTargets, customCats, addCustomCat, removeCustomCat, renameCustomCat,
    saveChatterTarget: async (name, targets) => {
      await setChatterTarget(name, targets);
      setChatterTargets(prev => ({ ...prev, [name]: targets }));
    },
    fixedExps, setFixedExps, addFixedExp, removeFixedExp, updateFixedExp,
    employees, setEmployees, addEmployeeCtx, removeEmployeeCtx,
    chatterSettings, setChatterSettings,
    saveChatterSetting: async (name, settings) => {
      setChatterSettings(prev => ({ ...prev, [name]: { ...(prev[name] || {}), ...settings } }));
      await saveChatterSettings(name, settings);
    },
    clientSettings, setClientSettings,
    saveClientSetting: async (name, settings) => {
      setClientSettings(prev => ({ ...prev, [name]: { ...(prev[name] || {}), ...settings } }));
      await saveClientSettings(name, settings);
    },
    addSettlement: async (s) => {
      if (demo) {
        const d = { id: `S-${Date.now()}`, ...s, timestamp: Date.now() };
        setSettlements(prev => [...prev, d]);
        return d;
      }
      const saved = await addSettlement(s);
      setSettlements(prev => [...prev, saved]);
      return saved;
    }
  }), [year, month, view, dateRange, page, income, expenses, settlements, chatterTargets, chatterSettings, clientSettings, models, history, genParams, loading, error, connected, demo, load, loadDemo, rv, updRate, loadStep, user, liveRate, customCats, fixedExps, employees]);

  return <Ctx.Provider value={val}>{children}</Ctx.Provider>;
}

// ═══════════════════════════════════════════════════════
// PAGE: LOGIN
// ═══════════════════════════════════════════════════════
function LoginPage() {
  const { login } = useApp();
  const [entityName, setEntityName] = useState("");
  const [entityPass, setEntityPass] = useState("");
  const [err, setErr] = useState("");
  const [logging, setLogging] = useState(false);

  const handleEntity = async (e) => {
    e.preventDefault();
    if (!entityName.trim()) { setErr("אנא הזן שם משתמש"); return; }
    setLogging(true); setErr("");
    const res = await login(entityPass, entityName.trim());
    if (!res.ok) setErr(res.Debug || "שם משתמש או סיסמה שגויים");
    setLogging(false);
  };

  const inputStyle = { width: "100%", padding: "14px 16px", background: C.bg, border: `2px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: 16, outline: "none", marginBottom: 12, textAlign: "center", boxSizing: "border-box" };

  return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <Card style={{ width: "100%", maxWidth: 380, padding: 32, textAlign: "center" }}>
      <h1 style={{ color: C.txt, fontSize: 24, fontWeight: 800, marginBottom: 20 }}>ניהול סוכנות</h1>
      <form onSubmit={handleEntity}>
        <p style={{ color: C.dim, fontSize: 13, marginBottom: 14 }}>הזן שם משתמש וסיסמה</p>
        <input type="text" value={entityName} onChange={e => setEntityName(e.target.value)} placeholder="שם משתמש" autoFocus style={inputStyle} />
        <input type="password" value={entityPass} onChange={e => setEntityPass(e.target.value)} placeholder="סיסמה" style={inputStyle} />
        {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <Btn size="lg" style={{ width: "100%" }} disabled={logging}>{logging ? "⏳ מתחבר..." : "כניסה"}</Btn>
      </form>
    </Card>
  </div>;
}
function useApp() { return useContext(Ctx); }

function useFD() {
  const { year, month, view, dateRange, income, expenses, models, genParams, liveRate, sheetUsers } = useApp();
  const dM = useMemo(() => new Date(year, month, 1), [year, month]);

  const incomeWithDynamicRate = useMemo(() => {
    return income.map(r => {
      const rate = parseFloat(r.usdRate) > 0 ? parseFloat(r.usdRate) : liveRate;
      // For chatter-submitted pending records, rawILS may be missing — fall back to stored amountILS
      const baseILS = r.rawILS !== undefined ? r.rawILS : (r.originalRawILS !== undefined ? r.originalRawILS : (r.amountILS || 0));
      // Preserve stored amountILS for records that already have commission calculated
      if (r.commissionPct > 0 && r.preCommissionILS != null) {
        return { ...r, rawILS: baseILS, amountILS: r.cancelled ? 0 : r.amountILS };
      }
      const computedILS = baseILS + (r.amountUSD || 0) * rate;
      return { ...r, rawILS: baseILS, amountILS: r.cancelled ? 0 : computedILS };
    });
  }, [income, liveRate]);

  const incomeWithCommission = useMemo(() => incomeWithDynamicRate.map(r => applyCommission(r, liveRate)), [incomeWithDynamicRate, liveRate]);
  const iY = useMemo(() => incomeWithCommission.filter(r => r.date && r.date.getFullYear() === year), [incomeWithCommission, year]);
  const iM = useMemo(() => iY.filter(r => r.date.getMonth() === month), [iY, month]);
  const eY = useMemo(() => expenses.filter(r => r.date && r.date.getFullYear() === year), [expenses, year]);
  const eM = useMemo(() => eY.filter(r => r.date.getMonth() === month), [eY, month]);
  const iRange = useMemo(() => {
    if (!dateRange.from && !dateRange.to) return [];
    const from = dateRange.from ? new Date(dateRange.from) : null;
    const to = dateRange.to ? new Date(dateRange.to + "T23:59:59") : null;
    return incomeWithCommission.filter(r => {
      if (!r.date) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      return true;
    });
  }, [incomeWithCommission, dateRange]);
  const eRange = useMemo(() => {
    if (!dateRange.from && !dateRange.to) return [];
    const from = dateRange.from ? new Date(dateRange.from) : null;
    const to = dateRange.to ? new Date(dateRange.to + "T23:59:59") : null;
    return expenses.filter(r => {
      if (!r.date) return false;
      if (from && r.date < from) return false;
      if (to && r.date > to) return false;
      return true;
    });
  }, [expenses, dateRange]);
  const chatters = useMemo(() => {
    const fromIncome = iY.map(r => r.chatterName).filter(Boolean);
    const fromUsers = (sheetUsers || []).filter(u => u.role === "chatter").map(u => u.name);
    return [...new Set([...fromIncome, ...fromUsers])].sort();
  }, [iY, sheetUsers]);
  const platforms = useMemo(() => [...new Set(iY.map(r => r.platform).filter(Boolean))].sort(), [iY]);
  const clients = useMemo(() => {
    const fromIncome = iY.map(r => r.modelName).filter(Boolean);
    const fromUsers = (sheetUsers || []).filter(u => u.role === "client").map(u => u.name);
    return [...new Set([...fromIncome, ...fromUsers])].sort();
  }, [iY, sheetUsers]);
  return { dM, iY, iM, iRange, eY, eM, eRange, chatters, clients, platforms, models, genParams };
}

// ═══════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════
function Card({ children, style: s = {}, onClick }) { return <div onClick={onClick} style={{ background: C.card, borderRadius: 12, padding: "16px 20px", border: `1px solid ${C.bdr}`, ...s, ...(onClick ? { cursor: "pointer" } : {}) }}>{children}</div>; }
function Stat({ title, value, sub, color, icon }) { return <Card style={{ flex: 1, minWidth: 140 }}><div style={{ color: C.dim, fontSize: 12, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>{icon && <span style={{ fontSize: 16 }}>{icon}</span>}{title}</div><div style={{ fontSize: 24, fontWeight: 700, color: color || C.txt }}>{value}</div>{sub && <div style={{ color: C.mut, fontSize: 11, marginTop: 4 }}>{sub}</div>}</Card>; }
function FB({ children }) { return <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 16, direction: "rtl" }}>{children}</div>; }
const VIEW_OPTIONS = [{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }, { value: "range", label: "טווח תאריכים" }];
function ViewFilter({ extraBefore } = {}) {
  const { view, setView, month, setMonth, dateRange, setDateRange, user } = useApp();
  const isSM = user?.role === "shift_manager";
  const filteredOptions = isSM ? VIEW_OPTIONS.filter(o => o.value !== "yearly") : VIEW_OPTIONS;
  const inp = { background: "var(--c-card,#1e2130)", border: "1px solid #2a2f45", borderRadius: 8, color: "#e2e8f0", padding: "5px 8px", fontSize: 12, outline: "none", cursor: "pointer" };
  return <>
    {extraBefore}
    <Sel label="תצוגה:" value={view} onChange={v => setView(v)} options={filteredOptions} />
    {view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}
    {view === "range" && <>
      <label style={{ display: "flex", alignItems: "center", gap: 5, color: "#94a3b8", fontSize: 12 }}>
        מ-<input type="date" value={dateRange.from} onChange={e => setDateRange(p => ({ ...p, from: e.target.value }))} style={inp} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 5, color: "#94a3b8", fontSize: 12 }}>
        עד<input type="date" value={dateRange.to} onChange={e => setDateRange(p => ({ ...p, to: e.target.value }))} style={inp} />
      </label>
    </>}
  </>;
}
function Sel({ label, value, onChange, options, style: s = {} }) { return <label style={{ display: "flex", alignItems: "center", gap: 5, color: C.dim, fontSize: 12, ...s }}>{label}<select value={value} onChange={e => onChange(e.target.value)} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "6px 10px", fontSize: 12, outline: "none" }}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>; }
function Btn({ children, onClick, variant = "primary", size = "md", style: s = {}, disabled }) { const base = { border: "none", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, transition: "all 0.2s", opacity: disabled ? .5 : 1 }; const sz = { sm: { padding: "5px 10px", fontSize: 11 }, md: { padding: "8px 16px", fontSize: 12 }, lg: { padding: "12px 22px", fontSize: 14 } }; const vr = { primary: { background: C.pri, color: "#fff" }, success: { background: C.grn, color: "#fff" }, danger: { background: C.red, color: "#fff" }, ghost: { background: "transparent", color: C.dim, border: `1px solid ${C.bdr}` }, warning: { background: C.ylw, color: "#000" } }; return <button onClick={disabled ? undefined : onClick} style={{ ...base, ...sz[size], ...vr[variant], ...s }}>{children}</button>; }
function Modal({ open, onClose, title, children, width = 560 }) { if (!open) return null; return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000, padding: 16 }} onClick={onClose}><div onClick={e => e.stopPropagation()} style={{ background: C.bg, borderRadius: 16, padding: 24, maxWidth: width, width: "100%", maxHeight: "85vh", overflowY: "auto", border: `1px solid ${C.bdr}`, direction: "rtl" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><h3 style={{ color: C.txt, margin: 0, fontSize: 16 }}>{title}</h3><Btn variant="ghost" size="sm" onClick={onClose}>✕</Btn></div>{children}</div></div>; }
function DT({ columns, rows, footer, textSm, onRowClick }) { const w = useWin(); const isMob = w < 768; const fs = textSm ? (isMob ? 9 : 10) : (isMob ? 11 : 13); const pad = textSm ? (isMob ? "4px" : "6px 8px") : (isMob ? "6px 6px" : "8px 14px"); return <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.bdr}` }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: fs, direction: "rtl", tableLayout: "auto" }}><thead><tr>{columns.map((c, i) => <th key={i} style={{ padding: pad, background: C.card, color: C.dim, borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap", fontSize: textSm ? (isMob ? 8 : 9) : (isMob ? 10 : 12), ...(c.thStyle || {}) }}>{c.label}</th>)}</tr></thead><tbody>{rows.map((row, ri) => <tr key={ri} onClick={() => onRowClick && onRowClick(row)} style={{ borderBottom: `1px solid ${C.bdr}`, cursor: onRowClick ? "pointer" : "default", transition: "all 0.15s" }} onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = `${C.pri}11`; }} onMouseLeave={e => { if (onRowClick) e.currentTarget.style.background = "transparent"; }}>{columns.map((c, ci) => <td key={ci} style={{ padding: pad, color: C.txt, whiteSpace: c.wrap ? "normal" : "nowrap", wordBreak: c.wrap ? "break-word" : "normal", ...(c.tdStyle || {}) }}>{c.render ? c.render(row) : row[c.key]}</td>)}</tr>)}</tbody>{footer && <tfoot><tr style={{ background: C.card }}>{footer.map((f, i) => <td key={i} style={{ padding: pad, fontWeight: 700, color: C.priL, fontSize: fs }}>{f}</td>)}</tr></tfoot>}</table></div>; }
const TT = ({ active, payload, label }) => { if (!active || !payload?.length) return null; return <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "8px 12px", fontSize: 12 }}><div style={{ color: C.dim, marginBottom: 4 }}>{label}</div>{payload.map((p, i) => <div key={i} style={{ color: p.color || C.txt }}>{p.name}: <strong>{fmtC(p.value)}</strong></div>)}</div>; };

// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════
const NAV = [
  { key: "dashboard", label: "דאשבורד", icon: "📊" },
  { key: "income", label: "מכירות", icon: "💰" },
  { key: "approvals", label: "אישורים", icon: "✅" },
  { key: "debts", label: "דוח התחשבנות", icon: "🤝" },
  { key: "expenses", label: "הוצאות", icon: "💳" },
  { key: "chatters", label: "צ'אטרים", icon: "👥" },
  { key: "clients", label: "לקוחות", icon: "👩" },
  { key: "targets", label: "יעדים", icon: "🎯" },
  { key: "record", label: "תיעוד הוצאות", icon: "📱" },
  { key: "users", label: "ניהול משתמשים", icon: "⚙️" },
  { key: "generator", label: "מחולל תכנים", icon: "✨" }
];

function Sidebar({ current, onNav }) {
  const { logout } = useApp();
  const w = useWin();
  if (w < 768) return null;
  return <div style={{ width: 200, background: C.card, borderLeft: `1px solid ${C.bdr}`, padding: "16px 0", display: "flex", flexDirection: "column", gap: 2, flexShrink: 0, height: "100vh", position: "sticky", top: 0, overflowY: "auto" }}>
    <div style={{ padding: "0 16px 16px", borderBottom: `1px solid ${C.bdr}`, marginBottom: 6 }}><div style={{ fontSize: 16, fontWeight: 800, color: C.pri, direction: "rtl" }}>🏢 ניהול סוכנות</div></div>
    {NAV.map(it => <button key={it.key} onClick={() => onNav(it.key)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: current === it.key ? `${C.pri}22` : "transparent", border: "none", borderRight: current === it.key ? `3px solid ${C.pri}` : "3px solid transparent", color: current === it.key ? C.pri : C.dim, cursor: "pointer", direction: "rtl", textAlign: "right", fontSize: 12, fontWeight: current === it.key ? 600 : 400, transition: "all .15s" }}><span style={{ fontSize: 14 }}>{it.icon}</span>{it.label}</button>)}
    <div style={{ flex: 1 }} />
    <button onClick={logout} style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: "transparent", border: "none", color: C.red, cursor: "pointer", direction: "rtl", textAlign: "right", fontSize: 12, marginTop: "auto", borderTop: `1px solid ${C.bdr}` }}><span>🚪</span>התנתקות</button>
  </div>;
}
function MobileNav({ current, onNav }) {
  const { logout } = useApp();
  const w = useWin();
  if (w >= 768) return null;
  return <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.card, borderTop: `1px solid ${C.bdr}`, zIndex: 900 }}>
    <div style={{ display: "flex", overflowX: "auto", padding: "6px 4px", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", msOverflowStyle: "none" }}>
      {NAV.map(it => <button key={it.key} onClick={() => onNav(it.key)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: current === it.key ? C.pri : C.mut, cursor: "pointer", padding: "4px 10px", fontSize: 9, fontWeight: current === it.key ? 700 : 400, flexShrink: 0, minWidth: 52 }}><span style={{ fontSize: 18 }}>{it.icon}</span>{it.label}</button>)}
      <button onClick={logout} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: C.red, cursor: "pointer", padding: "4px 10px", fontSize: 9, flexShrink: 0, minWidth: 52 }}><span style={{ fontSize: 18 }}>🚪</span>צא</button>
    </div>
  </div>;
}
function TopBar() {
  const { year, setYear, connected, demo, loading, load, loadStep, logout } = useApp();
  const w = useWin();
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: w < 768 ? "10px 14px" : "10px 24px", background: C.card, borderBottom: `1px solid ${C.bdr}`, direction: "rtl" }}>
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      {w < 768 && <span style={{ fontSize: 16, fontWeight: 800, color: C.pri }}>🏢</span>}
      <Sel label="שנה:" value={year} onChange={v => setYear(+v)} options={[2023, 2024, 2025, 2026].map(y => ({ value: y, label: y }))} />
      {connected && <Btn variant="ghost" size="sm" onClick={load}>{loading ? "⏳" : "🔄"}</Btn>}
      {loadStep && <span style={{ fontSize: 11, color: C.priL }}>{loadStep}</span>}
    </div>
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      {w < 768 && <Btn variant="ghost" size="sm" onClick={logout} style={{ color: C.red, padding: 0 }}>🚪</Btn>}
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// SETUP PAGE
// ═══════════════════════════════════════════════════════
function SetupPage() {
  const { load, loadDemo } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [step, setStep] = useState("");
  const [debugInfo, setDebugInfo] = useState("");

  const connect = async () => {
    setBusy(true); setErr(""); setStep("מתחבר ל-Google Sheets..."); setDebugInfo("");
    try {
      setStep("בודק חיבור...");
      const sheets = await API.getSheetNames();
      setStep(`נמצאו ${sheets.length} גיליונות: ${sheets.join(", ")}`);
      if (!sheets.includes("הכנסות ארכיון")) {
        setErr(`גיליון "הכנסות ארכיון" לא נמצא. גיליונות: ${sheets.join(", ")}`);
        setBusy(false); return;
      }
      setStep("טוען נתונים...");
      await load();
    } catch (e) {
      const msg = e.message || "Unknown error";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("CORS")) {
        setErr("שגיאת רשת / CORS — ודא שה-Apps Script מוגדר כ-Web App עם גישה ל-Anyone");
        setDebugInfo(`📋 פרטי שגיאה: ${msg}\n\n🔧 לתיקון:\n1. פתח את Apps Script Editor\n2. Deploy → New deployment\n3. Type: Web app\n4. Execute as: Me\n5. Who has access: Anyone\n6. Deploy והחלף את ה-URL`);
      } else {
        setErr(`שגיאה: ${msg}`);
      }
      setBusy(false);
    }
  };

  const testUrl = () => {
    window.open(`${APPS_SCRIPT_URL}?action=sheets`, "_blank");
  };

  return <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: C.bg, padding: 16 }}>
    <div style={{ background: C.card, borderRadius: 16, padding: "32px 28px", maxWidth: 460, width: "100%", border: `1px solid ${C.bdr}`, direction: "rtl" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 44, marginBottom: 8 }}>🏢</div>
        <h1 style={{ color: C.txt, fontSize: 22, fontWeight: 800, margin: 0 }}>ניהול סוכנות דוגמנות</h1>
        <p style={{ color: C.mut, marginTop: 6, fontSize: 13 }}>חיבור ישיר ל-Google Sheets דרך Apps Script</p>
      </div>

      {step && !err && <div style={{ padding: 10, borderRadius: 8, marginBottom: 12, background: `${C.pri}15`, color: C.priL, fontSize: 12 }}>⏳ {step}</div>}
      {err && <div style={{ background: `${C.red}15`, border: `1px solid ${C.red}33`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <div style={{ color: C.red, fontSize: 13, marginBottom: debugInfo ? 8 : 0 }}>{err}</div>
        {debugInfo && <pre style={{ color: C.dim, fontSize: 11, whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.5 }}>{debugInfo}</pre>}
      </div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn onClick={connect} size="lg" style={{ width: "100%" }} disabled={busy}>
          {busy ? "⏳ מתחבר..." : "🔗 התחבר ל-Google Sheets"}
        </Btn>
        <Btn variant="ghost" onClick={testUrl} size="sm" style={{ width: "100%" }}>
          🧪 בדוק URL בטאב חדש
        </Btn>
        <div style={{ textAlign: "center", color: C.mut, fontSize: 11 }}>— או —</div>
        <Btn variant="ghost" onClick={loadDemo} size="lg" style={{ width: "100%" }}>🎮 מצב הדגמה</Btn>
      </div>

      <div style={{ marginTop: 20, padding: 12, background: `${C.pri}08`, borderRadius: 8, border: `1px solid ${C.pri}22` }}>
        <div style={{ color: C.dim, fontSize: 11, lineHeight: 1.6 }}>
          <strong style={{ color: C.priL }}>💡 הגדרת Apps Script:</strong><br />
          ודא שהסקריפט כולל את הפונקציות הבאות:<br />
          • <code style={{ color: C.priL }}>doGet(e)</code> — לקריאת נתונים (GET)<br />
          • <code style={{ color: C.priL }}>doPost(e)</code> — לכתיבת נתונים (POST)<br />
          • Deploy כ-Web App עם "Anyone" access
        </div>
      </div>
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// COMPONENT: FIXED EXPENSES MANAGER
// ═══════════════════════════════════════════════════════
function FixedExpensesManager({ fixedExps, addFixedExp, removeFixedExp }) {
  const inpSt = { padding: "8px 10px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 13, outline: "none" };
  const btnSt = { padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.txt };
  const [newItem, setNewItem] = useState({ name: "", amount: "", period: "monthly" });
  const toMonthly = (amount, period) => period === "monthly" ? amount : period === "quarterly" ? amount / 3 : amount / 12;
  const periodLabel = { monthly: "חודשי", quarterly: "רבעוני", yearly: "שנתי" };
  const addFixed = async () => {
    if (!newItem.name || !newItem.amount) return;
    await addFixedExp({ name: newItem.name, amount: +newItem.amount, period: newItem.period });
    setNewItem({ name: "", amount: "", period: "monthly" });
  };
  return (
    <Card style={{ marginBottom: 16, direction: "rtl" }}>
      <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, marginBottom: 14 }}>🔒 הוצאות קבועות</h3>
      {fixedExps.length > 0 && <div style={{ marginBottom: 12 }}>
        {fixedExps.map(e => (
          <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.bdr}` }}>
            <span style={{ color: C.txt, fontSize: 13 }}>{e.name}</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: C.dim, fontSize: 11, background: C.bg, padding: "2px 8px", borderRadius: 4 }}>{periodLabel[e.period]}</span>
              <span style={{ color: C.red, fontSize: 13, fontWeight: 600 }}>{fmtC(e.amount)}</span>
              {e.period !== "monthly" && <span style={{ color: C.mut, fontSize: 11 }}>≈{fmtC(toMonthly(e.amount, e.period))}/חו'</span>}
              <button onClick={() => removeFixedExp(e.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>×</button>
            </div>
          </div>
        ))}
      </div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={newItem.name} onChange={e => setNewItem(p => ({ ...p, name: e.target.value }))} onKeyDown={e => e.key === "Enter" && addFixed()} placeholder="שם הוצאה" style={{ ...inpSt, flex: 1, minWidth: 120 }} />
        <input type="number" value={newItem.amount} onChange={e => setNewItem(p => ({ ...p, amount: e.target.value }))} onKeyDown={e => e.key === "Enter" && addFixed()} placeholder="סכום ₪" style={{ ...inpSt, width: 110 }} />
        <select value={newItem.period} onChange={e => setNewItem(p => ({ ...p, period: e.target.value }))} style={inpSt}>
          <option value="monthly">חודשי</option>
          <option value="quarterly">רבעוני</option>
          <option value="yearly">שנתי</option>
        </select>
        <button onClick={addFixed} style={{ ...btnSt, background: C.pri }}>+ הוסף הוצאה</button>
      </div>
    </Card>
  );
}

// Israeli progressive income tax brackets 2024 (annual amounts in ILS)
function calcProgressiveTax(annualIncome) {
  if (annualIncome <= 0) return 0;
  const brackets = [
    [81480,   0.10],
    [116760,  0.14],
    [187440,  0.20],
    [260520,  0.31],
    [542160,  0.35],
    [698280,  0.47],
    [Infinity, 0.50],
  ];
  let tax = 0, prev = 0;
  for (const [ceiling, rate] of brackets) {
    if (annualIncome <= prev) break;
    tax += (Math.min(annualIncome, ceiling) - prev) * rate;
    prev = ceiling;
  }
  return tax;
}

// ═══════════════════════════════════════════════════════
// PAGE: DASHBOARD
// ═══════════════════════════════════════════════════════
function DashPage() {
  const { year, month, setMonth, view, setView, liveRate, chatterSettings, clientSettings, settlements, fixedExps, addFixedExp, removeFixedExp, employees, addEmployeeCtx, removeEmployeeCtx } = useApp();
  const { iM, iY, iRange, eM, eY, eRange, targets } = useFD();
  const w = useWin();
  const [lmVals, setLmVals] = useState(() => { try { return JSON.parse(localStorage.getItem("LM_DB") || "{}"); } catch { return {}; } });
  const saveLm = (idx, val) => { const updated = { ...lmVals, [year]: { ...(lmVals[year] || {}), [idx]: val } }; setLmVals(updated); try { localStorage.setItem("LM_DB", JSON.stringify(updated)); } catch {} };
  const [bizType, setBizType] = useState(() => localStorage.getItem("AGENCY_BIZ_TYPE") || "עוסק");
  const [manualNI, setManualNI] = useState(() => +localStorage.getItem("AGENCY_MANUAL_NI") || 0);
  const activeI = view === "range" ? iRange : view === "monthly" ? iM : iY;
  const activeE = view === "range" ? eRange : view === "monthly" ? eM : eY;
  const mp = Calc.profit(activeI, activeE);
  const moneyThroughAgency = activeI.filter(r => !r.paidToClient).reduce((s, r) => s + r.amountILS, 0);
  const moneyThroughAgencyCount = activeI.filter(r => !r.paidToClient).length;
  const ymi = ym(year, month);
  const totalChatterSalary = useMemo(() => {
    const names = [...new Set(activeI.map(r => r.chatterName).filter(Boolean))];
    return names.reduce((sum, n) => {
      const cfg = chatterSettings[n] || {};
      return sum + Calc.chatterSalary(activeI.filter(r => r.chatterName === n), cfg, ymi).total;
    }, 0);
  }, [activeI, chatterSettings, ymi]);
  const totalClientSalary = useMemo(() => {
    const names = [...new Set(activeI.map(r => r.modelName).filter(Boolean))];
    return names.reduce((sum, n) => {
      const pct = getRate(n, ymi);
      return sum + Calc.clientBal(activeI, n, pct, [], chatterSettings).ent;
    }, 0);
  }, [activeI, ymi]);
  const netProfit = mp.profit - totalClientSalary - totalChatterSalary;

  // ─── New financial metrics ───────────────────────────────────────
  const toMonthly = (amount, period) => period === "monthly" ? amount : period === "quarterly" ? amount / 3 : amount / 12;
  const fixedMonthly = fixedExps.reduce((s, e) => s + toMonthly(e.amount, e.period), 0);
  const empGrossMonthly = employees.reduce((s, e) => s + e.grossAmount, 0);
  const empNIMonthly = employees.reduce((s, e) => s + e.nationalInsurance, 0);
  const empMonthly = empGrossMonthly + empNIMonthly;
  const burnRate = fixedMonthly + empMonthly;
  const agencyIncome = mp.inc - totalClientSalary - totalChatterSalary;
  const lmCurr = view === "monthly" ? (lmVals[year]?.[month] || 0) : 0;
  const vatBase = agencyIncome - lmCurr;
  const vat = vatBase > 0 ? vatBase * 0.18 : 0;
  const grossProfit = agencyIncome - mp.exp - fixedMonthly - empMonthly;
  const nonDeductible = activeE.filter(e => !e.taxRecognized).reduce((s, e) => s + (e.amount || 0), 0);
  const niTotal = empNIMonthly + manualNI;
  const taxableIncome = (agencyIncome - vat) - mp.exp - fixedMonthly - niTotal + nonDeductible - lmCurr;
  const incomeTax = taxableIncome > 0
    ? (bizType === "חברה"
        ? taxableIncome * 0.23
        : calcProgressiveTax(taxableIncome * 12) / 12)
    : 0;
  const effectiveTaxRate = taxableIncome > 0 ? (incomeTax / taxableIncome * 100) : 0;
  const netProfitFull = grossProfit - vat - incomeTax - niTotal;
  const cashToBank = netProfitFull - lmCurr;
  // ────────────────────────────────────────────────────────────────

  const paymentGap = useMemo(() => {
    const isMonthly = view === "monthly";
    const filterDate = s => {
      const d = new Date(s.timestamp || s.date || Date.now());
      return isMonthly ? (d.getMonth() === month && d.getFullYear() === year) : d.getFullYear() === year;
    };
    const periodSets = settlements.filter(filterDate);
    // Client gaps (with VAT)
    const clientNames = [...new Set(activeI.map(r => r.modelName).filter(Boolean))];
    const clientGap = clientNames.reduce((sum, n) => {
      const pct = getRate(n, ymi);
      const bal = Calc.clientBal(activeI, n, pct, periodSets.filter(s => s.entityType !== "chatter"), chatterSettings);
      const hasVat = (clientSettings[n] || {}).vatClient ?? false;
      return sum + bal.actualDue;
    }, 0);
    // Chatter gaps (without VAT, to match debts page totals)
    const chatterNames = [...new Set(activeI.map(r => r.chatterName).filter(Boolean))];
    const chatterSets = periodSets.filter(s => s.entityType === "chatter");
    const chatterGap = chatterNames.reduce((sum, name) => {
      const rows = activeI.filter(r => r.chatterName === name);
      const cfg = chatterSettings[name] || {};
      const sal = Calc.chatterSalary(rows, cfg, ymi).total;
      const paidDirect = rows.filter(r => (r.paymentTarget || (r.paidToClient ? "client" : "agency")) === "chatter").reduce((s, r) => s + r.amountILS, 0);
      let netSettled = 0;
      chatterSets.filter(s => s.modelName === name).forEach(s => {
        if (s.direction === "AgencyToChatter") netSettled += s.amount;
        if (s.direction === "ChatterToAgency") netSettled -= s.amount;
      });
      const balance = sal - paidDirect - netSettled;
      return sum + balance;
    }, 0);
    return clientGap + chatterGap;
  }, [activeI, settlements, chatterSettings, ymi, view, month, year]);

  const actualProfit = netProfit + paymentGap;

  const mbd = useMemo(() => {
    let lastDays = 31, lastInc = 0;
    return MONTHS_HE.map((m, i) => {
      const mi = iY.filter(r => r.date.getMonth() === i), me = eY.filter(e => e.date.getMonth() === i);
      const inc = mi.reduce((s, r) => s + r.amountILS, 0), exp = me.reduce((s, e) => s + e.amount, 0);
      const daysInMonth = new Date(year, i + 1, 0).getDate();
      const t = Calc.targets(lastInc, lastDays, daysInMonth);
      lastInc = inc; lastDays = daysInMonth;
      // Per-month payment gap
      const mSets = settlements.filter(s => { const d = new Date(s.timestamp || s.date || Date.now()); return d.getMonth() === i && d.getFullYear() === year; });
      const ymiM = ym(year, i);
      const clNames = [...new Set(mi.map(r => r.modelName).filter(Boolean))];
      const clGap = clNames.reduce((sum, n) => {
        const pct = getRate(n, ymiM);
        const bal = Calc.clientBal(mi, n, pct, mSets.filter(s => s.entityType !== "chatter"), chatterSettings);
        const hasVat = (clientSettings[n] || {}).vatClient ?? false;
        return sum + (hasVat ? bal.actualDue * 1.18 : bal.actualDue);
      }, 0);
      const chNames = [...new Set(mi.map(r => r.chatterName).filter(Boolean))];
      const chSets = mSets.filter(s => s.entityType === "chatter");
      const chGap = chNames.reduce((sum, name) => {
        const rows = mi.filter(r => r.chatterName === name);
        const cfg = chatterSettings[name] || {};
        const sal = Calc.chatterSalary(rows, cfg, ymiM).total;
        const pd = rows.filter(r => (r.paymentTarget || (r.paidToClient ? "client" : "agency")) === "chatter").reduce((s, r) => s + r.amountILS, 0);
        let ns = 0;
        chSets.filter(s => s.modelName === name).forEach(s => { if (s.direction === "AgencyToChatter") ns += s.amount; if (s.direction === "ChatterToAgency") ns -= s.amount; });
        const balance = sal - pd - ns;
        const hasVat = cfg.vatChatter ?? false;
        return sum + (hasVat ? balance * 1.18 : balance);
      }, 0);
      const gap = clGap + chGap;
      const clEnt = clNames.reduce((sum, n) => sum + Calc.clientBal(mi, n, getRate(n, ymiM), [], chatterSettings).ent, 0);
      const chSalMo = chNames.reduce((sum, name) => sum + Calc.chatterSalary(mi.filter(r => r.chatterName === name), chatterSettings[name] || {}, ymiM).total, 0);
      const agencyInc = inc - clEnt;
      return { month: m, ms: MONTHS_SHORT[i], idx: i, inc, exp, gap, agencyInc, clEnt, chSalMo, tgt1: t.t1, tgt2: t.t2, tgt3: t.t3, dailyAvg: t.daily, days: daysInMonth };
    });
  }, [iY, eY, year, liveRate, settlements, chatterSettings, clientSettings]);

  const cumData = useMemo(() => { let ci = 0, ct = 0; return mbd.map(d => { ci += d.inc; ct += d.tgt1; return { ...d, cumInc: ci, cumTgt: ct }; }); }, [mbd]);
  const yearTotInc = cumData[11]?.cumInc || 0, yearTotTgt = cumData[11]?.cumTgt || 0;

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: w < 768 ? 18 : 22, fontWeight: 700, marginBottom: 20 }}>📊 דאשבורד ניהול סוכנות</h2>
    <Card style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span style={{ color: C.dim, fontSize: 13 }}>🎯 התקדמות שנתית {year}</span>
        <div style={{ display: "flex", gap: 16 }}>
          <span style={{ fontSize: 12 }}><span style={{ color: C.grn }}>●</span> הכנסות: <strong style={{ color: C.grn }}>{fmtC(yearTotInc)}</strong></span>
          <span style={{ fontSize: 12 }}><span style={{ color: C.ylw }}>●</span> יעד: <strong style={{ color: C.ylw }}>{fmtC(yearTotTgt)}</strong></span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={cumData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} />
          <Tooltip content={<TT />} /><Area type="monotone" dataKey="cumTgt" fill={`${C.ylw}15`} stroke={C.ylw} strokeDasharray="5 5" name="יעד מצטבר" /><Line type="monotone" dataKey="cumInc" stroke={C.grn} strokeWidth={3} dot={{ r: 4, fill: C.grn }} name="הכנסות מצטבר" />
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
      {mbd.filter((_, i) => i <= month).map(d => {
        const isCurrent = d.idx === month;
        const daysPassed = isCurrent ? Math.max(1, new Date().getDate()) : d.days;
        const currentDaily = d.inc / daysPassed;
        const hit = currentDaily >= (d.tgt1 / d.days);
        return <Card key={d.idx} style={{ minWidth: 100, textAlign: "center", borderColor: hit ? `${C.grn}44` : `${C.red}44`, padding: "8px 10px", background: isCurrent ? `${C.pri}11` : C.card }}>
          <div style={{ fontSize: 10, color: C.dim, marginBottom: 2 }}>{d.ms}{isCurrent ? " (נוכחי)" : ""}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: hit ? C.grn : C.red }}>{fmtC(currentDaily)} <span style={{ fontSize: 10, fontWeight: 400, color: C.mut }}>/יום</span></div>
          <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>יעד 1: {fmtC(d.tgt1)}</div>
        </Card>;
      })}
    </div>
    <FB><ViewFilter /></FB>
    {view === "monthly" ? <div>
      {/* Business type toggle + ל.מ */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 0, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.bdr}` }}>
          <button onClick={() => { setBizType("עוסק"); localStorage.setItem("AGENCY_BIZ_TYPE", "עוסק"); }} style={{ padding: "7px 16px", background: bizType === "עוסק" ? C.pri : C.card, border: "none", color: C.txt, cursor: "pointer", fontSize: 13, fontWeight: bizType === "עוסק" ? 700 : 400 }}>עוסק מורשה</button>
          <button onClick={() => { setBizType("חברה"); localStorage.setItem("AGENCY_BIZ_TYPE", "חברה"); }} style={{ padding: "7px 16px", background: bizType === "חברה" ? C.pri : C.card, border: "none", color: C.txt, cursor: "pointer", fontSize: 13, fontWeight: bizType === "חברה" ? 700 : 400 }}>חברה</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ color: C.dim, fontSize: 12 }}>ל.מ (ניכויים) ₪</label>
          <input type="number" value={lmVals[year]?.[month] || ""} placeholder="0" onChange={e => saveLm(month, +e.target.value)} style={{ width: 90, padding: "6px 8px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 6, color: C.txt, fontSize: 13, outline: "none" }} />
        </div>
        {employees.length > 0 && <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ color: C.dim, fontSize: 12 }}>ב.ל נוסף (שכירים) ₪</label>
          <input type="number" value={manualNI || ""} placeholder="0" onChange={e => { const v = +e.target.value || 0; setManualNI(v); localStorage.setItem("AGENCY_MANUAL_NI", v); }} style={{ width: 100, padding: "6px 8px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 6, color: C.txt, fontSize: 13, outline: "none" }} />
        </div>}
      </div>

      {/* Row 1: Sales breakdown → agency income */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat icon="💰" title={`מכירות — ${MONTHS_HE[month]}`} value={fmtC(mp.inc)} color={C.grn} sub={`${iM.length} עסקאות`} />
        <Stat icon="👑" title="שכר לקוחות" value={fmtC(totalClientSalary)} color={C.ylw} />
        <Stat icon="💬" title="שכר צ'אטרים" value={fmtC(totalChatterSalary)} color={C.ylw} />
        <Stat icon="📥" title="צפי הכנסה שלי" value={fmtC(agencyIncome)} color={agencyIncome >= 0 ? C.grn : C.red} sub="אחרי שכר לקוחות וצ'אטרים" />
      </div>

      {/* Row 2: Expenses → gross profit */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat icon="💳" title="הוצאות שוטפות" value={fmtC(mp.exp)} color={C.red} />
        {nonDeductible > 0 && <Stat icon="🚫" title="הוצאות לא מוכרות" value={fmtC(nonDeductible)} color={C.red} sub="מוסיף לבסיס החייב במס" />}
        <Stat icon="🔄" title="כסף שעבר דרכנו" value={fmtC(moneyThroughAgency)} color={C.pri} sub={`${moneyThroughAgencyCount} עסקאות עברו דרכנו`} />
        <Stat icon="📊" title="צפי רווח ברוטו" value={fmtC(grossProfit)} color={grossProfit >= 0 ? C.grn : C.red} sub="לפני מסים" />
      </div>

      {/* Row 3: Tax / VAT / NI */}
      <Card style={{ marginBottom: 12, background: `${C.red}08`, border: `1px solid ${C.red}30` }}>
        <div style={{ color: C.ylw, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🧾 מסים ותשלומים חובה</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Stat icon="📋" title="מע״מ (18%)" value={fmtC(vat)} color={C.ylw} sub={`בסיס: ${fmtC(vatBase)}`} />
          <Stat icon="🏛️" title={`מס הכנסה${bizType === "חברה" ? " (23%)" : " (מדרגות)"}`} value={<span>{taxableIncome > 0 && <span style={{ display: "block", fontSize: 11, color: C.mut, fontWeight: 400, marginBottom: 2 }}>{effectiveTaxRate.toFixed(1)}% מהבסיס החייב</span>}{fmtC(incomeTax)}</span>} color={C.ylw} sub={`בסיס: ${fmtC(Math.max(0, taxableIncome))}`} />
          <Stat icon="🏥" title="ביטוח לאומי" value={fmtC(niTotal)} color={niTotal > 0 ? C.ylw : C.mut} sub={employees.length > 0 ? "עובדים + ידני" : "ידני"} />
          <Stat icon="💸" title="סה״כ מסים" value={fmtC(vat + incomeTax + niTotal)} color={C.red} sub="מע״מ + מס + ב.ל" />
        </div>
      </Card>

      {/* Row 4: Net profit + cash to bank + payment gaps */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <Stat icon="💚" title="רווח נטו" value={fmtC(netProfitFull)} color={netProfitFull >= 0 ? C.grn : C.red} sub="אחרי כל הניכויים" />
        <Stat icon="🏦" title="כסף לבנק" value={fmtC(cashToBank)} color={cashToBank >= 0 ? C.grn : C.red} sub="רווח נטו פחות ל.מ" />
        <Stat icon={paymentGap > 0 ? "🔴" : paymentGap < 0 ? "🟢" : "⚪"} title="פערי תשלומים" value={fmtC(Math.abs(paymentGap))} color={paymentGap > 0 ? C.red : paymentGap < 0 ? C.grn : C.mut} sub={paymentGap > 0 ? "אנחנו חייבים" : paymentGap < 0 ? "חייבים לנו" : "מאוזן"} />
      </div>

      {/* Burn rate */}
      {burnRate > 0 && <Card style={{ marginBottom: 16, background: `${C.red}10`, border: `2px solid ${C.red}40`, textAlign: "center" }}>
        <div style={{ color: C.red, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>🔥 שריפה חודשית</div>
        <div style={{ fontSize: 36, fontWeight: 800, color: C.red }}>{fmtC(burnRate)}</div>
        <div style={{ color: C.mut, fontSize: 12, marginTop: 6 }}>עלות ההחזקה של העסק ללא הכנסות</div>
        {fixedMonthly > 0 && <div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>הוצאות קבועות: {fmtC(fixedMonthly)} | שכירים: {fmtC(empMonthly)}</div>}
      </Card>}
    </div> : <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat icon="💰" title={`צפי מכירות — ${year}`} value={fmtC(mp.inc)} color={C.grn} sub={`${iY.length} עסקאות`} />
        <Stat icon="💳" title="הוצאות" value={fmtC(mp.exp)} color={C.red} />
        <Stat icon="👑" title="צפי שכר לקוחות" value={fmtC(totalClientSalary)} color={C.ylw} />
        <Stat icon="💬" title="צפי שכר צ'אטים" value={fmtC(totalChatterSalary)} color={C.ylw} />
        <Stat icon="📈" title="צפי רווח לפני מס" value={fmtC(netProfit)} color={netProfit >= 0 ? C.grn : C.red} />
      </div>
      <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={240}><BarChart data={mbd}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="inc" fill={C.grn} radius={[4, 4, 0, 0]} name="הכנסות" /><Bar dataKey="exp" fill={C.red} radius={[4, 4, 0, 0]} name="הוצאות" /></BarChart></ResponsiveContainer></Card>
      <DT columns={[
        { label: "חודש", key: "month" },
        { label: "הכנסות סוכנות", render: r => <span style={{ color: C.grn }}>{fmtC(r.agencyInc)}</span> },
        { label: "הוצאות", render: r => <span style={{ color: C.red }}>{fmtC(r.exp)}</span> },
        { label: "פערים", render: r => <span style={{ color: r.gap > 0 ? C.red : r.gap < 0 ? C.grn : C.mut }}>{fmtC(Math.abs(r.gap))}</span> },
        { label: "ל.מ", render: r => <input type="number" min="0" value={lmVals[year]?.[r.idx] || ""} placeholder="0" onChange={e => saveLm(r.idx, +e.target.value)} style={{ width: 72, padding: "2px 4px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 4, color: C.txt, fontSize: 12, textAlign: "center", outline: "none" }} /> },
        { label: "צפי מע״מ", render: r => { const base = r.agencyInc - (lmVals[year]?.[r.idx] || 0); return <span style={{ color: C.ylw }}>{fmtC(base > 0 ? base * 0.18 : 0)}</span>; } },
        { label: "צפי מס", render: r => { const lmVal = lmVals[year]?.[r.idx] || 0; const base = r.agencyInc - (lmVal); const vat = base > 0 ? base * 0.18 : 0; const taxBase = r.agencyInc - r.exp - r.chSalMo - lmVal - vat; const tax = taxBase > 0 ? taxBase * 0.23 : 0; return <span style={{ color: C.ylw }}>{fmtC(tax)}</span>; } },
        { label: "רווח נטו", render: r => { const lmVal = lmVals[year]?.[r.idx] || 0; const base = r.agencyInc - lmVal; const vat = base > 0 ? base * 0.18 : 0; const taxBase = r.agencyInc - r.exp - r.chSalMo - lmVal - vat; const tax = taxBase > 0 ? taxBase * 0.23 : 0; const net = r.agencyInc - r.exp - r.chSalMo - lmVal - vat - tax; return <span style={{ color: net >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(net)}</span>; } },
      ]} rows={mbd} footer={(() => {
        const totAgencyInc = mbd.reduce((s, r) => s + r.agencyInc, 0);
        const totExp = mbd.reduce((s, r) => s + r.exp, 0);
        const totGap = mbd.reduce((s, r) => s + r.gap, 0);
        const totLm = mbd.reduce((s, r) => s + (lmVals[year]?.[r.idx] || 0), 0);
        const totChSal = mbd.reduce((s, r) => s + r.chSalMo, 0);
        const totBase = totAgencyInc - totLm;
        const totVat = totBase > 0 ? totBase * 0.18 : 0;
        const totTaxBase = totAgencyInc - totExp - totChSal - totLm - totVat;
        const totTax = totTaxBase > 0 ? totTaxBase * 0.23 : 0;
        const totNet = totAgencyInc - totExp - totChSal - totLm - totVat - totTax;
        return ["סה״כ", fmtC(totAgencyInc), fmtC(totExp), fmtC(Math.abs(totGap)), fmtC(totLm), fmtC(totVat), fmtC(totTax), fmtC(totNet)];
      })()} />
    </>}

    {/* Hourly sales chart */}
    {(() => {
      const hourlyTotal = (() => {
        const map = {};
        for (let h = 0; h < 24; h++) map[h] = { hour: h, total: 0 };
        activeI.forEach(r => {
          let hStr = r.hour;
          if (!hStr) return;
          if (typeof hStr === "string" && hStr.includes("1899-") && hStr.includes("T")) hStr = hStr.split("T")[1].substring(0, 5);
          const hNum = parseInt(hStr, 10);
          if (isNaN(hNum) || hNum < 0 || hNum > 23) return;
          map[hNum].total += r.amountILS;
        });
        return Object.values(map).sort((a, b) => a.hour - b.hour);
      })();
      return activeI.length > 0 && <Card style={{ marginBottom: 16 }}>
        <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📈 מכירות לפי שעה ביום</div>
        <div style={{ direction: "ltr" }}><ResponsiveContainer width="100%" height={220}>
          <LineChart data={hourlyTotal} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} />
            <XAxis dataKey="hour" tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `${v}:00`} />
            <YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => fmtC(v)} />
            <Tooltip formatter={v => fmtC(v)} labelFormatter={v => `שעה ${v}:00`} />
            <Line type="monotone" dataKey="total" stroke={C.pri} strokeWidth={2} dot={{ r: 3 }} name="מכירות" connectNulls />
          </LineChart>
        </ResponsiveContainer></div>
      </Card>;
    })()}

    {/* Rankings */}
    {(() => {
      const data0 = view === "monthly" ? iM : iY;
      const chatterRank = Object.entries(data0.reduce((m, r) => { if (r.chatterName) m[r.chatterName] = (m[r.chatterName] || 0) + r.amountILS; return m; }, {})).sort((a, b) => b[1] - a[1]);
      const clientRank = Object.entries(data0.reduce((m, r) => { if (r.modelName) m[r.modelName] = (m[r.modelName] || 0) + r.amountILS; return m; }, {})).sort((a, b) => b[1] - a[1]);
      const top3Ch = chatterRank.slice(0, 3), bot3Ch = chatterRank.slice(-3).reverse();
      const top3Cl = clientRank.slice(0, 3), bot3Cl = clientRank.slice(-3).reverse();
      const medals = ["🥇", "🥈", "🥉"];
      const rankCard = (title, items, good) => (
        <Card style={{ flex: 1, minWidth: 180 }}>
          <h4 style={{ color: C.txt, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>{title}</h4>
          {items.map(([name, val], i) => (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: i < items.length - 1 ? `1px solid ${C.bdr}` : "none" }}>
              <span style={{ color: C.txt, fontSize: 13 }}>{good ? medals[i] : `${i + 1}.`} {name}</span>
              <span style={{ color: good ? C.grn : C.red, fontSize: 13, fontWeight: 600 }}>{fmtC(val)}</span>
            </div>
          ))}
          {items.length === 0 && <div style={{ color: C.mut, fontSize: 12 }}>אין נתונים</div>}
        </Card>
      );
      return <div style={{ marginTop: 24 }}>
        <h3 style={{ color: C.txt, fontSize: 16, fontWeight: 700, marginBottom: 12 }}>🏆 דירוגים</h3>
        <div style={{ display: "grid", gridTemplateColumns: w < 768 ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
          {rankCard("🌟 צ'אטרים מובילים", top3Ch, true)}
          {rankCard("⚠️ צ'אטרים נמוכים", bot3Ch, false)}
          {rankCard("👑 לקוחות מובילות", top3Cl, true)}
          {rankCard("📉 לקוחות נמוכות", bot3Cl, false)}
        </div>
      </div>;
    })()}

    {/* Tier Cubes */}
    <TierCubes income={view === "monthly" ? iM : iY} />
  </div>;
}

function TierCubes({ income }) {
  const w = useWin();
  const [thresholds, setThresholds] = useState(() => {
    const saved = localStorage.getItem("AGENCY_TIER_THRESHOLDS");
    if (saved) try { return JSON.parse(saved); } catch { /* ignore */ }
    return { bronze: 15000, silver: 30000 };
  });

  const updateThreshold = (key, val) => {
    const v = +val || 0;
    const next = { ...thresholds, [key]: v };
    setThresholds(next);
    localStorage.setItem("AGENCY_TIER_THRESHOLDS", JSON.stringify(next));
  };

  const chatterTotals = useMemo(() => {
    const map = {};
    income.forEach(r => { if (r.chatterName) map[r.chatterName] = (map[r.chatterName] || 0) + r.amountILS; });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [income]);

  const bronze = chatterTotals.filter(([, v]) => v <= thresholds.bronze);
  const silver = chatterTotals.filter(([, v]) => v > thresholds.bronze && v <= thresholds.silver);
  const gold = chatterTotals.filter(([, v]) => v > thresholds.silver);

  const tiers = [
    { key: "bronze", label: "ארד 🥉", chatters: bronze, color: "#cd7f32", bg: "#cd7f3215", thresholdLabel: `עד ${fmtC(thresholds.bronze)}`, inputKey: "bronze" },
    { key: "silver", label: "כסף 🥈", chatters: silver, color: "#c0c0c0", bg: "#c0c0c015", thresholdLabel: `${fmtC(thresholds.bronze + 1)} — ${fmtC(thresholds.silver)}`, inputKey: "silver" },
    { key: "gold", label: "זהב 🥇", chatters: gold, color: "#ffd700", bg: "#ffd70015", thresholdLabel: `מעל ${fmtC(thresholds.silver)}`, inputKey: null },
  ];

  return <div style={{ marginTop: 24, marginBottom: 20 }}>
    <h3 style={{ color: C.txt, fontSize: 16, fontWeight: 700, marginBottom: 12 }}>🏅 שכבות הכנסה</h3>
    <div style={{ display: "grid", gridTemplateColumns: w < 600 ? "1fr" : "1fr 1fr 1fr", gap: 0 }}>
      {tiers.map(t => (
        <div key={t.key} style={{
          background: t.bg, border: `2px solid ${t.color}`, padding: 16,
          display: "flex", flexDirection: "column", alignItems: "center", minHeight: 180
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: t.color, marginBottom: 4 }}>{t.label}</div>
          {t.inputKey && (
            <div style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: C.dim, fontSize: 11 }}>רף:</span>
              <input type="number" value={thresholds[t.inputKey]} onChange={e => updateThreshold(t.inputKey, e.target.value)}
                style={{ width: 80, padding: "4px 8px", background: C.card, border: `1px solid ${t.color}44`, borderRadius: 6, color: C.txt, fontSize: 13, textAlign: "center", outline: "none" }} />
              <span style={{ color: C.dim, fontSize: 11 }}>₪</span>
            </div>
          )}
          <div style={{ color: C.dim, fontSize: 11, marginBottom: 10 }}>{t.thresholdLabel}</div>
          <div style={{ width: "100%" }}>
            {t.chatters.length === 0 ? <div style={{ color: C.mut, fontSize: 12, textAlign: "center", marginTop: 10 }}>—</div> :
              t.chatters.map(([name, val]) => (
                <div key={name} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "6px 10px", borderBottom: `1px solid ${t.color}22`, fontSize: 13
                }}>
                  <span style={{ color: C.txt, fontWeight: 600 }}>{name}</span>
                  <span style={{ color: t.color, fontWeight: 700 }}>{fmtC(val)}</span>
                </div>
              ))
            }
          </div>
        </div>
      ))}
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: INCOME
// ═══════════════════════════════════════════════════════
function IncPage() {
  const { year, month, setMonth, view, setView, setIncome, liveRate } = useApp();
  const { iM, iY, iRange } = useFD();
  const activeInc = view === "range" ? iRange : view === "monthly" ? iM : iY;
  const incTypes = useMemo(() => [...new Set(activeInc.map(r => r.incomeType).filter(Boolean))].sort(), [activeInc]);
  const activeChatters = useMemo(() => [...new Set(activeInc.map(r => r.chatterName).filter(Boolean))].sort(), [activeInc]);
  const activeClients = useMemo(() => [...new Set(activeInc.map(r => r.modelName).filter(Boolean))].sort(), [activeInc]);
  const activePlatforms = useMemo(() => [...new Set(activeInc.map(r => r.platform).filter(Boolean))].sort(), [activeInc]);
  const [fP, setFP] = useState("all"), [fC, setFC] = useState("all"), [fCh, setFCh] = useState("all"), [fL, setFL] = useState("all"), [fT, setFT] = useState("all"), [xAxis, setXAxis] = useState("date");
  useEffect(() => { if (fCh !== "all" && !activeChatters.includes(fCh)) setFCh("all"); }, [activeChatters]);
  useEffect(() => { if (fC !== "all" && !activeClients.includes(fC)) setFC("all"); }, [activeClients]);
  useEffect(() => { if (fP !== "all" && !activePlatforms.includes(fP)) setFP("all"); }, [activePlatforms]);
  useEffect(() => { if (fT !== "all" && !incTypes.includes(fT)) setFT("all"); }, [incTypes]);
  const [showIncForm, setShowIncForm] = useState(false);
  const [showIncTypesMgr, setShowIncTypesMgr] = useState(false);
  const [editTx, setEditTx] = useState(null);
  const [noteView, setNoteView] = useState(null);

  const data = activeInc.filter(r => (fP === "all" || r.platform === fP) && (fC === "all" || r.modelName === fC) && (fCh === "all" || r.chatterName === fCh) && (fL === "all" || r.shiftLocation === fL) && (fT === "all" || r.incomeType === fT));
  const totalILS = data.reduce((s, r) => s + (r.rawILS || 0), 0);
  const totalUSD = data.reduce((s, r) => s + (r.amountUSD || 0), 0);
  const usdInILS = totalUSD * liveRate;
  const grandTotal = data.reduce((s, r) => s + r.amountILS, 0);
  const ilsOnlyTotal = data.reduce((s, r) => s + ((r.amountUSD || 0) > 0 ? 0 : r.amountILS), 0);
  const agencyTotal = data.filter(r => !r.cancelled && (!r.paymentTarget || r.paymentTarget === "agency")).reduce((s, r) => s + r.amountILS, 0);
  const totalPreCommUSD = data.reduce((s, r) => s + (r.preCommissionUSD || 0), 0);
  const totalPreCommILS = data.reduce((s, r) => s + (r.preCommissionILS || 0), 0);

  const setPayment = async (r, target) => {
    try {
      const nr = await IncSvc.setPaymentTarget(r, target);
      setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
    } catch (e) { alert("שגיאה: " + e.message); }
  };
  const cancelTx = async (r) => {
    const isCancelled = r.cancelled;
    if (!isCancelled && !confirm("לבטל עסקה זו?")) return;
    if (isCancelled && !confirm("לשחזר עסקה זו?")) return;
    try {
      if (isCancelled) {
        // Un-cancel: restore
        const nr = await IncSvc.uncancelTransaction(r);
        setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
      } else {
        const nr = await IncSvc.cancelTransaction(r);
        setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
      }
    } catch (e) { alert("שגיאה: " + e.message); }
  };
  const deleteTx = async (r) => {
    if (!confirm("למחוק עסקה זו לצמיתות? פעולה זו אינה ניתנת לביטול.")) return;
    try {
      await IncSvc.deleteTransaction(r);
      setIncome(prev => prev.filter(x => x.id !== r.id));
    } catch (e) { alert("שגיאה: " + e.message); }
  };
  const chartData = useMemo(() => {
    if (view === "yearly") return MONTHS_HE.map((m, i) => ({ name: MONTHS_SHORT[i], value: data.filter(r => r.date && r.date.getMonth() === i).reduce((s, r) => s + r.amountILS, 0) }));
    if (xAxis === "date") { const map = {}; data.forEach(r => { const k = r.date ? r.date.getDate() : "?"; map[k] = (map[k] || 0) + r.amountILS; }); return Object.entries(map).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => ({ name: k, value: v })); }
    const map = {}; data.forEach(r => { const k = xAxis === "chatter" ? r.chatterName : xAxis === "client" ? r.modelName : xAxis === "type" ? r.incomeType : r.platform; map[k] = (map[k] || 0) + r.amountILS; }); return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, value: v }));
  }, [data, view, xAxis, liveRate]);

  return <div style={{ direction: "rtl" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
      <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, margin: 0 }}>💰 פירוט מכירות</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="success" size="sm" onClick={() => setShowIncForm(true)}>➕ הוסף מכירה ידנית</Btn>
        <Btn variant="ghost" size="sm" onClick={() => setShowIncTypesMgr(true)}>✏️ עריכת סוגי הכנסה</Btn>
      </div>
    </div>
    <FB><ViewFilter /></FB>
    <FB><Sel label="פלטפורמה:" value={fP} onChange={setFP} options={[{ value: "all", label: "הכל" }, ...activePlatforms.map(p => ({ value: p, label: p }))]} /><Sel label="סוג הכנסה:" value={fT} onChange={setFT} options={[{ value: "all", label: "הכל" }, ...incTypes.map(t => ({ value: t, label: t }))]} /><Sel label="לקוחה:" value={fC} onChange={setFC} options={[{ value: "all", label: "הכל" }, ...activeClients.map(c => ({ value: c, label: c }))]} /><Sel label="צ'אטר:" value={fCh} onChange={setFCh} options={[{ value: "all", label: "הכל" }, ...activeChatters.map(c => ({ value: c, label: c }))]} /><Sel label="מיקום:" value={fL} onChange={setFL} options={[{ value: "all", label: "הכל" }, { value: "משרד", label: "משרד" }, { value: "חוץ", label: "חוץ" }]} /></FB>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
      <Stat icon="💰" title="סה״כ ₪" value={fmtC(grandTotal)} color={C.grn} sub={`${data.length} עסקאות • שער $: ₪${liveRate.toFixed(2)}`} />
      <Stat icon="🏦" title='סה״כ ₪ (שקל)' value={fmtC(ilsOnlyTotal)} color={C.grn} sub="עסקאות שנכנסו בשקל" />
      <Stat icon="💵" title='סה״כ $' value={fmtUSD(totalUSD)} color={C.pri} sub={`≈ ${fmtC(grandTotal - ilsOnlyTotal)} (מומר לשקל)`} />
      <Stat icon="🏢" title="עבר דרך הסוכנות" value={fmtC(agencyTotal)} color={C.ylw} sub="תשלומים שיועדו לסוכנות" />
    </div>
    <Card style={{ marginBottom: 16 }}>
      {view === "monthly" && <div style={{ marginBottom: 8 }}><Sel label="ציר X:" value={xAxis} onChange={setXAxis} options={[{ value: "date", label: "תאריך" }, { value: "chatter", label: "צ'אטר" }, { value: "client", label: "לקוחה" }, { value: "type", label: "סוג הכנסה" }, { value: "platform", label: "פלטפורמה" }]} /></div>}
      <ResponsiveContainer width="100%" height={220}><BarChart data={chartData} margin={{ left: 50, bottom: 20 }}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="name" tick={{ fill: C.dim, fontSize: 10 }} interval={0} angle={chartData.length > 15 ? -45 : 0} textAnchor={chartData.length > 15 ? "end" : "middle"} height={chartData.length > 15 ? 60 : 30} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.pri} radius={[4, 4, 0, 0]} name="הכנסות" /></BarChart></ResponsiveContainer>
    </Card>
    {view === "monthly" ? <DT columns={[{ label: "תאריך", render: renderDateHour }, { label: "סוג הכנסה", key: "incomeType" }, { label: "שם קונה", render: r => r.buyerName || "—" }, { label: "צ'אטר", key: "chatterName" }, { label: "דוגמנית", key: "modelName" }, { label: "פלטפורמה", key: "platform" }, { label: "מיקום", key: "shiftLocation" }, { label: "שולם", render: r => { const cur = r.paymentTarget || (r.paidToClient ? "client" : "agency"); const col = cur === "client" ? C.grn : cur === "chatter" ? C.pri : C.dim; return <select value={cur} onChange={e => setPayment(r, e.target.value)} style={{ background: C.card, border: `1px solid ${C.bdr}`, color: col, borderRadius: 6, padding: "3px 5px", fontSize: 11, cursor: "pointer", outline: "none" }}><option value="agency">לסוכנות</option><option value="client">ללקוחה</option><option value="chatter">לצ'אטר</option></select>; } },{ label: "לפני עמלה ($)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtUSD(r.preCommissionUSD)}</span> : "" }, { label: "לפני עמלה (₪)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtC(r.preCommissionILS)}</span> : "" }, { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> }, { label: "סכום ₪", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.amountILS)}</span> }, { label: "הערה", render: r => { if (!r.notes) return ""; const words = r.notes.trim().split(/\s+/); if (words.length <= 3) return <span style={{ fontSize: 11, color: C.dim }}>{r.notes}</span>; return <span onClick={() => setNoteView(r.notes)} style={{ fontSize: 11, color: C.pri, cursor: "pointer", whiteSpace: "nowrap" }} title="לחץ לצפייה בהערה המלאה">{words.slice(0, 3).join(" ")}...</span>; } }, { label: "עריכה", render: r => <Btn size="sm" variant="ghost" onClick={() => setEditTx(r)} style={{ color: C.pri }}>✏️</Btn> }, { label: "ביטול", render: r => <div style={{ display: "flex", gap: 4, alignItems: "center" }}><Btn size="sm" variant="ghost" onClick={() => cancelTx(r)} style={{ color: r.cancelled ? C.ylw : C.red }}>{r.cancelled ? "↩️ שחזר" : "❌"}</Btn>{r.cancelled && <Btn size="sm" variant="ghost" onClick={() => deleteTx(r)} style={{ color: C.red }} title="מחק לצמיתות">🗑️</Btn>}</div> }]} rows={data.sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || ""))} footer={["סה״כ", "", "", "", "", "", "", "", totalPreCommUSD > 0 ? fmtUSD(totalPreCommUSD) : "", totalPreCommILS > 0 ? fmtC(totalPreCommILS) : "", fmtUSD(totalUSD), fmtC(grandTotal), "", "", ""]} /> : <DT columns={[{ label: "חודש", key: "name" }, { label: "הכנסות", render: r => <span style={{ color: C.grn }}>{fmtC(r.value)}</span> }]} rows={chartData} footer={["סה״כ", fmtC(grandTotal)]} />}

    {showIncForm && <Modal open={true} onClose={() => setShowIncForm(false)} title="➕ תיעוד מכירה ידנית" width={500}>
      <RecordIncomeAdmin onClose={() => setShowIncForm(false)} />
    </Modal>}
    {editTx && <Modal open={true} onClose={() => setEditTx(null)} title="✏️ עריכת עסקה" width={420}>
      <EditIncomeModal record={editTx} onClose={() => setEditTx(null)} />
    </Modal>}
    {noteView && <Modal open={true} onClose={() => setNoteView(null)} title="📝 הערה" width={400}>
      <p style={{ color: C.txt, lineHeight: 1.7, whiteSpace: "pre-wrap", margin: 0 }}>{noteView}</p>
    </Modal>}
    {showIncTypesMgr && <Modal open={true} onClose={() => setShowIncTypesMgr(false)} title="✏️ עריכת סוגי הכנסה" width={500}>
      <IncomeTypesModal onClose={() => setShowIncTypesMgr(false)} />
    </Modal>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// INCOME TYPES MANAGER MODAL
// ═══════════════════════════════════════════════════════
function IncomeTypesModal({ onClose }) {
  const { income, setIncome } = useApp();
  const [editingType, setEditingType] = useState(null);
  const [editName, setEditName] = useState("");
  const [editComm, setEditComm] = useState("");
  const [newType, setNewType] = useState("");
  const [newComm, setNewComm] = useState("");
  const [saving, setSaving] = useState(false);
  const [commissions, setCommissions] = useState(() => ({ ..._incomeTypeCommissions }));
  const [customTypes, setCustomTypes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("CUSTOM_INCOME_TYPES") || "[]"); } catch { return []; }
  });

  const dataTypes = [...new Set(income.map(r => r.incomeType).filter(Boolean))].sort();
  const allTypes = [...new Set([...dataTypes, ...customTypes])].sort();

  const inputStyle = { padding: "8px 10px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 14, outline: "none" };

  const startEdit = (type) => { setEditingType(type); setEditName(type); setEditComm(String(commissions[type] || "")); };
  const cancelEdit = () => { setEditingType(null); setEditName(""); setEditComm(""); };

  const saveEdit = async (oldName) => {
    const newName = editName.trim();
    if (!newName) { cancelEdit(); return; }
    const pct = parseFloat(editComm) || 0;
    setSaving(true);
    try {
      // Save commission
      saveIncomeTypeCommission(newName, pct);
      if (newName !== oldName) saveIncomeTypeCommission(oldName, 0); // remove old key
      setCommissions({ ..._incomeTypeCommissions });

      // Rename in records if name changed
      if (newName !== oldName) {
        const toUpdate = income.filter(r => r.incomeType === oldName && !r._fromPending);
        const toUpdatePending = income.filter(r => r.incomeType === oldName && r._fromPending);
        await Promise.all([
          ...toUpdate.map(r => updateIncome(r.id, { incomeType: newName })),
          ...toUpdatePending.map(r => updatePending(r.id, { incomeType: newName })),
        ]);
        setIncome(prev => prev.map(r => r.incomeType === oldName ? { ...r, incomeType: newName } : r));
        setCustomTypes(prev => {
          const updated = prev.map(t => t === oldName ? newName : t);
          localStorage.setItem("CUSTOM_INCOME_TYPES", JSON.stringify(updated));
          return updated;
        });
      }
      cancelEdit();
    } catch (e) { alert("שגיאה: " + e.message); }
    setSaving(false);
  };

  const deleteType = async (type) => {
    const count = income.filter(r => r.incomeType === type).length;
    if (!confirm(`למחוק את הסוג "${type}"?${count > 0 ? ` זה ינקה את הסוג מ-${count} עסקאות.` : ""}`)) return;
    setSaving(true);
    try {
      const toUpdate = income.filter(r => r.incomeType === type && !r._fromPending);
      const toUpdatePending = income.filter(r => r.incomeType === type && r._fromPending);
      await Promise.all([
        ...toUpdate.map(r => updateIncome(r.id, { incomeType: "" })),
        ...toUpdatePending.map(r => updatePending(r.id, { incomeType: "" })),
      ]);
      setIncome(prev => prev.map(r => r.incomeType === type ? { ...r, incomeType: "" } : r));
      saveIncomeTypeCommission(type, 0);
      setCommissions({ ..._incomeTypeCommissions });
      setCustomTypes(prev => {
        const updated = prev.filter(t => t !== type);
        localStorage.setItem("CUSTOM_INCOME_TYPES", JSON.stringify(updated));
        return updated;
      });
    } catch (e) { alert("שגיאה: " + e.message); }
    setSaving(false);
  };

  const addType = () => {
    const name = newType.trim();
    if (!name) return;
    if (allTypes.includes(name)) { alert("סוג זה כבר קיים"); return; }
    const pct = parseFloat(newComm) || 0;
    if (pct > 0) { saveIncomeTypeCommission(name, pct); setCommissions({ ..._incomeTypeCommissions }); }
    setCustomTypes(prev => {
      const updated = [...prev, name];
      localStorage.setItem("CUSTOM_INCOME_TYPES", JSON.stringify(updated));
      return updated;
    });
    setNewType(""); setNewComm("");
  };

  return <div style={{ direction: "rtl" }}>
    {/* Header row */}
    <div style={{ display: "flex", gap: 8, padding: "0 12px 8px", color: C.dim, fontSize: 12, fontWeight: 600 }}>
      <span style={{ flex: 1 }}>סוג הכנסה</span>
      <span style={{ width: 60, textAlign: "center" }}>עמלה %</span>
      <span style={{ width: 70, textAlign: "center" }}>עסקאות</span>
      <span style={{ width: 72 }}></span>
    </div>
    {allTypes.length === 0 ? (
      <div style={{ color: C.dim, textAlign: "center", padding: 20 }}>אין סוגי הכנסה עדיין</div>
    ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20, maxHeight: 360, overflowY: "auto" }}>
        {allTypes.map(type => (
          <div key={type} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: C.card, borderRadius: 8, border: `1px solid ${C.bdr}` }}>
            {editingType === type ? (
              <>
                <input value={editName} onChange={e => setEditName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveEdit(type); if (e.key === "Escape") cancelEdit(); }} style={{ ...inputStyle, flex: 1 }} autoFocus disabled={saving} placeholder="שם" />
                <input value={editComm} onChange={e => setEditComm(e.target.value)} style={{ ...inputStyle, width: 60 }} disabled={saving} placeholder="%" type="number" min="0" max="100" />
                <Btn size="sm" variant="success" onClick={() => saveEdit(type)} disabled={saving}>✓</Btn>
                <Btn size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>✕</Btn>
              </>
            ) : (
              <>
                <span style={{ flex: 1, color: C.txt, fontSize: 14 }}>{type}</span>
                <span style={{ width: 60, textAlign: "center", color: commissions[type] > 0 ? C.ylw : C.dim, fontSize: 13, fontWeight: commissions[type] > 0 ? 700 : 400 }}>
                  {commissions[type] > 0 ? `${commissions[type]}%` : "—"}
                </span>
                <span style={{ width: 70, textAlign: "center", color: C.dim, fontSize: 11 }}>{income.filter(r => r.incomeType === type).length}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <Btn size="sm" variant="ghost" onClick={() => startEdit(type)} disabled={saving} style={{ color: C.pri }}>✏️</Btn>
                  <Btn size="sm" variant="ghost" onClick={() => deleteType(type)} disabled={saving} style={{ color: C.red }}>🗑️</Btn>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    )}
    <div style={{ borderTop: `1px solid ${C.bdr}`, paddingTop: 14, marginBottom: 14 }}>
      <div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>הוספת סוג חדש:</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={newType} onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === "Enter" && addType()} placeholder="שם הסוג..." style={{ ...inputStyle, flex: 1 }} />
        <input value={newComm} onChange={e => setNewComm(e.target.value)} style={{ ...inputStyle, width: 80 }} placeholder="עמלה %" type="number" min="0" max="100" />
        <Btn variant="primary" size="sm" onClick={addType}>+ הוסף</Btn>
      </div>
    </div>
    <div style={{ textAlign: "center" }}>
      <Btn variant="ghost" onClick={onClose}>סגור</Btn>
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// EDIT INCOME MODAL
// ═══════════════════════════════════════════════════════
function EditIncomeModal({ record, onClose }) {
  const { setIncome, liveRate, income } = useApp();
  const { clients } = useFD();
  const incomeTypes = useMemo(() => {
    const fromData = income.map(r => r.incomeType).filter(Boolean);
    const defaults = ["תוכן", "שיחה", "סקסטינג", "ביט", "העברה בנקאית", "פייבוקס", "וולט"];
    return [...new Set([...defaults, ...fromData])].filter(t => !/[a-zA-Z]/.test(t)).sort();
  }, [income]);

  const isUSD = (record.amountUSD || 0) > 0;
  const [currency, setCurrency] = useState(isUSD ? "USD" : "ILS");
  const [amount, setAmount] = useState(isUSD ? String(record.amountUSD || "") : String(record.rawILS || record.amountILS || ""));
  const [incomeType, setIncomeType] = useState(record.incomeType || "");
  const [modelName, setModelName] = useState(record.modelName || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const inputStyle = { width: "100%", padding: "10px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: 14, outline: "none", boxSizing: "border-box" };

  const save = async () => {
    if (!amount) { setErr("נא להזין סכום"); return; }
    setSaving(true); setErr("");
    try {
      const rate = liveRate || 3.14;
      const inputILS = currency === "ILS" ? +amount || 0 : 0;
      const inputUSD = currency === "USD" ? +amount || 0 : 0;
      const commFields = computeCommissionFields(record.platform, incomeType, inputILS, inputUSD, rate);
      const updates = {
        incomeType,
        modelName,
        rawILS: inputILS,
        originalRawILS: inputILS,
        originalRawUSD: inputUSD,
        usdRate: rate,
        ...commFields,
      };
      if (record._fromPending) {
        await updatePending(record.id, updates);
      } else {
        await updateIncome(record.id, updates);
      }
      setIncome(prev => prev.map(x => x.id === record.id ? { ...x, ...updates } : x));
      onClose();
    } catch (e) {
      setErr("שגיאה: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return <div style={{ direction: "rtl" }}>
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>
        {record.chatterName} • {record.modelName} • {record.platform} • {record.date instanceof Date ? record.date.toLocaleDateString("he-IL") : ""}
      </div>
    </div>

    <div style={{ marginBottom: 14 }}>
      <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 6 }}>לקוחה</label>
      <select value={modelName} onChange={e => setModelName(e.target.value)} style={inputStyle}>
        <option value="">בחר...</option>
        {clients.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
    </div>

    <div style={{ marginBottom: 14 }}>
      <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 6 }}>סוג הכנסה</label>
      <select value={incomeType} onChange={e => setIncomeType(e.target.value)} style={inputStyle}>
        <option value="">בחר...</option>
        {incomeTypes.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>

    <div style={{ marginBottom: 14 }}>
      <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 6 }}>סכום ומטבע</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {[{ key: "ILS", label: "₪ שקל" }, { key: "USD", label: "$ דולר" }].map(({ key, label }) => (
          <button key={key} onClick={() => setCurrency(key)} style={{
            flex: 1, padding: "10px", borderRadius: 8, fontSize: 14, fontWeight: 600,
            cursor: "pointer", background: currency === key ? C.pri : C.card,
            color: currency === key ? "#fff" : C.dim,
            border: `2px solid ${currency === key ? C.pri : C.bdr}`, transition: "all .15s"
          }}>{label}</button>
        ))}
      </div>
      <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" style={{ ...inputStyle, direction: "ltr" }} />
    </div>

    {err && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{err}</div>}
    <Btn onClick={save} variant="success" size="lg" style={{ width: "100%" }} disabled={saving}>
      {saving ? "⏳ שומר..." : "💾 שמור שינויים"}
    </Btn>
  </div>;
}

// ═══════════════════════════════════════════════════════
// RECORD INCOME ADMIN FORM (Bypasses approvals)
// ═══════════════════════════════════════════════════════

import { collection, getDocs, doc, updateDoc } from "firebase/firestore";
import { db } from "./firebase.js";

function RecordIncomeAdmin({ onClose }) {
  const { setIncome, liveRate, income, sheetUsers } = useApp();
  const registeredChatters = useMemo(() => (sheetUsers || []).filter(u => u.role === "chatter").map(u => u.name).sort(), [sheetUsers]);
  const registeredClients = useMemo(() => (sheetUsers || []).filter(u => u.role === "client").map(u => u.name).sort(), [sheetUsers]);
  const [form, setForm] = useState({
    chatterName: "",
    modelName: "",
    platform: "",
    incomeType: "",
    customIncomeType: "",
    amountILS: "",
    amountUSD: "",
    currency: "ILS",
    amount: "",
    shiftLocation: "משרד",
    notes: "",
    buyerName: "",
    date: new Date().toISOString().split("T")[0],
    hour: new Date().toTimeString().slice(0, 5)
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Replicate incomeTypes logic from ChatterPortal
  const incomeTypes = useMemo(() => {
    const fromData = income.map(r => r.incomeType).filter(Boolean);
    const defaults = ["תוכן", "שיחה", "סקסטינג", "ביט", "העברה בנקאית", "פייבוקס", "וולט"];
    return [...new Set([...defaults, ...fromData])].filter(t => !/[a-zA-Z]/.test(t)).sort();
  }, [income]);

  const save = async () => {
    if (!form.chatterName || !form.modelName || !form.amount) {
      setErr("נא למלא צ'אטר, לקוחה וסכום");
      return;
    }
    setSaving(true);
    setErr("");

    try {
      const typeStr = form.incomeType === "__other__" ? form.customIncomeType : form.incomeType;

      const rate = liveRate || 3.14;
      const inputILS = form.currency === "ILS" ? +form.amount || 0 : 0;
      const inputUSD = form.currency === "USD" ? +form.amount || 0 : 0;
      const commFields = computeCommissionFields(form.platform, typeStr, inputILS, inputUSD, rate);

      const newInc = {
        date: new Date(form.date).toISOString(),
        hour: form.hour,
        chatterName: form.chatterName,
        modelName: form.modelName,
        clientName: "",
        usdRate: rate,
        platform: form.platform,
        incomeType: typeStr,
        shiftLocation: form.shiftLocation,
        rawILS: inputILS,
        originalRawILS: inputILS,
        originalRawUSD: inputUSD,
        originalAmount: commFields.preCommissionILS,
        ...commFields,
        notes: form.notes,
        buyerName: form.buyerName || "",
        verified: "V", // Already verified if Admin adds it
        paymentTarget: "agency",
        paidToClient: false,
        cancelled: false,
        source: "ידני ממשק מנהל",
        submittedAt: new Date().toISOString(),
      };

      const res = await IncSvc.addDirect(newInc);
      TelegramSvc.notifyIncomeAdded(res);
      setIncome(prev => [res, ...prev]);
      onClose();
    } catch (e) {
      setErr("שגיאה בשמירה: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { width: "100%", padding: "10px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: 14, outline: "none", boxSizing: "border-box" };

  return <div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>צ'אטר *</label>
        <select value={form.chatterName} onChange={e => upd("chatterName", e.target.value)} style={inputStyle}>
          <option value="">בחר צ'אטר...</option>
          {registeredChatters.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>לקוחה *</label>
        <select value={form.modelName} onChange={e => upd("modelName", e.target.value)} style={inputStyle}>
          <option value="">בחר לקוחה...</option>
          {registeredClients.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>פלטפורמה</label>
        <select value={form.platform} onChange={e => upd("platform", e.target.value)} style={inputStyle}>
          {["טלגרם", "אונלי"].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סוג הכנסה</label>
        <select value={form.incomeType} onChange={e => upd("incomeType", e.target.value)} style={inputStyle}>
          <option value="">בחר...</option>
          {incomeTypes.map(t => <option key={t} value={t}>{t}</option>)}
          <option value="__other__">אחר (רשום ידנית)</option>
        </select>
        {form.incomeType === "__other__" && <input type="text" value={form.customIncomeType} onChange={e => upd("customIncomeType", e.target.value)} placeholder="רשום סוג הכנסה..." style={{ ...inputStyle, marginTop: 6 }} />}
      </div>

      <div style={{ gridColumn: "1 / -1" }}>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 6 }}>סכום ומטבע</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          {[{ key: "ILS", label: "₪ שקל" }, { key: "USD", label: "$ דולר" }].map(({ key, label }) => (
            <button key={key} onClick={() => upd("currency", key)} style={{
              flex: 1, padding: "10px", borderRadius: 8, fontSize: 14, fontWeight: 600,
              cursor: "pointer", background: form.currency === key ? C.pri : C.card,
              color: form.currency === key ? "#fff" : C.dim,
              border: `2px solid ${form.currency === key ? C.pri : C.bdr}`, transition: "all .15s"
            }}>{label}</button>
          ))}
        </div>
        <input type="number" value={form.amount} onChange={e => upd("amount", e.target.value)} placeholder="0" style={{ ...inputStyle, direction: "ltr" }} />
      </div>

      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שעה</label>
        <input type="time" value={form.hour} onChange={e => upd("hour", e.target.value)} style={{ ...inputStyle, direction: "ltr" }} />
      </div>
      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>תאריך</label>
        <input type="date" value={form.date} onChange={e => upd("date", e.target.value)} style={inputStyle} />
      </div>

      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>מיקום</label>
        <div style={{ display: "flex", gap: 8 }}>
          {["משרד", "חוץ"].map(loc => (
            <button key={loc} onClick={() => upd("shiftLocation", loc)} style={{
              flex: 1, padding: "10px", borderRadius: 8, fontSize: 14, fontWeight: 600,
              cursor: "pointer", background: form.shiftLocation === loc ? C.pri : C.card,
              color: form.shiftLocation === loc ? "#fff" : C.dim,
              border: `2px solid ${form.shiftLocation === loc ? C.pri : C.bdr}`, transition: "all .15s"
            }}>{loc}</button>
          ))}
        </div>
      </div>
      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שם קונה</label>
        <input value={form.buyerName} onChange={e => upd("buyerName", e.target.value)} placeholder="אופציונלי" style={inputStyle} />
      </div>
      <div>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>הערות</label>
        <input value={form.notes} onChange={e => upd("notes", e.target.value)} placeholder="אופציונלי" style={inputStyle} />
      </div>
    </div>

    {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}

    <Btn onClick={save} variant="success" size="lg" style={{ width: "100%", marginTop: 14 }} disabled={saving}>
      {saving ? "⏳ שומר..." : "💾 שמור הכנסה"}
    </Btn>

  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: EXPENSES
// ═══════════════════════════════════════════════════════
function ExpPage() {
  const { year, month, setMonth, view, setView, setPage, expenses, setExpenses, demo, rv, chatterSettings, clientSettings, customCats, addCustomCat, removeCustomCat, renameCustomCat } = useApp();
  const allCats = customCats;
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [editingCat, setEditingCat] = useState(null);
  const [editingCatName, setEditingCatName] = useState("");
  const { eM, eY, iM, iY } = useFD();
  const ymi = ym(year, month); const w = useWin();
  const [src, setSrc] = useState("all"), [popCat, setPopCat] = useState(null), [editExp, setEditExp] = useState(null), [delExp, setDelExp] = useState(null);
  const data = (view === "monthly" ? eM : eY).filter(e => src === "all" || (src === "auto" ? e.source === "אוטומטי" : e.source === "ידני"));
  const total = data.reduce((s, e) => s + e.amount, 0);
  const catBd = useMemo(() => { const m = {}; data.forEach(e => { if (e.classification) { m[e.classification] = (m[e.classification] || 0) + e.amount; } }); return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [data]);
  const mByCat = useMemo(() => { if (view !== "yearly") return []; const cats = [...new Set(data.map(e => e.classification).filter(Boolean))]; return cats.map(cat => { const row = { category: cat }; let t = 0; MONTHS_HE.forEach((_, i) => { const v = data.filter(e => e.classification === cat && e.date && e.date.getMonth() === i).reduce((s, e) => s + e.amount, 0); row[`m${i}`] = v; t += v; }); row.total = t; return row; }).sort((a, b) => b.total - a.total); }, [data, view]);
  const off = Calc.offset(view === "monthly" ? eM : eY);
  const incD = view === "monthly" ? iM : iY;
  const chNames = [...new Set(incD.map(r => r.chatterName).filter(Boolean))];
  const chSal = chNames.map(n => { const cfg = chatterSettings[n] || {}; const s = Calc.chatterSalary(incD.filter(r => r.chatterName === n), cfg, ymi); const hasVat = cfg.vatChatter ?? false; const vatAmt = s.total * 0.18; const totalWithVat = hasVat ? s.total * 1.18 : s.total; return { name: n, ...s, hasVat, vatAmt, totalWithVat }; }).sort((a, b) => b.total - a.total);
  const clNames = [...new Set(incD.map(r => r.modelName).filter(Boolean))];
  const clSal = clNames.map(n => { const p = getRate(n, ym(year, month)); const b = Calc.clientBal(incD, n, p, [], chatterSettings); const hasVat = (clientSettings[n] || {}).vatClient ?? false; const vatAmt = b.ent * 0.18; const entWithVat = hasVat ? b.ent * 1.18 : b.ent; return { name: n, ...b, hasVat, vatAmt, entWithVat }; }).sort((a, b) => b.totalIncome - a.totalIncome);
  const updCat = async (e, newCat) => { const updated = { ...e, classification: newCat }; setExpenses(prev => prev.map(x => x.id === e.id ? updated : x)); try { await ExpSvc.edit(updated); } catch (err) { console.error(err); } };
  const updField = async (e, field, val) => { const updated = { ...e, [field]: val }; setExpenses(prev => prev.map(x => x.id === e.id ? updated : x)); try { await ExpSvc.edit(updated); } catch (err) { console.error(err); } };
  const handleDelete = async (e) => { if (demo) { setExpenses(expenses.filter(x => x.id !== e.id)); setDelExp(null); setPopCat(null); return; } try { await ExpSvc.remove(e); setExpenses(expenses.filter(x => x.id !== e.id)); setDelExp(null); setPopCat(null); } catch (err) { alert(err.message); } };

  if (editExp) return <RecordExpensePage editMode={editExp} onDone={() => setEditExp(null)} />;

  const noExpenses = expenses.length === 0;

  return <div style={{ direction: "rtl" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
      <h2 style={{ color: C.txt, fontSize: w < 768 ? 17 : 22, fontWeight: 700, margin: 0 }}>💳 הוצאות סוכנות</h2>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={() => { setNewCatName(""); setEditingCat(null); setEditingCatName(""); setShowAddCat(true); }} variant="ghost">✏️ עריכת סיווגים</Btn>
        <Btn onClick={() => setPage("record")} variant="success">📱 תיעוד הוצאה</Btn>
      </div>
    </div>
    <Modal open={showAddCat} onClose={() => { setShowAddCat(false); setEditingCat(null); }} title="✏️ עריכת סיווגים" width={420}>
      <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 16 }}>
        {customCats.length === 0 && <div style={{ color: C.dim, fontSize: 12, marginBottom: 8, textAlign: "center", padding: "12px 0" }}>אין סיווגים עדיין</div>}
        {customCats.map(c => (
          <div key={c} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, background: `${C.pri}11`, borderRadius: 6, padding: "4px 8px" }}>
            {editingCat === c ? (
              <>
                <input value={editingCatName} onChange={e => setEditingCatName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { if (renameCustomCat(c, editingCatName)) setEditingCat(null); else alert("שם קיים או ריק"); } if (e.key === "Escape") setEditingCat(null); }} style={{ flex: 1, padding: "4px 8px", background: C.card, border: `1px solid ${C.pri}`, borderRadius: 6, color: C.txt, fontSize: 13, outline: "none" }} autoFocus />
                <Btn variant="primary" onClick={() => { if (renameCustomCat(c, editingCatName)) setEditingCat(null); else alert("שם קיים או ריק"); }} style={{ padding: "3px 10px", fontSize: 12 }}>✓</Btn>
                <Btn variant="ghost" onClick={() => setEditingCat(null)} style={{ padding: "3px 8px", fontSize: 12 }}>✕</Btn>
              </>
            ) : (
              <>
                <span style={{ flex: 1, color: C.priL, fontSize: 13 }}>{c}</span>
                <Btn variant="ghost" onClick={() => { setEditingCat(c); setEditingCatName(c); }} style={{ padding: "3px 8px", fontSize: 11 }}>✏️</Btn>
                <Btn variant="ghost" onClick={() => { if (window.confirm(`למחוק את הסיווג "${c}"?`)) removeCustomCat(c); }} style={{ padding: "3px 8px", fontSize: 11, color: C.red }}>🗑️</Btn>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${C.bdr}`, paddingTop: 12 }}>
        <div style={{ color: C.dim, fontSize: 12, marginBottom: 6 }}>הוספת סיווג חדש:</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newCatName} onChange={e => setNewCatName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { if (addCustomCat(newCatName)) setNewCatName(""); else alert("שם קיים או ריק"); } }} placeholder="לדוגמה: ציוד משרדי" style={{ flex: 1, padding: "8px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 14, outline: "none" }} />
          <Btn variant="primary" onClick={() => { if (addCustomCat(newCatName)) setNewCatName(""); else alert("שם קיים או ריק"); }}>➕ הוסף</Btn>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}><Btn variant="ghost" onClick={() => { setShowAddCat(false); setEditingCat(null); }}>סגור</Btn></div>
    </Modal>

    {noExpenses ? <Card style={{ textAlign: "center", padding: 40 }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
      <div style={{ color: C.dim, fontSize: 14, marginBottom: 8 }}>גיליון הוצאות עדיין לא מחובר</div>
      <div style={{ color: C.mut, fontSize: 12 }}>כשתוסיף את גיליון "הוצאות כולל" ל-Sheets, הנתונים יופיעו כאן</div>
    </Card> : <>
      <FB><ViewFilter /></FB>
      {view === "monthly" ? <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
          {(() => {
            const chTotal = chSal.reduce((s, c) => s + c.totalWithVat, 0);
            const clTotal = clSal.reduce((s, c) => s + c.entWithVat, 0);
            const grandTotal = total + chTotal + clTotal;
            return <Card style={{ flex: 1, minWidth: 200, padding: "14px 18px" }}>
              <div style={{ color: C.dim, fontSize: 12, marginBottom: 4 }}>💳 סה״כ הוצאות — {MONTHS_HE[month]}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.red, marginBottom: 8 }}>{fmtC(grandTotal)}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.dim }}>
                  <span>💳 הוצאות סוכנות</span>
                  <span style={{ color: C.txt, fontWeight: 600 }}>{fmtC(total)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.dim }}>
                  <span>👥 שכר צ'אטרים</span>
                  <span style={{ color: C.txt, fontWeight: 600 }}>{fmtC(chTotal)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.dim }}>
                  <span>👩 שכר לקוחות</span>
                  <span style={{ color: C.txt, fontWeight: 600 }}>{fmtC(clTotal)}</span>
                </div>
              </div>
            </Card>;
          })()}
          {catBd.length > 0 && <Card style={{ flex: 2, minWidth: 300, display: "flex", alignItems: "center" }}>
            <div style={{ width: "100%", direction: "ltr" }}>
              <ResponsiveContainer width="100%" height={80}>
                <BarChart data={catBd.map(([k, v]) => ({ name: k, value: v }))} layout="vertical" margin={{ top: 0, right: 150, bottom: 0, left: 20 }}>
                  <XAxis type="number" hide reversed={true} />
                  <YAxis type="category" dataKey="name" orientation="right" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="value" fill={C.priL} radius={[0, 4, 4, 0]} name="סה״כ סיווג"><LabelList dataKey="value" position="insideLeft" formatter={v => `₪${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} /></Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>}
        </div>
        <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>✍️ הוצאות ידניות ({MONTHS_HE[month]})</h3>
          <DT columns={[{ label: "תאריך", render: r => fmtD(r.date) }, { label: "ספק/סיבה", key: "category" }, { label: "פירוט", render: r => <span>{r.name}{r.installmentTotal > 0 && <span style={{ marginRight: 6, fontSize: 10, background: `${C.ylw}33`, color: C.ylw, border: `1px solid ${C.ylw}55`, borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>💳 {r.installmentCurrent}/{r.installmentTotal}</span>}</span> }, { label: "סהכ", render: r => <strong style={{ color: C.red }}>{fmtC(r.amount)}</strong> }, { label: "תשלום", key: "paidBy" }, { label: "פעולות", render: r => <div style={{ display: "flex", gap: 4 }}><Btn size="sm" variant="ghost" onClick={() => setEditExp(r)}>✏️</Btn><Btn size="sm" variant="ghost" onClick={() => setDelExp(r)} style={{ color: C.red }}>🗑️</Btn></div> }]} rows={data.filter(e => e.source === "ידני").sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || ""))} footer={["סה״כ", "", "", fmtC(data.filter(e => e.source === "ידני").reduce((s, e) => s + e.amount, 0)), "", ""]} />
        </div>
        <Modal open={!!popCat} onClose={() => setPopCat(null)} title={`📂 ${popCat}`}>{data.filter(e => e.category === popCat).sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || "")).map(e => <div key={e.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.bdr}` }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}><div style={{ flex: 1 }}><div style={{ fontWeight: 600, color: C.txt, fontSize: 13 }}>{e.name}</div><div style={{ fontSize: 10, color: C.mut, marginTop: 3 }}>{fmtD(e.date)} {e.hour && `• ${e.hour}`} • {e.paidBy} • {e.source === "אוטומטי" ? "🤖" : "✍️"} {e.source}</div></div><div style={{ textAlign: "left" }}><div style={{ fontSize: 15, fontWeight: 700, color: C.red, marginBottom: 4 }}>{fmtC(e.amount)}</div>{e.source === "ידני" && <div style={{ display: "flex", gap: 4 }}><Btn size="sm" variant="ghost" onClick={() => { setEditExp(e); setPopCat(null); }}>✏️</Btn><Btn size="sm" variant="ghost" onClick={() => setDelExp(e)} style={{ color: C.red }}>🗑️</Btn></div>}</div></div></div>)}</Modal>
        <Modal open={!!delExp} onClose={() => setDelExp(null)} title="🗑️ מחיקה" width={360}><p style={{ color: C.dim, fontSize: 13, marginBottom: 16 }}>למחוק "{delExp?.name}" ({fmtC(delExp?.amount)})?</p><div style={{ display: "flex", gap: 8 }}><Btn variant="danger" onClick={() => handleDelete(delExp)}>כן</Btn><Btn variant="ghost" onClick={() => setDelExp(null)}>לא</Btn></div></Modal>
      </> : <>
        <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={220}><BarChart data={MONTHS_HE.map((m, i) => ({ name: MONTHS_SHORT[i], value: data.filter(e => e.date && e.date.getMonth() === i).reduce((s, e) => s + e.amount, 0) }))}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.red} radius={[4, 4, 0, 0]} name="הוצאות" /></BarChart></ResponsiveContainer></Card>
        <DT columns={[{ label: "קטגוריה", key: "category" }, ...MONTHS_HE.map((m, i) => ({ label: MONTHS_SHORT[i], render: r => r[`m${i}`] ? fmtC(r[`m${i}`]) : "—" })), { label: "סה״כ", render: r => <strong style={{ color: C.red }}>{fmtC(r.total)}</strong> }]} rows={mByCat} footer={["סה״כ", ...MONTHS_HE.map((_, i) => fmtC(mByCat.reduce((s, r) => s + (r[`m${i}`] || 0), 0))), fmtC(total)]} />
      </>}
      <div style={{ marginTop: 28, overflowX: "auto" }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>🧾 כל החשבוניות</h3>
        <div style={{ fontSize: 11, whiteSpace: "nowrap" }}>
          <DT textSm columns={[{ label: "תאריך", render: r => fmtD(r.date) }, { label: "סוג", key: "docType" }, { label: "ספק/סיבה", key: "category", wrap: true, tdStyle: { maxWidth: 100 } }, { label: "פירוט", render: r => <span>{r.name}{r.installmentTotal > 0 && <span style={{ marginRight: 6, fontSize: 10, background: `${C.ylw}33`, color: C.ylw, border: `1px solid ${C.ylw}55`, borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>💳 {r.installmentCurrent}/{r.installmentTotal}</span>}</span>, wrap: true, tdStyle: { minWidth: 100, maxWidth: 280 } }, { label: "סהכ", render: r => <strong style={{ color: C.red }}>{fmtC(r.amount)}</strong> }, { label: "מעמ", render: r => <button onClick={() => updField(r, "vatRecognized", !r.vatRecognized)} style={{ background: r.vatRecognized ? `${C.grn}22` : `${C.red}22`, color: r.vatRecognized ? C.grn : C.red, border: `1px solid ${r.vatRecognized ? C.grn : C.red}44`, borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>{r.vatRecognized ? "כן" : "לא"}</button> }, { label: "מס", render: r => <button onClick={() => updField(r, "taxRecognized", !r.taxRecognized)} style={{ background: r.taxRecognized ? `${C.grn}22` : `${C.red}22`, color: r.taxRecognized ? C.grn : C.red, border: `1px solid ${r.taxRecognized ? C.grn : C.red}44`, borderRadius: 4, padding: "2px 6px", fontSize: 10, cursor: "pointer", fontWeight: 600 }}>{r.taxRecognized ? "כן" : "לא"}</button> }, { label: "תשלום", key: "paidBy" }, { label: "מזהה", key: "hour", wrap: true, tdStyle: { maxWidth: 100 } }, { label: "מסמך", render: r => r.receiptImage ? <a href={r.receiptImage} target="_blank" rel="noreferrer" style={{ color: C.pri, fontWeight: "bold" }}>5</a> : "" }, { label: "סיווג הוצאה", render: r => <select value={allCats.includes(r.classification) ? r.classification : ""} onChange={e => { if (e.target.value) updCat(r, e.target.value); }} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "6px 4px", fontSize: 11, outline: "none", width: "100%", cursor: "pointer" }}><option value="">{r.classification || "בחר סיווג..."}</option>{allCats.filter(c => c !== r.classification).map(c => <option key={c} value={c}>{c}</option>)}</select>, tdStyle: { minWidth: 120 } }, { label: "פעולות", render: r => <div style={{ display: "flex", gap: 4 }}><Btn size="sm" variant="ghost" onClick={() => setEditExp(r)} style={{ color: C.pri }}>✏️</Btn><Btn size="sm" variant="ghost" onClick={() => setDelExp(r)} style={{ color: C.red }}>🗑️</Btn></div> }]} rows={data.filter(e => e.source !== "ידני").sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || ""))} footer={["סה״כ", "", "", "", fmtC(data.filter(e => e.source !== "ידני").reduce((s, e) => s + e.amount, 0)), "", "", "", "", "", "", ""]} />
        </div>
      </div>
      <div style={{ marginTop: 28 }}>
        <h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>⚖️ קיזוז דור / יוראי / סוכנות</h3>
        <Card>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: off.transfers.length > 0 ? 16 : 0 }}>
            {[{ label: "דור", val: off.dor, net: off.netDor }, { label: "יוראי", val: off.yurai, net: off.netYurai }, { label: "סוכנות", val: off.agency, net: off.netAgency }].map(({ label, val, net }) => (
              <div key={label}>
                <div style={{ color: C.dim, fontSize: 11, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.txt }}>{fmtC(val)}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: net > 0.5 ? C.grn : net < -0.5 ? C.red : C.mut }}>
                  {net > 0.5 ? `+${fmtC(net)} (מגיע)` : net < -0.5 ? `${fmtC(net)} (חייב)` : "מאוזן"}
                </div>
              </div>
            ))}
          </div>
          {off.transfers.length > 0 && <div style={{ borderTop: `1px solid ${C.bdr}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ color: C.dim, fontSize: 11, marginBottom: 4 }}>העברות לאיזון:</div>
            {off.transfers.map((t, i) => (
              <div key={i} style={{ fontSize: 13, fontWeight: 700, color: C.ylw }}>{t.from} → {t.to}: {fmtC(t.amt)}</div>
            ))}
          </div>}
        </Card>
      </div>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>👥 שכר צ'אטרים</h3><DT columns={[{ label: "צ'אטר", key: "name" }, { label: "סוג שכר", render: r => SALARY_TYPE_LABELS[r.salaryType] || "מכירות" }, { label: "משרד", render: r => `${fmtC(r.oSal)} (${r.officePct ?? 17}%)` }, { label: "חוץ", render: r => `${fmtC(r.rSal)} (${r.fieldPct ?? 15}%)` }, { label: "שעתי", render: r => r.salaryType !== "sales" ? fmtC(r.hourlySalary) : "—" }, { label: "סה״כ", render: r => r.hasVat ? <div><div style={{ fontSize: 11, color: C.dim }}>שכר: {fmtC(r.total)}</div><div style={{ fontSize: 11, color: C.ylw }}>מע״מ 18%: {fmtC(r.vatAmt)}</div><strong style={{ color: C.pri }}>{fmtC(r.totalWithVat)}</strong></div> : <strong style={{ color: C.pri }}>{fmtC(r.total)}</strong> }]} rows={chSal} footer={["סה״כ", "", "", "", "", fmtC(chSal.reduce((s, c) => s + c.totalWithVat, 0))]} /></div>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>👩 שכר לקוחות</h3><DT columns={[{ label: "לקוחה", key: "name" }, { label: "הכנסות", render: r => fmtC(r.totalIncome) }, { label: "%", render: r => `${r.pct}%` }, { label: "זכאות", render: r => r.hasVat ? <div><div style={{ fontSize: 11, color: C.dim }}>שכר: {fmtC(r.ent)}</div><div style={{ fontSize: 11, color: C.ylw }}>מע״מ 18%: {fmtC(r.vatAmt)}</div><strong style={{ color: C.pri }}>{fmtC(r.entWithVat)}</strong></div> : fmtC(r.ent) }, { label: "נכנס אליה", render: r => fmtC(r.direct) }, { label: "יתרה", render: r => <span style={{ color: r.bal >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(r.bal)}</span> }]} rows={clSal} footer={["סה״כ", "", "", fmtC(clSal.reduce((s, c) => s + c.entWithVat, 0)), "", ""]} /></div>
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: CHATTERS
// ═══════════════════════════════════════════════════════
const SALARY_TYPE_LABELS = { sales: "מכירות בלבד", hourly: "שעתי בלבד", both: "שעתי + מכירות" };

function ChatterPage({ forceSel, onBack } = {}) {
  const { year, month, setMonth, view, setView, chatterSettings, saveChatterSetting, user, chatterTargets } = useApp();
  const isSM = user?.role === "shift_manager";
  const { iM, iY, iRange, chatters } = useFD();
  const [sel, setSel] = useState(forceSel || "");
  const [editSettings, setEditSettings] = useState(false);
  const [editHours, setEditHours] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ salaryType: "sales", officePct: 17, fieldPct: 15, hourlyRate: 0 });
  const [hoursVal, setHoursVal] = useState("");
  const [saving, setSaving] = useState(false);

  const incD = view === "range" ? iRange : view === "monthly" ? iM : iY;
  const sortedChatters = useMemo(() => {
    const ymi0 = ym(year, month);
    return [...chatters].sort((a, b) => {
      const aRows = incD.filter(r => r.chatterName === a);
      const bRows = incD.filter(r => r.chatterName === b);
      const aProfit = aRows.reduce((s, r) => s + r.amountILS, 0) - Calc.chatterSalary(aRows, chatterSettings[a] || {}, ymi0).total;
      const bProfit = bRows.reduce((s, r) => s + r.amountILS, 0) - Calc.chatterSalary(bRows, chatterSettings[b] || {}, ymi0).total;
      return bProfit - aProfit;
    });
  }, [chatters, incD, chatterSettings, year, month]);

  useEffect(() => { if (sortedChatters.length && !sel) setSel(sortedChatters[0]); }, [sortedChatters, sel]);

  const vatChatter = (chatterSettings[sel] || {}).vatChatter ?? false;

  const ymi = ym(year, month);
  const cfg = chatterSettings[sel] || {};
  const effectivePcts = getMonthlyPcts(cfg, ymi);
  const hasMonthlyOverride = !!(cfg.monthlyPcts?.[ymi]);
  const rows = incD.filter(r => r.chatterName === sel);
  const approvedRows = rows.filter(r => isVerified(r.verified));
  const pendingRows = rows.filter(r => !isVerified(r.verified));
  const totalApproved = approvedRows.reduce((s, r) => s + r.amountILS, 0);
  const totalPending = pendingRows.reduce((s, r) => s + r.amountILS, 0);
  const sal = Calc.chatterSalary(approvedRows, cfg, ymi);
  const tot = approvedRows.reduce((s, r) => s + r.amountILS, 0);

  const byCl = useMemo(() => { const m = {}; approvedRows.forEach(r => { m[r.modelName] = (m[r.modelName] || 0) + r.amountILS; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [approvedRows]);
  const byType = useMemo(() => { const m = {}; approvedRows.forEach(r => { if (r.incomeType) { m[r.incomeType] = (m[r.incomeType] || 0) + r.amountILS; } }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [approvedRows]);
  const mbd = useMemo(() => {
    if (view !== "yearly") return [];
    return MONTHS_HE.map((m, i) => {
      const ymiI = ym(year, i);
      const mr = iY.filter(r => r.chatterName === sel && r.date && r.date.getMonth() === i && isVerified(r.verified));
      const s = Calc.chatterSalary(mr, cfg, ymiI);
      return { month: m, ms: MONTHS_SHORT[i], sales: mr.reduce((sum, r) => sum + r.amountILS, 0), ...s };
    });
  }, [iY, sel, view, cfg, year]);

  const openSettings = () => {
    setSettingsForm({ salaryType: effectivePcts.salaryType ?? "sales", officePct: effectivePcts.officePct ?? 17, fieldPct: effectivePcts.fieldPct ?? 15, hourlyRate: effectivePcts.hourlyRate ?? 0 });
    setEditSettings(true);
  };
  const saveSettings = async () => {
    setSaving(true);
    await saveChatterSetting(sel, { monthlyPcts: { ...(cfg.monthlyPcts || {}), [ymi]: settingsForm } });
    setSaving(false);
    setEditSettings(false);
  };
  useEffect(() => { setHoursVal(String(cfg.monthlyHours?.[ymi] ?? "")); }, [sel, ymi]);
  const openHours = () => { setHoursVal(String(cfg.monthlyHours?.[ymi] ?? "")); setEditHours(true); };
  const saveHours = async () => {
    setSaving(true);
    await saveChatterSetting(sel, { monthlyHours: { ...(cfg.monthlyHours || {}), [ymi]: +hoursVal || 0 } });
    setSaving(false);
    setEditHours(false);
  };

  const inpS = { width: "100%", padding: "10px 12px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 14, outline: "none", boxSizing: "border-box" };

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>👥 צ'אטרים{sel ? ` — ${sel}` : ""}</h2>
    <FB><ViewFilter extraBefore={<Sel label="צ'אטר:" value={sel} onChange={v => { if (v === "__overview__" && onBack) { onBack(); } else { setSel(v); } }} options={[...(onBack ? [{ value: "__overview__", label: "סקירה כללית" }] : []), ...sortedChatters.map(c => ({ value: c, label: c }))]} />} /></FB>
    {!sel ? <p style={{ color: C.mut }}>בחר צ'אטר</p> : (view === "monthly" || view === "range") ? <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon="✅" title="מאושרות" value={fmtC(totalApproved)} sub={`${approvedRows.length} עסקאות`} color={C.grn} />
        {totalPending > 0 && <Stat icon="⏳" title="ממתינות" value={fmtC(totalPending)} sub={`${pendingRows.length} עסקאות`} color={C.ylw} />}
        <Stat icon="💰" title="סה״כ" value={fmtC(tot)} color={C.pri} sub={`${approvedRows.length} עסקאות`} />
        <Stat icon="🏢" title="משרד" value={fmtC(sal.oSales)} sub={isSM ? `${approvedRows.filter(r => r.shiftLocation === "משרד").length} עסקאות` : `שכר ${sal.officePct ?? 17}%: ${fmtC(sal.oSal)}`} />
        <Stat icon="🏠" title="חוץ" value={fmtC(sal.rSales)} sub={isSM ? `${approvedRows.filter(r => r.shiftLocation !== "משרד").length} עסקאות` : `שכר ${sal.fieldPct ?? 15}%: ${fmtC(sal.rSal)}`} />
        {!isSM && sal.salaryType !== "sales" && <Stat icon="⏱️" title="שעתי" value={fmtC(sal.hourlySalary)} sub={`${sal.hours} שעות × ₪${sal.hourlyRate}`} />}
        {!isSM && <Stat icon="💵" title="משכורת" value={fmtC(sal.total)} color={C.pri} sub={SALARY_TYPE_LABELS[sal.salaryType] || "מכירות"} />}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>מכירות לפי לקוחה</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={Math.max(180, byCl.length * 30)}><BarChart data={byCl} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.pri} radius={[4, 0, 0, 4]} name="מכירות"><LabelList dataKey="value" position="insideLeft" formatter={v => `₪${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} /></Bar></BarChart></ResponsiveContainer></div></Card>
        {byType.length > 0 && <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>מכירות לפי סוג הכנסה</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={Math.max(180, byType.length * 30)}><BarChart data={byType} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.priL} radius={[4, 0, 0, 4]} name="מכירות"><LabelList dataKey="value" position="insideLeft" formatter={v => `₪${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} /></Bar></BarChart></ResponsiveContainer></div></Card>}
      </div>

      {/* Targets section for shift manager */}
      {isSM && sel && (() => {
        const customT = chatterTargets[sel];
        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear = month === 0 ? year - 1 : year;
        const lastMonthIncome = iY.filter(r => r.chatterName === sel && r.date && r.date.getFullYear() === prevYear && r.date.getMonth() === prevMonth);
        const lastMonthTotal = lastMonthIncome.reduce((s, r) => s + r.amountILS, 0);
        const currentTotal = approvedRows.reduce((s, r) => s + r.amountILS, 0);
        const autoTargets = [
          { label: "יעד 5%", val: Math.round(lastMonthTotal * 1.05), color: "#22c55e", pct: 5 },
          { label: "יעד 10%", val: Math.round(lastMonthTotal * 1.10), color: "#f59e0b", pct: 10 },
          { label: "יעד 15%", val: Math.round(lastMonthTotal * 1.15), color: "#ef4444", pct: 15 },
        ];
        const targets = customT
          ? [{ label: "יעד 1", val: customT.t1, color: "#22c55e" }, { label: "יעד 2", val: customT.t2, color: "#f59e0b" }, { label: "יעד 3", val: customT.t3, color: "#ef4444" }]
          : autoTargets;
        const targetsWithProgress = targets.map(t => {
          const goal = t.val;
          const progress = goal > 0 ? Math.min(Math.round((currentTotal / goal) * 100), 100) : 0;
          return { ...t, goal, progress };
        });
        return <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, margin: 0 }}>🎯 יעדים — {sel}</h3>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.dim }}>
              <span>📅 סה"כ חודש קודם: <strong style={{ color: C.priL }}>{fmtC(lastMonthTotal)}</strong></span>
            </div>
          </div>
          {lastMonthTotal === 0 && !customT ? (
            <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: 16 }}>אין נתונים מחודש קודם לחישוב יעדים</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {targetsWithProgress.map((t, i) => (
                <div key={i}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: t.color }}>{t.label}</span>
                      {t.pct && <span style={{ fontSize: 11, color: C.dim }}>+{t.pct}% מחודש קודם</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.txt }}>{fmtC(currentTotal)}</span>
                      <span style={{ fontSize: 11, color: C.dim }}>/</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: t.color }}>{fmtC(t.goal)}</span>
                    </div>
                  </div>
                  <div style={{ background: C.bg, borderRadius: 8, height: 28, overflow: "hidden", position: "relative", border: `1px solid ${C.bdr}` }}>
                    <div style={{ height: "100%", borderRadius: 8, background: `linear-gradient(90deg, ${t.color}44, ${t.color})`, width: `${t.progress}%`, transition: "width 0.5s ease-in-out", minWidth: t.progress > 0 ? 20 : 0 }} />
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: t.progress >= 50 ? "#fff" : C.txt }}>
                      {t.progress}%{t.progress >= 100 && " 🎉"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>;
      })()}

      {/* Salary + Reconciliation combined */}
      {!isSM && (() => {
        const paidDirect = rows.filter(r => (r.paymentTarget || (r.paidToClient ? "client" : "agency")) === "chatter").reduce((s, r) => s + r.amountILS, 0);
        const balance = sal.total - paidDirect;
        const vatAmt = Math.abs(balance) * 0.18;
        const finalBalance = Math.abs(balance) * (vatChatter ? 1.18 : 1);
        return <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, position: "relative", zIndex: 2 }}>
            <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, margin: 0 }}>💵 שכר צ'אטר — {MONTHS_HE[month]}</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant={vatChatter ? "warning" : "ghost"} size="sm" onClick={async () => { await saveChatterSetting(sel, { vatChatter: !vatChatter }); }}>🧾 {vatChatter ? "מע״מ 18% ✓" : "משלם מע״מ"}</Btn>
              <Btn variant="ghost" size="sm" onClick={openSettings}>✏️ ערוך הגדרות</Btn>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${C.bdr}` }}>
            <Stat icon="📋" title="סוג שכר" value={SALARY_TYPE_LABELS[effectivePcts.salaryType || "sales"]} sub={hasMonthlyOverride ? `✎ ${MONTHS_HE[month]}` : "ברירת מחדל"} />
            <Stat icon="🏢" title="משרד" value={`${effectivePcts.officePct ?? 17}%`} sub={hasMonthlyOverride ? `✎ ${MONTHS_HE[month]}` : "ברירת מחדל"} />
            <Stat icon="🏠" title="חוץ" value={`${effectivePcts.fieldPct ?? 15}%`} sub={hasMonthlyOverride ? `✎ ${MONTHS_HE[month]}` : "ברירת מחדל"} />
            {sal.salaryType !== "sales" && <Stat icon="⏰" title="שכר לשעה" value={`₪${effectivePcts.hourlyRate ?? 0}`} />}
            <Card style={{ flex: 1, minWidth: 140 }}>
              <div style={{ color: C.dim, fontSize: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 16 }}>⏱️</span>שעות עבודה — {MONTHS_HE[month]}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="number" min="0" value={hoursVal}
                  onChange={e => setHoursVal(e.target.value)}
                  style={{ flex: 1, padding: "8px 12px", background: "#1e293b", border: `2px solid ${C.bdr}`, borderRadius: 8, color: "#f1f5f9", fontSize: 26, fontWeight: 700, outline: "none", textAlign: "center", minWidth: 0 }}
                />
                <button type="button" onClick={saveHours} disabled={saving} style={{ padding: "8px 14px", background: C.grn, border: "none", borderRadius: 8, color: "#fff", fontSize: 18, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "..." : "✓"}</button>
              </div>
            </Card>
            {(() => {
              const hours = parseFloat(hoursVal) || 0;
              const netProfit = tot - sal.total;
              const profitPerHour = hours > 0 ? netProfit / hours : null;
              const roiColor = netProfit >= 0 ? C.grn : C.red;
              return <>
                <Card style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ color: C.dim, fontSize: 12, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 16 }}>📊</span>רווח נקי לעסק</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: roiColor }}>{fmtC(netProfit)}</div>
                  <div style={{ color: C.mut, fontSize: 11, marginTop: 4 }}>הכנסות פחות שכר</div>
                </Card>
                <Card style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ color: C.dim, fontSize: 12, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 16 }}>⚡</span>רווח לשעת עבודה</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: hours > 0 ? (profitPerHour >= 0 ? C.pri : C.red) : C.mut }}>{hours > 0 ? fmtC(Math.round(profitPerHour)) : "—"}</div>
                  {hours > 0 && <div style={{ color: C.mut, fontSize: 11, marginTop: 4 }}>מכירות: {fmtC(Math.round(tot / hours))}/שעה</div>}
                  {hours === 0 && <div style={{ color: C.mut, fontSize: 11, marginTop: 4 }}>הזן שעות לחישוב</div>}
                </Card>
              </>;
            })()}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Stat icon="💵" title="שכר מגיע לצ'אטר" value={fmtC(sal.total)} color={C.pri} />
            <Stat icon="✅" title="שולם ישירות לצ'אטר" value={fmtC(paidDirect)} color={C.grn} />
            {vatChatter ? <>
              <Stat icon={balance > 0 ? "🔴" : balance < 0 ? "🟢" : "⚪"} title={balance > 0 ? "יתרה לפני מע״מ" : balance < 0 ? "יתרה לפני מע״מ" : "מאוזן"} value={fmtC(Math.abs(balance))} color={balance > 0 ? C.red : balance < 0 ? C.grn : C.mut} />
              <Stat icon="🧾" title="מע״מ 18%" value={fmtC(vatAmt)} color={C.ylw} />
              <Stat icon={balance > 0 ? "🔴" : balance < 0 ? "🟢" : "⚪"} title={balance > 0 ? "סה״כ לתשלום לו (כולל מע״מ)" : balance < 0 ? "סה״כ לתשלום לנו (כולל מע״מ)" : "מאוזן"} value={fmtC(finalBalance)} color={balance > 0 ? C.red : balance < 0 ? C.grn : C.mut} />
            </> : <Stat icon={balance > 0 ? "🔴" : balance < 0 ? "🟢" : "⚪"} title={balance > 0 ? "אנחנו חייבים לו" : balance < 0 ? "הוא חייב לנו" : "מאוזן"} value={fmtC(finalBalance)} color={balance > 0 ? C.red : balance < 0 ? C.grn : C.mut} />}
          </div>
        </Card>;
      })()}
      <DT columns={[{ label: "תאריך", render: renderDateHour }, { label: "סוג הכנסה", key: "incomeType" }, { label: "שם קונה", render: r => r.buyerName || "—" }, { label: "צ'אטר", key: "chatterName" }, { label: "דוגמנית", key: "modelName" }, { label: "פלטפורמה", key: "platform" }, { label: "מיקום", key: "shiftLocation" }, { label: "לפני עמלה ($)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtUSD(r.preCommissionUSD)}</span> : "" }, { label: "לפני עמלה (₪)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtC(r.preCommissionILS)}</span> : "" }, { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> }, { label: "סכום ₪", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.amountILS)}</span> }]} rows={rows.sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || ""))} footer={["סה״כ", "", "", "", "", "", "", "", "", fmtUSD(rows.reduce((s, r) => s + (r.amountUSD || 0), 0)), fmtC(tot)]} />

      {/* Edit settings modal */}
      {!isSM && <Modal open={editSettings} onClose={() => setEditSettings(false)} title={`⚙️ הגדרות שכר — ${sel} — ${MONTHS_HE[month]} ${year}`} width={400}>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 6 }}>סוג שכר</label>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(SALARY_TYPE_LABELS).map(([k, v]) => (
                <Btn key={k} variant={settingsForm.salaryType === k ? "primary" : "ghost"} size="sm" onClick={() => setSettingsForm(f => ({ ...f, salaryType: k }))}>{v}</Btn>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>% משרד (ברירת מחדל 17)</label>
              <input type="number" min="0" max="100" value={settingsForm.officePct} onChange={e => setSettingsForm(f => ({ ...f, officePct: +e.target.value }))} style={inpS} />
            </div>
            <div>
              <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>% חוץ (ברירת מחדל 15)</label>
              <input type="number" min="0" max="100" value={settingsForm.fieldPct} onChange={e => setSettingsForm(f => ({ ...f, fieldPct: +e.target.value }))} style={inpS} />
            </div>
          </div>
          {settingsForm.salaryType !== "sales" && <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שכר לשעה (₪)</label>
            <input type="number" min="0" value={settingsForm.hourlyRate} onChange={e => setSettingsForm(f => ({ ...f, hourlyRate: +e.target.value }))} style={inpS} />
          </div>}
          <div style={{ padding: "8px 10px", background: `${C.pri}15`, borderRadius: 8, fontSize: 11, color: C.dim }}>
            ℹ️ ההגדרות ישמרו עבור <strong style={{ color: C.priL }}>{MONTHS_HE[month]} {year}</strong> בלבד. חודשים חדשים יורשים את ההגדרות של החודש הקרוב ביותר שהוגדר.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <Btn variant="success" onClick={saveSettings} disabled={saving}>{saving ? "שומר..." : "💾 שמור"}</Btn>
            <Btn variant="ghost" onClick={() => setEditSettings(false)}>ביטול</Btn>
          </div>
        </div>
      </Modal>}

      {/* Edit hours modal */}
      {!isSM && <Modal open={editHours} onClose={() => setEditHours(false)} title={`⏱️ שעות — ${sel} — ${MONTHS_HE[month]}`} width={320}>
        <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 6 }}>מספר שעות עבודה החודש</label>
        <input type="number" min="0" value={hoursVal} onChange={e => setHoursVal(e.target.value)} style={{ ...inpS, fontSize: 22, marginBottom: 14 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="success" onClick={saveHours} disabled={saving}>{saving ? "שומר..." : "💾 שמור"}</Btn>
          <Btn variant="ghost" onClick={() => setEditHours(false)}>ביטול</Btn>
        </div>
      </Modal>}

    </> : <>
      <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={220}><ComposedChart data={mbd}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="sales" fill={C.pri} radius={[4, 4, 0, 0]} name="מכירות" />{!isSM && <Line type="monotone" dataKey="total" stroke={C.ylw} strokeWidth={2} dot={{ r: 3 }} name="משכורת" />}</ComposedChart></ResponsiveContainer></Card>
      <DT columns={[{ label: "חודש", key: "month" }, { label: "מכירות", render: r => fmtC(r.sales) }, { label: "משרד", render: r => fmtC(r.oSales) }, { label: "חוץ", render: r => fmtC(r.rSales) }, ...(isSM ? [] : [{ label: "שכר", render: r => <strong style={{ color: C.pri }}>{fmtC(r.total)}</strong> }])]} rows={mbd} footer={isSM ? ["סה״כ", fmtC(mbd.reduce((s, r) => s + r.sales, 0)), "", ""] : ["סה״כ", fmtC(mbd.reduce((s, r) => s + r.sales, 0)), "", "", fmtC(mbd.reduce((s, r) => s + r.total, 0))]} />
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: CHATTERS OVERVIEW + HUB
// ═══════════════════════════════════════════════════════
function InlinePctInput({ value, onSave }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type="number" min="0" max="100" value={v}
    onChange={e => setV(+e.target.value)}
    onBlur={() => { if (v !== value) onSave(v); }}
    onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
    style={{ width: 54, padding: "4px 6px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 4, color: C.txt, fontSize: 12, outline: "none", textAlign: "center" }} />;
}
const ENTITY_COLORS = ['#6366f1', '#22c55e', '#f97316', '#eab308', '#8b5cf6', '#06b6d4', '#f43f5e', '#84cc16', '#ec4899', '#14b8a6'];

function ChattersOverviewPage({ onSelectChatter }) {
  const { year, month, view, chatterSettings, saveChatterSetting, user } = useApp();
  const isSM = user?.role === "shift_manager";
  const { iM, iY, iRange, chatters } = useFD();
  const incD = view === "range" ? iRange : view === "monthly" ? iM : iY;
  const ymi = ym(year, new Date().getMonth());

  const chatterStats = useMemo(() => {
    return chatters.map(name => {
      const rows = incD.filter(r => r.chatterName === name);
      const cfg = chatterSettings[name] || {};
      const sal = Calc.chatterSalary(rows, cfg, ymi);
      const total = rows.reduce((s, r) => s + r.amountILS, 0);
      const roi = sal.total > 0 ? ((total - sal.total) / sal.total * 100) : 0;
      return { name, total, salary: sal.total, netProfit: total - sal.total, roi, txCount: rows.length };
    }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  }, [incD, chatters, chatterSettings, ymi]);

  const monthlyByChatter = useMemo(() => {
    if (view !== "yearly") return [];
    return MONTHS_SHORT.map((ms, i) => {
      const entry = { ms };
      chatters.forEach(name => {
        const rows = iY.filter(r => r.chatterName === name && r.date?.getMonth() === i);
        entry[name] = rows.reduce((s, r) => s + r.amountILS, 0);
      });
      return entry;
    });
  }, [iY, chatters, view]);

  const totalSales = chatterStats.reduce((s, c) => s + c.total, 0);
  const totalSalary = chatterStats.reduce((s, c) => s + c.salary, 0);

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>👥 סקירת כל הצ'אטרים</h2>
    <FB><ViewFilter extraBefore={<Sel label="צ'אטר:" value="" onChange={v => { if (v) onSelectChatter(v); }} options={[{ value: "", label: "סקירה כללית" }, ...chatterStats.map(c => ({ value: c.name, label: c.name }))]} />} /></FB>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
      <Stat icon="👥" title="מספר צ'אטרים" value={chatterStats.length} />
      <Stat icon="💰" title="סה״כ מכירות" value={fmtC(totalSales)} color={C.grn} />
      {!isSM && <Stat icon="💵" title="סה״כ משכורות" value={fmtC(totalSalary)} color={C.ylw} />}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
      <Card>
        <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📊 מכירות לפי צ'אטר</div>
        <div style={{ direction: "ltr" }}><ResponsiveContainer width="100%" height={Math.max(200, chatterStats.length * 44)}>
          <BarChart data={chatterStats} layout="vertical" margin={{ top: 5, right: 130, bottom: 5, left: 10 }}>
            <XAxis type="number" reversed tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v/1000).toFixed(0)}k`} />
            <YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={120} interval={0} />
            <Tooltip content={<TT />} />
            <Bar dataKey="total" name="מכירות" radius={[4,0,0,4]}>
              {chatterStats.map((_, i) => <Cell key={i} fill={ENTITY_COLORS[i % ENTITY_COLORS.length]} />)}
              <LabelList dataKey="total" position="insideLeft" formatter={v => `₪${v>=1000?(v/1000).toFixed(0)+'k':v}`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer></div>
      </Card>
      {!isSM && <Card>
        <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📊 השוואת ROI לפי צ'אטר</div>
        <div style={{ direction: "ltr" }}><ResponsiveContainer width="100%" height={Math.max(200, chatterStats.length * 44)}>
          <BarChart data={[...chatterStats].sort((a, b) => b.roi - a.roi)} layout="vertical" margin={{ top: 5, right: 130, bottom: 5, left: 10 }}>
            <XAxis type="number" reversed tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `${v.toFixed(0)}%`} />
            <YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={120} interval={0} />
            <Tooltip formatter={v => `${v.toFixed(0)}%`} />
            <Bar dataKey="roi" name="ROI" radius={[4,0,0,4]}>
              {[...chatterStats].sort((a, b) => b.roi - a.roi).map((c, i) => <Cell key={i} fill={c.roi >= 0 ? C.grn : C.red} />)}
              <LabelList dataKey="roi" position="insideLeft" formatter={v => `${v.toFixed(0)}%`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer></div>
      </Card>}
    </div>
    {(() => {
      const hourlyData = (() => {
        const map = {};
        for (let h = 0; h < 24; h++) map[h] = { hour: h };
        incD.forEach(r => {
          let hStr = r.hour;
          if (!hStr) return;
          if (typeof hStr === "string" && hStr.includes("1899-") && hStr.includes("T")) hStr = hStr.split("T")[1].substring(0, 5);
          const hNum = parseInt(hStr, 10);
          if (isNaN(hNum) || hNum < 0 || hNum > 23) return;
          const name = r.chatterName;
          if (!map[hNum][name]) map[hNum][name] = 0;
          map[hNum][name] += r.amountILS;
        });
        return Object.values(map).sort((a, b) => a.hour - b.hour);
      })();
      const activeNames = chatterStats.map(c => c.name);
      return activeNames.length > 0 && <Card style={{ marginBottom: 16 }}>
        <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📈 מכירות לפי שעה ביום</div>
        <div style={{ direction: "ltr" }}><ResponsiveContainer width="100%" height={280}>
          <LineChart data={hourlyData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
            <XAxis dataKey="hour" tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `${v}:00`} />
            <YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => fmtC(v)} />
            <Tooltip formatter={v => fmtC(v)} labelFormatter={v => `שעה ${v}:00`} />
            <Legend />
            {activeNames.map((name, i) => <Line key={name} type="monotone" dataKey={name} stroke={ENTITY_COLORS[i % ENTITY_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />)}
          </LineChart>
        </ResponsiveContainer></div>
      </Card>;
    })()}
    <Card style={{ marginBottom: 16 }}>
      <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📋 סיכום וניהול אחוזים</div>
      <DT columns={[
        { label: "צ'אטר", render: r => <button onClick={() => onSelectChatter(r.name)} style={{ background: "none", border: "none", color: C.pri, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0 }}>{r.name}</button> },
        { label: "מכירות", render: r => <span style={{ color: C.grn, fontWeight: 600 }}>{fmtC(r.total)}</span> },
        ...(isSM ? [] : [
          { label: "% משרד", render: r => <InlinePctInput value={r.officePct} onSave={v => saveChatterSetting(r.name, { officePct: v })} /> },
          { label: "% חוץ", render: r => <InlinePctInput value={r.fieldPct} onSave={v => saveChatterSetting(r.name, { fieldPct: v })} /> },
          { label: "משכורת", render: r => <span style={{ color: C.ylw, fontWeight: 600 }}>{fmtC(r.salary)}</span> },
          { label: "רווח נקי", render: r => <span style={{ color: r.netProfit >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(r.netProfit)}</span> },
        ]),
        { label: "", render: r => <button onClick={() => onSelectChatter(r.name)} style={{ background: "none", border: "none", color: C.pri, cursor: "pointer", fontSize: 12 }}>פרטים ←</button> }
      ]} rows={chatterStats.map(c => ({ ...c, officePct: (chatterSettings[c.name] || {}).officePct ?? 17, fieldPct: (chatterSettings[c.name] || {}).fieldPct ?? 15 }))}
      footer={isSM ? ["סה״כ", fmtC(totalSales), ""] : ["סה״כ", fmtC(totalSales), "", "", fmtC(totalSalary), fmtC(totalSales - totalSalary), ""]} />
    </Card>
  </div>;
}

function ChatterHub() {
  const [sel, setSel] = useState(null);
  if (sel) return <ChatterPage forceSel={sel} onBack={() => setSel(null)} />;
  return <ChattersOverviewPage onSelectChatter={setSel} />;
}

// ═══════════════════════════════════════════════════════
// PAGE: CLIENTS OVERVIEW + HUB
// ═══════════════════════════════════════════════════════
function ClientsOverviewPage({ onSelectClient }) {
  const { year, month, view, rv, updRate, clientSettings, saveClientSetting, chatterSettings } = useApp();
  const { iM, iY, iRange, clients } = useFD();
  const incD = view === "range" ? iRange : view === "monthly" ? iM : iY;
  const ymi = ym(year, month);

  const clientStats = useMemo(() => {
    return clients.map(name => {
      const rows = incD.filter(r => r.modelName === name);
      const total = rows.reduce((s, r) => s + r.amountILS, 0);
      const pct = getRate(name, ymi);
      const bal = Calc.clientBal(incD, name, pct, [], chatterSettings);
      const avgPct = view === "yearly"
        ? (() => { const rates = MONTHS_SHORT.map((_, i) => getRate(name, ym(year, i))).filter(r => r > 0); return rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : pct; })()
        : pct;
      return { name, total, pct, avgPct, entitlement: bal.ent, agencyShare: bal.agencyShare, direct: bal.direct, through: bal.through, balance: bal.actualDue, txCount: rows.length };
    }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  }, [incD, clients, ymi, rv, view, year]);

  const monthlyByClient = useMemo(() => {
    if (view !== "yearly") return [];
    return MONTHS_SHORT.map((ms, i) => {
      const entry = { ms };
      clients.forEach(name => {
        entry[name] = iY.filter(r => r.modelName === name && r.date?.getMonth() === i).reduce((s, r) => s + r.amountILS, 0);
      });
      return entry;
    });
  }, [iY, clients, view]);

  const totalIncome = clientStats.reduce((s, c) => s + c.total, 0);
  const totalEntitlement = clientStats.reduce((s, c) => s + c.entitlement, 0);
  const totalAgencyShare = clientStats.reduce((s, c) => s + c.agencyShare, 0);
  const totalThrough = clientStats.reduce((s, c) => s + c.through, 0);

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>👩 סקירת כל הלקוחות</h2>
    <FB><ViewFilter extraBefore={<Sel label="לקוחה:" value="" onChange={v => { if (v) onSelectClient(v); }} options={[{ value: "", label: "סקירה כללית" }, ...clientStats.map(c => ({ value: c.name, label: c.name }))]} />} /></FB>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
      <Stat icon="👩" title="מספר לקוחות" value={clientStats.length} />
      <Stat icon="💰" title="סה״כ הכנסות" value={fmtC(totalIncome)} color={C.grn} />
      <Stat icon="💵" title="סה״כ זכאות" value={fmtC(totalEntitlement)} color={C.ylw} />
    </div>
    {(() => {
      const hourlyByClient = (() => {
        const map = {};
        for (let h = 0; h < 24; h++) map[h] = { hour: h };
        incD.forEach(r => {
          let hStr = r.hour;
          if (!hStr) return;
          if (typeof hStr === "string" && hStr.includes("1899-") && hStr.includes("T")) hStr = hStr.split("T")[1].substring(0, 5);
          const hNum = parseInt(hStr, 10);
          if (isNaN(hNum) || hNum < 0 || hNum > 23) return;
          const name = r.modelName;
          if (!name) return;
          if (!map[hNum][name]) map[hNum][name] = 0;
          map[hNum][name] += r.amountILS;
        });
        return Object.values(map).sort((a, b) => a.hour - b.hour);
      })();
      const activeClients = clientStats.map(c => c.name);
      return activeClients.length > 0 && <Card style={{ marginBottom: 16 }}>
        <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📈 מכירות לפי שעה ביום</div>
        <div style={{ direction: "ltr" }}><ResponsiveContainer width="100%" height={280}>
          <LineChart data={hourlyByClient} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} />
            <XAxis dataKey="hour" tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `${v}:00`} />
            <YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => fmtC(v)} />
            <Tooltip formatter={v => fmtC(v)} labelFormatter={v => `שעה ${v}:00`} />
            <Legend />
            {activeClients.map((name, i) => <Line key={name} type="monotone" dataKey={name} stroke={ENTITY_COLORS[i % ENTITY_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />)}
          </LineChart>
        </ResponsiveContainer></div>
      </Card>;
    })()}
    {clientStats.length > 0 && <Card style={{ marginBottom: 16 }}>
      <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>🥧 חלוקת הכנסות</div>
      <div style={{ direction: "ltr" }}><ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={clientStats.map(c => ({ name: c.name, value: c.total || 1 }))} cx="50%" cy="50%" outerRadius={85} dataKey="value" label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={11}>
            {clientStats.map((_, i) => <Cell key={i} fill={ENTITY_COLORS[i % ENTITY_COLORS.length]} />)}
          </Pie>
          <Tooltip formatter={v => fmtC(v)} />
        </PieChart>
      </ResponsiveContainer></div>
    </Card>}
    <Card style={{ marginBottom: 16 }}>
      <div style={{ color: C.dim, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📋 סיכום וניהול אחוזים</div>
      <DT columns={[
        { label: "לקוחה", render: r => <button onClick={() => onSelectClient(r.name)} style={{ background: "none", border: "none", color: C.pri, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0 }}>{r.name}</button> },
        { label: "הכנסות", render: r => <span style={{ color: C.grn, fontWeight: 600 }}>{fmtC(r.total)}</span> },
        { label: "% סוכנות", render: r => view === "yearly" ? <span style={{ color: C.dim }}>{r.avgPct.toFixed(1)}%</span> : <InlinePctInput value={r.pct} onSave={v => updRate(r.name, ymi, v)} /> },
        { label: "זכאות סוכנות", render: r => <span style={{ color: C.pri, fontWeight: 600 }}>{fmtC(r.agencyShare)}</span> },
        { label: "זכאות לקוחה", render: r => <span style={{ color: C.ylw, fontWeight: 600 }}>{fmtC(r.entitlement)}</span> },
        { label: "שולם ישירות ללקוחה", render: r => <span style={{ color: C.dim }}>{fmtC(r.direct)}</span> },
        { label: "שולם ישירות אלינו", render: r => <span style={{ color: C.dim }}>{fmtC(r.through)}</span> },
        { label: "יתרה", render: r => <div><span style={{ color: r.balance >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(Math.abs(r.balance))}</span><div style={{ fontSize: 10, color: r.balance >= 0 ? C.grn : C.red }}>{r.balance >= 0 ? "חייבים ללקוחה" : "לקוחה חייבת"}</div></div> },
        { label: "", render: r => <button onClick={() => onSelectClient(r.name)} style={{ background: "none", border: "none", color: C.pri, cursor: "pointer", fontSize: 12 }}>פרטים ←</button> }
      ]} rows={clientStats} footer={["סה״כ", fmtC(totalIncome), "", fmtC(totalAgencyShare), fmtC(totalEntitlement), "", fmtC(totalThrough), "", ""]} />
    </Card>
  </div>;
}

function ClientHub() {
  const [sel, setSel] = useState(null);
  if (sel) return <ClientPage forceSel={sel} onBack={() => setSel(null)} />;
  return <ClientsOverviewPage onSelectClient={setSel} />;
}

// ═══════════════════════════════════════════════════════
// PAGE: CLIENTS
// ═══════════════════════════════════════════════════════
function ClientPage({ forceSel, onBack } = {}) {
  const { year, month, setMonth, view, setView, rv, updRate, setIncome, clientSettings, saveClientSetting, chatterSettings } = useApp(); const { iM, iY, iRange, clients } = useFD();
  const [sel, setSel] = useState(forceSel || ""), [editPct, setEditPct] = useState(false), [pv, setPv] = useState(0);
  const incD = view === "range" ? iRange : view === "monthly" ? iM : iY;
  const sortedClients = useMemo(() => {
    return [...clients].sort((a, b) => {
      const aTotal = incD.filter(r => r.modelName === a).reduce((s, r) => s + r.amountILS, 0);
      const bTotal = incD.filter(r => r.modelName === b).reduce((s, r) => s + r.amountILS, 0);
      return bTotal - aTotal;
    });
  }, [clients, incD]);
  useEffect(() => { if (sortedClients.length && !sel) setSel(sortedClients[0]); }, [sortedClients, sel]);
  const vatClient = (clientSettings[sel] || {}).vatClient ?? false;
  const ymi = ym(year, month), pct = getRate(sel, ymi); const bal = Calc.clientBal(incD, sel, pct, [], chatterSettings); const clientTxCount = incD.filter(r => r.modelName === sel).length;

  const togglePaid = async (r) => {
    try {
      const nr = await IncSvc.togglePaidToClient(r);
      setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
    } catch (e) { alert("שגיאה במערכת: " + e.message); }
  };
  const byCh = useMemo(() => { const m = {}; incD.filter(r => r.modelName === sel).forEach(r => { if (r.chatterName) m[r.chatterName] = (m[r.chatterName] || 0) + r.amountILS; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [incD, sel]);
  const byType = useMemo(() => { const m = {}; incD.filter(r => r.modelName === sel).forEach(r => { if (r.incomeType) m[r.incomeType] = (m[r.incomeType] || 0) + r.amountILS; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [incD, sel]);
  const ybd = useMemo(() => { if (view !== "yearly") return []; return MONTHS_HE.map((m, i) => { const yi = ym(year, i); const p = getRate(sel, yi); const mr = iY.filter(r => r.modelName === sel && r.date && r.date.getMonth() === i); const b = Calc.clientBal(mr, sel, p, [], chatterSettings); return { month: m, ms: MONTHS_SHORT[i], ...b }; }); }, [iY, sel, view, year, rv, chatterSettings]);

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>👩 לקוחות{sel ? ` — ${sel}` : ""}</h2>
    <FB><ViewFilter extraBefore={<Sel label="לקוחה:" value={sel} onChange={v => { if (v === "__overview__" && onBack) { onBack(); } else { setSel(v); } }} options={[...(onBack ? [{ value: "__overview__", label: "סקירה כללית" }] : []), ...sortedClients.map(c => ({ value: c, label: c }))]} />} /></FB>
    {!sel ? <p style={{ color: C.mut }}>בחר לקוחה</p> : (view === "monthly" || view === "range") ? <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}><Stat icon="💰" title="הכנסות" value={fmtC(bal.totalIncome)} color={C.grn} sub={`${clientTxCount} עסקאות`} /><Stat icon="🏢" title="דרך סוכנות" value={fmtC(bal.through)} /><Stat icon="👩" title="ישירות" value={fmtC(bal.direct)} /><Stat icon="💵" title="זכאות (שכר צפוי)" value={fmtC(bal.ent)} color={C.pri} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card><ResponsiveContainer width="100%" height={180}><PieChart><Pie data={[{ name: "סוכנות", value: bal.through || 1 }, { name: "ישירות", value: bal.direct || 1 }]} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={11}><Cell fill={C.pri} /><Cell fill={C.org} /></Pie><Tooltip formatter={v => fmtC(v)} /></PieChart></ResponsiveContainer></Card>
        {byCh.length > 0 && <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>לפי צ'אטר</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={Math.max(180, byCh.length * 30)}><BarChart data={byCh} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.pri} radius={[4, 0, 0, 4]} name="הכנסות"><LabelList dataKey="value" position="insideLeft" formatter={v => `₪${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} /></Bar></BarChart></ResponsiveContainer></div></Card>}
        {byType.length > 0 && <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>לפי סוג הכנסה</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={Math.max(180, byType.length * 30)}><BarChart data={byType} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.priL} radius={[4, 0, 0, 4]} name="הכנסות"><LabelList dataKey="value" position="insideLeft" formatter={v => `₪${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }} /></Bar></BarChart></ResponsiveContainer></div></Card>}
      </div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ color: C.dim, fontSize: 13 }}>💵 משכורת — {MONTHS_HE[month]}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant={vatClient ? "warning" : "ghost"} size="sm" onClick={async () => { await saveClientSetting(sel, { vatClient: !vatClient }); }}>🧾 {vatClient ? "מע״מ 18% ✓" : "משלם מע״מ"}</Btn>
            <Btn variant="ghost" size="sm" onClick={() => { setPv(pct); setEditPct(true); }}>✏️ ערוך אחוז סוכנות</Btn>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(100px,1fr))", gap: 12 }}>
          <div><div style={{ color: C.mut, fontSize: 11 }}>אחוז סוכנות</div><div style={{ fontSize: 22, fontWeight: 700, color: C.pri }}>{pct}%</div></div>
          <div><div style={{ color: C.mut, fontSize: 11 }}>זכאות (שכר)</div><div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{fmtC(bal.ent)}</div></div>
          <div><div style={{ color: C.mut, fontSize: 11 }}>כבר שולם לה</div><div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{fmtC(bal.direct)}</div></div>
          <div style={{ borderRight: `2px solid ${C.bdr}`, paddingRight: 12 }}>
            <div style={{ color: C.dim, fontSize: 11, fontWeight: 700 }}>יתרה לתשלום</div>
            {vatClient && Math.abs(bal.actualDue) >= 1 ? <>
              <div style={{ fontSize: 12, color: C.dim }}>לפני מע״מ: {fmtC(Math.abs(bal.actualDue))}</div>
              <div style={{ fontSize: 12, color: C.ylw }}>מע״מ 18%: {fmtC(Math.abs(bal.actualDue) * 0.18)}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: bal.actualDue >= 0 ? C.grn : C.red }}>{fmtC(Math.abs(bal.actualDue) * 1.18)}</div>
            </> : <div style={{ fontSize: 20, fontWeight: 800, color: bal.actualDue >= 0 ? C.grn : C.red }}>{fmtC(Math.abs(bal.actualDue))}</div>}
            <div style={{ fontSize: 10, color: bal.actualDue >= 0 ? C.grn : C.red }}>{bal.actualDue >= 0 ? "הסוכנות חייבת ללקוחה" : "הלקוחה חייבת לסוכנות"}{vatClient ? " (כולל מע״מ)" : ""}</div>
          </div>
        </div>
      </Card>
      <Modal open={editPct} onClose={() => setEditPct(false)} title={`עריכת אחוז סוכנות — ${sel} — ${MONTHS_HE[month]}`} width={340}><input type="number" min="0" max="100" value={pv} onChange={e => setPv(e.target.value)} style={{ width: "100%", padding: "12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 20, outline: "none", boxSizing: "border-box", marginBottom: 14 }} /><div style={{ display: "flex", gap: 8 }}><Btn variant="success" onClick={() => { updRate(sel, ymi, +pv); setEditPct(false); }}>💾 שמור</Btn><Btn variant="ghost" onClick={() => setEditPct(false)}>ביטול</Btn></div></Modal>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>🧾 עסקאות ({MONTHS_HE[month]})</h3>
        <DT columns={[{ label: "תאריך", render: renderDateHour }, { label: "סוג הכנסה", key: "incomeType" }, { label: "שם קונה", render: r => r.buyerName || "—" }, { label: "צ'אטר", key: "chatterName" }, { label: "דוגמנית", key: "modelName" }, { label: "פלטפורמה", key: "platform" }, { label: "מיקום", key: "shiftLocation" }, { label: "לפני עמלה ($)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtUSD(r.preCommissionUSD)}</span> : "" }, { label: "לפני עמלה (₪)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtC(r.preCommissionILS)}</span> : "" }, { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> }, { label: "סכום ₪", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.amountILS)}</span> }]} rows={incD.filter(r => r.modelName === sel).sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || ""))} footer={["סה״כ", "", "", "", "", "", "", "", "", fmtUSD(incD.filter(r => r.modelName === sel).reduce((s, r) => s + (r.amountUSD || 0), 0)), fmtC(bal.totalIncome)]} /></div>
    </> : <>
      <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={220}><ComposedChart data={ybd}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="totalIncome" fill={C.grn} radius={[4, 4, 0, 0]} name="הכנסות" /><Line type="monotone" dataKey="ent" stroke={C.pri} strokeWidth={2} name="זכאות" /><Line type="monotone" dataKey="bal" stroke={C.ylw} strokeWidth={2} strokeDasharray="5 5" name="יתרה" /></ComposedChart></ResponsiveContainer></Card>
      <DT columns={[{ label: "חודש", key: "month" }, { label: "הכנסות", render: r => fmtC(r.totalIncome) }, { label: "% סוכנות", render: r => `${r.pct}%` }, { label: "זכאות סוכנות", render: r => <span style={{ color: C.pri }}>{fmtC(r.agencyShare)}</span> }, { label: "זכאות לקוחה", render: r => <span style={{ color: C.ylw }}>{fmtC(r.ent)}</span> }, { label: "שולם ישירות ללקוחה", render: r => fmtC(r.direct) }, { label: "שולם ישירות אלינו", render: r => fmtC(r.through) }, { label: "יתרה", render: r => <div><span style={{ color: r.actualDue >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(Math.abs(r.actualDue))}</span><div style={{ fontSize: 10, color: r.actualDue >= 0 ? C.grn : C.red }}>{r.actualDue >= 0 ? "חייבים ללקוחה" : "לקוחה חייבת"}</div></div> }]} rows={ybd} footer={["סה״כ", fmtC(ybd.reduce((s, r) => s + r.totalIncome, 0)), "", fmtC(ybd.reduce((s, r) => s + r.agencyShare, 0)), fmtC(ybd.reduce((s, r) => s + r.ent, 0)), fmtC(ybd.reduce((s, r) => s + r.direct, 0)), fmtC(ybd.reduce((s, r) => s + r.through, 0)), ""]} />
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: TARGETS
// ═══════════════════════════════════════════════════════
function TgtPage() {
  const { year, month, liveRate, chatterTargets, saveChatterTarget } = useApp();
  const { iY } = useFD();
  const [selMonth, setSelMonth] = useState(null);
  const [editTarget, setEditTarget] = useState(null); // { name, t1, t2, t3 }
  const [savingTarget, setSavingTarget] = useState(false);

  const mbd = useMemo(() => {
    let lastDays = 31, lastInc = 0;
    return MONTHS_HE.map((m, i) => {
      const mi = iY.filter(r => r.date.getMonth() === i);
      const inc = mi.reduce((s, r) => s + r.amountILS, 0);
      const daysInMonth = new Date(year, i + 1, 0).getDate();
      const t = Calc.targets(lastInc, lastDays, daysInMonth);
      lastInc = inc; lastDays = daysInMonth;
      return { month: m, idx: i, inc, tgt1: t.t1, tgt2: t.t2, tgt3: t.t3, dailyAvg: t.daily, days: daysInMonth };
    });
  }, [iY, year, liveRate]);

  // Per-entity targets for selected month
  const entityTargets = useMemo(() => {
    if (selMonth === null) return { chatters: [], clients: [] };
    const prevIdx = selMonth - 1;
    const curDays = new Date(year, selMonth + 1, 0).getDate();
    const prevDays = selMonth > 0 ? new Date(year, selMonth, 0).getDate() : 31;

    const buildEntityTargets = (keyFn) => {
      const prevMap = {}, curMap = {};
      iY.forEach(r => {
        const key = keyFn(r);
        if (!key) return;
        const mi = r.date.getMonth();
        if (mi === prevIdx && prevIdx >= 0) prevMap[key] = (prevMap[key] || 0) + r.amountILS;
        if (mi === selMonth) curMap[key] = (curMap[key] || 0) + r.amountILS;
      });
      const allKeys = prevIdx >= 0 ? Object.keys(prevMap).sort() : Object.keys(curMap).sort();
      return allKeys.map(name => {
        const prevInc = prevMap[name] || 0;
        const curInc = curMap[name] || 0;
        const t = Calc.targets(prevInc, prevDays, curDays);
        const isCurrent = selMonth === month;
        const daysPassed = isCurrent ? Math.max(1, new Date().getDate()) : curDays;
        const daily = curInc / daysPassed;
        return { name, prevInc, curInc, daily, daysPassed, ...t, days: curDays };
      }).sort((a, b) => b.curInc - a.curInc);
    };

    return {
      chatters: buildEntityTargets(r => r.chatterName),
      clients: buildEntityTargets(r => r.modelName)
    };
  }, [iY, selMonth, year, month]);

  const renderMiniCards = (title, icon, entities, isChatter = false) => {
    if (!entities.length) return null;
    return <div style={{ marginBottom: 20 }}>
      <h4 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{icon} {title}</h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
        {entities.map(e => {
          const custom = isChatter && chatterTargets[e.name];
          const t1 = custom ? custom.t1 : e.t1;
          const t2 = custom ? custom.t2 : e.t2;
          const t3 = custom ? custom.t3 : e.t3;
          const hit1 = e.curInc >= t1, hit2 = e.curInc >= t2, hit3 = e.curInc >= t3;
          const color = hit3 ? C.grn : hit2 ? C.ylw : hit1 ? C.pri : C.red;
          return <div key={e.name} style={{ background: C.card, borderRadius: 10, padding: "10px 12px", border: `1px solid ${color}44` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.txt }}>{e.name}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color }}>{fmtC(e.daily)} /יום</span>
                {isChatter && <button onClick={() => setEditTarget({ name: e.name, t1: String(Math.round(t1)), t2: String(Math.round(t2)), t3: String(Math.round(t3)) })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.dim, padding: "0 2px", lineHeight: 1 }} title="עריכת יעדים">✏️</button>}
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>
              בפועל: <strong style={{ color: C.txt }}>{fmtC(e.curInc)}</strong>
              {e.prevInc > 0 && <> | חודש קודם: <strong>{fmtC(e.prevInc)}</strong></>}
              {custom && <span style={{ color: C.ylw, marginRight: 4 }}> ✎ יעד ידני</span>}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {[{ label: "+5%", val: t1, hit: hit1 }, { label: "+10%", val: t2, hit: hit2 }, { label: "+15%", val: t3, hit: hit3 }].map(t => (
                <div key={t.label} style={{
                  flex: 1, textAlign: "center", padding: "4px 2px", borderRadius: 6, fontSize: 10,
                  background: t.hit ? `${C.grn}22` : `${C.bg}`,
                  color: t.hit ? C.grn : C.dim,
                  border: `1px solid ${t.hit ? `${C.grn}44` : C.bdr}`
                }}>
                  <div style={{ fontWeight: 700 }}>{t.label}</div>
                  <div style={{ fontSize: 9 }}>{fmtC(t.val)}</div>
                </div>
              ))}
            </div>
          </div>;
        })}
      </div>
    </div>;
  };

  return <div style={{ direction: "rtl", maxWidth: 800 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
      <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, margin: 0 }}>🎯 תחזית יעדים — {year}</h2>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ color: C.dim, fontSize: 13 }}>חודש:</label>
        <select value={selMonth !== null ? selMonth : -1} onChange={e => { const v = +e.target.value; v === -1 ? setSelMonth(null) : setSelMonth(v); }} style={{ padding: "6px 10px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 13, outline: "none" }}>
          <option value={-1}>כל החודשים</option>
          {MONTHS_HE.map((m, i) => <option key={i} value={i}>{m}</option>)}
        </select>
      </div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 16, marginBottom: 24 }}>
      {mbd.map(d => {
        const isCurrent = d.idx === month;
        const daysPassed = isCurrent ? Math.max(1, new Date().getDate()) : d.days;
        const currentDaily = d.inc / daysPassed;
        const isFuture = d.idx > month;
        const isSelected = selMonth === d.idx;

        return <Card key={d.idx} onClick={() => !isFuture && setSelMonth(isSelected ? null : d.idx)} style={{
          border: isSelected ? `2px solid ${C.pri}` : isCurrent ? `2px solid ${C.pri}55` : `1px solid ${C.bdr}`,
          background: isSelected ? `${C.pri}15` : isCurrent ? `${C.pri}08` : C.card,
          opacity: isFuture ? 0.6 : 1,
          cursor: isFuture ? "default" : "pointer",
          transition: "all .15s"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: isSelected ? C.pri : isCurrent ? C.pri : C.txt }}>
              {d.month} {isCurrent ? "(נוכחי)" : ""} {isSelected ? "▼" : !isFuture ? "▶" : ""}
            </span>
            {!isFuture && <span style={{ fontSize: 13, color: currentDaily >= (d.tgt1 / d.days) ? C.grn : C.red, fontWeight: 600 }}>
              {fmtC(currentDaily)} /יום
            </span>}
          </div>

          <div style={{ padding: "12px", background: `${C.bg}55`, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: C.dim }}>הכנסות בפועל:</span>
              <span style={{ color: C.txt, fontWeight: 600 }}>{isFuture ? "—" : fmtC(d.inc)}</span>
            </div>
            {!isFuture && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: C.dim }}>יעד יומי (ברזל):</span>
              <span style={{ color: currentDaily >= (d.tgt1 / d.days) ? C.grn : C.ylw, fontWeight: 600 }}>{fmtC(d.tgt1 / d.days)}/יום</span>
            </div>}
            {!isFuture && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.dim }}>{isCurrent ? "צפי לסוף חודש:" : "ממוצע יומי × ימים:"}</span>
              <span style={{ color: isCurrent ? C.pri : C.dim, fontWeight: 600 }}>{fmtC(currentDaily * d.days)}</span>
            </div>}
          </div>

          <div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>יעדים שנקבעו לחודש זה:</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { label: "יעד ברזל (+5%)", val: d.tgt1 },
                { label: "יעד זהב (+10%)", val: d.tgt2 },
                { label: "יעד יהלום (+15%)", val: d.tgt3 },
              ].map(({ label, val }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                  <span style={{ color: C.txt }}>{label}</span>
                  <span style={{ textAlign: "left", direction: "ltr" }}>
                    <span style={{ color: d.inc >= val ? C.grn : C.dim, fontWeight: 600 }}>{fmtC(val)}</span>
                    {!isFuture && <span style={{ color: C.dim, fontSize: 10, marginRight: 5 }}>({fmtC(val / d.days)}/יום)</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Card>;
      })}
    </div>

    {/* Drill-down Modal */}
    <Modal open={selMonth !== null} onClose={() => setSelMonth(null)} title={`📊 פירוט יעדים — ${selMonth !== null ? MONTHS_HE[selMonth] : ""}`} width={700}>
      {selMonth !== null && <>
        {renderMiniCards("יעדים לפי צ'אטר", "👤", entityTargets.chatters, true)}
        {renderMiniCards("יעדים לפי לקוחה", "👑", entityTargets.clients, false)}
        {entityTargets.chatters.length === 0 && entityTargets.clients.length === 0 && (
          <div style={{ color: C.mut, textAlign: "center", padding: 20 }}>אין נתונים לחודש זה</div>
        )}
      </>}
    </Modal>

    {editTarget && <Modal open={true} onClose={() => setEditTarget(null)} title={`✏️ עריכת יעדים — ${editTarget.name}`} width={380}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ color: C.dim, fontSize: 12, margin: 0 }}>הגדר יעדים ידניים לצ'אטר. יעדים אלו יוצגו גם בפורטל הפרטי שלו.</p>
        {[{ key: "t1", label: "יעד 1 (קטן) ₪" }, { key: "t2", label: "יעד 2 (בינוני) ₪" }, { key: "t3", label: "יעד 3 (גדול) ₪" }].map(({ key, label }) => (
          <div key={key}>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>{label}</label>
            <input type="number" value={editTarget[key]} onChange={e => setEditTarget(prev => ({ ...prev, [key]: e.target.value }))}
              style={{ width: "100%", padding: "10px 12px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 16, outline: "none", boxSizing: "border-box" }} />
          </div>
        ))}
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <Btn variant="success" style={{ flex: 1 }} disabled={savingTarget} onClick={async () => {
            setSavingTarget(true);
            await saveChatterTarget(editTarget.name, { t1: +editTarget.t1, t2: +editTarget.t2, t3: +editTarget.t3 });
            setSavingTarget(false);
            setEditTarget(null);
          }}>{savingTarget ? "⏳ שומר..." : "💾 שמור"}</Btn>
          {chatterTargets[editTarget.name] && <Btn variant="ghost" disabled={savingTarget} onClick={async () => {
            setSavingTarget(true);
            await saveChatterTarget(editTarget.name, null);
            setSavingTarget(false);
            setEditTarget(null);
          }}>🗑️ איפוס לאוטומטי</Btn>}
          <Btn variant="ghost" onClick={() => setEditTarget(null)}>ביטול</Btn>
        </div>
      </div>
    </Modal>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: RECORD EXPENSE (mobile-first)
// ═══════════════════════════════════════════════════════
function RecordExpensePage({ editMode, onDone }) {
  const { setPage, demo, expenses, setExpenses, customCats, fixedExps, addFixedExp, removeFixedExp, updateFixedExp } = useApp(); const w = useWin();
  const allCats = customCats;
  const [mode, setMode] = useState(editMode ? "manual" : null);
  const [form, setForm] = useState(editMode ? { category: editMode.category, name: editMode.name, amount: String(editMode.amount), date: editMode.date ? `${editMode.date.getFullYear()}-${String(editMode.date.getMonth() + 1).padStart(2, "0")}-${String(editMode.date.getDate()).padStart(2, "0")}` : new Date().toISOString().split("T")[0], hour: editMode.hour || "12:00", paidBy: editMode.paidBy, vatRecognized: editMode.vatRecognized, taxRecognized: editMode.taxRecognized, isFixed: editMode.isFixed || false, fixedPeriod: editMode.fixedPeriod || "monthly", isInstallment: false, installmentCount: "3" } : { category: "", name: "", amount: "", date: new Date().toISOString().split("T")[0], hour: new Date().toTimeString().substring(0, 5), paidBy: "", vatRecognized: false, taxRecognized: true, isFixed: false, fixedPeriod: "monthly", isInstallment: false, installmentCount: "3" });
  const [saving, setSaving] = useState(false), [saved, setSaved] = useState(false), [err, setErr] = useState(""), [scaning, setScaning] = useState(false);
  const fileRef = useRef(null); const scanRef = useRef(null); const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleScan = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setScaning(true); setErr("");
    try {
      let base64;
      if (file.type === "application/pdf") {
        // Convert PDF first page to image
        base64 = await GroqSvc.pdfToImage(file);
      } else {
        // Read image as data URL
        base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (evt) => resolve(evt.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }
      const res = await GroqSvc.scanReceipt(base64);
      if (res) {
        setForm(f => ({
          ...f,
          name: res.Provider || f.name,
          amount: String(res.Amount || f.amount),
          category: allCats.find(c => c === res.Category) || f.category,
          date: res.Date ? res.Date.split("/").reverse().join("-") : f.date
        }));
        setMode("manual");
      }
    } catch (e) { setErr("סריקה נכשלה: " + e.message); }
    finally { setScaning(false); }
    e.target.value = "";
  };

  const save = async () => {
    if (!form.category || !form.name || !form.amount || !form.paidBy) { setErr("נא למלא שדות חובה"); return; }
    if (form.isInstallment && (!form.installmentCount || +form.installmentCount < 2)) { setErr("נא להזין מספר תשלומים (לפחות 2)"); return; }
    setSaving(true); setErr("");
    try {
      const baseDate = new Date(form.date);
      if (form.isInstallment && !editMode) {
        const count = +form.installmentCount;
        const totalAmount = +form.amount;
        const perInstallment = Math.round((totalAmount / count) * 100) / 100;
        for (let i = 1; i <= count; i++) {
          const d = new Date(baseDate);
          d.setMonth(d.getMonth() + (i - 1));
          const exp = { category: form.category, name: form.name, amount: perInstallment, date: d, hour: form.hour, paidBy: form.paidBy, vatRecognized: form.vatRecognized, taxRecognized: form.taxRecognized, isFixed: false, source: "ידני", receiptImage: null, installmentCurrent: i, installmentTotal: count };
          if (!demo) await ExpSvc.add(exp);
        }
        setSaving(false);
        setMode(null);
        setForm({ category: "", name: "", amount: "", date: new Date().toISOString().split("T")[0], hour: new Date().toTimeString().substring(0, 5), paidBy: "", vatRecognized: false, taxRecognized: true, isFixed: false, fixedPeriod: "monthly", isInstallment: false, installmentCount: "3" });
        alert(`✅ נשמרו ${count} תשלומים בהצלחה!`);
        window.location.reload();
        return;
      }
      const exp = { ...form, amount: +form.amount, source: "ידני", receiptImage: null };
      if (editMode) {
        const updated = { ...editMode, ...exp, date: new Date(form.date) };
        if (!demo) await ExpSvc.edit(updated);
        setExpenses(prev => prev.map(x => x.id === editMode.id ? updated : x));
        if (form.isFixed) {
          const existing = fixedExps.find(f => f.linkedExpId === editMode.id);
          if (existing) await updateFixedExp(existing.id, { name: form.name, amount: +form.amount, period: form.fixedPeriod });
          else await addFixedExp({ linkedExpId: editMode.id, name: form.name, amount: +form.amount, period: form.fixedPeriod });
        } else {
          const existing = fixedExps.find(f => f.linkedExpId === editMode.id);
          if (existing) await removeFixedExp(existing.id);
        }
        setSaving(false); if (onDone) onDone(); return;
      }
      if (!demo) await ExpSvc.add(exp);
      TelegramSvc.notifyExpenseAdded(exp);
      if (form.isFixed) {
        await addFixedExp({ name: form.name, amount: +form.amount, period: form.fixedPeriod });
      }
      setSaving(false);
      setMode(null);
      setForm({ category: "", name: "", amount: "", date: new Date().toISOString().split("T")[0], hour: new Date().toTimeString().substring(0, 5), paidBy: "", vatRecognized: false, taxRecognized: true, isFixed: false, fixedPeriod: "monthly", isInstallment: false, installmentCount: "3" });
      alert("✅ ההוצאה נשמרה בהצלחה!");
      window.location.reload();
    } catch (e) {
      console.error("Save expense error:", e);
      setErr("שגיאה בשמירה: " + (e.message || "נסה שוב"));
      setSaving(false);
    }
  };

  if (editMode && saved) { if (onDone) onDone(); return null; }
  if (saved) return <div style={{ direction: "rtl", textAlign: "center", padding: 40 }}><div style={{ fontSize: 56, marginBottom: 12 }}>✅</div><h2 style={{ color: C.grn, marginBottom: 16, fontSize: 18 }}>נשמר!</h2><div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}><Btn onClick={() => { setSaved(false); setMode(null); setForm({ category: "", name: "", amount: "", date: new Date().toISOString().split("T")[0], hour: new Date().toTimeString().substring(0, 5), paidBy: "", vatRecognized: false, taxRecognized: true }); }}>➕ עוד</Btn><Btn variant="ghost" onClick={() => setPage("dashboard")}>🏠</Btn><Btn variant="ghost" onClick={() => setPage("expenses")}>💳</Btn></div></div>;

  const manualExpenses = useMemo(() => expenses.filter(e => e.source === "ידני").sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || "")), [expenses]);
  const manualTotal = manualExpenses.reduce((s, e) => s + e.amount, 0);
  const handleDeleteManual = async (e) => {
    if (!confirm("למחוק הוצאה זו?")) return;
    if (!demo) try { await ExpSvc.remove(e); } catch (err) { alert(err.message); return; }
    setExpenses(prev => prev.filter(x => x.id !== e.id));
  };

  if (!mode && !editMode) return <div style={{ direction: "rtl", maxWidth: 700, margin: "0 auto", padding: w < 768 ? "0 8px" : 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}><Btn variant="ghost" size="sm" onClick={() => setPage("expenses")}>→</Btn><h2 style={{ color: C.txt, fontSize: 18, fontWeight: 700, margin: 0 }}>📱 תיעוד הוצאה</h2></div>
    <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
      <Card onClick={() => setMode("manual")} style={{ textAlign: "center", padding: 28, flex: 1, minWidth: 160 }}><div style={{ fontSize: 44, marginBottom: 8 }}>✍️</div><div style={{ fontSize: 15, fontWeight: 600, color: C.txt }}>הזנה ידנית</div></Card>
      <Card onClick={() => scanRef.current?.click()} style={{ textAlign: "center", padding: 28, flex: 1, minWidth: 160, position: "relative" }}>
        {scaning && <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, color: "#fff", fontWeight: 700 }}>⏳ סורק...</div>}
        <div style={{ fontSize: 44, marginBottom: 8 }}>📸</div><div style={{ fontSize: 15, fontWeight: 600, color: C.txt }}>סרוק קבלה (Groq OCR)</div>
        <div style={{ fontSize: 11, color: C.mut, marginTop: 4 }}>תמונה או PDF</div>
        <input type="file" accept="image/*,.pdf,application/pdf" ref={scanRef} onChange={handleScan} style={{ display: "none" }} />
      </Card>
    </div>
    {err && <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: `${C.red}22`, color: C.red, fontSize: 12 }}>{err}</div>}
    <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, marginBottom: 12 }}>📋 הוצאות שהוזנו ידנית ({manualExpenses.length})</h3>
    {manualExpenses.length === 0 ? <Card style={{ textAlign: "center", padding: 24 }}><div style={{ color: C.mut, fontSize: 13 }}>עדיין לא הוזנו הוצאות ידניות</div></Card> :
      <DT textSm columns={[
        { label: "תאריך", render: r => fmtD(r.date) },
        { label: "שם", key: "name" },
        { label: "קטגוריה", key: "category" },
        { label: "סכום", render: r => <span style={{ color: C.red }}>{fmtC(r.amount)}</span> },
        { label: "שילם", key: "paidBy" },
        { label: "", render: r => <div style={{ display: "flex", gap: 4 }}><Btn size="sm" variant="ghost" onClick={() => { setMode("manual"); setForm({ category: r.category, name: r.name, amount: String(r.amount), date: r.date ? `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}-${String(r.date.getDate()).padStart(2, "0")}` : "", hour: r.hour || "12:00", paidBy: r.paidBy, vatRecognized: r.vatRecognized, taxRecognized: r.taxRecognized }); }}>✏️</Btn><Btn size="sm" variant="ghost" onClick={() => handleDeleteManual(r)} style={{ color: C.red }}>🗑️</Btn></div> }
      ]} rows={manualExpenses} footer={["סה״כ", "", "", fmtC(manualTotal), "", ""]} />}
    <div style={{ marginTop: 28 }}>
      <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, marginBottom: 12 }}>🔒 הוצאות קבועות ({fixedExps.length})</h3>
      {fixedExps.length === 0 ? <Card style={{ textAlign: "center", padding: 24 }}><div style={{ color: C.mut, fontSize: 13 }}>אין הוצאות קבועות פעילות</div></Card> :
        <DT textSm columns={[
          { label: "שם", key: "name" },
          { label: "סכום", render: r => <span style={{ color: C.red, fontWeight: 700 }}>{fmtC(r.amount)}</span> },
          { label: "תדירות", render: r => ({ monthly: "חודשי", quarterly: "רבעוני", annual: "שנתי" }[r.period] || r.period) },
          { label: "", render: r => <Btn size="sm" variant="danger" onClick={async () => { if (confirm(`לבטל את ההוצאה הקבועה "${r.name}"?\nמהחודש הבא היא לא תתווסף יותר.`)) { if (!demo) await removeFixedExp(r.id); } }}>🚫 בטל</Btn> }
        ]} rows={fixedExps} footer={["סה״כ", fmtC(fixedExps.reduce((s, e) => s + e.amount, 0)), "", ""]} />}
    </div>
  </div>;

  const inputStyle = { width: "100%", padding: w < 768 ? "14px 12px" : "10px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: w < 768 ? 16 : 14, outline: "none", boxSizing: "border-box" };

  return <div style={{ direction: "rtl", maxWidth: 440, margin: "0 auto", padding: w < 768 ? "0 8px" : 0 }}>
    {editMode ? <Modal open={true} onClose={onDone} title="✏️ עריכה" width={440}>{renderForm()}</Modal> : <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}><Btn variant="ghost" size="sm" onClick={() => setMode(null)}>→</Btn><h2 style={{ color: C.txt, fontSize: 18, fontWeight: 700, margin: 0 }}>✍️ הזנה ידנית</h2></div>
      {renderForm()}
    </>}
  </div>;

  function renderForm() {
    return <><div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>קטגוריה *</label><select value={form.category} onChange={e => upd("category", e.target.value)} style={inputStyle}><option value="">בחר...</option>{allCats.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שם ההוצאה *</label><input value={form.name} onChange={e => upd("name", e.target.value)} placeholder="למשל: חשבונית חשמל" style={inputStyle} /></div>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סכום (₪) *</label><input type="number" value={form.amount} onChange={e => upd("amount", e.target.value)} placeholder="0" style={{ ...inputStyle, fontSize: w < 768 ? 20 : 16, direction: "ltr" }} /></div>
      <div style={{ display: "flex", gap: 10 }}><div style={{ flex: 1 }}><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>תאריך</label><input type="date" value={form.date} onChange={e => upd("date", e.target.value)} style={inputStyle} /></div><div style={{ flex: 1 }}><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שעה</label><input type="time" value={form.hour} onChange={e => upd("hour", e.target.value)} style={{ ...inputStyle, direction: "ltr" }} /></div></div>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>מי שילם *</label><div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{["דור", "יוראי", "סוכנות"].map(p => <button key={p} onClick={() => upd("paidBy", p)} style={{ flex: 1, minWidth: w < 768 ? "40%" : "auto", padding: w < 768 ? "16px" : "12px", borderRadius: 10, fontSize: w < 768 ? 16 : 14, fontWeight: 600, cursor: "pointer", background: form.paidBy === p ? C.pri : C.card, color: form.paidBy === p ? "#fff" : C.dim, border: `2px solid ${form.paidBy === p ? C.pri : C.bdr}`, transition: "all .15s" }}>{p}</button>)}</div></div>
      <div style={{ display: "flex", gap: 14 }}><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.dim, fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={form.vatRecognized} onChange={e => upd("vatRecognized", e.target.checked)} style={{ width: 18, height: 18 }} />מע״מ</label><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.dim, fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={form.taxRecognized} onChange={e => upd("taxRecognized", e.target.checked)} style={{ width: 18, height: 18 }} />מס</label></div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: form.isFixed ? `${C.pri}22` : C.card, border: `1px solid ${form.isFixed ? C.pri : C.bdr}`, borderRadius: 10, transition: "all .15s" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flex: 1 }}>
          <input type="checkbox" checked={form.isFixed} onChange={e => { upd("isFixed", e.target.checked); if (e.target.checked) upd("isInstallment", false); }} style={{ width: 18, height: 18, accentColor: C.pri }} />
          <span style={{ color: form.isFixed ? C.priL : C.dim, fontSize: 14, fontWeight: form.isFixed ? 600 : 400 }}>🔒 הוצאה קבועה</span>
        </label>
        {form.isFixed && <select value={form.fixedPeriod} onChange={e => upd("fixedPeriod", e.target.value)} style={{ padding: "6px 10px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 13, outline: "none" }}>
          <option value="monthly">חודשי</option>
          <option value="quarterly">רבעוני</option>
          <option value="yearly">שנתי</option>
        </select>}
      </div>
      {!editMode && <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 14px", background: form.isInstallment ? `${C.ylw}18` : C.card, border: `1px solid ${form.isInstallment ? C.ylw : C.bdr}`, borderRadius: 10, transition: "all .15s" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={form.isInstallment} onChange={e => { upd("isInstallment", e.target.checked); if (e.target.checked) upd("isFixed", false); }} style={{ width: 18, height: 18, accentColor: C.ylw }} />
          <span style={{ color: form.isInstallment ? C.ylw : C.dim, fontSize: 14, fontWeight: form.isInstallment ? 600 : 400 }}>💳 תשלומים</span>
        </label>
        {form.isInstallment && <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ color: C.dim, fontSize: 12 }}>מספר תשלומים</label>
          <input type="number" min="2" max="60" value={form.installmentCount} onChange={e => upd("installmentCount", e.target.value)} style={{ padding: "8px 12px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 14, outline: "none", width: 100 }} />
          {form.amount && form.installmentCount && +form.installmentCount >= 2 && <div style={{ color: C.ylw, fontSize: 12, marginTop: 2 }}>
            {Math.round((+form.amount / +form.installmentCount) * 100) / 100}₪ לחודש × {form.installmentCount} חודשים (מתחיל {form.date || "היום"})
          </div>}
        </div>}
      </div>}
    </div>
      {err && <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: `${C.red}22`, color: C.red, fontSize: 12 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}><Btn onClick={save} variant="success" size="lg" style={{ flex: 1 }}>{saving ? "⏳" : editMode ? "💾 עדכן" : "💾 שמור"}</Btn><Btn onClick={editMode ? onDone : () => setPage("expenses")} variant="ghost" size="lg">❌</Btn></div></>;
  }
}

// ═══════════════════════════════════════════════════════
// TABS: CLIENTS (MODELS) & PARAMETERS
// ═══════════════════════════════════════════════════════
function GenClientsTab() {
  const { models, setModels, demo, genParams, income } = useApp();
  const [editMod, setEditMod] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [syncing, setSyncing] = useState(false);

  const syncFromIncome = async () => {
    const existingNames = new Set(models.map(m => m.name.trim().toLowerCase()));
    const clientNames = [...new Set(income.map(r => r.modelName).filter(Boolean))];
    const newNames = clientNames.filter(n => !existingNames.has(n.trim().toLowerCase()));
    if (newNames.length === 0) { alert("כל הלקוחות כבר קיימים במחולל."); return; }
    if (!confirm(`להוסיף ${newNames.length} לקוחות חדשים מנתוני ההכנסות?\n\n${newNames.join(", ")}`)) return;
    setSyncing(true);
    const added = [];
    for (const name of newNames) {
      try {
        const m = await ModelSvc.add({ name, specialties: "", restrictions: "", notes: "" });
        added.push(m);
      } catch (e) { console.error("Failed to add:", name, e); }
    }
    setModels([...models, ...added]);
    setSyncing(false);
    alert(`נוספו ${added.length} לקוחות חדשים!`);
  };

  const startEdit = (m) => {
    setEditMod(m);
    setForm(m ? { ...m } : { name: "", specialties: "", restrictions: "", notes: "" });
  };

  const save = async () => {
    if (!form.name) { setErr("חובה להזין שם מודל"); return; }
    setSaving(true); setErr("");
    try {
      if (editMod) {
        await ModelSvc.edit(form);
        setModels(models.map(m => m.id === form.id ? form : m));
      } else {
        const added = await ModelSvc.add(form);
        setModels([...models, added]);
      }
      setEditMod(null); setForm(null);
    } catch (e) {
      setErr(e.message);
    }
    setSaving(false);
  };

  const remove = async (m) => {
    if (!window.confirm(`למחוק את ${m.name}?`)) return;
    try {
      await ModelSvc.remove(m);
      setModels(models.filter(x => x.id !== m.id));
    } catch (e) { alert(e.message); }
  };

  const inputStyle = { width: "100%", padding: "8px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 12 };
  const labelStyle = { color: C.dim, fontSize: 12, display: "block", marginBottom: 4 };

  return <div style={{ direction: "rtl" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
      <h3 style={{ color: C.txt, fontSize: 18, fontWeight: 700, margin: 0 }}>👩 ניהול לקוחות במחולל</h3>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={syncFromIncome} variant="ghost" disabled={syncing}>{syncing ? "⏳ מייבא..." : "🔄 ייבוא מהכנסות"}</Btn>
        <Btn onClick={() => startEdit(null)} variant="success">➕ לקוח חדש</Btn>
      </div>
    </div>

    {models.length === 0 ? <div style={{ color: C.mut, padding: 20, textAlign: "center", border: `1px dashed ${C.bdr}`, borderRadius: 8 }}>אין לקוחות עדיין במחולל. לחץ "ייבוא מהכנסות" לייבא אוטומטית.</div> :
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {models.map(m => <Card key={m.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ color: C.pri, margin: 0, fontSize: 16 }}>{m.name}</h3>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="ghost" onClick={() => startEdit(m)}>✏️</Btn>
              <Btn size="sm" variant="ghost" onClick={() => remove(m)} style={{ color: C.red }}>🗑️</Btn>
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.dim }}><strong>התמחויות:</strong> {m.specialties || "—"}</div>
          <div style={{ fontSize: 12, color: C.mut }}><strong>הגבלות:</strong> {m.restrictions || "—"}</div>
        </Card>)}
      </div>
    }

    {form && <Modal open={true} onClose={() => setForm(null)} title={editMod ? `עריכת לקוח: ${editMod.name}` : "לקוח חדש"} width={600}>
      <div style={{ maxHeight: "60vh", overflowY: "auto", paddingRight: 4 }}>
        <label style={labelStyle}>שם הלקוחה *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} />
        <label style={labelStyle}>התמחויות</label><textarea value={form.specialties} onChange={e => setForm({ ...form, specialties: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} placeholder="לדוגמה: ציצים גדולים, שליטה מינית..." />
        <label style={labelStyle}>הגבלות</label><textarea value={form.restrictions} onChange={e => setForm({ ...form, restrictions: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} placeholder="לדוגמה: אסור פנים, אין אנאל..." />
        <label style={labelStyle}>הערות נוספות</label><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} />
      </div>
      {err && <div style={{ color: C.red, fontSize: 13, margin: "10px 0" }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <Btn onClick={save} variant="success" style={{ flex: 1 }}>{saving ? "⏳" : "💾 שמור"}</Btn>
        <Btn onClick={() => setForm(null)} variant="ghost">ביטול</Btn>
      </div>
    </Modal>}
  </div>;
}

function GenParamsTab() {
  const { genParams, setGenParams } = useApp();
  const [vals, setVals] = useState({
    location: genParams.location.join(", "),
    outfit: genParams.outfit.join(", "),
    hairstyle: genParams.hairstyle.join(", "),
    lighting: genParams.lighting.join(", "),
    props: genParams.props.join(", "),
    angle: genParams.angle.join(", "),
    action: genParams.action.join(", ")
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const parsed = {
      location: vals.location.split(",").map(x => x.trim()).filter(Boolean),
      outfit: vals.outfit.split(",").map(x => x.trim()).filter(Boolean),
      hairstyle: vals.hairstyle.split(",").map(x => x.trim()).filter(Boolean),
      lighting: vals.lighting.split(",").map(x => x.trim()).filter(Boolean),
      props: vals.props.split(",").map(x => x.trim()).filter(Boolean),
      angle: vals.angle.split(",").map(x => x.trim()).filter(Boolean),
      action: vals.action.split(",").map(x => x.trim()).filter(Boolean),
    };
    await GenParamsSvc.save(parsed);
    setGenParams(parsed);
    setSaving(false);
    alert("נשמר בהצלחה!");
  };

  const taStyle = { width: "100%", padding: 12, background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 13, minHeight: 80, outline: "none", boxSizing: "border-box", marginBottom: 16, lineHeight: 1.5 };
  const labelStyle = { color: C.pri, fontSize: 14, fontWeight: "bold", display: "block", marginBottom: 6 };

  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target.result;
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      const newVals = { ...vals };
      let currentCat = null;

      lines.forEach(line => {
        const lower = line.toLowerCase();
        if (lower.startsWith("location") || line.includes("מיקום")) currentCat = "location";
        else if (lower.startsWith("outfit") || line.includes("לבוש")) currentCat = "outfit";
        else if (lower.startsWith("hair") || line.includes("שיער") || line.includes("תסרוקת")) currentCat = "hairstyle";
        else if (lower.startsWith("lighting") || line.includes("תאורה")) currentCat = "lighting";
        else if (lower.startsWith("prop") || line.includes("אביזר")) currentCat = "props";
        else if (lower.startsWith("angle") || line.includes("זווית")) currentCat = "angle";
        else if (lower.startsWith("action") || line.includes("פעולה")) currentCat = "action";
        else if (currentCat) {
          const items = line.split(",").map(i => i.trim()).filter(Boolean);
          if (items.length) {
            newVals[currentCat] = newVals[currentCat] ? newVals[currentCat] + ", " + items.join(", ") : items.join(", ");
          }
        }
      });
      setVals(newVals);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return <div style={{ direction: "rtl", maxWidth: 800 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
      <h3 style={{ color: C.txt, fontSize: 18, fontWeight: 700, margin: 0 }}>🗂️ מאגר פרמטרים</h3>
      <div>
        <label style={{ display: "inline-block", background: C.card, color: C.dim, padding: "6px 14px", borderRadius: 8, cursor: "pointer", border: `1px solid ${C.bdr}`, fontSize: 13, fontWeight: 600 }}>
          📄 העלה CSV
          <input type="file" accept=".csv" onChange={handleCsvUpload} style={{ display: "none" }} />
        </label>
      </div>
    </div>

    <p style={{ color: C.dim, fontSize: 13, marginBottom: 20 }}>הזן ערכים מופרדים בפסיקים (CSV) לכל קטגוריה, או העלה קובץ עם שמות הקטגוריות ככותרות.</p>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
      <div><label style={labelStyle}>מיקומים (Location)</label><textarea value={vals.location} onChange={e => setVals({ ...vals, location: e.target.value })} style={taStyle} placeholder="מיטה, ספה, מטבח..." /></div>
      <div><label style={labelStyle}>לבוש (Outfit)</label><textarea value={vals.outfit} onChange={e => setVals({ ...vals, outfit: e.target.value })} style={taStyle} placeholder="ביקיני, הלבשה תחתונה, עירום..." /></div>
      <div><label style={labelStyle}>תסרוקות (Hairstyle)</label><textarea value={vals.hairstyle} onChange={e => setVals({ ...vals, hairstyle: e.target.value })} style={taStyle} placeholder="פזור, אמבטיה, קוקו..." /></div>
      <div><label style={labelStyle}>תאורה (Lighting)</label><textarea value={vals.lighting} onChange={e => setVals({ ...vals, lighting: e.target.value })} style={taStyle} placeholder="טבעית, חמים, פלאש..." /></div>
      <div><label style={labelStyle}>אביזרים (Props)</label><textarea value={vals.props} onChange={e => setVals({ ...vals, props: e.target.value })} style={taStyle} placeholder="אזיקים, שוט, פלאג..." /></div>
      <div><label style={labelStyle}>זוויות (Camera Angle)</label><textarea value={vals.angle} onChange={e => setVals({ ...vals, angle: e.target.value })} style={taStyle} placeholder="מלמעלה, סלפי, תקריב..." /></div>
      <div><label style={labelStyle}>פעולה (Action)</label><textarea value={vals.action} onChange={e => setVals({ ...vals, action: e.target.value })} style={taStyle} placeholder="שוכבת, משחקת בשיער, מלקקת..." /></div>
    </div>

    <Btn onClick={save} variant="success" size="lg" style={{ width: "100%", marginTop: 10 }}>{saving ? "⏳ שומר..." : "💾 שמור מסד נתונים"}</Btn>
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: GENERATOR
// ═══════════════════════════════════════════════════════


function GeneratorPage() {
  const { models, history, setHistory, demo, genParams } = useApp();
  const [activeTab, setActiveTab] = useState("generator");

  const [selModelId, setSelModelId] = useState("");
  const [numP, setNumP] = useState(0);
  const [numV, setNumV] = useState(0);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("GROK_API_KEY") || GROK_API_KEY_DEFAULT || "");
  const saveApiKey = (k) => { setApiKey(k); localStorage.setItem("GROK_API_KEY", k); };

  const [ov, setOv] = useState({ location: "", outfit: "", hairstyle: "", lighting: "", props: "", angle: "", action: "" });
  const updOv = (k, v) => setOv(prev => ({ ...prev, [k]: v }));

  const [gening, setGening] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");
  const [viewHist, setViewHist] = useState(null);

  const selModel = models.find(m => m.id === selModelId);

  const generate = async () => {
    if (!apiKey) return setErr("יש להזין מפתח API של Grok");
    if (!selModel) return setErr("יש לבחור מודל תחילה");
    if (numP === 0 && numV === 0) return setErr("יש לבחור לפחות תמונה אחת או סרטון אחד");
    setErr(""); setGening(true);

    const overridesText = Object.entries(ov).filter(([_, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ");
    const prompt = `System:
אתה מומחה OnlyFans reference & script creator.
כבד 100% הגבלות – אל תמציא משהו שאסור ללקוחה.
השלם פרמטרים חסרים בהיגיון סקסי, עקבי ומתאים לסגנון.
פלט תמיד JSON בלבד – בלי טקסט נוסף.
{
  "items": [
    {
      "type": "photo" | "video",
      "index": 1,
      "parameters": {
        "מיקום": "...", "לבוש": "...", "תסרוקת": "...", "תאורה": "...", "אביזרים": "...", "זווית צילום": "...", "פעולה": "..."
      },
      "reference": "תיאור מלא בעברית",
      "script": "דיבור מלא בעברית"
    }
  ]
}

User:
לקוחה שמבצעת ומדברת (הדוברת בתסריט/רפרנס): ${selModel.name}
התמחויות: ${selModel.specialties}
הגבלות: ${selModel.restrictions}

בקשה:
${numP} תמונות + ${numV} סרטונים

Overrides מהמשתמש:
${overridesText || "אין"}

משימה:
- השלם כל פרמטר חסר (מיקום, לבוש, תסרוקת, תאורה, אביזרים, זווית צילום, פעולה) בהתאם למותרים ולסגנון.
- ${selModel.name} היא הדמות הראשית שעושה את הפעולות בתמונה. היא **לא** המשתמש.
- צור תיאור reference מפורט בעברית על מה שהלקוחה עושה כעת בפריים.
- צור תסריט דיבור מלוכלך בעברית (סקריפט) שבו הלקוחה מדברת ישירות למצלמה ומגרה את המעריץ שצופה בה.
פלט JSON בלבד!`;

    try {
      const response = await API.grok(prompt, apiKey);
      const content = response.choices[0].message.content;

      let items = [];
      try {
        const parsed = JSON.parse(content.replace(/```json|```/g, "").trim());
        items = parsed.items || [];
      } catch (e) { throw new Error("הפלט מהשרת אינו JSON תקין"); }

      setRes(items);
      const h = { modelName: selModel.name, type: `${numP} תמונות, ${numV} סרטונים`, parameters: JSON.stringify(ov), reference: JSON.stringify(items), script: "JSON", date: new Date().toISOString() };
      const savedH = await HistorySvc.add(h);
      setHistory([savedH, ...history]);
    } catch (err) {
      console.error(err);
      setErr("שגיאה ביצירת הרפרנסים: " + err.message);
    }
    setGening(false);
  };

  const copyItem = (item) => {
    const text = `[${item.type} #${item.index}]\nמיקום: ${item.parameters["מיקום"]}\nלבוש: ${item.parameters["לבוש"]}\nתסרוקת: ${item.parameters["תסרוקת"]}\nתאורה: ${item.parameters["תאורה"]}\nאביזרים: ${item.parameters["אביזרים"]}\nזווית: ${item.parameters["זווית צילום"]}\nפעולה: ${item.parameters["פעולה"]}\n\nרפרנס: ${item.reference}\n${item.script ? `תסריט: ${item.script}` : ""}`;
    navigator.clipboard.writeText(text);
    alert("הועתק ללוח!");
  };

  const inputStyle = { width: "100%", padding: "8px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 12 };
  const labelStyle = { color: C.dim, fontSize: 12, display: "block", marginBottom: 4 };

  return <div style={{ direction: "rtl", maxWidth: activeTab === "generator" ? 1000 : 800, margin: "0 auto" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
      <h2 style={{ color: C.txt, fontSize: 22, fontWeight: 700, margin: 0 }}>✨ מחולל תכנים ורפרנסים </h2>
      <div style={{ display: "flex", background: C.card, borderRadius: 8, padding: 4, border: `1px solid ${C.bdr}` }}>
        <button onClick={() => setActiveTab("generator")} style={{ padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: activeTab === "generator" ? 700 : 400, background: activeTab === "generator" ? C.pri : "transparent", color: activeTab === "generator" ? "#fff" : C.dim }}>מחולל</button>
        <button onClick={() => setActiveTab("clients")} style={{ padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: activeTab === "clients" ? 700 : 400, background: activeTab === "clients" ? C.pri : "transparent", color: activeTab === "clients" ? "#fff" : C.dim }}>לקוחות</button>
        <button onClick={() => setActiveTab("params")} style={{ padding: "6px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: activeTab === "params" ? 700 : 400, background: activeTab === "params" ? C.pri : "transparent", color: activeTab === "params" ? "#fff" : C.dim }}>פרמטרים</button>
      </div>
    </div>

    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
      {/* LEFT: Generator Form */}
      <Card style={{ flex: "1 1 300px" }}>

        <div style={{ marginBottom: 16, background: `${C.purple}22`, padding: 12, borderRadius: 8, border: `1px solid ${C.purple}44`, display: activeTab === "generator" ? "block" : "none" }}>
          <label style={{ ...labelStyle, color: C.txt }}>🔑 מפתח Grok API (xAI)</label>
          <input type="password" value={apiKey} onChange={e => saveApiKey(e.target.value)} style={{ ...inputStyle, marginBottom: 0, background: C.bg }} placeholder="xai-..." />
          <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>המפתח נשמר מקומית בדפדפן בלבד ומשמש לפנייה ישירה ל-API.</div>
        </div>

        {activeTab === "generator" && <>
          <h3 style={{ color: C.pri, fontSize: 16, marginTop: 0, marginBottom: 16 }}>הגדרות פלט</h3>
          <label style={labelStyle}>בחר לקוחה *</label>
          <select value={selModelId} onChange={e => setSelModelId(e.target.value)} style={inputStyle}>
            <option value="">בחר...</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={labelStyle}>מספר תמונות</label><input type="number" min="0" value={numP} onChange={e => setNumP(+e.target.value)} style={inputStyle} /></div>
            <div style={{ flex: 1 }}><label style={labelStyle}>מספר סרטונים</label><input type="number" min="0" value={numV} onChange={e => setNumV(+e.target.value)} style={inputStyle} /></div>
          </div>

          <h3 style={{ color: C.txt, fontSize: 14, marginTop: 10, marginBottom: 12, paddingBottom: 6, borderBottom: `1px solid ${C.bdr}` }}>Overrides (אופציונלי)</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>מיקום (Location)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("location", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.location ? C.pri : C.card, color: !ov.location ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.location.map(x => <button key={x} onClick={() => updOv("location", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.location === x ? C.pri : C.card, color: ov.location === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
            <div>
              <label style={labelStyle}>לבוש (Outfit)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("outfit", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.outfit ? C.pri : C.card, color: !ov.outfit ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.outfit.map(x => <button key={x} onClick={() => updOv("outfit", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.outfit === x ? C.pri : C.card, color: ov.outfit === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
            <div>
              <label style={labelStyle}>תסרוקת (Hairstyle)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("hairstyle", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.hairstyle ? C.pri : C.card, color: !ov.hairstyle ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.hairstyle.map(x => <button key={x} onClick={() => updOv("hairstyle", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.hairstyle === x ? C.pri : C.card, color: ov.hairstyle === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
            <div>
              <label style={labelStyle}>תאורה (Lighting)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("lighting", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.lighting ? C.pri : C.card, color: !ov.lighting ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.lighting.map(x => <button key={x} onClick={() => updOv("lighting", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.lighting === x ? C.pri : C.card, color: ov.lighting === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
            <div>
              <label style={labelStyle}>אביזרים (Props)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("props", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.props ? C.pri : C.card, color: !ov.props ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.props.map(x => <button key={x} onClick={() => updOv("props", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.props === x ? C.pri : C.card, color: ov.props === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
            <div>
              <label style={labelStyle}>זווית צילום (Angle)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("angle", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.angle ? C.pri : C.card, color: !ov.angle ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.angle.map(x => <button key={x} onClick={() => updOv("angle", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.angle === x ? C.pri : C.card, color: ov.angle === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
            <div>
              <label style={labelStyle}>פעולה (Action)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button onClick={() => updOv("action", "")} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: !ov.action ? C.pri : C.card, color: !ov.action ? "#fff" : C.dim, fontSize: 12, cursor: "pointer" }}>השלמת AI</button>
                {genParams.action.map(x => <button key={x} onClick={() => updOv("action", x)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.bdr}`, background: ov.action === x ? C.pri : C.card, color: ov.action === x ? "#fff" : C.txt, fontSize: 12, cursor: "pointer" }}>{x}</button>)}
              </div>
            </div>
          </div>

          {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 16 }}>{err}</div>}
          <Btn onClick={generate} variant="primary" size="lg" style={{ width: "100%", marginTop: 10 }} disabled={gening}>{gening ? "🧠 חושב..." : "🚀 צור רפרנסים ותסריטים"}</Btn>
        </>}

        {activeTab === "clients" && <GenClientsTab />}
        {activeTab === "params" && <GenParamsTab />}
      </Card>

      {/* RIGHT: Results */}
      <div style={{ flex: "2 1 400px", flexDirection: "column", gap: 16, display: activeTab === "generator" ? "flex" : "none" }}>
        {res && res.length > 0 && <Card style={{ background: `${C.pri}11`, border: `1px solid ${C.pri}` }}>
          <h3 style={{ color: C.pri, fontSize: 16, marginTop: 0, marginBottom: 16 }}>✅ תוצאות ({res.length})</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {res.map((item, idx) => (
              <div key={idx} style={{ background: C.bg, border: `1px solid ${C.bdr}`, padding: 16, borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontWeight: "bold", color: item.type === "סרטון" ? C.purple : C.priL, fontSize: 15 }}>{item.type} #{item.index}</div>
                  <Btn size="sm" variant="ghost" onClick={() => copyItem(item)}>📋 העתק</Btn>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12, color: C.dim, marginBottom: 12, background: C.card, padding: 10, borderRadius: 6 }}>
                  <div><strong>מיקום:</strong> {item.parameters["מיקום"]}</div>
                  <div><strong>לבוש:</strong> {item.parameters["לבוש"]}</div>
                  <div><strong>תאורה:</strong> {item.parameters["תאורה"]}</div>
                  <div><strong>אביזרים:</strong> {item.parameters["אביזרים"]}</div>
                  <div><strong>זווית:</strong> {item.parameters["זווית צילום"]}</div>
                  <div><strong>פעולה:</strong> {item.parameters["פעולה"]}</div>
                </div>

                <div style={{ color: C.txt, fontSize: 14, marginBottom: item.script ? 12 : 0, lineHeight: 1.5 }}>
                  <strong style={{ display: "block", color: C.priL, marginBottom: 4 }}>תיאור רפרנס:</strong>
                  {item.reference}
                </div>

                {item.script && <div style={{ color: C.txt, fontSize: 14, lineHeight: 1.5, background: `${C.purple}11`, borderLeft: `3px solid ${C.purple}`, padding: "8px 12px", borderRadius: "0 6px 6px 0" }}>
                  <strong style={{ display: "block", color: C.purple, marginBottom: 4 }}>תסריט / Dirty Talk:</strong>
                  {item.script}
                </div>}
              </div>
            ))}
          </div>
        </Card>}

        <Card>
          <h3 style={{ color: C.txt, fontSize: 16, marginTop: 0, marginBottom: 16 }}>📜 היסטוריית יצירות</h3>
          {history.length === 0 ? <div style={{ color: C.dim, fontSize: 13 }}>אין היסטוריה עדיין.</div> :
            <DT textSm columns={[
              { label: "תאריך", render: r => r.date ? fmtD(new Date(r.date)) : "" },
              { label: "מודל", key: "modelName" },
              { label: "סוג", key: "type" },
            ]} rows={history.slice(0, 10)} onRowClick={(r) => {
              try {
                const parsed = JSON.parse(r.reference);
                setViewHist({ type: "success", items: Array.isArray(parsed) ? parsed : [] });
              } catch (e) {
                setViewHist({ type: "error", message: "Error parsing history format. Legacy item." });
              }
            }} />
          }
        </Card>
      </div>
    </div>

    <Modal open={!!viewHist} onClose={() => setViewHist(null)} title="🔍 צפייה ברפרנס היסטורי" width={700}>
      <div style={{ maxHeight: "65vh", overflowY: "auto", paddingRight: 6 }}>
        {viewHist?.type === "error" ? <div style={{ color: C.red }}>{viewHist.message}</div> :
          viewHist?.items?.map((item, idx) => (
            <div key={idx} style={{ background: C.bg, border: `1px solid ${C.bdr}`, padding: 16, borderRadius: 8, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontWeight: "bold", color: item.type === "סרטון" ? C.purple : C.priL, fontSize: 15 }}>{item.type} #{item.index}</div>
                <Btn size="sm" variant="ghost" onClick={() => copyItem(item)}>📋 העתק</Btn>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12, color: C.dim, marginBottom: 12, background: C.card, padding: 10, borderRadius: 6 }}>
                <div><strong>מיקום:</strong> {item.parameters?.["מיקום"]}</div>
                <div><strong>לבוש:</strong> {item.parameters?.["לבוש"]}</div>
                <div><strong>תאורה:</strong> {item.parameters?.["תאורה"]}</div>
                <div><strong>אביזרים:</strong> {item.parameters?.["אביזרים"]}</div>
                <div><strong>זווית:</strong> {item.parameters?.["זווית צילום"]}</div>
                <div><strong>פעולה:</strong> {item.parameters?.["פעולה"]}</div>
              </div>
              <div style={{ color: C.txt, fontSize: 14, marginBottom: item.script ? 12 : 0, lineHeight: 1.5 }}>
                <strong style={{ display: "block", color: C.priL, marginBottom: 4 }}>תיאור רפרנס:</strong>
                {item.reference}
              </div>
              {item.script && <div style={{ color: C.txt, fontSize: 14, lineHeight: 1.5, background: `${C.purple}11`, borderLeft: `3px solid ${C.purple}`, padding: "8px 12px", borderRadius: "0 6px 6px 0" }}>
                <strong style={{ display: "block", color: C.purple, marginBottom: 4 }}>תסריט / Dirty Talk:</strong>
                {item.script}
              </div>}
            </div>
          ))}
      </div>
    </Modal>
  </div>;
}

// ═══════════════════════════════════════════════════════
// CHATTER PORTAL
// ═══════════════════════════════════════════════════════
function ChatterPortal({ hideHeader } = {}) {
  const { user, logout, income, setIncome, load, connected, year, setYear, month, setMonth, chatterTargets, sheetUsers, chatterSettings } = useApp();
  const { iM, iY } = useFD();
  const w = useWin();
  const chatterName = user?.name || "";
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    modelName: "", platform: "", amountILS: "", amountUSD: "", usdRate: "3.14", currency: "ILS",
    date: new Date().toISOString().split("T")[0],
    hour: new Date().toTimeString().substring(0, 5),
    shiftLocation: "משרד", notes: "", incomeType: "", customIncomeType: "", buyerName: ""
  });

  // Auto-load data if not connected
  useEffect(() => { if (!connected) load(); }, [connected, load]);

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Income filtered to this chatter — uses iM from useFD (already has dynamic rate + commission applied)
  const myIncome = useMemo(() =>
    iM.filter(r => r.chatterName === chatterName).sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || "")),
    [iM, chatterName]);

  const approved = myIncome.filter(r => isVerified(r.verified));
  const pending = myIncome.filter(r => !isVerified(r.verified));

  const byClient = useMemo(() => {
    const m = {};
    myIncome.forEach(r => {
      if (!r.modelName) return;
      if (!m[r.modelName]) m[r.modelName] = { name: r.modelName, total: 0, count: 0 };
      m[r.modelName].total += r.amountILS;
      m[r.modelName].count += 1;
    });
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [myIncome]);
  const totalApproved = approved.reduce((s, r) => s + r.amountILS, 0);
  const totalPending = pending.reduce((s, r) => s + r.amountILS, 0);

  // Last month income for this chatter
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const lastMonthIncome = useMemo(() =>
    iY.filter(r => r.chatterName === chatterName && r.date && r.date.getFullYear() === prevYear && r.date.getMonth() === prevMonth),
    [iY, chatterName, prevYear, prevMonth]);
  const lastMonthTotal = lastMonthIncome.reduce((s, r) => s + r.amountILS, 0);

  // Salary calculation (same as admin ChatterPage)
  const ymi = ym(year, month);
  const cfg = chatterSettings[chatterName] || {};
  const sal = useMemo(() => Calc.chatterSalary(myIncome, cfg, ymi), [myIncome, cfg, ymi]);
  const daysInLastMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
  const lastMonthDailyAvg = daysInLastMonth > 0 ? Math.round(lastMonthTotal / daysInLastMonth) : 0;

  // Current month progress
  const currentMonthTotal = myIncome.reduce((s, r) => s + r.amountILS, 0);
  const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
  const daysSoFar = Math.min(new Date().getDate(), daysInCurrentMonth);

  // Target goals — use custom targets if set by admin, otherwise compute from last month
  const customT = chatterTargets[chatterName];
  const autoTargets = [
    { label: "יעד 5%", val: Math.round(lastMonthTotal * 1.05), color: "#22c55e", pct: 5 },
    { label: "יעד 10%", val: Math.round(lastMonthTotal * 1.10), color: "#f59e0b", pct: 10 },
    { label: "יעד 15%", val: Math.round(lastMonthTotal * 1.15), color: "#ef4444", pct: 15 },
  ];
  const targets = customT
    ? [
        { label: "יעד 1", val: customT.t1, color: "#22c55e" },
        { label: "יעד 2", val: customT.t2, color: "#f59e0b" },
        { label: "יעד 3", val: customT.t3, color: "#ef4444" },
      ]
    : autoTargets;
  const targetsWithProgress = targets.map(t => {
    const goal = t.val;
    const progress = goal > 0 ? Math.min(Math.round((currentMonthTotal / goal) * 100), 100) : 0;
    return { ...t, goal, progress };
  });

  // Unique client names from all income + registered users
  const clientNames = useMemo(() => {
    const fromIncome = income.map(r => r.modelName).filter(Boolean);
    const fromUsers = (sheetUsers || []).filter(u => u.role === "client").map(u => u.name);
    return [...new Set([...fromIncome, ...fromUsers])].sort();
  }, [income, sheetUsers]);

  // Income types from all existing income data (filters out any string containing English characters)
  const incomeTypes = useMemo(() => {
    const fromData = income.map(r => r.incomeType).filter(Boolean);
    const defaults = ["תוכן", "שיחה", "סקסטינג", "ביט", "העברה בנקאית", "פייבוקס", "וולט"];
    return [...new Set([...defaults, ...fromData])].filter(t => !/[a-zA-Z]/.test(t)).sort();
  }, [income]);

  const save = async () => {
    if (!form.modelName || (!form.amountILS && !form.amountUSD)) { setErr("נא למלא לקוחה וסכום"); return; }
    setSaving(true); setErr("");

    const rate = +form.usdRate || 3.14;
    const inputILS = +form.amountILS || 0;
    const inputUSD = +form.amountUSD || 0;
    const finalIncomeType = form.incomeType === "__other__" ? form.customIncomeType : form.incomeType;
    const commFields = computeCommissionFields(form.platform, finalIncomeType, inputILS, inputUSD, rate);

    try {
      // Save to Firebase pendingIncome (awaits admin approval)
      const newInc = {
        chatterName, modelName: form.modelName,
        clientName: "", usdRate: rate,
        rawILS: inputILS, originalRawILS: inputILS, originalRawUSD: inputUSD,
        incomeType: finalIncomeType,
        originalAmount: commFields.preCommissionILS,
        ...commFields,
        platform: form.platform, date: new Date(form.date), hour: form.hour,
        notes: form.notes, verified: "", shiftLocation: form.shiftLocation,
        buyerName: form.buyerName || "",
        paymentTarget: "agency", paidToClient: false, cancelled: false
      };
      const saved = await addPending(newInc);
      TelegramSvc.notifyIncomeSubmitted(saved);
      setIncome(prev => [{ ...saved, _fromPending: true }, ...prev]);
      setSaving(false); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setForm(f => ({ ...f, modelName: "", amountILS: "", amountUSD: "", notes: "", incomeType: "", customIncomeType: "", currency: "ILS", buyerName: "" }));
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  const inputStyle = { width: "100%", padding: w < 768 ? "14px 12px" : "10px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: w < 768 ? 16 : 14, outline: "none", boxSizing: "border-box" };

  return <div style={{ minHeight: "100vh", background: C.bg, direction: "rtl" }}>
    {/* Header */}
    {!hideHeader && <div style={{ background: C.card, borderBottom: `1px solid ${C.bdr}`, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20 }}>👤</span>
        <div>
          <div style={{ color: C.txt, fontWeight: 700, fontSize: 15 }}>{chatterName}</div>
          <div style={{ color: C.dim, fontSize: 11 }}>פורטל צ'אטר</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select value={month} onChange={e => setMonth(+e.target.value)} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
          {MONTHS_HE.map((m, i) => <option key={i} value={i}>{m}</option>)}
        </select>
        <select value={year} onChange={e => setYear(+e.target.value)} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <Btn variant="ghost" size="sm" onClick={logout}>🚪 יציאה</Btn>
      </div>
    </div>}
    {hideHeader && <div style={{ background: C.card, borderBottom: `1px solid ${C.bdr}`, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20 }}>👤</span>
        <div>
          <div style={{ color: C.txt, fontWeight: 700, fontSize: 15 }}>{chatterName}</div>
          <div style={{ color: C.dim, fontSize: 11 }}>מנהל משמרת</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select value={month} onChange={e => setMonth(+e.target.value)} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
          {MONTHS_HE.map((m, i) => <option key={i} value={i}>{m}</option>)}
        </select>
        <select value={year} onChange={e => setYear(+e.target.value)} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
    </div>}

    <div style={{ maxWidth: 1100, margin: "0 auto", padding: w < 768 ? "16px 10px" : "24px" }}>
      {/* Summary Cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Stat icon="✅" title="מאושרות" value={fmtC(totalApproved)} sub={`${approved.length} עסקאות`} color={C.grn} />
        <Stat icon="⏳" title="ממתינות" value={fmtC(totalPending)} sub={`${pending.length} עסקאות`} color={C.ylw} />
        <Stat icon="💰" title="סה״כ החודש" value={fmtC(currentMonthTotal)} sub={`${myIncome.length} עסקאות`} color={C.pri} />
        <Stat icon="🏢" title="משרד" value={fmtC(sal.oSales)} sub={hideHeader ? `${approved.filter(r => r.shiftLocation === "משרד").length} עסקאות` : `שכר ${sal.officePct ?? 17}%: ${fmtC(sal.oSal)}`} />
        <Stat icon="🏠" title="חוץ" value={fmtC(sal.rSales)} sub={hideHeader ? `${approved.filter(r => r.shiftLocation !== "משרד").length} עסקאות` : `שכר ${sal.fieldPct ?? 15}%: ${fmtC(sal.rSal)}`} />
        {!hideHeader && <Stat icon="💵" title="משכורת" value={fmtC(sal.total)} color={C.pri} sub={SALARY_TYPE_LABELS[sal.salaryType] || "מכירות"} />}
      </div>

      {/* Last Month Context + Targets */}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, margin: 0 }}>🎯 יעדים לחודש הנוכחי</h3>
          <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.dim }}>
            <span>📊 ממוצע יומי חודש קודם: <strong style={{ color: C.pri }}>{fmtC(lastMonthDailyAvg)}</strong></span>
            <span>📅 סה"כ חודש קודם: <strong style={{ color: C.priL }}>{fmtC(lastMonthTotal)}</strong></span>
          </div>
        </div>

        {lastMonthTotal === 0 && !customT ? (
          <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: 16 }}>אין נתונים מחודש קודם לחישוב יעדים</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {targetsWithProgress.map((t, i) => (
              <div key={i}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: t.color }}>{t.label}</span>
                    <span style={{ fontSize: 11, color: C.dim }}>+{t.pct}% מחודש קודם</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.txt }}>{fmtC(currentMonthTotal)}</span>
                    <span style={{ fontSize: 11, color: C.dim }}>/</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: t.color }}>{fmtC(t.goal)}</span>
                  </div>
                </div>
                <div style={{ background: C.bg, borderRadius: 8, height: 28, overflow: "hidden", position: "relative", border: `1px solid ${C.bdr}` }}>
                  <div style={{
                    height: "100%", borderRadius: 8, background: `linear-gradient(90deg, ${t.color}44, ${t.color})`,
                    width: `${t.progress}%`, transition: "width 0.5s ease-in-out", minWidth: t.progress > 0 ? 20 : 0
                  }} />
                  <div style={{
                    position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700, color: t.progress >= 50 ? "#fff" : C.txt
                  }}>
                    {t.progress}%
                    {t.progress >= 100 && " 🎉"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Top 3 chatters this month */}
        {(() => {
          const byChatter = {};
          iM.forEach(r => {
            if (!r.chatterName) return;
            byChatter[r.chatterName] = (byChatter[r.chatterName] || 0) + r.amountILS;
          });
          const top3 = Object.entries(byChatter).sort((a, b) => b[1] - a[1]).slice(0, 3);
          if (top3.length === 0) return null;
          const medals = ["🥇", "🥈", "🥉"];
          const medalColors = ["#f59e0b", "#9ca3af", "#cd7f32"];
          return <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.bdr}` }}>
            <div style={{ color: C.dim, fontSize: 12, marginBottom: 10, fontWeight: 600 }}>🏆 הצ'אטרים הכי רווחיים החודש</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {top3.map(([name, total], i) => (
                <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg, borderRadius: 8, padding: "8px 12px", border: `1px solid ${C.bdr}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>{medals[i]}</span>
                    <span style={{ color: name === chatterName ? C.pri : C.txt, fontWeight: name === chatterName ? 700 : 500, fontSize: 14 }}>
                      {name}{name === chatterName ? " (את/ה)" : ""}
                    </span>
                  </div>
                  <span style={{ color: medalColors[i], fontWeight: 700, fontSize: 15 }}>{fmtC(total)}</span>
                </div>
              ))}
            </div>
          </div>;
        })()}
      </Card>

      {/* Income Entry Form */}
      <Card style={{ marginBottom: 20 }}>
        <h3 style={{ color: C.txt, fontSize: 16, fontWeight: 700, marginBottom: 14 }}>📝 תיעוד הכנסה חדשה</h3>
        {saved && <div style={{ background: `${C.grn}22`, color: C.grn, padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 12, textAlign: "center" }}>✅ נשמר בהצלחה! ממתין לאישור מנהל.</div>}
        <div style={{ display: "grid", gridTemplateColumns: w < 768 ? "1fr" : "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>לקוחה *</label>
            <select value={form.modelName} onChange={e => upd("modelName", e.target.value)} style={inputStyle}>
              <option value="">בחר לקוחה...</option>
              {clientNames.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>פלטפורמה</label>
            <select value={form.platform} onChange={e => upd("platform", e.target.value)} style={inputStyle}>
              <option value="">בחר...</option>
              {["טלגרם", "אונלי"].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סוג הכנסה</label>
            <select value={form.incomeType} onChange={e => upd("incomeType", e.target.value)} style={inputStyle}>
              <option value="">בחר...</option>
              {incomeTypes.map(t => <option key={t} value={t}>{t}</option>)}
              <option value="__other__">אחר (רשום ידנית)</option>
            </select>
            {form.incomeType === "__other__" && <input type="text" value={form.customIncomeType} onChange={e => upd("customIncomeType", e.target.value)} placeholder="רשום סוג הכנסה..." style={{ ...inputStyle, marginTop: 6 }} />}
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>מטבע וסכום</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              {[{ key: "ILS", label: "₪ שקל" }, { key: "USD", label: "$ דולר" }].map(({ key, label }) => (
                <button key={key} type="button" onClick={() => { upd("currency", key); upd("amountILS", ""); upd("amountUSD", ""); }} style={{
                  flex: 1, padding: "10px", borderRadius: 8, fontSize: 14, fontWeight: 700,
                  cursor: "pointer",
                  background: form.currency === key ? C.grn : C.card,
                  color: form.currency === key ? "#fff" : C.dim,
                  border: `2px solid ${form.currency === key ? C.grn : C.bdr}`,
                  transition: "all .15s"
                }}>{label}</button>
              ))}
            </div>
            <input
              type="number"
              value={form.currency === "ILS" ? form.amountILS : form.amountUSD}
              onChange={e => form.currency === "ILS" ? upd("amountILS", e.target.value) : upd("amountUSD", e.target.value)}
              placeholder="0"
              style={{ ...inputStyle, direction: "ltr" }}
            />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>תאריך</label>
            <input type="date" value={form.date} onChange={e => upd("date", e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שעה</label>
            <input type="time" value={form.hour} onChange={e => upd("hour", e.target.value)} style={{ ...inputStyle, direction: "ltr", textAlign: "left" }} />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>מיקום</label>
            <div style={{ display: "flex", gap: 8 }}>
              {["משרד", "חוץ"].map(loc => (
                <button key={loc} onClick={() => upd("shiftLocation", loc)} style={{
                  flex: 1, padding: "10px", borderRadius: 8, fontSize: 14, fontWeight: 600,
                  cursor: "pointer", background: form.shiftLocation === loc ? C.pri : C.card,
                  color: form.shiftLocation === loc ? "#fff" : C.dim,
                  border: `2px solid ${form.shiftLocation === loc ? C.pri : C.bdr}`, transition: "all .15s"
                }}>{loc}</button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שם קונה</label>
            <input value={form.buyerName} onChange={e => upd("buyerName", e.target.value)} placeholder="אופציונלי" style={inputStyle} />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>הערות</label>
            <input value={form.notes} onChange={e => upd("notes", e.target.value)} placeholder="אופציונלי" style={inputStyle} />
          </div>
        </div>
        {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
        <Btn onClick={save} variant="success" size="lg" style={{ width: "100%", marginTop: 14 }} disabled={saving}>
          {saving ? "⏳ שומר..." : "💾 שמור הכנסה"}
        </Btn>
      </Card>

      {/* Per-client breakdown */}
      {byClient.length > 0 && <>
        <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>👩 הכנסות לפי לקוחה</h3>
        <DT textSm columns={[
          { label: "לקוחה", key: "name" },
          { label: "עסקאות", render: r => <span style={{ color: C.dim }}>{r.count}</span> },
          { label: "סכום ₪", render: r => <span style={{ color: C.grn, fontWeight: 700 }}>{fmtC(r.total)}</span> },
        ]} rows={byClient} footer={["סה״כ", myIncome.length, fmtC(myIncome.reduce((s, r) => s + r.amountILS, 0))]} />
      </>}

      {/* Pending Transactions */}
      {pending.length > 0 && <>
        <h3 style={{ color: C.ylw, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>⏳ ממתינות לאישור ({pending.length})</h3>
        <div style={{ marginBottom: 20 }}>
          <DT textSm columns={[
            { label: "תאריך", render: renderDateHour },
            { label: "סוג הכנסה", key: "incomeType" },
            { label: "שם קונה", render: r => r.buyerName || "—" },
            { label: "דוגמנית", key: "modelName" },
            { label: "פלטפורמה", key: "platform" },
            { label: "מיקום", key: "shiftLocation" },
            { label: "עמ׳ $", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtUSD(r.preCommissionUSD)}</span> : "" },
            { label: "עמ׳ ₪", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtC(r.preCommissionILS)}</span> : "" },
            { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> },
            { label: "סכום ₪", render: r => <span style={{ color: C.ylw }}>{fmtC(r.amountILS)}</span> },
            { label: "סטטוס", render: () => <span style={{ color: C.ylw }}>⏳ ממתין</span> }
          ]} rows={pending} footer={["סה״כ", "", "", "", "", "", "", fmtUSD(pending.reduce((s, r) => s + (r.amountUSD || 0), 0)), fmtC(totalPending), "", ""]} />
        </div>
      </>}

      {/* Approved Transactions */}
      <h3 style={{ color: C.grn, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>✅ מאושרות ({approved.length})</h3>
      {approved.length === 0 ? <Card style={{ textAlign: "center", padding: 20 }}><div style={{ color: C.mut, fontSize: 13 }}>אין עסקאות מאושרות עדיין</div></Card> :
        <DT textSm columns={[
          { label: "תאריך", render: renderDateHour },
          { label: "סוג הכנסה", key: "incomeType" },
          { label: "שם קונה", render: r => r.buyerName || "—" },
          { label: "דוגמנית", key: "modelName" },
          { label: "פלטפורמה", key: "platform" },
          { label: "מיקום", key: "shiftLocation" },
          { label: "עמ׳ $", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtUSD(r.preCommissionUSD)}</span> : "" },
          { label: "עמ׳ ₪", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtC(r.preCommissionILS)}</span> : "" },
          { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> },
          { label: "סכום ₪", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.amountILS)}</span> },
          { label: "סטטוס", render: r => <span style={{ color: r.cancelled ? C.ylw : C.dim }}>{r.cancelled ? "בוטל" : "✅"}</span> }
        ]} rows={approved} footer={["סה״כ", "", "", "", "", "", "", fmtUSD(approved.reduce((s, r) => s + (r.amountUSD || 0), 0)), fmtC(totalApproved), "", ""]} />
      }

    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// SHIFT MANAGER PORTAL
// ═══════════════════════════════════════════════════════
const SM_NAV = [
  { key: "main", label: "ראשי", icon: "👤" },
  { key: "approvals", label: "אישורים", icon: "✅" },
  { key: "chatters", label: "צ'אטרים", icon: "👥" },
];

function ShiftManagerPortal() {
  const { logout } = useApp();
  const w = useWin();
  const [smPage, setSmPage] = useState("main");

  const renderPage = () => {
    if (smPage === "approvals") return <ApprovalsPage />;
    if (smPage === "chatters") return <ChatterHub />;
    return <ChatterPortal hideHeader />;
  };

  return <div style={{ display: "flex", minHeight: "100vh", background: C.bg, direction: "rtl" }}>
    {/* Desktop Sidebar */}
    {w >= 768 && <div style={{ width: 180, background: C.card, borderLeft: `1px solid ${C.bdr}`, padding: "16px 0", display: "flex", flexDirection: "column", gap: 2, flexShrink: 0, height: "100vh", position: "sticky", top: 0 }}>
      <div style={{ padding: "0 16px 16px", borderBottom: `1px solid ${C.bdr}`, marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.pri }}>🔑 מנהל משמרת</div>
      </div>
      {SM_NAV.map(it => <button key={it.key} onClick={() => setSmPage(it.key)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: smPage === it.key ? `${C.pri}22` : "transparent", border: "none", borderRight: smPage === it.key ? `3px solid ${C.pri}` : "3px solid transparent", color: smPage === it.key ? C.pri : C.dim, cursor: "pointer", textAlign: "right", fontSize: 12, fontWeight: smPage === it.key ? 600 : 400, transition: "all .15s" }}><span style={{ fontSize: 14 }}>{it.icon}</span>{it.label}</button>)}
      <div style={{ flex: 1 }} />
      <button onClick={logout} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: "transparent", border: "none", color: C.red, cursor: "pointer", textAlign: "right", fontSize: 12 }}><span style={{ fontSize: 14 }}>🚪</span>יציאה</button>
    </div>}

    {/* Main content */}
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {smPage !== "main" && <div style={{ padding: w < 768 ? "14px 10px 80px" : "24px", overflowY: "auto", flex: 1 }}>{renderPage()}</div>}
      {smPage === "main" && renderPage()}
    </div>

    {/* Mobile bottom nav */}
    {w < 768 && <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.card, borderTop: `1px solid ${C.bdr}`, zIndex: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-around", padding: "6px 4px" }}>
        {SM_NAV.map(it => <button key={it.key} onClick={() => setSmPage(it.key)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: smPage === it.key ? C.pri : C.mut, cursor: "pointer", padding: "4px 10px", fontSize: 9, fontWeight: smPage === it.key ? 700 : 400 }}><span style={{ fontSize: 18 }}>{it.icon}</span>{it.label}</button>)}
        <button onClick={logout} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: C.red, cursor: "pointer", padding: "4px 10px", fontSize: 9 }}><span style={{ fontSize: 18 }}>🚪</span>צא</button>
      </div>
    </div>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// APPROVALS PAGE (ADMIN)
// ═══════════════════════════════════════════════════════
function isVerified(v) { return v === "V" || v === "מאומת"; }

function ApprovalsPage() {
  const { income, setIncome, demo, liveRate } = useApp();
  const [approving, setApproving] = useState(null);
  const [approveError, setApproveError] = useState(null);
  const [page, setPage] = useState(0);
  const [noteView, setNoteView] = useState(null);
  const [noteEdit, setNoteEdit] = useState(null); // { row, text }
  const [savingNote, setSavingNote] = useState(false);
  const PAGE_SIZE = 50;

  const pendingAll = useMemo(() =>
    income.filter(r => !isVerified(r.verified) && r.chatterName).sort((a, b) => {
      const da = a.date instanceof Date ? a.date.getTime() : 0;
      const db = b.date instanceof Date ? b.date.getTime() : 0;
      return db - da;
    }).map(r => applyCommission(r, liveRate)),
    [income, liveRate]);

  const pageCount = Math.max(1, Math.ceil(pendingAll.length / PAGE_SIZE));
  const visibleRows = pendingAll.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const approve = async (row) => {
    setApproving(row.id);
    setApproveError(null);
    try {
      if (!demo) {
        if (row._fromPending) {
          // approvePending writes a decision doc inside pendingIncome (addDoc only)
          await approvePending(row.id, row);
        } else if (row._rowIndex > 0) {
          const rowData = Array(16).fill(null);
          rowData[12] = "V";
          await API.update("sales_report", row._rowIndex, rowData);
        } else {
          // Regular income record (from 'income' collection) — update verified field
          await updateIncome(row.id, { verified: "V" });
        }
      }
      TelegramSvc.notifyIncomeApproved(row);
      setIncome(prev => prev.map(r => r.id === row.id ? { ...r, verified: "V" } : r));
    } catch (e) {
      console.error("Approve error:", e);
      setApproveError(`שגיאה באישור: ${e?.code || e?.message || String(e)}`);
    }
    setApproving(null);
  };

  const reject = async (row) => {
    if (!confirm(`לדחות עסקה של ${row.chatterName}?\n${row.modelName} — ${fmtC(row.amountILS)}`)) return;
    setApproving(row.id);
    try {
      if (!demo) {
        if (row._fromPending) {
          await rejectPending(row.id);
        } else if (row._rowIndex > 0) {
          await API.deleteRow("sales_report", row._rowIndex);
        } else {
          // Regular income record — mark as cancelled (soft delete)
          await updateIncome(row.id, { cancelled: true });
        }
      }
      setIncome(prev => prev.filter(r => r.id !== row.id));
    } catch (e) {
      console.error("Reject error:", e);
      setApproveError(`שגיאה בדחייה: ${e?.code || e?.message || String(e)}`);
    }
    setApproving(null);
  };

  const approveAll = async () => {
    if (!confirm(`לאשר את כל ${pendingAll.length} העסקאות הממתינות?`)) return;
    const ids = new Set(pendingAll.map(r => r.id));
    if (!demo) {
      for (const row of pendingAll) {
        if (row._fromPending) {
          try { await approvePending(row.id, row); } catch (e) { console.error("Approve all error:", e); }
        }
      }
    }
    setIncome(prev => prev.map(r => ids.has(r.id) ? { ...r, verified: "V" } : r));
  };

  const saveNote = async () => {
    if (!noteEdit) return;
    setSavingNote(true);
    const { row, text } = noteEdit;
    try {
      if (!demo) {
        if (row._fromPending) {
          await updatePending(row.id, { notes: text });
        } else {
          await updateIncome(row.id, { notes: text });
        }
      }
      setIncome(prev => prev.map(r => r.id === row.id ? { ...r, notes: text } : r));
      setNoteEdit(null);
    } catch (e) {
      console.error("Save note error:", e);
      setApproveError(`שגיאה בשמירת הערה: ${e?.code || e?.message || String(e)}`);
    }
    setSavingNote(false);
  };

  return <div style={{ direction: "rtl" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
      <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 800, margin: 0 }}>✅ אישור עסקאות</h2>
      <div style={{ display: "flex", gap: 8 }}>
        {pendingAll.length > 0 && <Btn variant="success" onClick={approveAll}>✅ אשר הכל ({pendingAll.length})</Btn>}
      </div>
    </div>

    {approveError && (
      <div style={{ background: "#3a1a1a", border: `1px solid ${C.red}`, borderRadius: 8, padding: "12px 16px", marginBottom: 16, color: C.red, fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>⚠️ {approveError}</span>
        <button onClick={() => setApproveError(null)} style={{ background: "none", border: "none", color: C.mut, cursor: "pointer", fontSize: 16 }}>✕</button>
      </div>
    )}

    {pendingAll.length === 0 ? (
      <Card style={{ textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
        <div style={{ color: C.grn, fontSize: 16, fontWeight: 700 }}>אין עסקאות ממתינות לאישור</div>
      </Card>
    ) : (<>
      <DT columns={[
        { label: "תאריך", render: r => { try { return fmtD(r.date); } catch { return "—"; } } },
        { label: "שעה", render: r => r.hour || "—" },
        { label: "צ'אטר", key: "chatterName" },
        { label: "לקוחה", key: "modelName" },
        { label: "שם קונה", render: r => r.buyerName || "—" },
        { label: "סוג הכנסה", render: r => r.incomeType || "—" },
        { label: "פלטפורמה", key: "platform" },
        { label: "מיקום", key: "shiftLocation" },
        { label: "לפני עמלה ($)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtUSD(r.preCommissionUSD)}</span> : "" },
        { label: "לפני עמלה (₪)", render: r => r.commissionPct > 0 ? <span style={{ color: C.dim }}>{fmtC(r.preCommissionILS)}</span> : "" },
        { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> },
        { label: "סכום ₪", render: r => <span style={{ fontWeight: 700, color: C.pri }}>{fmtC(r.amountILS)}</span> },
        {
          label: "הערות", render: r => {
            const notes = r.notes;
            if (!notes) return (
              <span onClick={() => setNoteEdit({ row: r, text: "" })} style={{ fontSize: 11, color: C.mut, cursor: "pointer" }} title="הוסף הערה">+ הערה</span>
            );
            const words = notes.trim().split(/\s+/);
            if (words.length <= 3) return (
              <span onClick={() => setNoteEdit({ row: r, text: notes })} style={{ fontSize: 11, color: C.dim, cursor: "pointer" }} title="ערוך הערה">{notes}</span>
            );
            return (
              <span onClick={() => setNoteView(notes)} style={{ fontSize: 11, color: C.pri, cursor: "pointer", whiteSpace: "nowrap" }} title="לחץ לצפייה בהערה המלאה">{words.slice(0, 3).join(" ")}...</span>
            );
          }
        },
        {
          label: "פעולות", render: r => (
            <div style={{ display: "flex", gap: 6 }}>
              <Btn size="sm" variant="success" onClick={() => approve(r)} disabled={approving === r.id}>
                {approving === r.id ? "⏳" : "✅ אשר"}
              </Btn>
              <Btn size="sm" variant="danger" onClick={() => reject(r)} disabled={approving === r.id}>❌</Btn>
            </div>
          )
        }
      ]} rows={visibleRows} footer={["סה״כ", "", "", "", fmtC(pendingAll.reduce((s, r) => s + r.amountILS, 0)), "", ""]} />
      {pageCount > 1 && <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16, alignItems: "center" }}>
        <Btn size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>→ הקודם</Btn>
        <span style={{ color: C.dim, fontSize: 13 }}>עמוד {page + 1} מתוך {pageCount} ({pendingAll.length} עסקאות)</span>
        <Btn size="sm" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>הבא ←</Btn>
      </div>}
    </>)}
    {noteView && <Modal open={true} onClose={() => setNoteView(null)} title="📝 הערה" width={400}>
      <p style={{ color: C.txt, lineHeight: 1.7, whiteSpace: "pre-wrap", margin: 0 }}>{noteView}</p>
    </Modal>}
    {noteEdit && <Modal open={true} onClose={() => setNoteEdit(null)} title="📝 הוסף / ערוך הערה" width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <textarea
          value={noteEdit.text}
          onChange={e => setNoteEdit(prev => ({ ...prev, text: e.target.value }))}
          placeholder="הכנס הערה..."
          rows={4}
          style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, padding: "10px 12px", fontSize: 13, resize: "vertical", direction: "rtl", outline: "none", width: "100%", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={() => setNoteEdit(null)}>ביטול</Btn>
          <Btn variant="primary" onClick={saveNote} disabled={savingNote}>{savingNote ? "⏳ שומר..." : "💾 שמור"}</Btn>
        </div>
      </div>
    </Modal>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// CLIENT PORTAL (for client login)
// ═══════════════════════════════════════════════════════
function ClientPortal() {
  const { user, logout, year, month, setMonth, loading, load, connected, setConnected, demo, loadDemo, clientSettings, settlements, chatterSettings } = useApp();
  const { iM, iY } = useFD();
  const w = useWin();
  const [view, setView] = useState("monthly");

  useEffect(() => { if (!connected && !demo) { load().then(() => setConnected(true)).catch(() => loadDemo()); } }, []);

  const clientName = user?.name;
  const allData = useMemo(() => iY.filter(r => r.modelName === clientName && !r.cancelled), [iY, clientName]);
  const monthData = useMemo(() => iM.filter(r => r.modelName === clientName && !r.cancelled), [iM, clientName]);
  const data = view === "monthly" ? monthData : allData;

  const ymi = ym(year, month);
  const pct = getRate(clientName, ymi);
  const vatClient = (clientSettings[clientName] || {}).vatClient ?? false;
  const relevantSettlements = useMemo(() => (settlements || []).filter(s => {
    const d = new Date(s.timestamp || s.date || Date.now());
    return view === "monthly" ? (d.getFullYear() === year && d.getMonth() === month) : d.getFullYear() === year;
  }), [settlements, view, year, month]);
  const bal = useMemo(() => Calc.clientBal(data, clientName, pct, relevantSettlements, chatterSettings), [data, clientName, pct, relevantSettlements, chatterSettings]);
  const txCount = data.length;

  // Targets: based on previous month's performance
  const targets = useMemo(() => {
    if (view !== "monthly") return null;
    const prevMonth = month - 1;
    const prevData = prevMonth >= 0 ? allData.filter(r => r.date.getMonth() === prevMonth) : [];
    const prevInc = prevData.reduce((s, r) => s + r.amountILS, 0);
    const prevDays = prevMonth >= 0 ? new Date(year, month, 0).getDate() : 31;
    const curDays = new Date(year, month + 1, 0).getDate();
    const t = Calc.targets(prevInc, prevDays, curDays);
    const curInc = monthData.reduce((s, r) => s + r.amountILS, 0);
    const isCurrent = month === new Date().getMonth() && year === new Date().getFullYear();
    const daysPassed = isCurrent ? Math.max(1, new Date().getDate()) : curDays;
    const dailyAvg = curInc / daysPassed;
    return { ...t, curInc, prevInc, dailyAvg, daysPassed, curDays, isCurrent };
  }, [allData, monthData, month, year, view]);

  if (loading) return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ color: C.pri, fontSize: 18 }}>⏳ טוען...</div></div>;

  return <div style={{ minHeight: "100vh", background: C.bg, padding: w < 768 ? 12 : 24 }}>
    <div style={{ maxWidth: 1100, margin: "0 auto", direction: "rtl" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700 }}>👩 שלום, {clientName}</h2>
        <Btn variant="ghost" size="sm" onClick={logout}>🚪 יציאה</Btn>
      </div>

      <FB>
        <Sel label="תצוגה:" value={view} onChange={setView} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />
        {view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}
      </FB>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon="💰" title="סה״כ הכנסות" value={fmtC(bal.totalIncome)} color={C.grn} />
        <Stat icon="📊" title="סה״כ עסקאות" value={txCount} color={C.pri} />
      </div>

      {/* Monthly Targets */}
      {targets && targets.prevInc > 0 && <Card style={{ marginBottom: 16 }}>
        <h3 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 12 }}>🎯 יעדים — {MONTHS_HE[month]}</h3>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.dim, marginBottom: 8 }}>
          <span>ממוצע יומי: <strong style={{ color: C.txt }}>{fmtC(targets.dailyAvg)}</strong></span>
          <span>חודש קודם: <strong style={{ color: C.txt }}>{fmtC(targets.prevInc)}</strong></span>
        </div>
        {[{ label: "יעד ברזל (+5%)", val: targets.t1, color: "#cd7f32" },
        { label: "יעד כסף (+10%)", val: targets.t2, color: "#c0c0c0" },
        { label: "יעד זהב (+15%)", val: targets.t3, color: "#ffd700" }
        ].map(t => {
          const pct = Math.min(100, targets.curInc / t.val * 100);
          const hit = targets.curInc >= t.val;
          return <div key={t.label} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: C.txt }}>{t.label}</span>
              <span style={{ color: hit ? C.grn : C.dim }}>{fmtC(t.val)} {hit ? "🎉" : ""}</span>
            </div>
            <div style={{ background: C.bg, borderRadius: 8, height: 8, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: hit ? C.grn : t.color, borderRadius: 8, transition: "width .5s" }} />
            </div>
          </div>;
        })}
      </Card>}

      {data.length > 0 && <Card style={{ marginBottom: 16 }}>
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie data={[{ name: "סוכנות", value: bal.through || 1 }, { name: "ישירות", value: bal.direct || 1 }]} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={11}>
              <Cell fill={C.pri} /><Cell fill={C.org} />
            </Pie>
            <Tooltip formatter={v => fmtC(v)} />
          </PieChart>
        </ResponsiveContainer>
      </Card>}

      {/* Payment Balance Card */}
      {data.length > 0 && (() => {
        const due = bal.actualDue;
        const clientOwes = due < 0;
        const agencyOwes = due > 0;
        const vatAmt = Math.abs(due) * 0.18;
        const totalWithVat = Math.abs(due) * 1.18;
        const borderColor = clientOwes ? C.red : agencyOwes ? C.grn : C.bdr;
        return <Card style={{ marginBottom: 16, border: `1px solid ${borderColor}` }}>
          <h3 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 14 }}>💳 תשלום</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: vatClient && Math.abs(due) >= 1 ? 14 : 0 }}>
            <Stat icon={clientOwes ? "🔴" : agencyOwes ? "🟢" : "⚪"}
              title={clientOwes ? "הלקוחה חייבת לסוכנות" : agencyOwes ? "הסוכנות חייבת ללקוחה" : "מאוזן"}
              value={Math.abs(due) < 1 ? "מאוזן" : fmtC(Math.abs(due))}
              color={clientOwes ? C.red : agencyOwes ? C.grn : C.mut}
              />
            {vatClient && Math.abs(due) >= 1 && <>
              <Stat icon="🧾" title="מע״מ 18%" value={fmtC(vatAmt)} color={C.ylw} />
              <Stat icon={clientOwes ? "🔴" : "🟢"} title={`סה״כ ${clientOwes ? "לתשלום" : "להחזר"} (כולל מע״מ)`} value={fmtC(totalWithVat)} color={clientOwes ? C.red : C.grn} />
            </>}
          </div>
        </Card>;
      })()}

      <Card>
        <h3 style={{ color: C.dim, fontSize: 14, marginBottom: 12 }}>🧾 פירוט עסקאות</h3>
        <DT textSm columns={[
          { label: "תאריך", render: renderDateHour },
          { label: "פלטפורמה", key: "platform" },
          { label: "סכום $", render: r => <span style={{ color: C.pri }}>{fmtUSD(r.amountUSD)}</span> },
          { label: "סכום ₪", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.amountILS)}</span> },
        ]} rows={data.sort((a, b) => ((b.date || 0) - (a.date || 0)) || (b.hour || "").localeCompare(a.hour || ""))} footer={["סה״כ", "", fmtUSD(data.reduce((s, r) => s + (r.amountUSD || 0), 0)), fmtC(bal.totalIncome)]} />
      </Card>
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// IMPORT FROM SHEETS (ONE-TIME)
// ═══════════════════════════════════════════════════════
function ImportFromSheetsCard() {
  const { setIncome, load } = useApp();
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState("");

  const handleMigrate = async () => {
    if (!confirm("זה יעביר את כל ההכנסות מגוגל שיטס ל-Firebase. להמשיך?")) return;
    setImporting(true); setResult(""); setProgress("מוריד נתונים מגוגל שיטס...");
    try {
      const imported = await IncSvc.migrateFromSheets((saved, total) => {
        setProgress(`שומר ב-Firebase... ${saved}/${total}`);
      });
      setResult(`✅ הועברו ${imported.length} הכנסות ל-Firebase בהצלחה!`);
      setProgress("");
      load(); // Reload from Firebase
    } catch (e) {
      setResult(`❌ שגיאה: ${e.message}`);
      setProgress("");
    }
    setImporting(false);
  };

  const handleMigrateUsers = async () => {
    if (!confirm("להעביר משתמשים מגוגל שיטס ל-Firebase?")) return;
    setImporting(true); setResult(""); setProgress("מוריד משתמשים...");
    try {
      const rows = await API.read("users");
      const users = rows.slice(1).map(r => ({
        name: String(r[0] || "").trim(),
        password: String(r[1] || "").trim(),
        role: String(r[2] || "chatter").trim()
      })).filter(u => u.name && u.password);
      await saveAllUsers(users);
      setResult(`✅ הועברו ${users.length} משתמשים ל-Firebase!`);
      setProgress("");
    } catch (e) {
      setResult(`❌ שגיאה: ${e.message}`);
      setProgress("");
    }
    setImporting(false);
  };

  return <Card style={{ marginBottom: 16, border: `1px solid ${C.pri}44` }}>
    <h4 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🔥 מיגרציה ל-Firebase</h4>
    <div style={{ color: C.dim, fontSize: 12, marginBottom: 12 }}>
      העבר נתונים מגוגל שיטס ל-Firebase (פעם אחת בלבד)
    </div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <Btn onClick={handleMigrate} disabled={importing}>
        {importing ? "⏳ מעביר..." : "📥 העבר הכנסות ל-Firebase"}
      </Btn>
      <Btn variant="warning" onClick={handleMigrateUsers} disabled={importing}>
        👤 העבר משתמשים ל-Firebase
      </Btn>
    </div>
    {progress && <div style={{ marginTop: 8, fontSize: 12, color: C.pri }}>{progress}</div>}
    {result && <div style={{ marginTop: 10, fontSize: 13, color: result.startsWith("✅") ? C.grn : C.red }}>{result}</div>}
  </Card>;
}

// ═══════════════════════════════════════════════════════
// USER MANAGEMENT (ADMIN)
// ═══════════════════════════════════════════════════════
function UserManagementPage() {
  const { sheetUsers, loadSheetUsers } = useApp();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState({ name: "", pass: "", role: "chatter" });
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => { loadUsers(); }, []);
  const loadUsers = async () => { setLoading(true); const u = await loadSheetUsers(); setUsers(u); setLoading(false); };

  const handleAdd = async () => {
    if (!newUser.name.trim() || !newUser.pass.trim()) { setErr("נא למלא שם וסיסמה"); return; }
    setAdding(true); setErr(""); setMsg("");
    try {
      await UserSvc.add(newUser.name.trim(), newUser.pass.trim(), newUser.role);
      setMsg(`✅ ${newUser.role === "chatter" ? "צ'אטר" : newUser.role === "shift_manager" ? "מנהל משמרת" : "לקוחה"} "${newUser.name}" נוסף/ה בהצלחה!`);
      setNewUser({ name: "", pass: "", role: newUser.role });
      await loadUsers();
    } catch (e) { setErr("שגיאה: " + e.message); }
    setAdding(false);
  };

  const handleDelete = async (u) => {
    if (!confirm(`למחוק את ${u.name}?`)) return;
    try {
      await UserSvc.remove(u._rowIndex);
      setMsg(`🗑️ ${u.name} נמחק/ה`);
      await loadUsers();
    } catch (e) { setErr("שגיאה במחיקה: " + e.message); }
  };

  const chatters = users.filter(u => u.role === "chatter");
  const clients = users.filter(u => u.role === "client");
  const shiftManagers = users.filter(u => u.role === "shift_manager");
  const inputStyle = { padding: "10px 12px", background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 14, outline: "none", flex: 1, minWidth: 100 };

  const [editPassUser, setEditPassUser] = useState(null); // { id, name }
  const [newPass, setNewPass] = useState("");
  const [savingPass, setSavingPass] = useState(false);
  const [adminPass, setAdminPass] = useState("");
  const [savingAdminPass, setSavingAdminPass] = useState(false);

  const [forcingLogout, setForcingLogout] = useState(false);

  const handleForceLogoutAll = async () => {
    if (!confirm("לנתק את כל המשתמשים? הם יצטרכו להתחבר מחדש.")) return;
    setForcingLogout(true); setErr(""); setMsg("");
    try {
      await forceLogoutAll();
      setMsg("✅ כל המשתמשים ינותקו בכניסה הבאה שלהם!");
    } catch (e) { setErr("שגיאה בניתוק: " + e.message); }
    setForcingLogout(false);
  };

  const handleAdminPassChange = async () => {
    if (!adminPass.trim()) { setErr("נא להזין סיסמה חדשה"); return; }
    setSavingAdminPass(true); setErr(""); setMsg("");
    try {
      await setAdminPassword(adminPass.trim());
      setMsg("✅ סיסמת האדמין עודכנה בהצלחה!");
      setAdminPass("");
    } catch (e) { setErr("שגיאה בעדכון סיסמה: " + e.message); }
    setSavingAdminPass(false);
  };

  const handleChangePassword = async () => {
    if (!newPass.trim()) { setErr("נא להזין סיסמה חדשה"); return; }
    setSavingPass(true); setErr(""); setMsg("");
    try {
      await UserSvc.updatePassword(editPassUser.id, newPass.trim());
      setMsg(`✅ הסיסמה של "${editPassUser.name}" עודכנה בהצלחה!`);
      setEditPassUser(null);
      setNewPass("");
      await loadUsers();
    } catch (e) { setErr("שגיאה בעדכון סיסמה: " + e.message); }
    setSavingPass(false);
  };

  const entityTable = (title, icon, list) => (
    <Card style={{ marginBottom: 16 }}>
      <h3 style={{ color: C.txt, fontSize: 15, fontWeight: 700, marginBottom: 12 }}>{icon} {title} ({list.length})</h3>
      {list.length === 0 ? <div style={{ color: C.mut, fontSize: 13 }}>אין {title} רשומים</div> :
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {list.map(u => (
            <div key={u._rowIndex} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: `${C.bg}88`, borderRadius: 8, fontSize: 13 }}>
              <div>
                <span style={{ color: C.txt, fontWeight: 600 }}>{u.name}</span>
                <span style={{ color: C.dim, marginRight: 8 }}> • ••••</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn variant="ghost" size="sm" onClick={() => { setEditPassUser({ id: u._rowIndex, name: u.name }); setNewPass(""); }} style={{ color: C.pri, fontSize: 12 }}>🔑 סיסמה</Btn>
                <Btn variant="ghost" size="sm" onClick={() => handleDelete(u)} style={{ color: C.red, fontSize: 12 }}>🗑️</Btn>
              </div>
            </div>
          ))}
        </div>
      }
    </Card>
  );

  if (loading) return <div style={{ direction: "rtl", textAlign: "center", padding: 40 }}><div style={{ color: C.pri }}>⏳ טוען משתמשים...</div></div>;

  return <div style={{ direction: "rtl", maxWidth: 700, margin: "0 auto" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>⚙️ ניהול משתמשים</h2>

    {msg && <Card style={{ marginBottom: 16, background: `${C.grn}15`, border: `1px solid ${C.grn}44` }}>
      <div style={{ color: C.grn, fontSize: 13 }}>{msg}</div>
    </Card>}
    {err && <Card style={{ marginBottom: 16, background: `${C.red}15`, border: `1px solid ${C.red}44` }}>
      <div style={{ color: C.red, fontSize: 13 }}>{err}</div>
    </Card>}

    {entityTable("צ'אטרים", "👤", chatters)}
    {entityTable("לקוחות", "👩", clients)}
    {entityTable("מנהלי משמרת", "🔑", shiftManagers)}

    <Card style={{ marginBottom: 24 }}>
      <h4 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 12 }}>➕ הוסף משתמש חדש</h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <select value={newUser.role} onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))} style={{ ...inputStyle, flex: "0 0 auto", minWidth: 90, cursor: "pointer" }}>
          <option value="chatter">צ'אטר</option>
          <option value="client">לקוחה</option>
          <option value="shift_manager">מנהל משמרת</option>
        </select>
        <input placeholder="שם" value={newUser.name} onChange={e => setNewUser(p => ({ ...p, name: e.target.value }))} style={inputStyle} />
        <input placeholder="סיסמה" value={newUser.pass} onChange={e => setNewUser(p => ({ ...p, pass: e.target.value }))} style={inputStyle} />
        <Btn onClick={handleAdd} disabled={adding} style={{ whiteSpace: "nowrap" }}>
          {adding ? "⏳ שומר..." : "➕ הוסף"}
        </Btn>
      </div>
      <div style={{ color: C.dim, fontSize: 11 }}>המשתמש יתווסף ישירות ויוכל להתחבר מיד — בלי deploy!</div>
    </Card>

    <Card style={{ marginBottom: 24 }}>
      <h4 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 12 }}>🔐 שינוי סיסמת אדמין</h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input type="text" placeholder="סיסמה חדשה לפורטל אדמין" value={adminPass} onChange={e => setAdminPass(e.target.value)} style={inputStyle} />
        <Btn onClick={handleAdminPassChange} disabled={savingAdminPass} style={{ whiteSpace: "nowrap" }}>
          {savingAdminPass ? "⏳ שומר..." : "🔐 עדכן סיסמה"}
        </Btn>
      </div>
    </Card>

    <Card style={{ marginBottom: 24 }}>
      <h4 style={{ color: C.txt, fontSize: 14, fontWeight: 700, marginBottom: 12 }}>🚪 ניתוק כל המשתמשים</h4>
      <div style={{ color: C.dim, fontSize: 12, marginBottom: 12 }}>מנתק את כל המשתמשים המחוברים — הם יצטרכו להתחבר מחדש עם הסיסמה החדשה.</div>
      <Btn onClick={handleForceLogoutAll} disabled={forcingLogout} style={{ background: C.red }}>
        {forcingLogout ? "⏳ מנתק..." : "🚪 נתק את כל המשתמשים"}
      </Btn>
    </Card>

    {editPassUser && <Modal open={true} onClose={() => setEditPassUser(null)} title={`🔑 שינוי סיסמה — ${editPassUser.name}`} width={380}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סיסמה חדשה</label>
          <input type="text" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="הזן סיסמה חדשה..." style={inputStyle} autoFocus />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={() => setEditPassUser(null)}>ביטול</Btn>
          <Btn variant="success" onClick={handleChangePassword} disabled={savingPass}>{savingPass ? "⏳ שומר..." : "💾 שמור"}</Btn>
        </div>
      </div>
    </Modal>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: DEBTS REPORT (דוח חובות)
// ═══════════════════════════════════════════════════════
function DebtsPage() {
  const { models, income, settlements, month, year, setMonth, addSettlement, chatterSettings, clientSettings } = useApp();
  const [debtsView, setDebtsView] = useState("monthly");
  const [modalClient, setModalClient] = useState(null);
  const [form, setForm] = useState({ amount: "", direction: "AgencyToClient", notes: "" });
  const [modalChatter, setModalChatter] = useState(null);
  const [chatterForm, setChatterForm] = useState({ amount: "", direction: "AgencyToChatter", notes: "" });
  const [saving, setSaving] = useState(false);

  const allClientNames = useMemo(() => [...new Set([...models.map(m => m.name), ...income.map(i => i.modelName)])].filter(Boolean), [models, income]);

  const yearIncome = useMemo(() => income.filter(r => new Date(r.date || 0).getFullYear() === year), [income, year]);

  const monthChatterSettlements = useMemo(() =>
    settlements.filter(s => s.entityType === "chatter" && new Date(s.timestamp || s.date || Date.now()).getMonth() === month && new Date(s.timestamp || s.date || Date.now()).getFullYear() === year),
    [settlements, month, year]);

  const chatterDebtRows = useMemo(() => {
    const names = [...new Set(income.map(r => r.chatterName).filter(Boolean))];
    return names.map(name => {
      const rows = income.filter(r => r.chatterName === name && new Date(r.date || 0).getMonth() === month && new Date(r.date || 0).getFullYear() === year);
      const cfg = (chatterSettings || {})[name] || {};
      const sal = Calc.chatterSalary(rows, cfg, ym(year, month));
      const paidDirect = rows.filter(r => (r.paymentTarget || (r.paidToClient ? "client" : "agency")) === "chatter").reduce((s, r) => s + r.amountILS, 0);
      let netSettled = 0;
      monthChatterSettlements.filter(s => s.modelName === name).forEach(s => {
        if (s.direction === "AgencyToChatter") netSettled += s.amount;
        if (s.direction === "ChatterToAgency") netSettled -= s.amount;
      });
      const balance = sal.total - paidDirect - netSettled;
      const hasVat = cfg.vatChatter ?? false;
      const vatAmt = Math.abs(balance) * 0.18;
      const finalBalance = Math.abs(balance) * (hasVat ? 1.18 : 1);
      return { name, sales: rows.reduce((s, r) => s + r.amountILS, 0), salary: sal.total, paidDirect, netSettled, balance, hasVat, vatAmt, finalBalance };
    }).sort((a, b) => b.sales - a.sales);
  }, [income, month, year, chatterSettings, monthChatterSettlements]);

  // Group data by client for the current month
  const monthData = useMemo(() => income.filter(r => new Date(r.date || 0).getMonth() === month && new Date(r.date || 0).getFullYear() === year), [income, month, year]);

  const debtRows = useMemo(() => {
    return allClientNames.map(clientName => {
      const pct = getRate(clientName, ym(year, month));
      const bal = Calc.clientBal(monthData, clientName, pct, settlements.filter(s => new Date(s.timestamp || s.date || Date.now()).getMonth() === month && new Date(s.timestamp || s.date || Date.now()).getFullYear() === year), chatterSettings);
      const hasVat = (clientSettings[clientName] || {}).vatClient ?? false;
      const vatAmt = Math.abs(bal.actualDue) * 0.18;
      const finalDue = Math.abs(bal.actualDue) * (hasVat ? 1.18 : 1);
      return {
        name: clientName,
        totalIncome: bal.totalIncome,
        direct: bal.direct,
        throughAgency: bal.through,
        pct: bal.pct,
        entitlement: bal.ent,
        netSettled: bal.netSettled,
        actualDue: bal.actualDue,
        hasVat, vatAmt, finalDue
      };
    }).sort((a, b) => b.totalIncome - a.totalIncome);
  }, [allClientNames, income, monthData, settlements, year, month, clientSettings]);

  // Yearly breakdown: per month totals across all clients
  const yearlyMonthRows = useMemo(() => {
    return MONTHS_HE.map((mName, mi) => {
      const mIncome = yearIncome.filter(r => new Date(r.date || 0).getMonth() === mi);
      const mSettlements = settlements.filter(s => {
        const d = new Date(s.timestamp || s.date || Date.now());
        return d.getMonth() === mi && d.getFullYear() === year;
      });
      let totalIncome = 0, totalEntitlement = 0, totalSettled = 0, totalDue = 0;
      allClientNames.forEach(clientName => {
        const pct = getRate(clientName, ym(year, mi));
        const bal = Calc.clientBal(mIncome, clientName, pct, mSettlements, chatterSettings);
        totalIncome += bal.totalIncome;
        totalEntitlement += bal.ent;
        totalSettled += bal.netSettled;
        totalDue += bal.actualDue;
      });
      return { month: mName, monthIdx: mi, totalIncome, totalEntitlement, totalSettled, totalDue };
    });
  }, [yearIncome, settlements, allClientNames, year]);

  // Yearly breakdown per client: total owed per client across the whole year
  const yearlyClientRows = useMemo(() => {
    return allClientNames.map(clientName => {
      const pct = getRate(clientName, ym(year, 0));
      const yearSets = settlements.filter(s => new Date(s.timestamp || s.date || Date.now()).getFullYear() === year);
      const bal = Calc.clientBal(yearIncome, clientName, pct, yearSets, chatterSettings);
      const hasVat = (clientSettings[clientName] || {}).vatClient ?? false;
      const finalDue = Math.abs(bal.actualDue) * (hasVat ? 1.18 : 1);
      return { name: clientName, totalIncome: bal.totalIncome, entitlement: bal.ent, netSettled: bal.netSettled, actualDue: bal.actualDue, hasVat, finalDue };
    }).filter(r => r.totalIncome > 0 || Math.abs(r.actualDue) > 0).sort((a, b) => b.totalIncome - a.totalIncome);
  }, [allClientNames, yearIncome, settlements, year, clientSettings]);

  const totalDue = debtRows.reduce((acc, r) => acc + r.actualDue, 0);
  const annualTotalDue = yearlyMonthRows.reduce((acc, r) => acc + r.totalDue, 0);
  const annualTotalSettled = yearlyMonthRows.reduce((acc, r) => acc + r.totalSettled, 0);
  const annualTotalEntitlement = yearlyMonthRows.reduce((acc, r) => acc + r.totalEntitlement, 0);

  const handleSave = async () => {
    if (!form.amount || isNaN(form.amount) || form.amount <= 0) return alert("הכנס סכום תקין");
    setSaving(true);
    try {
      const settlementData = {
        modelName: modalClient.name,
        amount: Number(form.amount),
        direction: form.direction,
        notes: form.notes,
        date: new Date().toISOString()
      };
      await addSettlement(settlementData);
      setModalClient(null);
    } catch (e) {
      alert("שגיאה במערכת: " + e.message);
    }
    setSaving(false);
  };

  const handleChatterSave = async () => {
    if (!chatterForm.amount || isNaN(chatterForm.amount) || chatterForm.amount <= 0) return alert("הכנס סכום תקין");
    setSaving(true);
    try {
      const chatterSettlementData = {
        modelName: modalChatter.name,
        entityType: "chatter",
        amount: Number(chatterForm.amount),
        direction: chatterForm.direction,
        notes: chatterForm.notes,
        date: new Date().toISOString()
      };
      await addSettlement(chatterSettlementData);
      setModalChatter(null);
    } catch (e) {
      alert("שגיאה במערכת: " + e.message);
    }
    setSaving(false);
  };

  return <div style={{ direction: "rtl", maxWidth: 1000, margin: "0 auto" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
      <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700 }}>⚖️ דוח חובות והתחשבנות</h2>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Sel label="תצוגה:" value={debtsView} onChange={v => setDebtsView(v)} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />
        {debtsView === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}
      </div>
    </div>

    {debtsView === "monthly" ? <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon={totalDue > 0 ? "🔴" : totalDue < 0 ? "🟢" : "⚪"} title={`סה״כ פער דורש קיזוז — ${MONTHS_HE[month]}`} value={Math.abs(totalDue) < 1 ? "מאוזן" : fmtC(Math.abs(totalDue))} color={totalDue > 0 ? C.red : totalDue < 0 ? C.grn : C.mut} sub={totalDue > 0 ? "הסוכנות חייבת ללקוחות" : totalDue < 0 ? "לקוחות חייבות לסוכנות" : ""} />
      </div>

      <Card style={{ padding: "0" }}>
        <DT
          columns={[
            { label: "לקוחה", key: "name", tdStyle: { fontWeight: "bold", color: C.txt } },
            { label: 'סה״כ הכנסות', render: r => <span style={{ color: C.dim }}>{fmtC(r.totalIncome)}</span> },
            { label: 'דרך סוכנות', render: r => <span style={{ color: C.dim }}>{fmtC(r.throughAgency)}</span> },
            { label: 'שולם ללקוחה ישירות', render: r => <span style={{ color: C.dim }}>{fmtC(r.direct)}</span> },
            { label: '% סוכנות', render: r => <span style={{ color: C.dim }}>{r.pct}%</span> },
            { label: 'שכר מגיע ללקוחה', render: r => <span style={{ color: C.pri }}>{fmtC(r.entitlement)}</span> },
            { label: 'קוזז החודש', render: r => <span style={{ color: C.ylw }}>{fmtC(r.netSettled)}</span> },
            {
              label: 'חוב מסכם לתשלום',
              render: r => {
                const bg = r.finalDue < 1 ? 'transparent' : (r.actualDue > 0 ? `${C.grn}15` : `${C.red}15`);
                const col = r.finalDue < 1 ? C.mut : (r.actualDue > 0 ? C.grn : C.red);
                const txt = r.finalDue < 1 ? 'מאוזן' : (r.actualDue > 0 ? 'אנחנו צריכים לשלם לה' : 'היא צריכה להעביר לנו');
                return <div style={{ background: bg, color: col, padding: "4px 8px", borderRadius: 4, fontWeight: "bold", fontSize: 13 }}>
                  {r.hasVat && r.finalDue >= 1 ? <>
                    <div style={{ fontSize: 10, color: C.dim }}>שכר: {fmtC(Math.abs(r.actualDue))}</div>
                    <div style={{ fontSize: 10, color: C.ylw }}>מע״מ 18%: {fmtC(r.vatAmt)}</div>
                    <div style={{ fontSize: 16 }}>{fmtC(r.finalDue)}</div>
                  </> : <div style={{ fontSize: 16 }}>{fmtC(r.finalDue)}</div>}
                  <div style={{ fontSize: 9 }}>{txt}{r.hasVat && r.finalDue >= 1 ? " (כולל מע״מ)" : ""}</div>
                </div>
              }
            },
            {
              label: 'פעולות',
              render: r => <Btn size="sm" variant="outline" onClick={() => { setModalClient(r); setForm({ amount: Math.abs(r.actualDue), direction: r.actualDue > 0 ? "AgencyToClient" : "ClientToAgency", notes: "" }) }}>
                ⚖️ בצע קיזוז
              </Btn>
            }
          ]}
          rows={debtRows}
          footer={null}
        />
      </Card>

      {/* Chatters reconciliation table */}
      <h3 style={{ color: C.txt, fontSize: 17, fontWeight: 700, marginTop: 32, marginBottom: 12 }}>👥 התחשבנות צ'אטרים — {MONTHS_HE[month]}</h3>
      {(() => {
        const weOwe = chatterDebtRows.filter(r => r.balance > 0).reduce((s, r) => s + r.finalBalance, 0);
        const theyOwe = chatterDebtRows.filter(r => r.balance < 0).reduce((s, r) => s + r.finalBalance, 0);
        const net = weOwe - theyOwe;
        const label = net > 0 ? "הסוכנות חייבת לצ'אטרים" : net < 0 ? "צ'אטרים חייבים לסוכנות" : "מאוזן";
        const col = net > 0 ? C.red : net < 0 ? C.grn : C.mut;
        return <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <Stat icon={net > 0 ? "🔴" : net < 0 ? "🟢" : "⚪"} title={label} value={fmtC(Math.abs(net))} color={col} />
        </div>;
      })()}
      <Card style={{ padding: 0, marginBottom: 32 }}>
        <DT columns={[
          { label: "צ'אטר", key: "name", tdStyle: { fontWeight: "bold", color: C.txt } },
          { label: "מכירות", render: r => <span style={{ color: C.dim }}>{fmtC(r.sales)}</span> },
          { label: "שכר מגיע", render: r => <span style={{ color: C.pri }}>{fmtC(r.salary)}</span> },
          { label: "שולם ישירות", render: r => <span style={{ color: C.grn }}>{fmtC(r.paidDirect)}</span> },
          { label: "קוזז החודש", render: r => <span style={{ color: C.ylw }}>{fmtC(r.netSettled)}</span> },
          { label: "יתרה לתשלום", render: r => {
            const col = Math.abs(r.balance) < 1 ? C.mut : r.balance > 0 ? C.red : C.grn;
            const txt = Math.abs(r.balance) < 1 ? "מאוזן" : r.balance > 0 ? "אנחנו חייבים" : "הוא חייב לנו";
            if (r.hasVat && Math.abs(r.balance) >= 1) {
              return <div style={{ color: col, fontWeight: 700 }}>
                <div style={{ fontSize: 11, color: C.dim }}>לפני מע״מ: {fmtC(Math.abs(r.balance))}</div>
                <div style={{ fontSize: 11, color: C.ylw }}>מע״מ 18%: {fmtC(r.vatAmt)}</div>
                <div style={{ fontSize: 14 }}>סה״כ: {fmtC(r.finalBalance)}</div>
                <div style={{ fontSize: 10 }}>{txt} + מע״מ</div>
              </div>;
            }
            return <div style={{ color: col, fontWeight: 700 }}><div>{fmtC(r.finalBalance)}</div><div style={{ fontSize: 10 }}>{txt}</div></div>;
          }},
          {
            label: "פעולות",
            render: r => <Btn size="sm" variant="outline" onClick={() => { setModalChatter(r); setChatterForm({ amount: Math.abs(r.balance), direction: r.balance > 0 ? "AgencyToChatter" : "ChatterToAgency", notes: "" }); }}>
              ⚖️ בצע קיזוז
            </Btn>
          }
        ]} rows={chatterDebtRows} footer={["סה״כ", fmtC(chatterDebtRows.reduce((s,r)=>s+r.sales,0)), fmtC(chatterDebtRows.reduce((s,r)=>s+r.salary,0)), fmtC(chatterDebtRows.reduce((s,r)=>s+r.paidDirect,0)), fmtC(chatterDebtRows.reduce((s,r)=>s+r.netSettled,0)), ""  , ""]} />
      </Card>
    </> : <>
      {/* ── YEARLY VIEW ── */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon="📊" title={`סה״כ שכר ללקוחות — ${year}`} value={fmtC(annualTotalEntitlement)} color={C.pri} sub="סה״כ מגיע לכולן" />
        <Stat icon="✅" title={`סה״כ קוזז — ${year}`} value={fmtC(annualTotalSettled)} color={C.ylw} sub="שולם/קוזז בפועל" />
        <Stat icon="⚠️" title={`נשאר לקיזוז — ${year}`} value={fmtC(Math.abs(annualTotalDue))} color={annualTotalDue > 0 ? C.grn : C.red} sub={annualTotalDue > 0 ? "הסוכנות חייבת" : "לקוחות חייבות"} />
      </div>

      {/* Monthly breakdown table */}
      <h3 style={{ color: C.txt, fontSize: 16, fontWeight: 700, marginBottom: 10 }}>📅 פירוט חודשי — {year}</h3>
      <Card style={{ padding: 0, marginBottom: 28 }}>
        <DT columns={[
          { label: "חודש", render: r => <button onClick={() => { setMonth(r.monthIdx); setDebtsView("monthly"); }} style={{ background: "none", border: "none", color: C.pri, cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0 }}>{r.month} ↗</button> },
          { label: "סה״כ הכנסות", render: r => <span style={{ color: C.dim }}>{r.totalIncome > 0 ? fmtC(r.totalIncome) : "—"}</span> },
          { label: "שכר ללקוחות", render: r => <span style={{ color: C.pri }}>{r.totalEntitlement > 0 ? fmtC(r.totalEntitlement) : "—"}</span> },
          { label: "קוזז", render: r => <span style={{ color: C.ylw }}>{r.totalSettled !== 0 ? fmtC(r.totalSettled) : "—"}</span> },
          { label: "נשאר לקיזוז", render: r => {
            if (Math.abs(r.totalDue) < 1) return <span style={{ color: C.mut }}>מאוזן</span>;
            const col = r.totalDue > 0 ? C.grn : C.red;
            const txt = r.totalDue > 0 ? "אנחנו חייבים" : "לקוחות חייבות";
            return <div style={{ color: col, fontWeight: 700, fontSize: 13 }}>{fmtC(Math.abs(r.totalDue))}<div style={{ fontSize: 10, fontWeight: 400 }}>{txt}</div></div>;
          }}
        ]} rows={yearlyMonthRows}
        footer={["סה״כ שנתי", fmtC(yearlyMonthRows.reduce((s,r)=>s+r.totalIncome,0)), fmtC(annualTotalEntitlement), fmtC(annualTotalSettled), fmtC(Math.abs(annualTotalDue))]} />
      </Card>

      {/* Per-client annual breakdown */}
      <h3 style={{ color: C.txt, fontSize: 16, fontWeight: 700, marginBottom: 10 }}>👤 פירוט לפי לקוחה — {year}</h3>
      <Card style={{ padding: 0, marginBottom: 32 }}>
        <DT columns={[
          { label: "לקוחה", key: "name", tdStyle: { fontWeight: "bold", color: C.txt } },
          { label: "סה״כ הכנסות", render: r => <span style={{ color: C.dim }}>{fmtC(r.totalIncome)}</span> },
          { label: "שכר מגיע", render: r => <span style={{ color: C.pri }}>{fmtC(r.entitlement)}</span> },
          { label: "קוזז", render: r => <span style={{ color: C.ylw }}>{fmtC(r.netSettled)}</span> },
          { label: "נשאר לקיזוז", render: r => {
            if (Math.abs(r.actualDue) < 1) return <span style={{ color: C.mut }}>מאוזן</span>;
            const col = r.actualDue > 0 ? C.grn : C.red;
            const txt = r.actualDue > 0 ? "אנחנו חייבים לה" : "היא חייבת לנו";
            return <div style={{ color: col, fontWeight: 700 }}>
              {fmtC(r.hasVat ? r.finalDue : Math.abs(r.actualDue))}
              {r.hasVat && <div style={{ fontSize: 10, color: C.ylw }}>כולל מע״מ</div>}
              <div style={{ fontSize: 10, fontWeight: 400 }}>{txt}</div>
            </div>;
          }}
        ]} rows={yearlyClientRows}
        footer={["סה״כ", fmtC(yearlyClientRows.reduce((s,r)=>s+r.totalIncome,0)), fmtC(yearlyClientRows.reduce((s,r)=>s+r.entitlement,0)), fmtC(yearlyClientRows.reduce((s,r)=>s+r.netSettled,0)), fmtC(Math.abs(yearlyClientRows.reduce((s,r)=>s+r.actualDue,0)))]} />
      </Card>
    </>}

    {modalClient && <Modal open={true} onClose={() => setModalClient(null)} title={`תיעוד העברה לקיזוז חוב: ${modalClient.name}`} width={400}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ color: C.dim, fontSize: 13, marginBottom: 10 }}>יתרת חוב מצב נוכחי: <strong style={{ color: C.txt }}>{fmtC(Math.abs(modalClient.actualDue))}</strong> ({modalClient.actualDue >= 0 ? "הסוכנות חייבת" : "הלקוחה חייבת"})</p>

        <label style={{ color: C.dim, fontSize: 12 }}>כיוון העברה</label>
        <select value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value })} style={{ padding: 12, borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, outline: "none" }}>
          <option value="AgencyToClient">הסוכנות משלמת/מעבירה ללקוחה (+)</option>
          <option value="ClientToAgency">הלקוחה מעבירה לסוכנות (-)</option>
        </select>

        <label style={{ color: C.dim, fontSize: 12 }}>סכום (₪)</label>
        <input type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} style={{ padding: 12, borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, outline: "none", fontSize: 18 }} placeholder="לדוגמה 1000" />

        <label style={{ color: C.dim, fontSize: 12 }}>הערה (אופציונלי)</label>
        <input type="text" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ padding: 12, borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, outline: "none" }} placeholder="העברה בביט / מזומן / סיבת קיזוז" />

        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <Btn style={{ flex: 1 }} variant="success" onClick={handleSave} disabled={saving}>{saving ? "⏳" : "💾 תעד המרה/קיזוז"}</Btn>
          <Btn variant="ghost" onClick={() => setModalClient(null)}>ביטול</Btn>
        </div>
      </div>
    </Modal>}

    {modalChatter && <Modal open={true} onClose={() => setModalChatter(null)} title={`תיעוד קיזוז לצ'אטר: ${modalChatter.name}`} width={400}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ color: C.dim, fontSize: 13, marginBottom: 10 }}>יתרת חוב מצב נוכחי: <strong style={{ color: C.txt }}>{fmtC(Math.abs(modalChatter.balance))}</strong> ({modalChatter.balance >= 0 ? "הסוכנות חייבת לצ'אטר" : "הצ'אטר חייב לסוכנות"})</p>

        <label style={{ color: C.dim, fontSize: 12 }}>כיוון העברה</label>
        <select value={chatterForm.direction} onChange={e => setChatterForm({ ...chatterForm, direction: e.target.value })} style={{ padding: 12, borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, outline: "none" }}>
          <option value="AgencyToChatter">הסוכנות משלמת/מעבירה לצ'אטר (+)</option>
          <option value="ChatterToAgency">הצ'אטר מעביר לסוכנות (-)</option>
        </select>

        <label style={{ color: C.dim, fontSize: 12 }}>סכום (₪)</label>
        <input type="number" value={chatterForm.amount} onChange={e => setChatterForm({ ...chatterForm, amount: e.target.value })} style={{ padding: 12, borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, outline: "none", fontSize: 18 }} placeholder="לדוגמה 1000" />

        <label style={{ color: C.dim, fontSize: 12 }}>הערה (אופציונלי)</label>
        <input type="text" value={chatterForm.notes} onChange={e => setChatterForm({ ...chatterForm, notes: e.target.value })} style={{ padding: 12, borderRadius: 8, background: C.bg, border: `1px solid ${C.bdr}`, color: C.txt, outline: "none" }} placeholder="העברה בביט / מזומן / סיבת קיזוז" />

        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <Btn style={{ flex: 1 }} variant="success" onClick={handleChatterSave} disabled={saving}>{saving ? "⏳" : "💾 תעד קיזוז"}</Btn>
          <Btn variant="ghost" onClick={() => setModalChatter(null)}>ביטול</Btn>
        </div>
      </div>
    </Modal>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
const PAGES = { dashboard: DashPage, income: IncPage, expenses: ExpPage, chatters: ChatterHub, clients: ClientHub, debts: DebtsPage, targets: TgtPage, record: RecordExpensePage, generator: GeneratorPage, approvals: ApprovalsPage, users: UserManagementPage };
function Content() {
  const { page, setPage, connected, user, load } = useApp();
  const w = useWin();
  if (import.meta.env.VITE_USE_AUTH === "true" && !user) return <LoginPage />;
  if (user?.role === "chatter") return <ChatterPortal />;
  if (user?.role === "shift_manager") return <ShiftManagerPortal />;
  if (user?.role === "client") return <ClientPortal />;
  // SetupPage disabled — connection is managed automatically
  const P = PAGES[page] || DashPage;
  return <div style={{ display: "flex", minHeight: "100vh", background: C.bg }}><Sidebar current={page} onNav={setPage} /><div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}><TopBar /><div style={{ flex: 1, padding: w < 768 ? "14px 10px 80px" : "24px", overflowY: "auto" }}><P /></div></div><MobileNav current={page} onNav={setPage} /></div>;
}
export default function App() { return <Prov><style>{`*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:#0f172a}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}select option{background:#1e293b;color:#f8fafc}`}</style><Content /></Prov>; }
