# 🏢 מדריך הגדרה — אפליקציית ניהול סוכנות

## 📋 דרישות מקדימות

### התקנת Node.js
כדי להריץ את האפליקציה צריך Node.js מותקן.

**Mac:**
```bash
# דרך Homebrew (מומלץ)
brew install node

# או הורדה ישירה מ:
# https://nodejs.org/ (בחר LTS)
```

---

## שלב 1: הגדרת Google Sheet

### יצירת גיליון חדש
1. פתח [Google Sheets](https://sheets.google.com)
2. צור Spreadsheet חדש
3. צור את הגיליונות (Tabs) הבאים:

### גיליון `sales_report`
| | A | B | C | D | E | F | G | H | I | J | K | L | M | N |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1** | ID | Chatter | Model | Client | Rate | USD | ILS | Type | Platform | Date | Hour | Notes | Verified | Location |

### גיליון `הוצאות כולל`
| | A | B | C | D | E | F | G | H | I | J | K | L | M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1** | ID | קטגוריה | שם | סכום | תאריך | שעה | שילם | מע״מ | מס | שנה | חודש | מקור | קבלה |

### גיליון `יעדים`
| | A | B | C |
|---|---|---|---|
| **1** | חודש | יעד | שנה |

4. **העתק את ה-Spreadsheet ID** מה-URL:
```
https://docs.google.com/spreadsheets/d/XXXXXXXXXXXXX/edit
                                       ↑ זה ה-ID
```

---

## שלב 2: הגדרת Google Apps Script

1. פתח [script.google.com](https://script.google.com) → **New Project**
2. מחק את כל הקוד הקיים
3. העתק והדבק את כל התוכן מהקובץ:
   ```
   google-apps-script/apps-script-code.js
   ```
4. **שנה את ה-`SPREADSHEET_ID`** בשורה 20 ל-ID שהעתקת בשלב 1
5. שמור (Ctrl+S)

### בדיקת חיבור
1. בחר את הפונקציה `testConnection` מהתפריט
2. לחץ ▶️ Run
3. בדוק ב-Execution Log שמופיע ✅

### פרסום כ-Web App
1. לחץ **Deploy** → **New Deployment**
2. **Select type**: Web app
3. **Description**: Agency App API
4. **Execute as**: Me
5. **Who has access**: Anyone
6. לחץ **Deploy**
7. אשר הרשאות (Authorize access)
8. **העתק את ה-Web App URL** שנוצר

---

## שלב 3: הגדרת האפליקציה

1. פתח את קובץ `.env` בתיקיית הפרויקט
2. החלף את ה-URL:
```env
VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_URL_HERE/exec
```

---

## שלב 4: הרצת האפליקציה

```bash
# התקנת חבילות (פעם ראשונה בלבד)
npm install

# הרצת שרת פיתוח
npm run dev
```

האפליקציה תיפתח בדפדפן ב: http://localhost:3000

---

## 🎮 מצב הדגמה

אם אתה רוצה לראות את האפליקציה בלי Google Sheets, לחץ על **"מצב הדגמה"** במסך הראשי — יטענו נתונים אקראיים.

---

## ❓ פתרון בעיות

| בעיה | פתרון |
|---|---|
| שגיאת CORS | ודא ש-Web App מוגדר עם "Anyone" access |
| "Sheet not found" | ודא ששמות הגיליונות מדויקים (כולל עברית) |
| לא מתחבר | בדוק שה-URL ב-`.env` מתחיל ב-`https://script.google.com/macros/s/` |
| שגיאת הרשאות | הרץ Deploy מחדש ואשר הרשאות |
