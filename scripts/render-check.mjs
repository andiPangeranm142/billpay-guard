/**
 * render-check.mjs - verify the built demo renders without errors.
 *
 * Usage: `node scripts/render-check.mjs [url] [screenshot]`. Defaults to
 * the live GitHub Pages demo. Pass a local preview URL to check a local
 * build instead (`npm run build`, then `npx vite preview --port 4173`).
 *
 * Exits non-zero if the page shows a fatal error, if any console error or
 * page error occurs, or if the expected content is missing. Writes a
 * screenshot to /tmp/billpay-render.png by default.
 *
 * Playwright is not a dependency of this repo: it is resolved from the
 * shared install at ~/workspace/codegeist/video-recorder/node_modules
 * via createRequire (NODE_PATH does not work for ESM imports).
 *
 * Chromium cannot use the VM's egress proxy directly (it resolves only to
 * an IPv6 address, and the proxy MITM-signs TLS with its own CA), so the
 * script runs the same localhost TCP forwarder the video-recorder uses
 * (127.0.0.1:3132 -> proxy IPv6:3128) and launches Chromium through it
 * with ignoreHTTPSErrors. Without this, the app's RPC reads fail with
 * ERR_TUNNEL_CONNECTION_FAILED and the live totals show "...".
 *
 * Port 3132 is used (not 3129) because other subagents often occupy 3129.
 * If it still fails with EADDRINUSE, wait a moment and retry.
 */
import { createRequire } from "node:module";
import net from "node:net";
import dns from "node:dns/promises";

const require = createRequire("/home/hatch/workspace/codegeist/video-recorder/package.json");
const { chromium } = require("playwright");

const FORWARDER_PORT = 3132;

async function startForwarder(localPort = FORWARDER_PORT) {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || "";
  const u = new URL(raw);
  const target = await dns.lookup(u.hostname, { family: 6 });
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: target.address, port: Number(u.port) || 3128 });
    client.pipe(upstream);
    upstream.pipe(client);
    const onErr = () => { client.destroy(); upstream.destroy(); };
    client.on("error", onErr);
    upstream.on("error", onErr);
  });
  await new Promise((resolve, reject) => {
    server.listen(localPort, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  return server;
}

const url = process.argv[2] ?? "https://andipangeranm142.github.io/billpay-guard/";
const screenshotPath = process.argv[3] ?? "/tmp/billpay-render.png";

const forwarder = await startForwarder();
const browser = await chromium.launch({
  proxy: { server: `http://127.0.0.1:${FORWARDER_PORT}`, bypass: "localhost,127.0.0.1" },
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true, // egress proxy MITM-signs TLS (see header)
});
const page = await context.newPage();
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("requestfailed", (req) => errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`));

await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: screenshotPath, fullPage: true });

const text = await page.evaluate(() => document.body.innerText);
const checks = {
  "title BillPay Guard": text.includes("BillPay Guard"),
  "subtitle (autonomous bill-payment agent)": text.includes("autonomous bill-payment agent"),
  "contract address": text.includes("0xac31fb4f4b85f29f6dc72e8485fa9188b37f3b6e"),
  // Stat labels are uppercased by CSS text-transform in innerText.
  "live schedules count (2)": /schedules\s*\n2\b/i.test(text),
  "live payments executed (7)": /payments executed\s*\n7\b/i.test(text),
  "live total paid (0.45 QOR)": text.includes("0.45 QOR"),
  "live guard balance (0.05 QOR)": text.includes("0.05 QOR"),
  "schedule 0 paid/cap (0.2 / 0.25 QOR)": text.includes("0.2 / 0.25 QOR"),
  "schedule 1 paid/cap (0.25 / 0.5 QOR)": text.includes("0.25 / 0.5 QOR"),
  // checkDue reason "cap-reached" is shown with its human label.
  "cap-reached status shown (Total cap reached)": text.includes("Total cap reached"),
  "due status shown (Due — ready to pay)": text.includes("Due — ready to pay"),
  "payment history section": text.includes("Payment history"),
  "connect prompt": text.includes("Connect a wallet"),
  "no 'contract not deployed' fallback": !text.includes("Contract not deployed yet"),
  "no fatal error text": !/something went wrong|failed to load|white screen/i.test(text),
};
let ok = true;
for (const [name, passed] of Object.entries(checks)) {
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (!passed) ok = false;
}
if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors) console.log(`  ${e}`);
  ok = false;
} else {
  console.log("PASS no console/page/request errors");
}
console.log(`screenshot: ${screenshotPath}`);
await browser.close();
forwarder.close();
process.exit(ok ? 0 : 1);
