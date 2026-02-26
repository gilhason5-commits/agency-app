// ═══════════════════════════════════════════════════════════════
// Google Apps Script — Backend for Agency Management App
// ═══════════════════════════════════════════════════════════════
//
// הקוד הזה מותאם לאפליקציה ותומך בשני פורמטים של update.
// החלף את הקוד הקיים שלך ב-Apps Script Editor ועשה Deploy חדש.
//
// ═══════════════════════════════════════════════════════════════

function doGet(e) {
    var action = e.parameter.action || "read";
    var sheet = e.parameter.sheet || "sales_report";
    var ssid = e.parameter.ssid || "";  // optional external spreadsheet ID
    var ss = ssid ? SpreadsheetApp.openById(ssid) : SpreadsheetApp.getActiveSpreadsheet();

    if (action === "read") {
        var ws = ss.getSheetByName(sheet);
        if (!ws) {
            return jsonResponse({ error: "Sheet not found: " + sheet, sheets: ss.getSheets().map(function (s) { return s.getName(); }) });
        }
        var data = ws.getDataRange().getValues();
        return jsonResponse({ success: true, sheet: sheet, data: data, rows: data.length });
    }

    if (action === "sheets") {
        var names = ss.getSheets().map(function (s) { return s.getName(); });
        return jsonResponse({ success: true, sheets: names });
    }

    return jsonResponse({ error: "Unknown action" });
}

function doPost(e) {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var sheet = body.sheet;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ws = ss.getSheetByName(sheet);

    if (!ws) {
        return jsonResponse({ error: "Sheet not found: " + sheet });
    }

    if (action === "append") {
        var rows = body.rows;
        rows.forEach(function (row) {
            ws.appendRow(row);
        });
        return jsonResponse({ success: true, added: rows.length });
    }

    if (action === "update") {
        // Support both formats:
        // Format 1 (React app): { rowIndex: 5, rowData: [...] }
        // Format 2 (legacy):    { range: "A5:M5", values: [[...]] }
        if (body.rowIndex && body.rowData) {
            // React app format — write each cell in the row
            var rowIndex = body.rowIndex;
            var rowData = body.rowData;
            for (var col = 0; col < rowData.length; col++) {
                ws.getRange(rowIndex, col + 1).setValue(rowData[col]);
            }
            return jsonResponse({ success: true, updated: rowIndex });
        } else if (body.range && body.values) {
            // Legacy format
            ws.getRange(body.range).setValues(body.values);
            return jsonResponse({ success: true, updated: body.range });
        }
        return jsonResponse({ error: "Missing rowIndex/rowData or range/values for update" });
    }

    if (action === "delete") {
        var rowIndex = body.rowIndex;
        ws.deleteRow(rowIndex);
        return jsonResponse({ success: true, deleted: rowIndex });
    }

    return jsonResponse({ error: "Unknown action" });
}

function jsonResponse(data) {
    return ContentService
        .createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
}
