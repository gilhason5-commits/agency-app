import { useState, useEffect, useCallback, createContext, useContext, useMemo, useRef } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart, Area } from "recharts";

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
const APPS_SCRIPT_URL = import.meta.env.VITE_APPS_SCRIPT_URL || "";
const EXPENSES_URL = import.meta.env.VITE_EXPENSES_URL || "";
const GROK_API_KEY_DEFAULT = import.meta.env.VITE_GROK_API_KEY || "";

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
function fmtC(n) { if (n == null || isNaN(n)) return "₪0"; return `${n < 0 ? "-" : ""}₪${Math.abs(n).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
function ym(y, m) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
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
// DATA MAPPING
// ═══════════════════════════════════════════════════════
// Columns: A=Timestamp(0), B=chatter(1), C=model(2), D=client(3), E=rate(4), F=usd(5), G=ils(6), H=type(7), I=platform(8), J=date(9), K=hour(10), L=notes(11), M=verified(12), N=location(13), O=paidToClient(14), P=cancelled(15)
function mapInc(row, i) {
  const cancelled = String(row[15]).trim() === "V" || false;
  const hourRaw = row[10] || "";
  const hour = (typeof hourRaw === "string" && hourRaw.includes("T")) ? hourRaw.split("T")[1].slice(0, 5) : hourRaw;
  const typeRaw = row[7] || "";
  const incomeType = (typeRaw instanceof Date || (typeof typeRaw === "number" && typeRaw < 2)) ? "" : typeRaw;

  const rawILS = +row[6] || 0;
  const rawUSD = +row[5] || 0;
  const rate = +row[4] || 0;
  // If ILS is missing but USD exists, compute ILS from USD × rate
  const computedILS = rawILS > 0 ? rawILS : (rawUSD > 0 && rate > 0 ? Math.round(rawUSD * rate) : 0);

  return {
    id: `I-${i}-${Date.now()}`,
    _rowIndex: i + 2,
    chatterName: row[1] || "", modelName: row[2] || "", clientName: row[3] || "",
    usdRate: rate,
    amountUSD: cancelled ? 0 : rawUSD,
    amountILS: cancelled ? 0 : computedILS,
    originalAmount: computedILS,
    incomeType, platform: row[8] || "",
    date: parseDate(row[9]), hour,
    notes: row[11] || "", verified: row[12] || "", shiftLocation: row[13] || "",
    paidToClient: String(row[14]).trim() === "V",
    cancelled
  };
}
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
  async fetchAll() {
    const rows = await API.read("sales_report");
    // Include rows with ILS or USD amounts
    return rows.slice(1).map((r, i) => mapInc(r, i)).filter(r => r.originalAmount > 0 || r.amountUSD > 0);
  },
  async togglePaidToClient(incRow) {
    const newVal = incRow.paidToClient ? "" : "V";
    if (!incRow._rowIndex) return { ...incRow, paidToClient: !incRow.paidToClient }; // Demo mode fallback
    // Using a partial update (if supported) or full row reconstruction.
    // If we must supply the full row, we reconstruct it based on mapInc:
    const d = incRow.date instanceof Date ? incRow.date : new Date(incRow.date);
    const rowData = [
      "", // Timestamp placeholder (0)
      incRow.chatterName, incRow.modelName, incRow.clientName, // 1,2,3
      incRow.usdRate, incRow.amountUSD, incRow.amountILS, // 4,5,6
      incRow.incomeType, incRow.platform, // 7,8
      fmtD(d), incRow.hour, // 9,10
      incRow.notes, incRow.verified, incRow.shiftLocation, // 11,12,13
      newVal, // 14: paidToClient
      incRow.cancelled ? "V" : "" // 15: cancelled
    ];
    await API.update("sales_report", incRow._rowIndex, rowData);
    return { ...incRow, paidToClient: !incRow.paidToClient };
  },
  async cancelTransaction(incRow) {
    if (!incRow._rowIndex) return { ...incRow, cancelled: true, amountILS: 0, amountUSD: 0 }; // Demo mode fallback
    // Alternatively, fully delete: return API.deleteRow("sales_report", incRow._rowIndex);
    // But user asked for a line through, implying we should "mark" it cancelled.
    const d = incRow.date instanceof Date ? incRow.date : new Date(incRow.date);
    const rowData = [
      "", incRow.chatterName, incRow.modelName, incRow.clientName,
      incRow.usdRate, incRow.amountUSD, incRow.amountILS,
      incRow.incomeType, incRow.platform,
      fmtD(d), incRow.hour,
      incRow.notes, incRow.verified, incRow.shiftLocation,
      incRow.paidToClient ? "V" : "",
      "V" // 15: cancelled = V
    ];
    await API.update("sales_report", incRow._rowIndex, rowData);
    // To retain the history and calculate 0 correctly in zero out amountILS, we also alter the client-side state
    return { ...incRow, cancelled: true, amountILS: 0, amountUSD: 0 };
  }
};
const ExpSvc = {
  async fetchAll() {
    try { const rows = await API.read("כל החשבוניות", EXPENSES_URL); return rows.slice(1).map((r, i) => mapExp(r, i)); }
    catch (e) { console.log("Expenses sheet not ready:", e.message); return []; }
  },
  async add(e) {
    const id = `EXP-${Date.now()}`; const d = e.date instanceof Date ? e.date : new Date(e.date);
    return API.append("כל החשבוניות", [[fmtD(d), "חשבונית מס קבלה", e.name, e.amount, e.vatRecognized ? "כן" : "לא", e.taxRecognized ? "כן" : "לא", e.category, e.paidBy, e.hour || "", e.receiptImage || "", "", "", e.classification || ""]], EXPENSES_URL);
  },
  async edit(e) {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    return API.update("כל החשבוניות", e._rowIndex, [fmtD(d), e.docType || "חשבונית מס קבלה", e.name, e.amount, e.vatRecognized ? "כן" : "לא", e.taxRecognized ? "כן" : "לא", e.category, e.paidBy, e.hour || "", e.receiptImage || "", "", "", e.classification || ""], EXPENSES_URL);
  },
  async remove(e) {
    return API.deleteRow("כל החשבוניות", e._rowIndex, EXPENSES_URL);
  },
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
  chatterSalary(rows) { let o = 0, r = 0; rows.forEach(x => { if (x.shiftLocation === "משרד") o += x.amountILS; else r += x.amountILS; }); return { oSales: o, rSales: r, oSal: o * .17, rSal: r * .15, total: o * .17 + r * .15 }; },
  clientBal(rows, cn, pct) {
    const clRows = rows.filter(r => r.modelName === cn);
    const tot = clRows.reduce((s, r) => s + r.amountILS, 0);
    const direct = clRows.filter(r => r.incomeType === cn || r.paidToClient).reduce((s, r) => s + r.amountILS, 0);
    const ent = tot * (pct / 100);
    return { totalIncome: tot, direct, through: tot - direct, pct, ent, bal: ent - direct, actualDue: ent - direct };
  },
  offset(exps) { const d = exps.filter(e => e.paidBy === "דור").reduce((s, e) => s + e.amount, 0); const y = exps.filter(e => e.paidBy === "יוראי").reduce((s, e) => s + e.amount, 0); return { dor: d, yurai: y, off: Math.abs(d - y) / 2, owes: d > y ? "יוראי" : "דור", paid: d > y ? "דור" : "יוראי" }; },
  profit(inc, exp) { const i = inc.reduce((s, r) => s + r.amountILS, 0); const e = exp.reduce((s, x) => s + x.amount, 0); return { inc: i, exp: e, profit: i - e }; },
  targets(prevInc, prevDays, nextDays) {
    if (!prevDays || !nextDays) return { t1: 0, t2: 0, t3: 0, daily: 0 };
    const daily = prevInc / prevDays;
    return { daily, t1: daily * 1.05 * nextDays, t2: daily * 1.10 * nextDays, t3: daily * 1.15 * nextDays };
  }
};
const _rates = {}; function getRate(n, ymi) { return _rates[n]?.[ymi] ?? 0; } function setRate(n, ymi, p) { if (!_rates[n]) _rates[n] = {}; _rates[n][ymi] = p; }

// ═══════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════
const Ctx = createContext(null);
function Prov({ children }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [view, setView] = useState("monthly");
  const [page, setPage] = useState("dashboard");
  const [income, setIncome] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [models, setModels] = useState([]);
  const [history, setHistory] = useState([]);
  const [genParams, setGenParams] = useState(DEFAULT_PARAMS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(() => localStorage.getItem("AGENCY_CONNECTED") === "true");
  const [demo, setDemo] = useState(false);
  const [rv, setRv] = useState(0);
  const [loadStep, setLoadStep] = useState("");
  const updRate = useCallback((n, ymi, p) => { setRate(n, ymi, p); setRv(v => v + 1); }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setLoadStep("מתחבר...");
    try {
      setLoadStep("קורא נתוני הכנסות מ-sales_report...");
      const inc = await IncSvc.fetchAll();
      console.log("Fetched income:", inc);
      setIncome(inc);
      setLoadStep(`נטענו ${inc.length} שורות הכנסה`);
      try { const exp = await ExpSvc.fetchAll(); console.log("Fetched expenses:", exp); setExpenses(exp); } catch (e) { console.error(e); }
      setConnected(true);
      localStorage.setItem("AGENCY_CONNECTED", "true");
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
  }, []);

  const loadDemo = useCallback(() => {
    setDemo(true);
    const ch = ["נועם", "שירה", "דנה", "אלון", "מיכל"], cl = ["יעל", "רוני", "נועה", "תמר", "ליאת"], pl = ["OnlyFans", "Fansly", "Instagram", "TikTok"], lo = ["משרד", "חוץ"];
    const di = []; for (let m = 0; m < 12; m++) { const cnt = 30 + Math.floor(Math.random() * 40); for (let i = 0; i < cnt; i++) { const day = Math.floor(Math.random() * 28) + 1, ils = Math.floor(Math.random() * 3000) + 200, c = cl[Math.floor(Math.random() * cl.length)]; di.push({ id: `demo-I-${m}-${i}-${Date.now()}`, chatterName: ch[Math.floor(Math.random() * ch.length)], modelName: c, clientName: c, usdRate: 3.6, amountUSD: Math.round(ils / 3.6), amountILS: ils, originalAmount: ils, incomeType: Math.random() < .25 ? c : "", platform: pl[Math.floor(Math.random() * pl.length)], date: new Date(year, m, day), hour: `${Math.floor(Math.random() * 24)}:00`, notes: "", verified: "", shiftLocation: lo[Math.floor(Math.random() * lo.length)] }); } }
    const de = []; EXPENSE_CATEGORIES.forEach(cat => { for (let m = 0; m < 12; m++) { const n = Math.floor(Math.random() * 3) + 1; for (let i = 0; i < n; i++) { de.push({ id: `E${Date.now()}-${Math.random()}`, category: cat, name: `${cat} #${i + 1}`, amount: Math.floor(Math.random() * 5000) + 100, date: new Date(year, m, Math.floor(Math.random() * 28) + 1), hour: "12:00", paidBy: Math.random() > .5 ? "דור" : "יוראי", vatRecognized: Math.random() > .4, taxRecognized: Math.random() > .2, year, month: m + 1, source: Math.random() > .5 ? "אוטומטי" : "ידני", receiptImage: null, _rowIndex: 0 }); } } });
    cl.forEach(c => { for (let m = 0; m < 12; m++)setRate(c, ym(year, m), Math.floor(Math.random() * 20) + 25); });
    setIncome(di); setExpenses(de); setConnected(true); setRv(v => v + 1);
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
  const login = (pass, chatterName) => {
    if (chatterName) {
      // Chatter login
      const chatters = {};
      (import.meta.env.VITE_CHATTERS || "").split(",").filter(Boolean).forEach(pair => {
        const [n, p] = pair.split(":");
        if (n && p) chatters[n.trim()] = p.trim();
      });
      if (chatters[chatterName] && chatters[chatterName] === pass) {
        const u = { role: "chatter", name: chatterName };
        setUser(u); localStorage.setItem("AGENCY_USER", JSON.stringify(u)); return true;
      }
      return false;
    }
    // Admin login
    const correct = import.meta.env.VITE_APP_PASSWORD || "1234";
    if (pass === correct) {
      const u = { role: "admin", name: "admin" };
      setUser(u); localStorage.setItem("AGENCY_USER", JSON.stringify(u)); return true;
    }
    return false;
  };
  const logout = () => { setUser(null); localStorage.removeItem("AGENCY_USER"); };

  const val = useMemo(() => ({
    year, setYear, month, setMonth, view, setView, page, setPage,
    income, setIncome, expenses, setExpenses, models, setModels,
    history, setHistory, genParams, setGenParams, loading, error,
    connected, setConnected, demo, setDemo, load, loadDemo, rv, updRate,
    loadStep, user, login, logout
  }), [year, month, view, page, income, expenses, models, history, genParams, loading, error, connected, demo, load, loadDemo, rv, updRate, loadStep, user]);

  return <Ctx.Provider value={val}>{children}</Ctx.Provider>;
}

