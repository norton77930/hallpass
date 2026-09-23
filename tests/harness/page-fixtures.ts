/**
 * Page fixture service (part of T025).
 *
 * Serves the ordinary / form / empty / iframe-only / Shadow-DOM-only / canvas-only / reload / SPA /
 * document-change / origin-change fixtures - and the 004 structural pages under
 * `tests/e2e/fixtures/pages/` - over TLS on three unprivileged 127.0.0.1 ports. The
 * ports differ only in what the deterministic origin-safety adapter says about them:
 *
 *   19443 allow   19444 deny   19445 unknown
 *
 * The extension holds no host permission for 127.0.0.1, so every page journey still has to prove
 * the `activeTab` boundary.
 *
 * Run through `npm run dev:test-pages`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEST_PAGE_ALLOW_PORT,
  TEST_PAGE_DENY_PORT,
  TEST_PAGE_UNKNOWN_PORT,
} from "../../packages/test-kit/dist/build-config.js";

const PFX_PASSPHRASE = "hallpass-test";
const HOST = "127.0.0.1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const leafPfxPath = resolve(repoRoot, ".test-pki", "leaf.pfx");

/**
 * Distinctive sentinels for C5. None of these - nor any length, hash, or partial form of them -
 * may appear in panel output, WSS traffic, errors, storage, or logs.
 */
const SENTINEL = {
  password: "SENTINEL-PASSWORD-a1b2c3",
  hidden: "SENTINEL-HIDDEN-d4e5f6",
  otp: "SENTINEL-ONETIMECODE-g7h8i9",
  card: "SENTINEL-CARDNUMBER-j0k1l2",
  cvc: "SENTINEL-CVC-m3n4o5",
  credential: "SENTINEL-PRODUCTCRED-p6q7r8",
  ambiguous: "SENTINEL-AMBIGUOUS-s9t0u1",
} as const;

const FIXTURES = [
  "ordinary",
  "form",
  "empty",
  "iframe-only",
  "shadow-dom-only",
  "canvas-only",
  "reload",
  "spa",
  "document-change",
  "origin-change",
  "tags",
  "gestures",
  "waiting",
  "localized",
  "long",
  "dialogs",
  // 014/T359: a field that takes the first keystroke and then stops answering for a while.
  "slow-input",
  /**
   * 014/T367: the three pages a site transition needs.
   *
   * `transition-a` is the page the session works on; its links go through `/go-b` and `/go-bc`,
   * which are *redirects* rather than direct links, because the move this feature is about is the
   * one the agent did not ask for - a click whose destination the server chooses. `transition-b`
   * is an ordinary page on another origin, and `transition-batch` is a sequence whose second step
   * leaves.
   */
  "transition-a",
  "transition-b",
  "transition-batch",
  /**
   * 014/T382: a form that takes more than one file at once.
   *
   * The `form` fixture's attachment input is single-file, which is the ordinary case and the one
   * every other upload journey uses. The directory question is asked once per *call*, so proving
   * "two files from two directories, one card" needs an input that would actually accept both -
   * otherwise the page refuses the upload for its own reasons and the card proves nothing.
   */
  "upload-multi",
] as const;

type FixtureName = (typeof FIXTURES)[number];

/**
 * 004/T074 fixtures. These are plain files under `tests/e2e/fixtures/pages/` rather than strings in
 * this module: each is a whole page whose *structure* is the fixture (frame trees, a CSS-only
 * submenu, shadow roots, a fixed-coordinate toolbar), which reads far better as HTML than as an
 * escaped template literal. They are served here so that the one fixture server, the one set of
 * origins and the one TLS chain still apply.
 */
const PAGE_FILES = [
  "frames",
  "frames-child",
  "frames-grandchild",
  "frames-oopif",
  "hover-menu",
  "combobox",
  "shadow-host",
  "canvas",
  "form-values",
  "download",
  // 012/T316: a page whose layout is decided by the viewport it is given, and nothing else.
  "viewport",
  /**
   * 013/T340: the places a picture can be delivered to, each at a coordinate the page decides - two
   * file inputs (one not rendered), a drop zone, and the same zone one same-origin document down.
   * Every element is absolutely positioned because half of what the gate asserts is a *point*.
   */
  "upload-image",
  "upload-image-child",
] as const;

