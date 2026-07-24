// Screenshot the redesigned PWA in its ?demo= states via headless Helium.
// Temporary verification harness — not part of the app.
import puppeteer from 'puppeteer-core';

const OUT = process.argv[2] ?? '.';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Helium.app/Contents/MacOS/Helium',
  headless: 'new',
  args: ['--no-first-run', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

async function shoot(name, { url, dark = false, tab = null, fullPage = false }) {
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
  ]);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 900)); // fonts + entrance springs
  if (tab) {
    await page.evaluate((label) => {
      const btn = [...document.querySelectorAll('nav button')].find((b) =>
        b.textContent.includes(label),
      );
      btn?.click();
    }, tab);
    await new Promise((r) => setTimeout(r, 900));
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log('shot', name);
}

const base = 'http://localhost:5173/?demo=cool';
await shoot('home-light', { url: base });
await shoot('home-light-full', { url: base, fullPage: true });
await shoot('home-dark', { url: base, dark: true, fullPage: true });
await shoot('settings-light', { url: base, tab: 'Settings' });
await shoot('settings-dark', { url: base, dark: true, tab: 'Settings' });
await shoot('home-heat', { url: 'http://localhost:5173/?demo=heat' });
await shoot('home-off', { url: 'http://localhost:5173/?demo=off' });

await browser.close();