// ═══════════════════════════════════════════════════════
// PAGE: LOGIN
// ═══════════════════════════════════════════════════════
function LoginPage() {
  const { login } = useApp();
  const [tab, setTab] = useState("admin");
  const [pass, setPass] = useState("");
  const [chatterName, setChatterName] = useState("");
  const [chatterPass, setChatterPass] = useState("");
  const [err, setErr] = useState("");

  const handleAdmin = (e) => {
    e.preventDefault();
    if (login(pass)) setErr("");
    else setErr("סיסמה שגויה");
  };
  const handleChatter = (e) => {
    e.preventDefault();
    if (!chatterName.trim()) { setErr("אנא הזן שם משתמש"); return; }
    if (login(chatterPass, chatterName.trim())) setErr("");
    else setErr("שם משתמש או סיסמה שגויים");
  };

  const tabBtn = (key, label, icon) => (
    <button onClick={() => { setTab(key); setErr(""); }} style={{
      flex: 1, padding: "12px 8px", background: tab === key ? C.pri : "transparent",
      color: tab === key ? "#fff" : C.dim, border: `1px solid ${tab === key ? C.pri : C.bdr}`,
      borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 13, transition: "all .2s"
    }}>{icon} {label}</button>
  );

  const inputStyle = { width: "100%", padding: "14px 16px", background: C.bg, border: `2px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: 16, outline: "none", marginBottom: 12, textAlign: "center", boxSizing: "border-box" };

  return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <Card style={{ width: "100%", maxWidth: 380, padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🏢</div>
      <h1 style={{ color: C.txt, fontSize: 24, fontWeight: 800, marginBottom: 20 }}>ניהול סוכנות</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabBtn("admin", "מנהל", "🔐")}
        {tabBtn("chatter", "צ'אטר", "👤")}
      </div>
      {tab === "admin" ? (
        <form onSubmit={handleAdmin}>
          <p style={{ color: C.dim, fontSize: 13, marginBottom: 14 }}>הזן סיסמת מנהל</p>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="סיסמה" autoFocus style={inputStyle} />
          {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <Btn size="lg" style={{ width: "100%" }}>התחברות</Btn>
        </form>
      ) : (
        <form onSubmit={handleChatter}>
          <p style={{ color: C.dim, fontSize: 13, marginBottom: 14 }}>הזן שם משתמש וסיסמה</p>
          <input type="text" value={chatterName} onChange={e => setChatterName(e.target.value)} placeholder="שם משתמש" autoFocus style={inputStyle} />
          <input type="password" value={chatterPass} onChange={e => setChatterPass(e.target.value)} placeholder="סיסמה" style={inputStyle} />
          {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <Btn size="lg" style={{ width: "100%" }}>כניסה</Btn>
        </form>
      )}
    </Card>
  </div>;
}
function useApp() { return useContext(Ctx); }

function useFD() {
  const { year, month, view, income, expenses, models, genParams } = useApp();
  const dM = useMemo(() => new Date(year, month, 1), [year, month]);
  const iY = useMemo(() => income.filter(r => r.date && r.date.getFullYear() === year), [income, year]);
  const iM = useMemo(() => iY.filter(r => r.date.getMonth() === month), [iY, month]);
  const eY = useMemo(() => expenses.filter(r => r.date && r.date.getFullYear() === year), [expenses, year]);
  const eM = useMemo(() => eY.filter(r => r.date.getMonth() === month), [eY, month]);
  const chatters = useMemo(() => [...new Set(iY.map(r => r.chatterName).filter(Boolean))].sort(), [iY]);
  const platforms = useMemo(() => [...new Set(iY.map(r => r.platform).filter(Boolean))].sort(), [iY]);
  const clients = useMemo(() => [...new Set(iY.map(r => r.modelName).filter(Boolean))].sort(), [iY]);
  return { dM, iY, iM, eY, eM, chatters, clients, platforms, models, genParams };
}

// ═══════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════
function Card({ children, style: s = {}, onClick }) { return <div onClick={onClick} style={{ background: C.card, borderRadius: 12, padding: "16px 20px", border: `1px solid ${C.bdr}`, ...s, ...(onClick ? { cursor: "pointer" } : {}) }}>{children}</div>; }
function Stat({ title, value, sub, color, icon }) { return <Card style={{ flex: 1, minWidth: 140 }}><div style={{ color: C.dim, fontSize: 12, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>{icon && <span style={{ fontSize: 16 }}>{icon}</span>}{title}</div><div style={{ fontSize: 24, fontWeight: 700, color: color || C.txt }}>{value}</div>{sub && <div style={{ color: C.mut, fontSize: 11, marginTop: 4 }}>{sub}</div>}</Card>; }
function FB({ children }) { return <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 16, direction: "rtl" }}>{children}</div>; }
function Sel({ label, value, onChange, options, style: s = {} }) { return <label style={{ display: "flex", alignItems: "center", gap: 5, color: C.dim, fontSize: 12, ...s }}>{label}<select value={value} onChange={e => onChange(e.target.value)} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "6px 10px", fontSize: 12, outline: "none" }}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>; }
function Btn({ children, onClick, variant = "primary", size = "md", style: s = {}, disabled }) { const base = { border: "none", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, transition: "all 0.2s", opacity: disabled ? .5 : 1 }; const sz = { sm: { padding: "5px 10px", fontSize: 11 }, md: { padding: "8px 16px", fontSize: 12 }, lg: { padding: "12px 22px", fontSize: 14 } }; const vr = { primary: { background: C.pri, color: "#fff" }, success: { background: C.grn, color: "#fff" }, danger: { background: C.red, color: "#fff" }, ghost: { background: "transparent", color: C.dim, border: `1px solid ${C.bdr}` }, warning: { background: C.ylw, color: "#000" } }; return <button onClick={disabled ? undefined : onClick} style={{ ...base, ...sz[size], ...vr[variant], ...s }}>{children}</button>; }
function Modal({ open, onClose, title, children, width = 560 }) { if (!open) return null; return <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000, padding: 16 }} onClick={onClose}><div onClick={e => e.stopPropagation()} style={{ background: C.bg, borderRadius: 16, padding: 24, maxWidth: width, width: "100%", maxHeight: "85vh", overflowY: "auto", border: `1px solid ${C.bdr}`, direction: "rtl" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><h3 style={{ color: C.txt, margin: 0, fontSize: 16 }}>{title}</h3><Btn variant="ghost" size="sm" onClick={onClose}>✕</Btn></div>{children}</div></div>; }
function DT({ columns, rows, footer, textSm, onRowClick }) { const w = useWin(); const isMob = w < 768; const fs = textSm ? (isMob ? 9 : 10) : (isMob ? 11 : 13); const pad = textSm ? (isMob ? "4px" : "6px 8px") : (isMob ? "6px 6px" : "8px 14px"); return <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.bdr}` }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: fs, direction: "rtl", tableLayout: "auto" }}><thead><tr>{columns.map((c, i) => <th key={i} style={{ padding: pad, background: C.card, color: C.dim, borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap", fontSize: textSm ? (isMob ? 8 : 9) : (isMob ? 10 : 12), ...(c.thStyle || {}) }}>{c.label}</th>)}</tr></thead><tbody>{rows.map((row, ri) => <tr key={ri} onClick={() => onRowClick && onRowClick(row)} style={{ borderBottom: `1px solid ${C.bdr}`, cursor: onRowClick ? "pointer" : "default", transition: "all 0.15s" }} onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = `${C.pri}11`; }} onMouseLeave={e => { if (onRowClick) e.currentTarget.style.background = "transparent"; }}>{columns.map((c, ci) => <td key={ci} style={{ padding: pad, color: C.txt, whiteSpace: c.wrap ? "normal" : "nowrap", wordBreak: c.wrap ? "break-word" : "normal", ...(c.tdStyle || {}) }}>{c.render ? c.render(row) : row[c.key]}</td>)}</tr>)}</tbody>{footer && <tfoot><tr style={{ background: C.card }}>{footer.map((f, i) => <td key={i} style={{ padding: pad, fontWeight: 700, color: C.priL, fontSize: fs }}>{f}</td>)}</tr></tfoot>}</table></div>; }
const TT = ({ active, payload, label }) => { if (!active || !payload?.length) return null; return <div style={{ background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, padding: "8px 12px", fontSize: 12 }}><div style={{ color: C.dim, marginBottom: 4 }}>{label}</div>{payload.map((p, i) => <div key={i} style={{ color: p.color || C.txt }}>{p.name}: <strong>{fmtC(p.value)}</strong></div>)}</div>; };

// ═══════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════
const NAV = [{ key: "dashboard", label: "דאשבורד", icon: "📊" }, { key: "income", label: "הכנסות", icon: "💰" }, { key: "approvals", label: "אישורים", icon: "✅" }, { key: "expenses", label: "הוצאות", icon: "💳" }, { key: "chatters", label: "צ'אטרים", icon: "👥" }, { key: "clients", label: "לקוחות", icon: "👩" }, { key: "targets", label: "יעדים", icon: "🎯" }, { key: "record", label: "תיעוד הוצאות", icon: "📱" }, { key: "generator", label: "מחולל תכנים", icon: "✨" }];

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
  return <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.card, borderTop: `1px solid ${C.bdr}`, display: "flex", justifyContent: "space-around", padding: "6px 0", zIndex: 900 }}>
    {NAV.slice(0, 4).map(it => <button key={it.key} onClick={() => onNav(it.key)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: current === it.key ? C.pri : C.mut, cursor: "pointer", padding: "4px 6px", fontSize: 9, fontWeight: current === it.key ? 700 : 400 }}><span style={{ fontSize: 18 }}>{it.icon}</span>{it.label}</button>)}
    <button onClick={() => onNav("record")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: current === "record" ? C.pri : C.mut, cursor: "pointer", padding: "4px 6px", fontSize: 9 }}><span style={{ fontSize: 18 }}>📱</span>תיעוד</button>
    <button onClick={logout} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "transparent", border: "none", color: C.red, cursor: "pointer", padding: "4px 6px", fontSize: 9 }}><span style={{ fontSize: 18 }}>🚪</span>צא</button>
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
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? C.grn : C.red }} />
        <span style={{ fontSize: 11, color: C.mut }}>{demo ? "הדגמה" : connected ? "מחובר ל-Sheets" : "לא מחובר"}</span>
      </div>
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
      if (!sheets.includes("sales_report")) {
        setErr(`גיליון "sales_report" לא נמצא. גיליונות: ${sheets.join(", ")}`);
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
// PAGE: DASHBOARD
// ═══════════════════════════════════════════════════════
function DashPage() {
  const { year, month, setMonth, view, setView } = useApp();
  const { iM, iY, eM, eY, targets } = useFD();
  const w = useWin();
  const mp = Calc.profit(iM, eM);
  const mbd = useMemo(() => {
    let lastDays = 31, lastInc = 0;
    return MONTHS_HE.map((m, i) => {
      const mi = iY.filter(r => r.date.getMonth() === i), me = eY.filter(e => e.date.getMonth() === i);
      const inc = mi.reduce((s, r) => s + r.amountILS, 0), exp = me.reduce((s, e) => s + e.amount, 0);
      const daysInMonth = new Date(year, i + 1, 0).getDate();
      const t = Calc.targets(lastInc, lastDays, daysInMonth);
      lastInc = inc; lastDays = daysInMonth;
      return { month: m, ms: MONTHS_SHORT[i], idx: i, inc, exp, tgt1: t.t1, tgt2: t.t2, tgt3: t.t3, dailyAvg: t.daily, days: daysInMonth };
    });
  }, [iY, eY, year]);

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
    <FB><Sel label="תצוגה:" value={view} onChange={setView} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />{view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}</FB>
    {view === "monthly" ? <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <Stat icon="💰" title={`צפי הכנסות — ${MONTHS_HE[month]}`} value={fmtC(mp.inc)} color={C.grn} sub={`${iM.length} עסקאות`} />
      <Stat icon="📈" title="צפי רווח לפני מיסים" value={fmtC(mp.profit)} color={mp.profit >= 0 ? C.grn : C.red} sub={`הוצאות: ${fmtC(mp.exp)}`} />
    </div> : <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <Stat icon="💰" title={`הכנסות ${year}`} value={fmtC(iY.reduce((s, r) => s + r.amountILS, 0))} color={C.grn} />
        <Stat icon="💳" title="הוצאות" value={fmtC(eY.reduce((s, e) => s + e.amount, 0))} color={C.red} />
        <Stat icon="📈" title="רווח" value={fmtC(Calc.profit(iY, eY).profit)} color={Calc.profit(iY, eY).profit >= 0 ? C.grn : C.red} />
      </div>
      <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={240}><BarChart data={mbd}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="inc" fill={C.grn} radius={[4, 4, 0, 0]} name="הכנסות" /><Bar dataKey="exp" fill={C.red} radius={[4, 4, 0, 0]} name="הוצאות" /></BarChart></ResponsiveContainer></Card>
      <DT columns={[{ label: "חודש", key: "month" }, { label: "ממוצע יומי", render: r => fmtC(r.dailyAvg) }, { label: "הכנסות", render: r => <span style={{ color: C.grn }}>{fmtC(r.inc)}</span> }, { label: "יעד 1 (+5%)", render: r => fmtC(r.tgt1) }, { label: "יעד 2 (+10%)", render: r => fmtC(r.tgt2) }, { label: "יעד 3 (+15%)", render: r => fmtC(r.tgt3) }]} rows={mbd} footer={["סה״כ", "", fmtC(mbd.reduce((s, r) => s + r.inc, 0)), "", "", ""]} />
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: INCOME
// ═══════════════════════════════════════════════════════
function IncPage() {
  const { year, month, setMonth, view, setView, setIncome } = useApp();
  const { iM, iY, chatters, clients, platforms } = useFD();
  const incTypes = useMemo(() => [...new Set((view === "monthly" ? iM : iY).map(r => r.incomeType).filter(Boolean))].sort(), [iM, iY, view]);
  const [fP, setFP] = useState("all"), [fC, setFC] = useState("all"), [fCh, setFCh] = useState("all"), [fL, setFL] = useState("all"), [fT, setFT] = useState("all"), [xAxis, setXAxis] = useState("date");
  const data = (view === "monthly" ? iM : iY).filter(r => (fP === "all" || r.platform === fP) && (fC === "all" || r.modelName === fC) && (fCh === "all" || r.chatterName === fCh) && (fL === "all" || r.shiftLocation === fL) && (fT === "all" || r.incomeType === fT));
  const total = data.reduce((s, r) => s + r.amountILS, 0);

  const togglePaid = async (r) => {
    try {
      const nr = await IncSvc.togglePaidToClient(r);
      setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
    } catch (e) { alert("שגיאה: " + e.message); }
  };
  const cancelTx = async (r) => {
    if (!confirm("לבטל עסקה זו?")) return;
    try {
      const nr = await IncSvc.cancelTransaction(r);
      setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
    } catch (e) { alert("שגיאה במחיקה: " + e.message); }
  };
  const chartData = useMemo(() => {
    if (view === "yearly") return MONTHS_HE.map((m, i) => ({ name: MONTHS_SHORT[i], value: data.filter(r => r.date && r.date.getMonth() === i).reduce((s, r) => s + r.amountILS, 0) }));
    if (xAxis === "date") { const map = {}; data.forEach(r => { const k = r.date ? r.date.getDate() : "?"; map[k] = (map[k] || 0) + r.amountILS; }); return Object.entries(map).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => ({ name: k, value: v })); }
    const map = {}; data.forEach(r => { const k = xAxis === "chatter" ? r.chatterName : xAxis === "client" ? r.modelName : xAxis === "type" ? r.incomeType : r.platform; map[k] = (map[k] || 0) + r.amountILS; }); return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, value: v }));
  }, [data, view, xAxis]);

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>💰 פירוט הכנסות</h2>
    <FB><Sel label="תצוגה:" value={view} onChange={setView} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />{view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}</FB>
    <FB><Sel label="פלטפורמה:" value={fP} onChange={setFP} options={[{ value: "all", label: "הכל" }, ...platforms.map(p => ({ value: p, label: p }))]} /><Sel label="סוג הכנסה:" value={fT} onChange={setFT} options={[{ value: "all", label: "הכל" }, ...incTypes.map(t => ({ value: t, label: t }))]} /><Sel label="לקוחה:" value={fC} onChange={setFC} options={[{ value: "all", label: "הכל" }, ...clients.map(c => ({ value: c, label: c }))]} /><Sel label="צ'אטר:" value={fCh} onChange={setFCh} options={[{ value: "all", label: "הכל" }, ...chatters.map(c => ({ value: c, label: c }))]} /><Sel label="מיקום:" value={fL} onChange={setFL} options={[{ value: "all", label: "הכל" }, { value: "משרד", label: "משרד" }, { value: "חוץ", label: "חוץ" }]} /></FB>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}><Stat icon="💰" title="סה״כ" value={fmtC(total)} color={C.grn} sub={`${data.length} עסקאות`} /></div>
    <Card style={{ marginBottom: 16 }}>
      {view === "monthly" && <div style={{ marginBottom: 8 }}><Sel label="ציר X:" value={xAxis} onChange={setXAxis} options={[{ value: "date", label: "תאריך" }, { value: "chatter", label: "צ'אטר" }, { value: "client", label: "לקוחה" }, { value: "type", label: "סוג הכנסה" }, { value: "platform", label: "פלטפורמה" }]} /></div>}
      <ResponsiveContainer width="100%" height={220}><BarChart data={chartData} margin={{ left: 50, bottom: 20 }}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="name" tick={{ fill: C.dim, fontSize: 10 }} interval={0} angle={chartData.length > 15 ? -45 : 0} textAnchor={chartData.length > 15 ? "end" : "middle"} height={chartData.length > 15 ? 60 : 30} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.pri} radius={[4, 4, 0, 0]} name="הכנסות" /></BarChart></ResponsiveContainer>
    </Card>
    {view === "monthly" ? <DT columns={[{ label: "תאריך", render: r => <span style={{ whiteSpace: "nowrap" }}>{fmtD(r.date)} {r.hour && <span style={{ fontSize: 11, color: C.mut }}>{r.hour}</span>}</span> }, { label: "סוג הכנסה", key: "incomeType" }, { label: "צ'אטר", key: "chatterName" }, { label: "דוגמנית", key: "modelName" }, { label: "פלטפורמה", key: "platform" }, { label: "מיקום", key: "shiftLocation" }, { label: "שולם ללקוחה", render: r => <Btn size="sm" variant="ghost" onClick={() => togglePaid(r)}>{r.paidToClient ? "✔️" : "❌"}</Btn> }, { label: "סכום", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.originalAmount)}</span> }, { label: "ביטול", render: r => r.cancelled ? <span style={{ color: C.dim, fontSize: 11 }}>בוטל</span> : <Btn size="sm" variant="ghost" onClick={() => cancelTx(r)} style={{ color: C.red }}>❌</Btn> }]} rows={data.sort((a, b) => (b.date || 0) - (a.date || 0))} footer={["סה״כ", "", "", "", "", "", "", fmtC(total), ""]} /> : <DT columns={[{ label: "חודש", key: "name" }, { label: "הכנסות", render: r => <span style={{ color: C.grn }}>{fmtC(r.value)}</span> }]} rows={chartData} footer={["סה״כ", fmtC(total)]} />}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: EXPENSES