type PageFileName = (typeof PAGE_FILES)[number];

const pagesDirectory = resolve(repoRoot, "tests", "e2e", "fixtures", "pages");

/**
 * `frames.html` needs a *second* origin, and the only other origins in this harness are the sibling
 * ports. Substituting the token keeps the port numbers defined once, in build-config, instead of
 * hard-coded in a file that cannot import them.
 */
function crossOrigin(port: number): string {
  const other = port === TEST_PAGE_ALLOW_PORT ? TEST_PAGE_UNKNOWN_PORT : TEST_PAGE_ALLOW_PORT;
  return `https://${HOST}:${other}`;
}

/**
 * A genuinely different *site* from `HOST`, not just a different origin (T129, B73/B74).
 *
 * `crossOrigin` above only ever varies the port, so its child is cross-origin but same-site - same
 * host, so never an out-of-process iframe. `localhost` and `127.0.0.1` are two different sites by
 * Chrome's own reckoning even though both resolve to this one loopback server, which is what turns
 * `frames-oopif.html`'s child into a real OOPIF: same port, same TLS leaf (already trusted under
 * both names elsewhere in this harness), different site.
 */
function oopifOrigin(port: number): string {
  return `https://localhost:${port}`;
}

function pageFile(name: PageFileName, port: number): string {
  return readFileSync(resolve(pagesDirectory, `${name}.html`), "utf8")
    .replaceAll("__CROSS_ORIGIN__", crossOrigin(port))
    .replaceAll("__OOPIF_ORIGIN__", oopifOrigin(port));
}

const PORT_LABEL: Record<number, string> = {
  [TEST_PAGE_ALLOW_PORT]: "allow",
  [TEST_PAGE_DENY_PORT]: "deny",
  [TEST_PAGE_UNKNOWN_PORT]: "unknown",
};

function layout(title: string, body: string, head = "", lang = "en"): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; }
  fieldset { margin: 1rem 0; }
  label { display: block; margin: .5rem 0; }
  nav a { margin-right: .75rem; }
  .filler p { margin: 1.2rem 0; }
</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

/** Enough real prose that `please scroll` has somewhere to scroll to. */
function filler(paragraphs: number): string {
  const lines: string[] = ['<div class="filler">'];
  for (let index = 1; index <= paragraphs; index += 1) {
    lines.push(
      `<p>Paragraph ${index}. This fixture page carries ordinary, clearly non-sensitive visible text ` +
        `so a page read has something real to return and a scroll has somewhere to go. ` +
        `Nothing in this paragraph is a credential, a token, or personal data.</p>`,
    );
  }
  lines.push("</div>");
  return lines.join("\n");
}

function nav(port: number): string {
  const links = FIXTURES.map((name) => `<a href="/${name}">${name}</a>`).join("");
  return `<nav>${links}</nav><p><small>port ${port} - origin safety says <strong>${PORT_LABEL[port] ?? "?"}</strong></small></p><hr>`;
}

