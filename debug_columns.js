async function c() {
    const URL = 'https://script.google.com/macros/s/AKfycbyj2mD6Gu6TRezxs10xsn6KnvRUWyie9XrOqwOgHYZZbxw0RW9VLAjQab_ksAK5azdMzg/exec';
    const r = await fetch(URL + '?action=read&sheet=' + encodeURIComponent('הכנסות ארכיון'));
    const d = await r.json();
    const rows = d.data || [];
    console.log('Total rows (including header):', rows.length);
    console.log('Data rows:', rows.length - 1);
    // Count non-empty rows (have at least a name or amount)
    let empty = 0;
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row[0] && !row[1] && !row[2] && !row[5] && !row[4]) empty++;
    }
    console.log('Empty rows:', empty);
    console.log('Non-empty rows:', rows.length - 1 - empty);
    // Last 3 rows
    for (let i = Math.max(1, rows.length - 3); i < rows.length; i++) {
        console.log('Row ' + i + ': ' + JSON.stringify(rows[i]));
    }
}
c();
