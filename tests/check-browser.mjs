// Optional Windows QA with Node 22+ and an installed Edge/Chromium.
// Uses a new temporary profile; never opens a personal profile or disables sandboxing.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const base = new URL(process.argv[2] || "http://localhost:4174/");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/.test(base.href)) throw new Error("QA only accepts a local preview URL.");
const browserPath = process.argv[3] || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const temp = join(process.env.LOCALAPPDATA, "Temp", "opencode");
const profile = join(temp, `skorochisto-qa-profile-${randomUUID()}`);
const output = join(temp, `skorochisto-qa-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const axePath = join(temp, "chisto-audit-tools", "axe-4.14.0.min.js");
const checks = [];
const documents = [];
const events = [];
const pending = new Map();
const listeners = new Set();
let socket;
let sequence = 0;
let session;
let browser;
let suite;

await mkdir(profile, { recursive: true });
await mkdir(output, { recursive: true });

function command(method, params = {}, browserCommand = false) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 120000);
    timeout.unref();
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(!browserCommand && session ? { sessionId: session } : {}) }));
  });
}

function nextEvent(method) {
  return new Promise((resolve, reject) => {
    const listener = (event) => {
      if (event.method !== method || event.sessionId !== session) return;
      clearTimeout(timeout);
      listeners.delete(listener);
      resolve(event);
    };
    const timeout = setTimeout(() => { listeners.delete(listener); reject(new Error(`${method} did not arrive`)); }, 60000);
    timeout.unref();
    listeners.add(listener);
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function settle() {
  await evaluate("(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()");
}

async function viewport(width) {
  await command("Emulation.setDeviceMetricsOverride", { width, height: width <= 760 ? 844 : 1000, deviceScaleFactor: 1, mobile: width <= 760 });
}

async function navigate(path) {
  events.length = 0;
  const loaded = nextEvent("Page.loadEventFired");
  await command("Page.navigate", { url: new URL(path, base).href });
  await loaded;
  await settle();
}

async function check(name, operation) {
  try {
    if (await operation() === false) throw new Error("Unexpected page state");
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
  }
}

async function capture(name) {
  await evaluate("window.scrollTo({ top: 0, behavior: 'instant' }); true");
  await settle();
  await evaluate("(async () => { await Promise.allSettled([...document.images].map(i => i.decode())); await Promise.allSettled(document.getAnimations().map(a => a.finished)); return true; })()");
  const { cssContentSize: size } = await command("Page.getLayoutMetrics");
  const { data } = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
  await writeFile(join(output, name), Buffer.from(data, "base64"));
}

async function press(key, code, windowsVirtualKeyCode) {
  const text = key === "Enter" ? "\r" : "";
  await command("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode, ...(text ? { text, unmodifiedText: text } : {}) });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  await settle();
}

function checkRequests(name) {
  return check(`${name}: no missing resources, external requests or uncaught errors`, () => {
    const bad = events.filter((event) => {
      const { method, params } = event;
      if (method === "Runtime.exceptionThrown" || (method === "Runtime.consoleAPICalled" && params.type === "error")) return true;
      if (method === "Network.responseReceived" && params.response.status >= 400) return true;
      if (method === "Network.loadingFailed" && !params.canceled) return true;
      if (method !== "Network.requestWillBeSent") return false;
      return !["GET", "HEAD"].includes(params.request.method) || (/^https?:/.test(params.request.url) && new URL(params.request.url).origin !== base.origin);
    });
    if (bad.length) throw new Error(JSON.stringify(bad));
    return true;
  });
}

try {
  browser = spawn(browserPath, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-sync", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error("Isolated Chromium did not start")), 30000);
    browser.once("error", (error) => { clearTimeout(timeout); reject(error); });
    browser.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(debuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method) {
      events.push(message);
      for (const listener of listeners) listener(message);
    }
  });
  const target = await command("Target.createTarget", { url: "about:blank" }, true);
  session = (await command("Target.attachToTarget", { targetId: target.targetId, flatten: true }, true)).sessionId;
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");
  await command("Page.bringToFront");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `document.addEventListener('click', event => { const link = event.target.closest('a[href]'); if (!link) return; const url = new URL(link.href, location.href); if (url.protocol === 'tel:' || url.origin !== ${JSON.stringify(base.origin)}) event.preventDefault(); }, true);` });

  await viewport(1440);
  await navigate("tests/test-suite.html");
  suite = await evaluate("(() => new Promise(resolve => { if (window.SKOROCHISTO_TEST_RESULTS) return resolve(window.SKOROCHISTO_TEST_RESULTS); const observer = new MutationObserver(() => { if (window.SKOROCHISTO_TEST_RESULTS) { observer.disconnect(); resolve(window.SKOROCHISTO_TEST_RESULTS); } }); observer.observe(document.getElementById('summary'), { childList: true }); }))()");
  await writeFile(join(output, "frontend-results.json"), JSON.stringify(suite, null, 2));
  await check("Frontend suite passes", () => suite.failed === 0 && suite.passed >= 70);
  await checkRequests("Frontend suite");

  const axeSource = existsSync(axePath) ? await readFile(axePath, "utf8") : "";
  for (const path of ["index.html", "services.html", "privacy.html"]) {
    for (const width of [320, 390, 1440]) {
      await viewport(width);
      await navigate(path);
      const name = `${path.replace(".html", "")}-${width}`;
      const layout = await evaluate("({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, forms: document.forms.length, phoneLinks: [...document.querySelectorAll('[data-call], [data-phone]')].map(a => a.href), images: [...document.images].map(i => ({ src: i.currentSrc, loaded: i.complete && i.naturalWidth > 0 })), fonts: [...document.fonts].map(f => ({ family: f.family, status: f.status })) })");
      documents.push({ name, layout });
      await check(`${name}: layout and verified phone`, () => layout.scrollWidth <= width + 1 && layout.forms === 0 && layout.phoneLinks.every((url) => url === "tel:+79229034414") && layout.images.every((image) => image.loaded));
      await checkRequests(name);
      if (axeSource) {
        await evaluate(`${axeSource}\ntrue`);
        const audit = await evaluate("(async () => { const r = await axe.run(document, { resultTypes: ['violations', 'incomplete'] }); return { version: r.testEngine.version, violations: r.violations, incomplete: r.incomplete }; })()");
        await writeFile(join(output, `axe-${name}.json`), JSON.stringify(audit, null, 2));
        await check(`${name}: axe accessibility`, () => {
          if (audit.violations.length) throw new Error(audit.violations.map((violation) => violation.id).join(", "));
          return true;
        });
      }
      await capture(`${name}.png`);
    }
  }

  await viewport(390);
  await navigate("index.html");
  await evaluate("document.querySelector('.menu-toggle').focus(); true");
  await press("Enter", "Enter", 13);
  await check("Native Enter opens the mobile menu", () => evaluate("document.querySelector('#mobile-menu').open && document.querySelector('.menu-toggle').getAttribute('aria-expanded') === 'true'"));
  await capture("mobile-menu.png");
  await press("Escape", "Escape", 27);
  await check("Native Escape closes the menu and restores focus", () => evaluate("!document.querySelector('#mobile-menu').open && document.activeElement.matches('.menu-toggle')"));
  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await check("Reduced motion is respected", () => evaluate("getComputedStyle(document.documentElement).scrollBehavior === 'auto'"));

  const failed = checks.filter((item) => !item.passed);
  const report = { passed: checks.length - failed.length, failed: failed.length, suite, checks, documents, browser: browserPath, output };
  await writeFile(join(output, "browser-results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ frontend: { passed: suite.passed, failed: suite.failed }, browser: { passed: report.passed, failed: report.failed }, failures: [...suite.checks, ...checks].filter((item) => !item.passed), output }, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await command("Browser.close", {}, true); } catch {}
    socket.close();
  }
  if (browser && browser.exitCode === null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { browser.kill(); resolve(); }, 10000);
      browser.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
  for (const request of pending.values()) clearTimeout(request.timeout);
  // Remove only the newly-created, GUID-named QA profile after its browser exits.
  if (browser?.exitCode !== null) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
