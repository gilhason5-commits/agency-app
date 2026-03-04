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

async function check() {
    const URL = "https://script.google.com/macros/s/AKfycbyj2mD6Gu6TRezxs10xsn6KnvRUWyie9XrOqwOgHYZZbxw0RW9VLAjQab_ksAK5azdMzg/exec";
    const resp = await fetch(`${URL}?action=read&sheet=${encodeURIComponent("הכנסות ארכיון")}`);
    const data = await resp.json();
    const rows = data.data || [];

    // Check: for rows with "01.02.2026" as date string, what does parseDate return?
    let mismatch = 0;
    let samples = [];

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const raw = r[8];
        if (!raw) continue;

        const rawStr = String(raw);
        const parsed = parseDate(raw);
        if (!parsed) continue;

        // Extract expected month from raw "DD.MM.YYYY"
        const parts = rawStr.split(".");
        if (parts.length === 3) {
            const expectedMonth = +parts[1]; // 1-indexed 
            const gotMonth = parsed.getMonth() + 1; // 0-indexed → 1-indexed
            if (expectedMonth !== gotMonth) {
                mismatch++;
                if (samples.length < 5) {
                    samples.push({ row: i + 1, raw: rawStr, expected: expectedMonth, got: gotMonth, parsed: parsed.toISOString() });
                }
            }
        }
    }

    console.log(`Date mismatches: ${mismatch}`);
    console.log("Samples:", JSON.stringify(samples, null, 2));

    // Also check the total count per month
    // Using SIMPLE string-based parsing (correct)
    const simpleMonths = {};
    const parsedMonths = {};

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const rawStr = String(r[8] || "");
        const parts = rawStr.split(".");

        if (parts.length === 3) {
            const key = `${parts[2]}-${parts[1].padStart(2, '0')}`;
            simpleMonths[key] = (simpleMonths[key] || 0) + 1;
        }

        const parsed = parseDate(r[8]);
        if (parsed) {
            const key = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
            parsedMonths[key] = (parsedMonths[key] || 0) + 1;
        }
    }

    console.log("\n=== SIMPLE STRING PARSING (correct) ===");
    Object.keys(simpleMonths).sort().forEach(k => console.log(`${k}: ${simpleMonths[k]} rows`));

    console.log("\n=== parseDate PARSING (what app uses) ===");
    Object.keys(parsedMonths).sort().forEach(k => console.log(`${k}: ${parsedMonths[k]} rows`));
}

check();