function page(name: FixtureName, port: number): { status: number; headers: Record<string, string>; body: string } {
  const html = (title: string, body: string, head = "", includeNavigation = true, lang = "en") => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: layout(title, `${includeNavigation ? nav(port) : ""}${body}`, head, lang),
  });

  switch (name) {
    case "ordinary":
      return html(
        "Ordinary fixture",
        `<h1>Ordinary page</h1>
<p>A plain document with visible text, one safe button and one safe text box, and no form values worth withholding.</p>
<button type="button" id="safe-button" onclick="document.getElementById('clicked').textContent = 'clicked at ' + new Date().toISOString()">Safe action</button>
<p id="clicked">not clicked yet</p>
<label>Notes <input type="text" name="notes" value="ordinary note"></label>
${filler(24)}`,
      );

    case "form":
      return html(
        "Form fixture",
        `<h1>Form page</h1>
<p>Ordinary values may be disclosed with a separate current-document form-values consent.
Everything in the second fieldset must never leave this page in any form.</p>

<!--
  A real submit control, in a form of its own (003/B1). It is separate from the form below on
  purpose: whether a form has a submit affordance is exactly what 002's implicit-submission guard
  decides on, so adding one to the fieldsets below would quietly change what the archived path does
  with an Enter key there. Submitting is observable without leaving the page, so a journey can
  assert that the click landed rather than that a navigation happened.

  It sits here, above both fieldsets, rather than after them (004/T128): a filter: "interactive"
  read keeps only what the viewport is showing (FR-067), and the fieldsets below - eight sensitive
  fields deep - push anything placed after them well below the fold.
-->
<form id="signin" onsubmit="document.getElementById('submitted').textContent = 'signed in as ' + (this.elements.username.value || 'nobody') + (this.elements.agree.checked ? ' (agreed)' : ''); return false">
  <fieldset>
    <legend>Sign in - submission stays on this page</legend>
    <label>Username <input type="text" name="username" autocomplete="username"></label>
    <label>Agree <input type="checkbox" name="agree"></label>
    <label>Plan
      <select name="plan">
        <option value="free" selected>Free</option>
        <option value="pro">Pro</option>
      </select>
    </label>
    <button type="submit" id="submit-button">Sign in</button>
  </fieldset>
</form>
<p id="submitted">not submitted yet</p>

<form onsubmit="return false">
  <fieldset>
    <legend>Ordinary, disclosable with consent</legend>
    <label>Nickname <input type="text" name="nickname" value="ordinary-nickname"></label>
    <label>Message <textarea name="message">ordinary comment text</textarea></label>
    <label>Colour
      <select name="country">
        <option value="red">Red</option>
        <option value="green" selected>Green</option>
        <option value="blue">Blue</option>
      </select>
    </label>
    <button type="button" id="safe-button" onclick="document.getElementById('clicked').textContent = 'clicked at ' + new Date().toISOString()">Safe action</button>
    <p id="clicked">not clicked yet</p>
  </fieldset>

  <fieldset>
    <legend>Sensitive - must never be disclosed</legend>
    <label>Password <input type="password" name="password" autocomplete="current-password" value="${SENTINEL.password}"></label>
    <input type="hidden" name="csrf" value="${SENTINEL.hidden}">
    <label>Attachment <input type="file" name="attachment" onchange="document.getElementById('uploaded').textContent = this.files.length === 0 ? 'no file chosen' : Array.from(this.files).map(function (file) { return file.name + ':' + file.size; }).join(', ')"></label>
    <p id="uploaded">no file chosen</p>
    <label>One-time code <input type="text" name="otp" autocomplete="one-time-code" value="${SENTINEL.otp}"></label>
    <label>Card number <input type="text" name="card" autocomplete="cc-number" value="${SENTINEL.card}"></label>
    <label>Security code <input type="text" name="cvc" autocomplete="cc-csc" value="${SENTINEL.cvc}"></label>
    <label>API key <input type="password" name="api-key" autocomplete="current-password" value="${SENTINEL.credential}"></label>
    <input type="text" value="${SENTINEL.ambiguous}" aria-hidden="false">
    <p><small>The last control above carries no name, label, or placeholder. An unidentified
    control fails closed: its value is withheld even with a form-values grant.</small></p>
  </fieldset>
</form>
${filler(12)}`,
      );

    case "empty":
      return html("Empty fixture", "", "", false);

    case "iframe-only":
      return html(
        "Iframe-only fixture",
        `<iframe src="/iframe-child" title="child" width="100%" height="240"></iframe>`,
        "",
        false,
      );

    case "shadow-dom-only":
      return html(
        "Shadow-DOM-only fixture",
        `<hallpass-closed-shadow id="host"></hallpass-closed-shadow>
<script>
  const host = document.getElementById("host");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = "<article><h2>Shadow content</h2><p>Only reachable through the shadow root.</p>" +
    "<button type='button'>Shadow action</button></article>";
</script>`,
        "",
        false,
      );

    case "canvas-only":
      return html(
        "Canvas-only fixture",
        `<canvas id="c" width="600" height="200"></canvas>
<script>
  const context = document.getElementById("c").getContext("2d");
  context.font = "20px system-ui";
  context.fillText("This sentence exists only as pixels.", 20, 60);
  context.fillText("A page read cannot honestly return it.", 20, 100);
</script>`,
        "",
        false,
      );

    case "reload":
      return html(
        "Reload fixture",
        `<h1>Reload page</h1>
<p>This document replaces itself after five seconds, which retires every outstanding target handle.</p>
<p>Loaded at <span id="stamp"></span></p>
<button type="button" id="safe-button" onclick="location.reload()">Reload now</button>
${filler(6)}
<script>
  document.getElementById("stamp").textContent = new Date().toISOString();
  setTimeout(() => location.reload(), 5000);
</script>`,
      );

    case "spa":
      return html(
        "SPA fixture",
        `<h1>SPA page</h1>
<p>The URL changes without a navigation, so the document - and every handle minted against it - stays alive.</p>
<p>Current path: <code id="path">/spa</code></p>
<button type="button" id="safe-button" onclick="history.pushState({}, '', '/spa/' + Date.now()); document.getElementById('path').textContent = location.pathname">Push a new path</button>
${filler(6)}`,
      );

    case "document-change":
      return html(
        "Document-change fixture",
        `<h1>Document-change page</h1>
<p>The button navigates to a different document on the same origin. A handle minted before the
change must not resolve afterwards.</p>
<button type="button" id="safe-button" onclick="location.href = '/ordinary'">Go to /ordinary</button>
<label>Notes <input type="text" name="notes" value="document-change note"></label>
${filler(6)}`,
      );

    case "tags":
      return html(
        "Tags fixture",
        `<h1>Tags page</h1>
<p>The tag field sits outside any form and commits a tag on Enter or Tab through its own script. The search
form below has a submit button, so Enter in its box would submit and navigate; the assistant must refuse it.</p>
<label>Tag <input type="text" name="description" aria-label="Tag"></label>
<ul id="tags"></ul>
<form action="/ordinary" method="get">
  <label>Search <input type="search" name="query" aria-label="Search" value="cats"></label>
  <button type="submit">Search</button>
</form>
<p id="pressed">no key yet</p>
<script>
  (function () {
    var tag = document.querySelector('input[name="description"]');
    var list = document.getElementById('tags');
    var pressed = document.getElementById('pressed');
    tag.addEventListener('keydown', function (event) {
      pressed.textContent = 'pressed ' + event.key + (event.shiftKey ? ' with Shift' : '');
      if ((event.key === 'Enter' || event.key === 'Tab') && tag.value.trim()) {
        var item = document.createElement('li');
        item.textContent = tag.value.trim();
        list.appendChild(item);
        tag.value = '';
        event.preventDefault();
      }
    });
  })();
</script>
${filler(6)}`,
      );

    case "gestures":
      return html(
        "Gestures fixture",
        `<h1>Gestures page</h1>
<p>A menu that opens on hover through the page's own script, a control that opens on a double activation, and
a list reordered by drag and drop. Nothing here navigates or submits. The menu item is in the document from the
start but hidden until the hover.</p>
<style>#menu-items.closed { display: none; }</style>
<div>
  <button type="button" id="menu" aria-label="Menu">Menu</button>
  <div id="menu-items" class="closed">
    <button type="button" id="open-settings" aria-label="Open settings">Open settings</button>
  </div>
</div>
<button type="button" id="double" aria-label="Open on double-click">Open on double-click</button>
<p id="opened">nothing opened yet</p>
<button type="button" id="context" aria-label="Context target">Context target</button>
<p id="gesture-log">no gesture yet</p>
<ul id="list">
  <li id="alpha"><button type="button" draggable="true" aria-label="Alpha">Alpha</button></li>
  <li id="beta"><button type="button" draggable="true" aria-label="Beta">Beta</button></li>
</ul>
<script>
  (function () {
    var menu = document.getElementById('menu');
    var items = document.getElementById('menu-items');
    var opened = document.getElementById('opened');
    function open() { items.classList.remove('closed'); }
    menu.addEventListener('pointerenter', open);
    menu.addEventListener('mouseenter', open);
    document.getElementById('open-settings').addEventListener('click', function () {
      opened.textContent = 'settings opened';
    });
    document.getElementById('double').addEventListener('dblclick', function () {
      opened.textContent = 'opened by double-click';
    });
    // 003/T069: the two gestures whose only witness is the page's own handler. A right button
    // opens the browser's menu and a triple click selects text, and neither leaves anything on the
    // page unless the page listens - so this control listens, and says which one it saw.
    var context = document.getElementById('context');
    var gestureLog = document.getElementById('gesture-log');
    context.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      gestureLog.textContent = 'context menu requested';
    });
    context.addEventListener('click', function (event) {
      if (event.detail === 3) gestureLog.textContent = 'triple click seen';
    });
    var list = document.getElementById('list');
    var dragged = null;
    list.addEventListener('dragstart', function (event) { dragged = event.target.closest('li'); });
    list.addEventListener('dragover', function (event) { event.preventDefault(); });
    list.addEventListener('drop', function (event) {
      var row = event.target.closest('li');
      if (dragged && row && row !== dragged) row.after(dragged);
    });
  })();
</script>
${filler(6)}`,
      );

    case "waiting":
      return html(
        "Waiting fixture",
        `<h1>Waiting page</h1>
<p>Starting the work reveals a result after a moment, through the page's own script. The result button is in
the document from the start and hidden by a class until then, which is the same shape the gestures menu has.
The second button is hidden the same way and is never revealed, so a wait on it can only end at its bound.
Nothing here navigates or submits.</p>
<style>.not-yet { display: none; }</style>
<button type="button" id="start" aria-label="Start">Start</button>
<button type="button" id="open-result" class="not-yet" aria-label="Open result">Open result</button>
<button type="button" id="never" class="not-yet" aria-label="Never appears">Never appears</button>
<p id="opened">nothing opened yet</p>
<script>
  (function () {
    var result = document.getElementById('open-result');
    var opened = document.getElementById('opened');
    document.getElementById('start').addEventListener('click', function () {
      opened.textContent = 'working';
      // Long enough that a step which guessed a delay would be wrong either way, and short enough
      // that a wait bounded at five seconds reaches it comfortably.
      setTimeout(function () { result.classList.remove('not-yet'); }, 600);
    });
    result.addEventListener('click', function () { opened.textContent = 'result opened'; });
  })();
</script>
${filler(6)}`,
      );

    case "slow-input":
      /**
       * 014/T359 — the one state FR-181 is about: the input has been delivered and nothing has
       * answered yet.
       *
       * The field takes the first keystroke and then blocks its own renderer, so the worker's key
       * dispatch is still outstanding when the owner presses 中斷 - which is exactly the moment an
       * honest answer cannot say "nothing happened" and must not say "verified". It blocks by
       * spinning rather than by never returning, so the tab comes back to life on its own and the
       * next test meets an ordinary browser; the window is long enough for a person-speed press
       * and short enough to sit well inside the spec's own timeout.
       *
       * One keystroke only: the handler removes itself, so the page is ordinary afterwards and the
       * late result this produces is the late result the gate then reads about.
       */
      return html(
        "Slow input fixture",
        `<h1>Slow input page</h1>
<p>The field below accepts the first keystroke and then stops answering for a while. Nothing here navigates,
submits, or carries anything sensitive.</p>
<label>Slow field <input type="text" name="slow" id="slow" aria-label="Slow field"></label>
<p id="took">no keystroke yet</p>
<script>
  (function () {
    var field = document.getElementById('slow');
    var took = document.getElementById('took');
    function hold() {
      field.removeEventListener('keydown', hold);
      took.textContent = 'first keystroke taken';
      var until = Date.now() + 6000;
      // Deliberately synchronous: an asynchronous wait would leave the renderer free to answer the
      // very dispatch this fixture exists to leave outstanding.
      while (Date.now() < until) {
        /* hold the renderer */
      }
    }
    field.addEventListener('keydown', hold);
  })();
</script>
${filler(4)}`,
      );

    case "dialogs":
      /**
       * 008/T228 — every dialog US3 names, on one page (FR-110..FR-117).
       *
       * Four of the buttons differ only in *when* the dialog opens relative to the click, which is
       * the whole of the chaining rule: `#confirm` opens one inside the click, `#chained` 300 ms
       * after it, and `#timer` three seconds after the page loads with no click at all. The form
       * arms `beforeunload` only once its field has actually been edited, because a browser raises
       * that prompt only for a page the person has interacted with - so the fixture cannot arm it
       * from a script and must be typed into, exactly as the gate's journey does.
       *
       * Every outcome lands in `#result` as one short word, so the page itself is the evidence for
       * what the agent's answer did: `confirm:true` and `confirm:false` are different facts, and a
       * prompt reports the text it actually received.
       */
      return html(
        "Dialogs fixture",
        `<h1>Dialogs page</h1>
<p>Each button opens a native dialog. The result of the last one is written below, so what the page
received is checkable without asking the page anything. The form arms a "leave site?" prompt once its
field has been edited.</p>
<button type="button" id="alert" aria-label="Show alert">Show alert</button>
<button type="button" id="confirm" aria-label="Ask to confirm">Ask to confirm</button>
<button type="button" id="prompt" aria-label="Ask for a name">Ask for a name</button>
<button type="button" id="chained" aria-label="Confirm shortly after the click">Confirm shortly after the click</button>
<button type="button" id="timer" aria-label="Confirm three seconds later">Confirm three seconds later</button>
<form id="unsaved" onsubmit="return false">
  <label for="notes">Notes</label>
  <input type="text" id="notes" name="notes" aria-label="Notes" />
</form>
<button type="button" id="leave" aria-label="Leave this page">Leave this page</button>
<p id="result">nothing yet</p>
<script>
  (function () {
    var result = document.getElementById('result');
    function say(text) { result.textContent = text; }
    document.getElementById('alert').addEventListener('click', function () {
      window.alert('Saved 3 orders.');
      say('alert-closed');
    });
    document.getElementById('confirm').addEventListener('click', function () {
      say('confirm:' + window.confirm('Delete 3 orders? This cannot be undone.'));
    });
    document.getElementById('prompt').addEventListener('click', function () {
      var typed = window.prompt('What is your name?', 'hello');
      say('prompt:' + (typed === null ? 'null' : typed));
    });
    // 300 ms after the click, so the dialog belongs to an approved action by the clock rather than
    // by being raised inside the click's own turn (R-139: the chained case).
    document.getElementById('chained').addEventListener('click', function () {
      setTimeout(function () {
        say('confirm:' + window.confirm('Also delete the attached invoices?'));
      }, 300);
    });
    // Three seconds later, which is well outside the chaining window whatever raised it: this is
    // the dialog that must cost the owner a decision. Armed by its own button, or by loading the
    // page as /dialogs?timer=1 when the journey wants one with no click behind it at all - never
    // by simply being on the page, because every other scenario here would then meet it too.
    function armTimer() {
      setTimeout(function () {
        say('confirm:' + window.confirm('Your session is about to expire. Extend it?'));
      }, 3000);
    }
    document.getElementById('timer').addEventListener('click', armTimer);
    if (window.location.search.indexOf('timer=1') >= 0) armTimer();
    // Armed by a real edit only (a browser ignores it without interaction), and disarmed after the
    // page is left so a reload does not inherit it.
    var notes = document.getElementById('notes');
    var dirty = false;
    notes.addEventListener('input', function () { dirty = true; });
    // The page taking itself somewhere else (008/T230, FR-115's last sentence): the "leave site?"
    // prompt this raises belongs to whoever pressed the button, and when that is the owner rather
    // than an agent tool the extension must not answer it. Nothing here is an agent tool: the gate
    // presses this one through the page's own input, the way a person does.
    document.getElementById('leave').addEventListener('click', function () {
      window.location.href = '/ordinary';
    });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });
  })();
</script>
${filler(4)}`,
      );

    case "localized":
      // The ordinary page written in zh-TW: one safe button, one text box, and one control the
      // description must not reach. Its labels are the evidence for a description written without
      // word breaks (002/FR-026, T074a), so the zh-TW packaged gate can resolve one in its own
      // language. Nothing here navigates or submits.
      return html(
        "在地化頁面",
        `<h1>在地化頁面</h1>
<p>一個以繁體中文標示的頁面:一個安全的按鈕、一個備註欄位,以及一個描述不應該找到的按鈕。</p>
<button type="button" id="safe-button" aria-label="安全動作" onclick="document.getElementById('clicked').textContent = '已點擊 ' + new Date().toISOString()">安全動作</button>
<button type="button" id="danger-button" aria-label="危險動作">危險動作</button>
<p id="clicked">尚未點擊</p>
<label for="notes">備註</label>
<textarea id="notes" name="notes" aria-label="備註"></textarea>
${filler(6)}`,
        "",
        true,
        "zh-Hant-TW",
      );

    case "long":
      // 004/T136: a page whose visible text alone exceeds `AGENT_READ_PAGE_MAX_CHARS` (50,000), so a
      // `get_page_text` read at the default ceiling is genuinely cut rather than merely capable of
      // being - and a smaller caller-chosen `max_chars` can be shown to carry less than a larger one.
      return html("Long fixture", `<h1>Long page</h1><p>A page long enough to exceed the text read's own ceiling.</p>${filler(300)}`);

    case "transition-a":
      /**
       * 014/T367 — where a session works, with two ways to be taken somewhere else.
       *
       * Both are `/go-…` paths on *this* origin that answer 302: the agent clicks a link on the
       * page it is on, and the server decides where the tab ends up, which is exactly the move
       * FR-185 is about (a click, a redirect, a form post - none of them asked for by name).
       */
      return html(
        "Transition A",
        `<h1>Transition A</h1>
<p>The page a session works on. Its two links are redirects the server resolves.</p>
<button type="button" id="safe-button" onclick="document.getElementById('clicked').textContent = 'clicked at ' + new Date().toISOString()">Safe action</button>
<p id="clicked">not clicked yet</p>
<button type="button" id="to-b" onclick="window.location.href = '/go-b'">Go to B</button>
<button type="button" id="to-bc" onclick="window.location.href = '/go-bc'">Go to B then C</button>
${filler(6)}`,
      );

    case "transition-b":
      return html(
        "Transition B",
        `<h1>Transition B</h1>
<p>An ordinary page on another origin. Nothing here is sensitive and nothing here navigates by itself.</p>
<button type="button" id="safe-button" onclick="document.getElementById('clicked').textContent = 'clicked at ' + new Date().toISOString()">Safe action</button>
<p id="clicked">not clicked yet</p>
<p><a href="https://${HOST}:${TEST_PAGE_ALLOW_PORT}/transition-a" id="back-to-a">Back to A</a></p>
${filler(6)}`,
      );

    case "transition-batch":
      // A sequence whose second step leaves: two safe buttons around one link that redirects to a
      // third origin, so a batch can be stopped between two steps that would both have worked.
      return html(
        "Transition batch",
        `<h1>Transition batch</h1>
<p>Three steps, the middle of which takes the tab to another origin.</p>
<button type="button" id="safe-button" onclick="document.getElementById('clicked').textContent = 'clicked at ' + new Date().toISOString()">Safe action</button>
<p id="clicked">not clicked yet</p>
<button type="button" id="to-c" onclick="window.location.href = '/go-c'">Leave for C</button>
${filler(4)}`,
      );

    case "upload-multi":
      return html(
        "Upload multi",
        `<h1>Upload several files</h1>
<p>One file input that accepts more than one file, and says what it was given.</p>
<label>Attachments <input type="file" name="attachments" multiple onchange="document.getElementById('uploaded').textContent = this.files.length === 0 ? 'no file chosen' : Array.from(this.files).map(function (file) { return file.name + ':' + file.size; }).join(', ')"></label>
<p id="uploaded">no file chosen</p>
${filler(4)}`,
      );

    case "origin-change":
      return html(
        "Origin-change fixture",
        `<h1>Origin-change page</h1>
<p>These links move to a different origin, which must invalidate the binding rather than carry it over.</p>
<ul>
  <li><a href="https://${HOST}:${TEST_PAGE_ALLOW_PORT}/ordinary">allow origin (${TEST_PAGE_ALLOW_PORT})</a></li>
  <li><a href="https://${HOST}:${TEST_PAGE_DENY_PORT}/ordinary">deny origin (${TEST_PAGE_DENY_PORT})</a></li>
  <li><a href="https://${HOST}:${TEST_PAGE_UNKNOWN_PORT}/ordinary">unknown origin (${TEST_PAGE_UNKNOWN_PORT})</a></li>
</ul>
${filler(6)}`,
      );
  }
}