// ═══════════════════════════════════════════════════════
function ExpPage() {
  const { year, month, setMonth, view, setView, setPage, expenses, setExpenses, demo } = useApp();
  const { eM, eY, iM, iY } = useFD();
  const { rv } = useApp(); const w = useWin();
  const [src, setSrc] = useState("all"), [popCat, setPopCat] = useState(null), [editExp, setEditExp] = useState(null), [delExp, setDelExp] = useState(null);
  const data = (view === "monthly" ? eM : eY).filter(e => src === "all" || (src === "auto" ? e.source === "אוטומטי" : e.source === "ידני"));
  const total = data.reduce((s, e) => s + e.amount, 0);
  const catBd = useMemo(() => { const m = {}; data.forEach(e => { if (e.classification) { m[e.classification] = (m[e.classification] || 0) + e.amount; } }); return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [data]);
  const mByCat = useMemo(() => { if (view !== "yearly") return []; const cats = [...new Set(data.map(e => e.classification).filter(Boolean))]; return cats.map(cat => { const row = { category: cat }; let t = 0; MONTHS_HE.forEach((_, i) => { const v = data.filter(e => e.classification === cat && e.date && e.date.getMonth() === i).reduce((s, e) => s + e.amount, 0); row[`m${i}`] = v; t += v; }); row.total = t; return row; }).sort((a, b) => b.total - a.total); }, [data, view]);
  const off = Calc.offset(view === "monthly" ? eM : eY);
  const incD = view === "monthly" ? iM : iY;
  const chNames = [...new Set(incD.map(r => r.chatterName).filter(Boolean))];
  const chSal = chNames.map(n => { const s = Calc.chatterSalary(incD.filter(r => r.chatterName === n)); return { name: n, ...s }; }).sort((a, b) => b.total - a.total);
  const clNames = [...new Set(incD.map(r => r.modelName).filter(Boolean))];
  const clSal = clNames.map(n => { const p = getRate(n, ym(year, month)); const b = Calc.clientBal(incD, n, p); return { name: n, ...b }; }).sort((a, b) => b.totalIncome - a.totalIncome);
  const updCat = async (e, newCat) => { const updated = { ...e, classification: newCat }; setExpenses(prev => prev.map(x => x.id === e.id ? updated : x)); try { await ExpSvc.edit(updated); } catch (err) { console.error(err); } };
  const handleDelete = async (e) => { if (demo) { setExpenses(expenses.filter(x => x.id !== e.id)); setDelExp(null); setPopCat(null); return; } try { await ExpSvc.remove(e); setExpenses(expenses.filter(x => x.id !== e.id)); setDelExp(null); setPopCat(null); } catch (err) { alert(err.message); } };

  if (editExp) return <RecordExpensePage editMode={editExp} onDone={() => setEditExp(null)} />;

  const noExpenses = expenses.length === 0;

  return <div style={{ direction: "rtl" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
      <h2 style={{ color: C.txt, fontSize: w < 768 ? 17 : 22, fontWeight: 700, margin: 0 }}>💳 הוצאות סוכנות</h2>
      <Btn onClick={() => setPage("record")} variant="success">📱 תיעוד הוצאה</Btn>
    </div>

    {noExpenses ? <Card style={{ textAlign: "center", padding: 40 }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
      <div style={{ color: C.dim, fontSize: 14, marginBottom: 8 }}>גיליון הוצאות עדיין לא מחובר</div>
      <div style={{ color: C.mut, fontSize: 12 }}>כשתוסיף את גיליון "הוצאות כולל" ל-Sheets, הנתונים יופיעו כאן</div>
    </Card> : <>
      <FB><Sel label="תצוגה:" value={view} onChange={setView} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />{view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}</FB>
      {view === "monthly" ? <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
          <Stat icon="💳" title={`סה״כ — ${MONTHS_HE[month]}`} value={fmtC(total)} color={C.red} style={{ flex: 1, minWidth: 200 }} />
          {catBd.length > 0 && <Card style={{ flex: 2, minWidth: 300, display: "flex", alignItems: "center" }}>
            <div style={{ width: "100%", direction: "ltr" }}>
              <ResponsiveContainer width="100%" height={80}>
                <BarChart data={catBd.map(([k, v]) => ({ name: k, value: v }))} layout="vertical" margin={{ top: 0, right: 150, bottom: 0, left: 20 }}>
                  <XAxis type="number" hide reversed={true} />
                  <YAxis type="category" dataKey="name" orientation="right" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} />
                  <Tooltip content={<TT />} />
                  <Bar dataKey="value" fill={C.priL} radius={[0, 4, 4, 0]} name="סה״כ סיווג" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>}
        </div>
        <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>✍️ הוצאות ידניות ({MONTHS_HE[month]})</h3>
          <DT columns={[{ label: "תאריך", render: r => fmtD(r.date) }, { label: "ספק/סיבה", key: "category" }, { label: "פירוט", key: "name" }, { label: "סהכ", render: r => <strong style={{ color: C.red }}>{fmtC(r.amount)}</strong> }, { label: "תשלום", key: "paidBy" }, { label: "פעולות", render: r => <div style={{ display: "flex", gap: 4 }}><Btn size="sm" variant="ghost" onClick={() => setEditExp(r)}>✏️</Btn><Btn size="sm" variant="ghost" onClick={() => setDelExp(r)} style={{ color: C.red }}>🗑️</Btn></div> }]} rows={data.filter(e => e.source === "ידני").sort((a, b) => (b.date || 0) - (a.date || 0))} footer={["סה״כ", "", "", fmtC(data.filter(e => e.source === "ידני").reduce((s, e) => s + e.amount, 0)), "", ""]} />
        </div>
        <Modal open={!!popCat} onClose={() => setPopCat(null)} title={`📂 ${popCat}`}>{data.filter(e => e.category === popCat).sort((a, b) => (b.date || 0) - (a.date || 0)).map(e => <div key={e.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.bdr}` }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}><div style={{ flex: 1 }}><div style={{ fontWeight: 600, color: C.txt, fontSize: 13 }}>{e.name}</div><div style={{ fontSize: 10, color: C.mut, marginTop: 3 }}>{fmtD(e.date)} {e.hour && `• ${e.hour}`} • {e.paidBy} • {e.source === "אוטומטי" ? "🤖" : "✍️"} {e.source}</div></div><div style={{ textAlign: "left" }}><div style={{ fontSize: 15, fontWeight: 700, color: C.red, marginBottom: 4 }}>{fmtC(e.amount)}</div>{e.source === "ידני" && <div style={{ display: "flex", gap: 4 }}><Btn size="sm" variant="ghost" onClick={() => { setEditExp(e); setPopCat(null); }}>✏️</Btn><Btn size="sm" variant="ghost" onClick={() => setDelExp(e)} style={{ color: C.red }}>🗑️</Btn></div>}</div></div></div>)}</Modal>
        <Modal open={!!delExp} onClose={() => setDelExp(null)} title="🗑️ מחיקה" width={360}><p style={{ color: C.dim, fontSize: 13, marginBottom: 16 }}>למחוק "{delExp?.name}" ({fmtC(delExp?.amount)})?</p><div style={{ display: "flex", gap: 8 }}><Btn variant="danger" onClick={() => handleDelete(delExp)}>כן</Btn><Btn variant="ghost" onClick={() => setDelExp(null)}>לא</Btn></div></Modal>
      </> : <>
        <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={220}><BarChart data={MONTHS_HE.map((m, i) => ({ name: MONTHS_SHORT[i], value: data.filter(e => e.date && e.date.getMonth() === i).reduce((s, e) => s + e.amount, 0) }))}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.red} radius={[4, 4, 0, 0]} name="הוצאות" /></BarChart></ResponsiveContainer></Card>
        <DT columns={[{ label: "קטגוריה", key: "category" }, ...MONTHS_HE.map((m, i) => ({ label: MONTHS_SHORT[i], render: r => r[`m${i}`] ? fmtC(r[`m${i}`]) : "—" })), { label: "סה״כ", render: r => <strong style={{ color: C.red }}>{fmtC(r.total)}</strong> }]} rows={mByCat} footer={["סה״כ", ...MONTHS_HE.map((_, i) => fmtC(mByCat.reduce((s, r) => s + (r[`m${i}`] || 0), 0))), fmtC(total)]} />
      </>}
      <div style={{ marginTop: 28, overflowX: "auto" }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>🧾 כל החשבוניות</h3>
        <div style={{ fontSize: 11, whiteSpace: "nowrap" }}>
          <DT textSm columns={[{ label: "תאריך", render: r => fmtD(r.date) }, { label: "סוג", key: "docType" }, { label: "ספק/סיבה", key: "category", wrap: true, tdStyle: { maxWidth: 100 } }, { label: "פירוט", key: "name", wrap: true, tdStyle: { minWidth: 100, maxWidth: 280 } }, { label: "סהכ", render: r => <strong style={{ color: C.red }}>{fmtC(r.amount)}</strong> }, { label: "מעמ", render: r => r.vatRecognized ? "כן" : "לא" }, { label: "מס", render: r => r.taxRecognized ? "כן" : "לא" }, { label: "תשלום", key: "paidBy" }, { label: "מזהה", key: "hour", wrap: true, tdStyle: { maxWidth: 100 } }, { label: "מסמך", render: r => r.receiptImage ? <a href={r.receiptImage} target="_blank" rel="noreferrer" style={{ color: C.pri, fontWeight: "bold" }}>5</a> : "" }, { label: "סיווג הוצאה", render: r => <select value={EXPENSE_CATEGORIES.includes(r.classification) ? r.classification : ""} onChange={e => { if (e.target.value) updCat(r, e.target.value); }} style={{ background: C.card, color: C.txt, border: `1px solid ${C.bdr}`, borderRadius: 6, padding: "6px 4px", fontSize: 11, outline: "none", width: "100%", cursor: "pointer" }}><option value="">{r.classification || "בחר סיווג..."}</option>{EXPENSE_CATEGORIES.filter(c => c !== r.classification).map(c => <option key={c} value={c}>{c}</option>)}</select>, tdStyle: { minWidth: 120 } }]} rows={data.sort((a, b) => (b.date || 0) - (a.date || 0))} footer={["סה״כ", "", "", "", fmtC(total), "", "", "", "", "", ""]} />
        </div>
      </div>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>⚖️ קיזוז דור / יוראי</h3><Card style={{ display: "flex", gap: 20, flexWrap: "wrap" }}><div><div style={{ color: C.dim, fontSize: 11 }}>דור</div><div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{fmtC(off.dor)}</div></div><div><div style={{ color: C.dim, fontSize: 11 }}>יוראי</div><div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{fmtC(off.yurai)}</div></div><div><div style={{ color: C.dim, fontSize: 11 }}>קיזוז</div><div style={{ fontSize: 14, fontWeight: 700, color: C.ylw }}>{off.owes} → {off.paid}: {fmtC(off.off)}</div></div></Card></div>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>👥 שכר צ'אטרים</h3><DT columns={[{ label: "צ'אטר", key: "name" }, { label: "משרד 17%", render: r => fmtC(r.oSal) }, { label: "חוץ 15%", render: r => fmtC(r.rSal) }, { label: "סה״כ", render: r => <strong style={{ color: C.pri }}>{fmtC(r.total)}</strong> }]} rows={chSal} footer={["סה״כ", "", "", fmtC(chSal.reduce((s, c) => s + c.total, 0))]} /></div>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>👩 שכר לקוחות</h3><DT columns={[{ label: "לקוחה", key: "name" }, { label: "הכנסות", render: r => fmtC(r.totalIncome) }, { label: "%", render: r => `${r.pct}%` }, { label: "זכאות", render: r => fmtC(r.ent) }, { label: "נכנס אליה", render: r => fmtC(r.direct) }, { label: "יתרה", render: r => <span style={{ color: r.bal >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(r.bal)}</span> }]} rows={clSal} footer={["סה״כ", "", "", fmtC(clSal.reduce((s, c) => s + c.ent, 0)), "", ""]} /></div>
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: CHATTERS
// ═══════════════════════════════════════════════════════
function ChatterPage() {
  const { year, month, setMonth, view, setView } = useApp(); const { iM, iY, chatters } = useFD(); const [sel, setSel] = useState("");
  useEffect(() => { if (chatters.length && !sel) setSel(chatters[0]); }, [chatters, sel]);
  const incD = view === "monthly" ? iM : iY; const rows = incD.filter(r => r.chatterName === sel); const sal = Calc.chatterSalary(rows); const tot = rows.reduce((s, r) => s + r.amountILS, 0);
  const byCl = useMemo(() => { const m = {}; rows.forEach(r => { m[r.modelName] = (m[r.modelName] || 0) + r.amountILS; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [rows]);
  const byType = useMemo(() => { const m = {}; rows.forEach(r => { if (r.incomeType) { m[r.incomeType] = (m[r.incomeType] || 0) + r.amountILS; } }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [rows]);
  const mbd = useMemo(() => { if (view !== "yearly") return []; return MONTHS_HE.map((m, i) => { const mr = iY.filter(r => r.chatterName === sel && r.date && r.date.getMonth() === i); const s = Calc.chatterSalary(mr); return { month: m, ms: MONTHS_SHORT[i], sales: mr.reduce((sum, r) => sum + r.amountILS, 0), ...s }; }); }, [iY, sel, view]);

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>👥 צ'אטרים</h2>
    <FB><Sel label="צ'אטר:" value={sel} onChange={setSel} options={chatters.map(c => ({ value: c, label: c }))} /><Sel label="תצוגה:" value={view} onChange={setView} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />{view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}</FB>
    {!sel ? <p style={{ color: C.mut }}>בחר צ'אטר</p> : view === "monthly" ? <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}><Stat icon="💰" title="מכירות" value={fmtC(tot)} color={C.grn} /><Stat icon="🏢" title="משרד" value={fmtC(sal.oSales)} sub={`שכר: ${fmtC(sal.oSal)}`} /><Stat icon="🏠" title="חוץ" value={fmtC(sal.rSales)} sub={`שכר: ${fmtC(sal.rSal)}`} /><Stat icon="💵" title="משכורת" value={fmtC(sal.total)} color={C.pri} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>מכירות לפי לקוחה</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={180}><BarChart data={byCl} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.pri} radius={[4, 0, 0, 4]} name="מכירות" /></BarChart></ResponsiveContainer></div></Card>
        {byType.length > 0 && <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>מכירות לפי סוג הכנסה</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={180}><BarChart data={byType} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.priL} radius={[4, 0, 0, 4]} name="מכירות" /></BarChart></ResponsiveContainer></div></Card>}
      </div>
      <DT columns={[{ label: "תאריך", render: r => <span style={{ whiteSpace: "nowrap" }}>{fmtD(r.date)} {r.hour && <span style={{ fontSize: 11, color: C.mut }}>{r.hour}</span>}</span> }, { label: "דוגמנית", key: "modelName" }, { label: "פלטפורמה", key: "platform" }, { label: "מיקום", key: "shiftLocation" }, { label: "סכום", render: r => fmtC(r.amountILS) }]} rows={rows.sort((a, b) => (b.date || 0) - (a.date || 0))} footer={["סה״כ", "", "", "", fmtC(tot)]} />
    </> : <>
      <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={220}><ComposedChart data={mbd}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="sales" fill={C.pri} radius={[4, 4, 0, 0]} name="מכירות" /><Line type="monotone" dataKey="total" stroke={C.ylw} strokeWidth={2} dot={{ r: 3 }} name="משכורת" /></ComposedChart></ResponsiveContainer></Card>
      <DT columns={[{ label: "חודש", key: "month" }, { label: "מכירות", render: r => fmtC(r.sales) }, { label: "משרד", render: r => fmtC(r.oSales) }, { label: "חוץ", render: r => fmtC(r.rSales) }, { label: "שכר", render: r => <strong style={{ color: C.pri }}>{fmtC(r.total)}</strong> }]} rows={mbd} footer={["סה״כ", fmtC(mbd.reduce((s, r) => s + r.sales, 0)), "", "", fmtC(mbd.reduce((s, r) => s + r.total, 0))]} />
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: CLIENTS
// ═══════════════════════════════════════════════════════
function ClientPage() {
  const { year, month, setMonth, view, setView, rv, updRate, setIncome } = useApp(); const { iM, iY, clients } = useFD();
  const [sel, setSel] = useState(""), [editPct, setEditPct] = useState(false), [pv, setPv] = useState(0);
  useEffect(() => { if (clients.length && !sel) setSel(clients[0]); }, [clients, sel]);
  const ymi = ym(year, month), pct = getRate(sel, ymi); const incD = view === "monthly" ? iM : iY; const bal = Calc.clientBal(incD, sel, pct);

  const togglePaid = async (r) => {
    try {
      const nr = await IncSvc.togglePaidToClient(r);
      setIncome(prev => prev.map(x => x.id === r.id ? nr : x));
    } catch (e) { alert("שגיאה במערכת: " + e.message); }
  };
  const byCh = useMemo(() => { const m = {}; incD.filter(r => r.modelName === sel).forEach(r => { if (r.chatterName) m[r.chatterName] = (m[r.chatterName] || 0) + r.amountILS; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [incD, sel]);
  const byType = useMemo(() => { const m = {}; incD.filter(r => r.modelName === sel).forEach(r => { if (r.incomeType) m[r.incomeType] = (m[r.incomeType] || 0) + r.amountILS; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })); }, [incD, sel]);
  const ybd = useMemo(() => { if (view !== "yearly") return []; return MONTHS_HE.map((m, i) => { const yi = ym(year, i); const p = getRate(sel, yi); const mr = iY.filter(r => r.modelName === sel && r.date && r.date.getMonth() === i); const b = Calc.clientBal(mr, sel, p); return { month: m, ms: MONTHS_SHORT[i], ...b }; }); }, [iY, sel, view, year, rv]);

  return <div style={{ direction: "rtl" }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>👩 לקוחות</h2>
    <FB><Sel label="לקוחה:" value={sel} onChange={setSel} options={clients.map(c => ({ value: c, label: c }))} /><Sel label="תצוגה:" value={view} onChange={setView} options={[{ value: "monthly", label: "חודשי" }, { value: "yearly", label: "שנתי" }]} />{view === "monthly" && <Sel label="חודש:" value={month} onChange={v => setMonth(+v)} options={MONTHS_HE.map((m, i) => ({ value: i, label: m }))} />}</FB>
    {!sel ? <p style={{ color: C.mut }}>בחר לקוחה</p> : view === "monthly" ? <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}><Stat icon="💰" title="הכנסות" value={fmtC(bal.totalIncome)} color={C.grn} /><Stat icon="🏢" title="דרך סוכנות" value={fmtC(bal.through)} /><Stat icon="👩" title="ישירות" value={fmtC(bal.direct)} /><Stat icon="💵" title="זכאות (שכר צפוי)" value={fmtC(bal.ent)} color={C.pri} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(250px,1fr))", gap: 16, marginBottom: 16 }}>
        <Card><ResponsiveContainer width="100%" height={180}><PieChart><Pie data={[{ name: "סוכנות", value: bal.through || 1 }, { name: "ישירות", value: bal.direct || 1 }]} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={11}><Cell fill={C.pri} /><Cell fill={C.org} /></Pie><Tooltip formatter={v => fmtC(v)} /></PieChart></ResponsiveContainer></Card>
        {byCh.length > 0 && <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>לפי צ'אטר</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={180}><BarChart data={byCh} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.pri} radius={[4, 0, 0, 4]} name="הכנסות" /></BarChart></ResponsiveContainer></div></Card>}
        {byType.length > 0 && <Card><div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>לפי סוג הכנסה</div><div style={{ width: "100%", direction: "ltr" }}><ResponsiveContainer width="100%" height={180}><BarChart data={byType} layout="vertical" margin={{ top: 5, right: 150, bottom: 5, left: 20 }}><XAxis type="number" reversed={true} tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><YAxis type="category" orientation="right" dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} width={150} interval={0} /><Tooltip content={<TT />} /><Bar dataKey="value" fill={C.priL} radius={[4, 0, 0, 4]} name="הכנסות" /></BarChart></ResponsiveContainer></div></Card>}
      </div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}><span style={{ color: C.dim, fontSize: 13 }}>💵 משכורת — {MONTHS_HE[month]}</span><Btn variant="ghost" size="sm" onClick={() => { setPv(pct); setEditPct(true); }}>✏️ ערוך אחוז</Btn></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(100px,1fr))", gap: 12 }}>
          <div><div style={{ color: C.mut, fontSize: 11 }}>אחוז</div><div style={{ fontSize: 22, fontWeight: 700, color: C.pri }}>{pct}%</div></div>
          <div><div style={{ color: C.mut, fontSize: 11 }}>זכאות (שכר)</div><div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{fmtC(bal.ent)}</div></div>
          <div><div style={{ color: C.mut, fontSize: 11 }}>כבר שולם לה</div><div style={{ fontSize: 18, fontWeight: 700, color: C.txt }}>{fmtC(bal.direct)}</div></div>
          <div style={{ borderRight: `2px solid ${C.bdr}`, paddingRight: 12 }}>
            <div style={{ color: C.dim, fontSize: 11, fontWeight: 700 }}>תשלום בפועל</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: bal.actualDue >= 0 ? C.grn : C.red }}>{fmtC(bal.actualDue)}</div>
            <div style={{ fontSize: 10, color: bal.actualDue >= 0 ? C.grn : C.red }}>{bal.actualDue >= 0 ? "הסוכנות חייבת ללקוחה" : "הלקוחה חייבת לסוכנות"}</div>
          </div>
        </div>
      </Card>
      <Modal open={editPct} onClose={() => setEditPct(false)} title={`עריכת אחוז — ${sel} — ${MONTHS_HE[month]}`} width={340}><input type="number" min="0" max="100" value={pv} onChange={e => setPv(e.target.value)} style={{ width: "100%", padding: "12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 8, color: C.txt, fontSize: 20, outline: "none", boxSizing: "border-box", marginBottom: 14 }} /><div style={{ display: "flex", gap: 8 }}><Btn variant="success" onClick={() => { updRate(sel, ymi, +pv); setEditPct(false); }}>💾 שמור</Btn><Btn variant="ghost" onClick={() => setEditPct(false)}>ביטול</Btn></div></Modal>
      <div style={{ marginTop: 28 }}><h3 style={{ color: C.dim, fontSize: 14, marginBottom: 10 }}>🧾 עסקאות ({MONTHS_HE[month]})</h3>
        <DT columns={[{ label: "תאריך", render: r => <span style={{ whiteSpace: "nowrap" }}>{fmtD(r.date)} {r.hour && <span style={{ fontSize: 11, color: C.mut }}>{r.hour}</span>}</span> }, { label: "סוג הכנסה", key: "incomeType" }, { label: "צ'אטר", key: "chatterName" }, { label: "פלטפורמה", key: "platform" }, { label: "מיקום", key: "shiftLocation" }, { label: "שולם ללקוחה", render: r => <Btn size="sm" variant="ghost" onClick={() => togglePaid(r)}>{r.paidToClient ? "✔️" : "❌"}</Btn> }, { label: "סכום", render: r => <span style={{ color: C.grn, textDecoration: r.cancelled ? "line-through" : "none" }}>{fmtC(r.originalAmount)}</span> }]} rows={incD.filter(r => r.modelName === sel).sort((a, b) => (b.date || 0) - (a.date || 0))} footer={["סה״כ", "", "", "", "", "", fmtC(bal.totalIncome)]} /></div>
    </> : <>
      <Card style={{ marginBottom: 16 }}><ResponsiveContainer width="100%" height={220}><ComposedChart data={ybd}><CartesianGrid strokeDasharray="3 3" stroke={C.bdr} /><XAxis dataKey="ms" tick={{ fill: C.dim, fontSize: 11 }} /><YAxis tick={{ fill: C.dim, fontSize: 10 }} tickFormatter={v => `₪${(v / 1000).toFixed(0)}k`} /><Tooltip content={<TT />} /><Bar dataKey="totalIncome" fill={C.grn} radius={[4, 4, 0, 0]} name="הכנסות" /><Line type="monotone" dataKey="ent" stroke={C.pri} strokeWidth={2} name="זכאות" /><Line type="monotone" dataKey="bal" stroke={C.ylw} strokeWidth={2} strokeDasharray="5 5" name="יתרה" /></ComposedChart></ResponsiveContainer></Card>
      <DT columns={[{ label: "חודש", key: "month" }, { label: "הכנסות", render: r => fmtC(r.totalIncome) }, { label: "דרך סוכנות", render: r => fmtC(r.through) }, { label: "ישירות", render: r => fmtC(r.direct) }, { label: "%", render: r => `${r.pct}%` }, { label: "זכאות", render: r => fmtC(r.ent) }, { label: "יתרה", render: r => <span style={{ color: r.bal >= 0 ? C.grn : C.red, fontWeight: 700 }}>{fmtC(r.bal)}</span> }]} rows={ybd} footer={["סה״כ", fmtC(ybd.reduce((s, r) => s + r.totalIncome, 0)), "", "", "", fmtC(ybd.reduce((s, r) => s + r.ent, 0)), ""]} />
    </>}
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: TARGETS
// ═══════════════════════════════════════════════════════
function TgtPage() {
  const { year, month } = useApp();
  const { iY, eY } = useFD();

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
  }, [iY, year]);

  return <div style={{ direction: "rtl", maxWidth: 800 }}>
    <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 700, marginBottom: 20 }}>🎯 תחזית יעדים — {year}</h2>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 16, marginBottom: 24 }}>
      {mbd.map(d => {
        const isCurrent = d.idx === month;
        const daysPassed = isCurrent ? Math.max(1, new Date().getDate()) : d.days;
        const currentDaily = d.inc / daysPassed;
        const isFuture = d.idx > month;

        return <Card key={d.idx} style={{
          border: isCurrent ? `2px solid ${C.pri}` : `1px solid ${C.bdr}`,
          background: isCurrent ? `${C.pri}08` : C.card,
          opacity: isFuture ? 0.6 : 1
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: isCurrent ? C.pri : C.txt }}>{d.month} {isCurrent ? "(נוכחי)" : ""}</span>
            {!isFuture && <span style={{ fontSize: 13, color: currentDaily >= (d.tgt1 / d.days) ? C.grn : C.red, fontWeight: 600 }}>
              {fmtC(currentDaily)} /יום
            </span>}
          </div>

          <div style={{ padding: "12px", background: `${C.bg}55`, borderRadius: 8, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
              <span style={{ color: C.dim }}>הכנסות בפועל:</span>
              <span style={{ color: C.txt, fontWeight: 600 }}>{isFuture ? "—" : fmtC(d.inc)}</span>
            </div>
            {isCurrent && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.dim }}>קצב צפוי לסוף חודש:</span>
              <span style={{ color: C.pri, fontWeight: 600 }}>{fmtC(currentDaily * d.days)}</span>
            </div>}
          </div>

          <div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>יעדים שנקבעו לחודש זה:</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: C.txt }}>יעד ברזל (+5%)</span>
                <span style={{ color: d.inc >= d.tgt1 ? C.grn : C.dim }}>{fmtC(d.tgt1)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: C.txt }}>יעד זהב (+10%)</span>
                <span style={{ color: d.inc >= d.tgt2 ? C.grn : C.dim }}>{fmtC(d.tgt2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: C.txt }}>יעד יהלום (+15%)</span>
                <span style={{ color: d.inc >= d.tgt3 ? C.grn : C.dim }}>{fmtC(d.tgt3)}</span>
              </div>
            </div>
          </div>
        </Card>;
      })}
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// PAGE: RECORD EXPENSE (mobile-first)
// ═══════════════════════════════════════════════════════
function RecordExpensePage({ editMode, onDone }) {
  const { setPage, demo, expenses, setExpenses } = useApp(); const w = useWin();
  const [mode, setMode] = useState(editMode ? "manual" : null);
  const [form, setForm] = useState(editMode ? { category: editMode.category, name: editMode.name, amount: String(editMode.amount), date: editMode.date ? `${editMode.date.getFullYear()}-${String(editMode.date.getMonth() + 1).padStart(2, "0")}-${String(editMode.date.getDate()).padStart(2, "0")}` : new Date().toISOString().split("T")[0], hour: editMode.hour || "12:00", paidBy: editMode.paidBy, vatRecognized: editMode.vatRecognized, taxRecognized: editMode.taxRecognized } : { category: "", name: "", amount: "", date: new Date().toISOString().split("T")[0], hour: new Date().toTimeString().substring(0, 5), paidBy: "", vatRecognized: false, taxRecognized: true });
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
          category: EXPENSE_CATEGORIES.find(c => c === res.Category) || f.category,
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
    setSaving(true); setErr("");
    const exp = { ...form, amount: +form.amount, source: "ידני", receiptImage: null };
    if (editMode) { const updated = { ...editMode, ...exp, date: new Date(form.date) }; if (!demo) try { await ExpSvc.edit(updated); } catch (e) { setErr(e.message); setSaving(false); return; } setExpenses(expenses.map(x => x.id === editMode.id ? updated : x)); setSaving(false); if (onDone) onDone(); return; }
    if (!demo) try { await ExpSvc.add(exp); } catch (e) { setErr(e.message); setSaving(false); return; }
    const d = new Date(form.date); setExpenses([...expenses, { id: `E${Date.now()}`, ...exp, date: d, year: d.getFullYear(), month: d.getMonth() + 1, _rowIndex: 0 }]); setSaving(false); setSaved(true);
  };

  if (editMode && saved) { if (onDone) onDone(); return null; }
  if (saved) return <div style={{ direction: "rtl", textAlign: "center", padding: 40 }}><div style={{ fontSize: 56, marginBottom: 12 }}>✅</div><h2 style={{ color: C.grn, marginBottom: 16, fontSize: 18 }}>נשמר!</h2><div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}><Btn onClick={() => { setSaved(false); setMode(null); setForm({ category: "", name: "", amount: "", date: new Date().toISOString().split("T")[0], hour: new Date().toTimeString().substring(0, 5), paidBy: "", vatRecognized: false, taxRecognized: true }); }}>➕ עוד</Btn><Btn variant="ghost" onClick={() => setPage("dashboard")}>🏠</Btn><Btn variant="ghost" onClick={() => setPage("expenses")}>💳</Btn></div></div>;

  const manualExpenses = useMemo(() => expenses.filter(e => e.source === "ידני").sort((a, b) => (b.date || 0) - (a.date || 0)), [expenses]);
  const manualTotal = manualExpenses.reduce((s, e) => s + e.amount, 0);
  const handleDeleteManual = async (e) => {
    if (!confirm("למחוק הוצאה זו?")) return;
    if (!demo) try { await ExpSvc.remove(e); } catch (err) { alert(err.message); return; }
    setExpenses(expenses.filter(x => x.id !== e.id));
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
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>קטגוריה *</label><select value={form.category} onChange={e => upd("category", e.target.value)} style={inputStyle}><option value="">בחר...</option>{EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שם ההוצאה *</label><input value={form.name} onChange={e => upd("name", e.target.value)} placeholder="למשל: חשבונית חשמל" style={inputStyle} /></div>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סכום (₪) *</label><input type="number" value={form.amount} onChange={e => upd("amount", e.target.value)} placeholder="0" style={{ ...inputStyle, fontSize: w < 768 ? 20 : 16, direction: "ltr" }} /></div>
      <div style={{ display: "flex", gap: 10 }}><div style={{ flex: 1 }}><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>תאריך</label><input type="date" value={form.date} onChange={e => upd("date", e.target.value)} style={inputStyle} /></div><div style={{ flex: 1 }}><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שעה</label><input type="time" value={form.hour} onChange={e => upd("hour", e.target.value)} style={inputStyle} /></div></div>
      <div><label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>מי שילם *</label><div style={{ display: "flex", gap: 10 }}>{["דור", "יוראי"].map(p => <button key={p} onClick={() => upd("paidBy", p)} style={{ flex: 1, padding: w < 768 ? "16px" : "12px", borderRadius: 10, fontSize: w < 768 ? 16 : 14, fontWeight: 600, cursor: "pointer", background: form.paidBy === p ? C.pri : C.card, color: form.paidBy === p ? "#fff" : C.dim, border: `2px solid ${form.paidBy === p ? C.pri : C.bdr}`, transition: "all .15s" }}>{p}</button>)}</div></div>
      <div style={{ display: "flex", gap: 14 }}><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.dim, fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={form.vatRecognized} onChange={e => upd("vatRecognized", e.target.checked)} style={{ width: 18, height: 18 }} />מע״מ</label><label style={{ display: "flex", alignItems: "center", gap: 6, color: C.dim, fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={form.taxRecognized} onChange={e => upd("taxRecognized", e.target.checked)} style={{ width: 18, height: 18 }} />מס</label></div>
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
      <div style={{ flex: "2 1 400px", display: "flex", flexDirection: "column", gap: 16, display: activeTab === "generator" ? "flex" : "none" }}>
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
function ChatterPortal() {
  const { user, logout, income, setIncome, load, connected, year, setYear, month, setMonth } = useApp();
  const w = useWin();
  const chatterName = user?.name || "";
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    modelName: "", platform: "", amountILS: "", amountUSD: "", usdRate: "3.6",
    date: new Date().toISOString().split("T")[0],
    hour: new Date().toTimeString().substring(0, 5),
    shiftLocation: "משרד", notes: ""
  });

  // Auto-load data if not connected
  useEffect(() => { if (!connected) load(); }, [connected, load]);

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Income filtered to this chatter
  const myIncome = useMemo(() =>
    income.filter(r => r.chatterName === chatterName && r.date && r.date.getFullYear() === year && r.date.getMonth() === month)
      .sort((a, b) => (b.date || 0) - (a.date || 0)),
    [income, chatterName, year, month]);

  const approved = myIncome.filter(r => r.verified === "V");
  const pending = myIncome.filter(r => r.verified !== "V");
  const totalApproved = approved.reduce((s, r) => s + r.amountILS, 0);
  const totalPending = pending.reduce((s, r) => s + r.amountILS, 0);

  // Last month income for this chatter
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const lastMonthIncome = useMemo(() =>
    income.filter(r => r.chatterName === chatterName && r.date && r.date.getFullYear() === prevYear && r.date.getMonth() === prevMonth),
    [income, chatterName, prevYear, prevMonth]);
  const lastMonthTotal = lastMonthIncome.reduce((s, r) => s + r.amountILS, 0);
  const daysInLastMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
  const lastMonthDailyAvg = daysInLastMonth > 0 ? Math.round(lastMonthTotal / daysInLastMonth) : 0;

  // Current month progress
  const currentMonthTotal = myIncome.reduce((s, r) => s + r.amountILS, 0);
  const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
  const daysSoFar = Math.min(new Date().getDate(), daysInCurrentMonth);

  // Target goals based on last month 
  const targets = [
    { label: "יעד 10%", pct: 10, color: "#22c55e" },
    { label: "יעד 20%", pct: 20, color: "#f59e0b" },
    { label: "יעד 30%", pct: 30, color: "#ef4444" },
  ].map(t => {
    const goal = Math.round(lastMonthTotal * (1 + t.pct / 100));
    const progress = goal > 0 ? Math.min(Math.round((currentMonthTotal / goal) * 100), 100) : 0;
    return { ...t, goal, progress };
  });

  // Unique client names from all income
  const clientNames = useMemo(() => [...new Set(income.map(r => r.modelName).filter(Boolean))].sort(), [income]);

  const save = async () => {
    if (!form.modelName || (!form.amountILS && !form.amountUSD)) { setErr("נא למלא לקוחה וסכום"); return; }
    setSaving(true); setErr("");
    const rate = +form.usdRate || 3.6;
    const ils = +form.amountILS || Math.round((+form.amountUSD || 0) * rate);
    const row = [
      "", chatterName, form.modelName, "", String(rate),
      String(+form.amountUSD || 0), String(ils), "",
      form.platform, form.date.split("-").reverse().join("/"),
      form.hour, form.notes, "", form.shiftLocation, "", ""
    ];
    try {
      await API.append("sales_report", [row]);
      // Add to local state
      const newInc = {
        id: `I-chatter-${Date.now()}`, chatterName, modelName: form.modelName,
        clientName: "", usdRate: rate, amountUSD: +form.amountUSD || 0,
        amountILS: ils, originalAmount: ils, incomeType: "",
        platform: form.platform, date: new Date(form.date), hour: form.hour,
        notes: form.notes, verified: "", shiftLocation: form.shiftLocation,
        paidToClient: false, cancelled: false, _rowIndex: 0
      };
      setIncome(prev => [...prev, newInc]);
      setSaving(false); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setForm(f => ({ ...f, modelName: "", amountILS: "", amountUSD: "", notes: "" }));
    } catch (e) { setErr(e.message); setSaving(false); }
  };

  const inputStyle = { width: "100%", padding: w < 768 ? "14px 12px" : "10px 12px", background: C.card, border: `1px solid ${C.bdr}`, borderRadius: 10, color: C.txt, fontSize: w < 768 ? 16 : 14, outline: "none", boxSizing: "border-box" };

  return <div style={{ minHeight: "100vh", background: C.bg, direction: "rtl" }}>
    {/* Header */}
    <div style={{ background: C.card, borderBottom: `1px solid ${C.bdr}`, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 100 }}>
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
    </div>

    <div style={{ maxWidth: 700, margin: "0 auto", padding: w < 768 ? "16px 10px" : "24px" }}>
      {/* Summary Cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Stat icon="✅" title="מאושרות" value={fmtC(totalApproved)} sub={`${approved.length} עסקאות`} color={C.grn} />
        <Stat icon="⏳" title="ממתינות" value={fmtC(totalPending)} sub={`${pending.length} עסקאות`} color={C.ylw} />
        <Stat icon="💰" title="סה״כ החודש" value={fmtC(currentMonthTotal)} sub={`${myIncome.length} עסקאות`} color={C.pri} />
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

        {lastMonthTotal === 0 ? (
          <div style={{ color: C.mut, fontSize: 13, textAlign: "center", padding: 16 }}>אין נתונים מחודש קודם לחישוב יעדים</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {targets.map((t, i) => (
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
              {["OnlyFans", "Fansly", "Instagram", "TikTok", "טלגרם", "אחר"].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סכום (₪)</label>
            <input type="number" value={form.amountILS} onChange={e => upd("amountILS", e.target.value)} placeholder="0" style={{ ...inputStyle, direction: "ltr" }} />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>סכום ($)</label>
            <input type="number" value={form.amountUSD} onChange={e => upd("amountUSD", e.target.value)} placeholder="0" style={{ ...inputStyle, direction: "ltr" }} />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>תאריך</label>
            <input type="date" value={form.date} onChange={e => upd("date", e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>שעה</label>
            <input type="time" value={form.hour} onChange={e => upd("hour", e.target.value)} style={inputStyle} />
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
            <label style={{ color: C.dim, fontSize: 12, display: "block", marginBottom: 4 }}>הערות</label>
            <input value={form.notes} onChange={e => upd("notes", e.target.value)} placeholder="אופציונלי" style={inputStyle} />
          </div>
        </div>
        {err && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{err}</div>}
        <Btn onClick={save} variant="success" size="lg" style={{ width: "100%", marginTop: 14 }} disabled={saving}>
          {saving ? "⏳ שומר..." : "💾 שמור הכנסה"}
        </Btn>
      </Card>

      {/* Pending Transactions */}
      {pending.length > 0 && <>
        <h3 style={{ color: C.ylw, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>⏳ ממתינות לאישור ({pending.length})</h3>
        <div style={{ marginBottom: 20 }}>
          <DT textSm columns={[
            { label: "תאריך", render: r => fmtD(r.date) },
            { label: "לקוחה", key: "modelName" },
            { label: "פלטפורמה", key: "platform" },
            { label: "סכום", render: r => <span style={{ color: C.ylw }}>{fmtC(r.amountILS)}</span> },
            { label: "סטטוס", render: () => <span style={{ color: C.ylw }}>⏳ ממתין</span> }
          ]} rows={pending} />
        </div>
      </>}

      {/* Approved Transactions */}
      <h3 style={{ color: C.grn, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>✅ מאושרות ({approved.length})</h3>
      {approved.length === 0 ? <Card style={{ textAlign: "center", padding: 20 }}><div style={{ color: C.mut, fontSize: 13 }}>אין עסקאות מאושרות עדיין</div></Card> :
        <DT textSm columns={[
          { label: "תאריך", render: r => fmtD(r.date) },
          { label: "לקוחה", key: "modelName" },
          { label: "פלטפורמה", key: "platform" },
          { label: "סכום", render: r => <span style={{ color: C.grn }}>{fmtC(r.amountILS)}</span> },
          { label: "סטטוס", render: () => <span style={{ color: C.grn }}>✅ מאושר</span> }
        ]} rows={approved} footer={["סה״כ", "", "", fmtC(totalApproved), ""]} />
      }
    </div>
  </div>;
}

// ═══════════════════════════════════════════════════════
// APPROVALS PAGE (ADMIN)
// ═══════════════════════════════════════════════════════
function ApprovalsPage() {
  const { income, setIncome, demo } = useApp();
  const [approving, setApproving] = useState(null);

  const pendingAll = useMemo(() =>
    income.filter(r => r.verified !== "V" && r.chatterName).sort((a, b) => (b.date || 0) - (a.date || 0)),
    [income]);

  const approve = async (row) => {
    setApproving(row.id);
    try {
      if (!demo && row._rowIndex > 0) {
        // Update verified column (column 13 = M) in the sheet
        const rowData = Array(16).fill(null);
        rowData[12] = "V";
        await API.update("sales_report", row._rowIndex, rowData);
      }
      setIncome(prev => prev.map(r => r.id === row.id ? { ...r, verified: "V" } : r));
    } catch (e) {
      console.error("Approve error:", e);
      // Still update locally even if API fails
      setIncome(prev => prev.map(r => r.id === row.id ? { ...r, verified: "V" } : r));
    }
    setApproving(null);
  };

  const reject = async (row) => {
    if (!confirm(`לדחות עסקה של ${row.chatterName}?\n${row.modelName} — ${fmtC(row.amountILS)}`)) return;
    setApproving(row.id);
    try {
      if (!demo && row._rowIndex > 0) {
        await API.deleteRow("sales_report", row._rowIndex);
      }
      setIncome(prev => prev.filter(r => r.id !== row.id));
    } catch (e) {
      console.error("Reject error:", e);
      // Still remove locally
      setIncome(prev => prev.filter(r => r.id !== row.id));
    }
    setApproving(null);
  };

  const approveAll = async () => {
    if (!confirm(`לאשר את כל ${pendingAll.length} העסקאות הממתינות?`)) return;
    const ids = new Set(pendingAll.map(p => p.id));
    // Update API for rows with valid indices
    for (const row of pendingAll) {
      if (!demo && row._rowIndex > 0) {
        try {
          const rowData = Array(16).fill(null);
          rowData[12] = "V";
          await API.update("sales_report", row._rowIndex, rowData);
        } catch (e) { console.error("Approve error for", row.id, e); }
      }
    }
    setIncome(prev => prev.map(r => ids.has(r.id) ? { ...r, verified: "V" } : r));
  };

  return <div style={{ direction: "rtl" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
      <h2 style={{ color: C.txt, fontSize: 20, fontWeight: 800, margin: 0 }}>✅ אישור עסקאות</h2>
      {pendingAll.length > 0 && <Btn variant="success" onClick={approveAll}>✅ אשר הכל ({pendingAll.length})</Btn>}
    </div>

    {pendingAll.length === 0 ? (
      <Card style={{ textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
        <div style={{ color: C.grn, fontSize: 16, fontWeight: 700 }}>אין עסקאות ממתינות לאישור</div>
      </Card>
    ) : (
      <DT columns={[
        { label: "תאריך", render: r => fmtD(r.date) },
        { label: "צ'אטר", key: "chatterName" },
        { label: "לקוחה", key: "modelName" },
        { label: "פלטפורמה", key: "platform" },
        { label: "סכום", render: r => <span style={{ fontWeight: 700, color: C.pri }}>{fmtC(r.amountILS)}</span> },
        { label: "מיקום", key: "shiftLocation" },
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
      ]} rows={pendingAll} footer={["סה״כ", "", "", "", fmtC(pendingAll.reduce((s, r) => s + r.amountILS, 0)), "", ""]} />
    )}
  </div>;
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
const PAGES = { dashboard: DashPage, income: IncPage, expenses: ExpPage, chatters: ChatterPage, clients: ClientPage, targets: TgtPage, record: RecordExpensePage, generator: GeneratorPage, approvals: ApprovalsPage };
function Content() {
  const { page, setPage, connected, user, load } = useApp();
  const w = useWin();
  if (import.meta.env.VITE_USE_AUTH === "true" && !user) return <LoginPage />;
  if (user?.role === "chatter") return <ChatterPortal />;
  if (!connected) return <SetupPage />;
  const P = PAGES[page] || DashPage;
  return <div style={{ display: "flex", minHeight: "100vh", background: C.bg }}><Sidebar current={page} onNav={setPage} /><div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}><TopBar /><div style={{ flex: 1, padding: w < 768 ? "14px 10px 80px" : "24px", overflowY: "auto" }}><P /></div></div><MobileNav current={page} onNav={setPage} /></div>;
}
export default function App() { return <Prov><style>{`*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:#0f172a}::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}select option{background:#1e293b;color:#f8fafc}`}</style><Content /></Prov>; }
