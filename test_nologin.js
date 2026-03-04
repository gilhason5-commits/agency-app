const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));
  try {
    await page.goto('http://127.0.0.1:3004', { waitUntil: 'networkidle0', timeout: 10000 });
  } catch (e) {
    console.log('GOTO ERROR:', e.message);
  }
  await browser.close();
  process.exit(0);
})();