function index(port: number): string {
  const rows = [...FIXTURES, ...PAGE_FILES]
    .map((name) => `<li><a href="/${name}">${name}</a></li>`)
    .join("\n");
  return layout(
    `Page fixtures (${PORT_LABEL[port] ?? "?"})`,
    `<h1>Page fixtures</h1>
<p>Origin <code>https://${HOST}:${port}</code> - origin safety says <strong>${PORT_LABEL[port] ?? "?"}</strong>.</p>
<ul>${rows}</ul>`,
  );
}

function handle(port: number, request: IncomingMessage, response: ServerResponse): void {
  const path = (request.url ?? "/").split("?")[0] ?? "/";

  if (path === "/" || path === "") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(index(port));
    return;
  }

  if (path === "/iframe-child") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(
      layout(
        "Iframe child",
        `<h2>Framed content</h2><p>This paragraph lives in a child frame, not the top document.</p>
<button type="button">Framed action</button>`,
      ),
    );
    return;
  }

  /**
   * 014/T367 — the redirects themselves (FR-185).
   *
   * A 302 rather than a link straight to the other origin, because the two are different facts:
   * a link's destination is in the page the agent read, and a redirect's is not. The agent asks
   * for a path on the origin it is already on, and the tab ends up somewhere else - which is the
   * whole of what the owner is then asked about.
   *
   * `/go-bc` chains: it redirects to `/go-c` on B, which redirects again to C, so two commits
   * happen with no call in between (the collapse of FR-189).
   */
  const redirects: Record<string, string> = {
    "/go-b": `https://${HOST}:${TEST_PAGE_UNKNOWN_PORT}/transition-b`,
    "/go-c": `https://${HOST}:${TEST_PAGE_DENY_PORT}/transition-b`,
    "/go-bc": `https://${HOST}:${TEST_PAGE_UNKNOWN_PORT}/go-c`,
  };
  const redirect = redirects[path];
  if (redirect) {
    response.writeHead(302, { location: redirect, "cache-control": "no-store" });
    response.end();
    return;
  }

  if (path === "/manual.pdf") {
    response.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
    response.end("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    return;
  }

  const file = PAGE_FILES.find((candidate) => path === `/${candidate}`);
  if (file) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(pageFile(file, port));
    return;
  }

  const name = FIXTURES.find((fixture) => path === `/${fixture}`);
  if (!name) {
    // The SPA fixture pushes synthetic paths; serve it for anything under /spa/.
    if (path.startsWith("/spa/")) {
      const spa = page("spa", port);
      response.writeHead(spa.status, spa.headers);
      response.end(spa.body);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("fixture.not-found");
    return;
  }

  const rendered = page(name, port);
  response.writeHead(rendered.status, rendered.headers);
  response.end(rendered.body);
}

