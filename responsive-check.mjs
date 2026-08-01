import { chromium } from 'playwright';
import fs from 'fs';

const TARGET_URL = process.argv[2] || 'file://' + process.cwd() + '/index.html';
const OUT_DIR = 'responsive-screenshots';
fs.mkdirSync(OUT_DIR, { recursive: true });

const breakpoints = [
  { name: 'mobile-se',        width: 375,  height: 667  },
  { name: 'mobile-large',     width: 414,  height: 896  },
  { name: 'mobile-landscape', width: 667,  height: 375  },
  { name: 'tablet-portrait',  width: 768,  height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768  },
  { name: 'small-desktop',    width: 1280, height: 720  },
  { name: 'large-desktop',    width: 1920, height: 1080 },
];

const browser = await chromium.launch();
const results = [];

for (const bp of breakpoints) {
  const page = await browser.newPage({ viewport: { width: bp.width, height: bp.height } });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3200); // let load-in + scan-line + gauge animation settle

  // pre-scroll through the page so all IntersectionObserver-driven scroll-reveal
  // animations fire and finish before the stitched full-page screenshot, otherwise
  // sections can appear blank/half-revealed purely from capture timing.
  const pageHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < pageHeight; y += bp.height) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  await page.screenshot({ path: `${OUT_DIR}/${bp.name}-full.png`, fullPage: true, animations: 'disabled' });
  await page.screenshot({ path: `${OUT_DIR}/${bp.name}-fold.png`, animations: 'disabled' });

  const overflow = await page.evaluate(() => {
    const sw = document.documentElement.scrollWidth;
    const iw = window.innerWidth;
    return { scrollWidth: sw, innerWidth: iw, overflowing: sw > iw + 1 };
  });

  let smallTargets = [];
  if (bp.width < 768) {
    smallTargets = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, input, [role="button"], [onclick]'));
      return els
        .map(el => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName, text: (el.innerText || '').slice(0, 30), w: r.width, h: r.height };
        })
        .filter(el => (el.w > 0 && el.h > 0) && (el.w < 44 || el.h < 44));
    });
  }

  results.push({ breakpoint: bp.name, width: bp.width, height: bp.height, ...overflow, smallTargets });
  await page.close();
}

await browser.close();
fs.writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(results, null, 2));

console.log('\n=== Responsive QA summary ===');
for (const r of results) {
  const status = r.overflowing ? 'FAIL (horizontal overflow)' : 'PASS';
  console.log(`${r.breakpoint} (${r.width}x${r.height}): ${status}${r.smallTargets.length ? `, ${r.smallTargets.length} small touch target(s)` : ''}`);
}
