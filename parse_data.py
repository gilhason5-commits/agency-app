import re

raw = open('/tmp/agency_data.txt', 'r', encoding='utf-8').read()

# Payment method keywords (Hebrew) - sort longest first to avoid partial matches
payment_ils = [
    'ביט ספייסי', 'ביט יוראי', 'ביט ריף', 'ביט קישור 2', 'ביט קישור', 'ביט דיאנה',
    'ביט ניקו', 'ביט ליוראי', 'ביט',
    'קארדקום קישור חדש', 'קארדקום',
    'פייבוקס יוראי', 'פייבוקס ספייסי', 'פייבוקס ריינה', 'פייבוקס',
    'וולט ריף', 'וולט יוראי', 'וולט',
    'מזומן', 'מזומן דיאנה',
    'העברה בנקאית', 'בנקאית ספייסי', 'בנקאית',
    'קריפטו', 'ווישלי', 'קוד משיכה', 'קוד וולט',
    'קאשקאש', 'פייפאל', 'ארנק דיגיטלי', 'קישור 2', 'קישור',
    'ריף וולט'
]
payment_ils.sort(key=len, reverse=True)

# Dollar payment methods
payment_usd = ['אונלי', 'אונליאונלי']

total_ils = 0
total_usd = 0
count_ils = 0
count_usd = 0

for pm in payment_ils:
    pattern = r'(\d{1,5}(?:,\d{3})*(?:\.\d+)?)\s*' + re.escape(pm)
    matches = re.findall(pattern, raw)
    for m in matches:
        val = float(m.replace(',', ''))
        if val > 0:
            total_ils += val
            count_ils += 1

for pm in payment_usd:
    pattern = r'(\d{1,5}(?:,\d{3})*(?:\.\d+)?)\s*' + re.escape(pm)
    matches = re.findall(pattern, raw)
    for m in matches:
        val = float(m.replace(',', ''))
        if val > 0:
            total_usd += val
            count_usd += 1

print(f"=== סיכום ===")
print(f"עסקאות בשקלים: {count_ils} | סה\"כ: ₪{total_ils:,.0f}")
print(f"עסקאות בדולרים: {count_usd} | סה\"כ: ${total_usd:,.2f}")
print(f"")
print(f"המרה גסה (₪3.6 לדולר): ₪{total_usd*3.6:,.0f}")
print(f"סה\"כ משוער (ILS): ₪{total_ils + total_usd*3.6:,.0f}")