function main(): void {
  if (!existsSync(leafPfxPath)) {
    process.stderr.write(
      `test-pki.leaf-missing\n  expected ${leafPfxPath}\n  run: npm run test:certs:install\n`,
    );
    process.exit(1);
  }
  const pfx = readFileSync(leafPfxPath);

  const servers = [TEST_PAGE_ALLOW_PORT, TEST_PAGE_DENY_PORT, TEST_PAGE_UNKNOWN_PORT].map((port) => {
    const server = createServer({ pfx, passphrase: PFX_PASSPHRASE }, (request, response) =>
      handle(port, request, response),
    );
    server.listen(port, HOST);
    return server;
  });

  process.stdout.write(
    [
      "",
      "page fixtures ready",
      `  allow    https://${HOST}:${TEST_PAGE_ALLOW_PORT}/`,
      `  deny     https://${HOST}:${TEST_PAGE_DENY_PORT}/`,
      `  unknown  https://${HOST}:${TEST_PAGE_UNKNOWN_PORT}/`,
      "",
      `  fixtures: ${FIXTURES.join(", ")}`,
      `  pages:    ${PAGE_FILES.join(", ")}`,
      "",
      "  the extension holds no host permission for 127.0.0.1 - page access still needs activeTab",
      "",
    ].join("\n"),
  );

  const shutdown = (signal: string) => {
    process.stdout.write(`\n${signal} received, closing\n`);
    for (const server of servers) {
      server.close();
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
