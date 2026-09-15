/**
 * Client render test.
 *
 * The browser half has no test framework, and the parts added here (工作流
 * 管理: cards, schedule controls, run history, log panel) are exactly the parts
 * that a syntax check cannot validate — a typo, a missing helper or a bad
 * property access only shows up when the component actually runs.
 *
 * So this builds the REAL component tree with a minimal React stand-in:
 * `createElement` returns a plain object, hooks hand back their initial value,
 * and a tiny renderer expands function components. Building the tree *is* the
 * test — every JSX expression, helper and prop runs. What a user would read is
 * then asserted against the collected text.
 *
 * Two passes over the same file:
 *   1. as shipped — no workflow is registered, so this covers the empty state;
 *   2. with the workflow state seeded in memory — covers the card, the schedule
 *      controls, every run status and the log panel, which pass 1 never reaches.
 * The seeding patches the source text in memory only; nothing is written.
 *
 * Run: node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const CLIENT_SOURCE = readFileSync(join(__dirname, "..", "lib", "client.js"), "utf8");

/** The smallest React that can build a tree: elements, and hooks that just return. */
function makeReactStub(options) {
  const settings = options || {};
  const stateCalls = [];
  const cleanups = [];
  return {
    Fragment: "Fragment",
    effectCleanups: cleanups,
    createElement: function (type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      const merged = Object.assign({}, props);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type: type, props: merged };
    },
    // There is no re-render, so the initial value is what the single pass draws —
    // but every setter call is recorded, which is how a test can assert what the
    // mount-time hydration actually loaded.
    useState: function (initial) {
      return [typeof initial === "function" ? initial() : initial, function (next) { stateCalls.push(next); }];
    },
    // Effects are skipped by default (one render pass is the test); a test that
    // needs to exercise the mount path opts in. A throwing effect is swallowed:
    // effects here assume a real browser, and the assertions that matter are on
    // the state setters the effect calls before it could ever reach that point.
    // Cleanups are collected so a test can simulate unmount.
    useEffect: function (fn) {
      if (settings.runEffects !== true) return;
      try {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      } catch (error) { /* browser-only effect body */ }
    },
    useLayoutEffect: function () {},
    useRef: function (initial) { return { current: initial === undefined ? null : initial }; },
    useMemo: function (fn) { return fn(); },
    useCallback: function (fn) { return fn; },
    createContext: function () { return {}; },
    stateCalls: stateCalls
  };
}

/** Expand function components into a plain tree, guarding against a runaway loop. */
function render(node, depth) {
  if (depth > 60) throw new Error("render depth exceeded — a component is recursing");
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(function (child) { return render(child, depth + 1); });
  if (typeof node === "string" || typeof node === "number") return node;
  if (typeof node.type === "function") return render(node.type(node.props || {}), depth + 1);
  // Props are kept (not just children), so a test can assert on `src` and other
  // attributes rather than only on the text a user would read.
  return { type: node.type, props: node.props, children: render(node.props && node.props.children, depth + 1) };
}

/** Every string in the tree, in render order — what a user would actually read. */
function collectText(node, out) {
  const text = out || [];
  if (node === null || node === undefined) return text;
  if (typeof node === "string" || typeof node === "number") { text.push(String(node)); return text; }
  if (Array.isArray(node)) { node.forEach(function (child) { collectText(child, text); }); return text; }
  collectText(node.children, text);
  return text;
}

/**
 * Evaluate the client bundle, run its `apply`, and return the components it
 * registers.
 *
 * @param {string} source - client source (possibly patched in memory).
 * @param {object} demo - values bound to the `__DEMO_*` names a patch inserts;
 *   the keys ARE the parameter names, so each test declares only what it seeds.
 * @param {object} [options]
 * @param {boolean} [options.runEffects] - run `useEffect` bodies, which is what
 *   exercises the mount-time state load.
 * @param {Function} [options.fetch] - replaces `fetch` for apiGet/apiPost.
 * @returns {{view: Function, entries: object, injected: string[], stateCalls: any[]}} the
 *   `conversation.view` component, every registration keyed `name:id` (the plugin
 *   registers into more than one slot — keeping only the last one is how a test
 *   ends up rendering the wrong component), the slot names the bundle declared a
 *   dependency on, and every value any `useState` setter was called with.
 */
function loadClient(source, demo, options) {
  const settings = options || {};
  const react = makeReactStub({ runEffects: settings.runEffects === true });
  const demoNames = Object.keys(demo || {});
  const demoValues = demoNames.map(function (name) { return demo[name]; });
  const fetchImpl = settings.fetch || function () {
    return Promise.resolve({ json: function () { return Promise.resolve({ ok: true }); } });
  };
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load: function (mod) { captured = mod; } },
    // The plugin listens for resize to re-place the overlay pill; a no-op here
    // keeps its effect body runnable in Node.
    addEventListener: function () {},
    removeEventListener: function () {}
  };
  function shim(name) {
    if (name === "react") return react;
    throw new Error("unexpected require(" + name + ")");
  }
  // Function(...) builds the same function as `new Function(...)` without the
  // `new`, so the parameter list can be spread.
  const factory = Function.apply(null, ["window", "require", "fetch"].concat(demoNames, [source]));
  factory.apply(null, [fakeWindow, shim, fetchImpl].concat(demoValues));

  assert.ok(captured, "the bundle did not call window.__ModuleLoader__.load");
  const mod = captured.factory(shim);

  let registered = null;
  const entries = {};
  const injected = [];
  const slots = {
    // The name matters: a slot is only wired up if the plugin injected it, so a
    // typo here leaves the entry dangling and nothing else would notice.
    inject: function (name, fn) { injected.push(name); fn(); },
    register: function (opts, comp) {
      entries[opts.name + ":" + (opts.id === undefined ? "" : opts.id)] = comp;
      if (opts.name === "conversation.view") registered = comp;
      return function () {};
    }
  };
  mod.apply({ get: function (key) { return key === "slots" ? slots : null; } });
  assert.equal(typeof registered, "function", "the workbench registered no conversation view");
  return { view: registered, entries: entries, injected: injected, stateCalls: react.stateCalls, effectCleanups: react.effectCleanups };
}

/** Render the whole workbench once and return every string it produced. */
function renderWorkbench(source, demo, options) {
  return collectText(render(loadClient(source, demo, options).view({}), 0), []);
}

test("with nothing registered, 工作流 renders an honest empty state", () => {
  const text = renderWorkbench(CLIENT_SOURCE, {
    __DEMO_WORKFLOWS__: [], __DEMO_RUNS__: [], __DEMO_RUN__: null
  }).join("|");
  assert.match(text, /还没有已注册的工作流/);
  // The empty state must say where a workflow comes from, not just that none exist.
  assert.match(text, /lib\/workflows\.js/);
});

test("workflow cards render their schedule, controls and every run status", () => {
  const now = Date.now();
  const demo = {
    workflows: [
      {
        id: "demo.sync", name: "示例同步", description: "把二创印花同步到外部目录",
        enabled: true, schedule: { type: "interval", everyMinutes: 30 }, nextRunAt: now + 1800000,
        lastRunAt: now - 60000, lastRunId: "run-a", lastStatus: "success", running: false, runId: null
      },
      {
        id: "demo.daily", name: "每日备份", description: "",
        enabled: false, schedule: { type: "daily", atTime: "09:00" }, nextRunAt: null,
        lastRunAt: now - 86400000, lastRunId: "run-b", lastStatus: "failed", running: false, runId: null
      },
      {
        id: "demo.live", name: "正在跑的", description: "验证运行中的样式",
        enabled: true, schedule: { type: "interval", everyMinutes: 1 }, nextRunAt: now + 60000,
        lastRunAt: now, lastRunId: "run-c", lastStatus: "running", running: true, runId: "run-c"
      }
    ],
    runs: [
      { id: "run-c", workflowId: "demo.sync", workflowName: "示例同步", trigger: "schedule", status: "running", startedAt: now, finishedAt: null, durationMs: null, error: null, summary: null, skippedReason: null, logCount: 1 },
      { id: "run-a", workflowId: "demo.sync", workflowName: "示例同步", trigger: "manual", status: "success", startedAt: now - 60000, finishedAt: now - 58000, durationMs: 2000, error: null, summary: "同步 3 个文件", skippedReason: null, logCount: 2 },
      { id: "run-b", workflowId: "demo.sync", workflowName: "示例同步", trigger: "schedule", status: "skipped", startedAt: now - 7200000, finishedAt: now - 7200000, durationMs: 0, error: null, summary: null, skippedReason: "DSH 未运行期间错过了这次调度，已跳过（不补跑）。", logCount: 1 }
    ],
    run: {
      id: "run-a", workflowId: "demo.sync", workflowName: "示例同步", trigger: "manual", status: "success",
      startedAt: now - 60000, finishedAt: now - 58000, durationMs: 2000,
      error: null, summary: "同步 3 个文件", skippedReason: null,
      logs: [
        { t: now - 59000, level: "info", message: "开始同步" },
        { t: now - 58500, level: "warn", message: "有 1 个文件已存在，跳过" }
      ]
    }
  };

  const patched = CLIENT_SOURCE
    .replace("var workflowsState = React.useState([]);", "var workflowsState = React.useState(__DEMO_WORKFLOWS__);");
  // Guard the guard: if the seed stops matching (the code was refactored), this
  // test would quietly render something else and still "pass".
  assert.match(patched, /useState\(__DEMO_WORKFLOWS__\)/);

  const text = renderWorkbench(patched, {
    __DEMO_WORKFLOWS__: demo.workflows,
    __DEMO_RUNS__: [],
    __DEMO_RUN__: null
  });
  const missing = [
    ["示例同步", "a workflow's name"],
    ["把二创印花同步到外部目录", "its description"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  // The list shows every workflow with its live status and a way in.
  missing.push.apply(missing, [
    ["每日备份", "a second workflow"],
    ["正在跑的", "a third workflow"],
    ["已停用", "a disabled workflow"],
    ["成功", "a workflow whose last run succeeded"],
    ["失败", "a workflow whose last run failed"],
    ["进入", "the way into a workflow's page"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; }));
  assert.deepEqual(missing, [], "nothing the user needs is missing from the workflow list");
});

test("a workflow's page renders its settings, schedule and run history", () => {
  const now = Date.now();
  const workflow = {
    id: "demo.sync", name: "示例同步", description: "把二创印花同步到外部目录",
    enabled: true, schedule: { type: "interval", everyMinutes: 30 }, nextRunAt: now + 1800000,
    lastRunAt: now - 60000, lastRunId: "run-a", lastStatus: "success", running: false, runId: null,
    settingFields: [
      { key: "sceneCount", label: "随机选择多少个场景图", type: "number", min: 1, max: 24, default: 2, help: "每件二创T恤随机挑这么多张场景图" },
      { key: "sceneOutputs", label: "每个场景图出几张", type: "number", min: 1, max: 12, default: 4, help: "每张场景图生成几张成片" }
    ],
    settings: { sceneCount: 3, sceneOutputs: 4 }
  };
  const runs = [
    { id: "run-a", workflowId: "demo.sync", workflowName: "示例同步", trigger: "manual", status: "success", startedAt: now - 60000, finishedAt: now - 58000, durationMs: 2000, error: null, summary: "同步 3 个文件", skippedReason: null, logCount: 2 },
    { id: "run-b", workflowId: "demo.sync", workflowName: "示例同步", trigger: "schedule", status: "skipped", startedAt: now - 7200000, finishedAt: now - 7200000, durationMs: 0, error: null, summary: null, skippedReason: "DSH 未运行期间错过了这次调度，已跳过（不补跑）。", logCount: 1 }
  ];
  const run = {
    id: "run-a", workflowId: "demo.sync", workflowName: "示例同步", trigger: "manual", status: "success",
    startedAt: now - 60000, finishedAt: now - 58000, durationMs: 2000,
    error: null, summary: "同步 3 个文件", skippedReason: null,
    logs: [
      { t: now - 59000, level: "info", message: "开始同步" },
      { t: now - 58500, level: "warn", message: "有 1 个文件已存在，跳过" }
    ]
  };

  const patched = CLIENT_SOURCE
    .replace("var workflowsState = React.useState([]);", "var workflowsState = React.useState(__DEMO_WORKFLOWS__);")
    // The list is a list; everything you can do lives on the page, so open it.
    // Anchored on `detailId` because `detailState` is also the selected run's.
    .replace(
      /var detailState = React\.useState\(null\);\s*\n\s*var detailId = detailState\[0\];/,
      "var detailState = React.useState(__DEMO_WORKFLOWS__[0].id);\n        var detailId = detailState[0];"
    )
    .replace("var runsState = React.useState([]);", "var runsState = React.useState(__DEMO_RUNS__);")
    .replace("var detailState = React.useState(null);", "var detailState = React.useState(__DEMO_RUN__);");
  assert.match(patched, /useState\(__DEMO_WORKFLOWS__\[0\]\.id\)/, "the seed for the open workflow page no longer applies");

  // The page is tabbed, so the settings live on one tab and the log on another;
  // a single render would only ever prove that one of them exists.
  function textFor(tab) {
    const seeded = patched.replace("var tabState = React.useState(tabs[0].key);", "var tabState = React.useState(__DEMO_TAB__);");
    assert.match(seeded, /useState\(__DEMO_TAB__\)/, "the tab seed no longer applies — update it");
    return renderWorkbench(seeded, {
      __DEMO_WORKFLOWS__: [workflow],
      __DEMO_RUNS__: runs,
      __DEMO_RUN__: run,
      __DEMO_TAB__: tab
    });
  }
  const settingsText = textFor("settings");
  const missing = [
    ["← 工作流", "the way back to the list"],
    ["示例同步", "the workflow's name"],
    ["已启用", "its enabled state"],
    ["每 30 分钟", "its schedule in words"],
    ["下次运行", "when it runs next"],
    ["设置与参数", "the tab the settings live on"],
    ["运行记录", "the tab that holds the history"],
    // The settings form is generated from the definition's declaration.
    ["参数", "the settings block"],
    ["随机选择多少个场景图", "a declared setting's label"],
    ["每个场景图出几张", "the other setting"],
    ["每件二创T恤随机挑这么多张场景图", "a setting's help line"],
    ["1–24", "the declared range, so the user knows the bounds"]
  ].filter(function (entry) {
    return !settingsText.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "nothing the user needs is missing from the workflow page");

  const runsText = textFor("runs");
  const missingHistory = [
    ["运行记录", "the history section"],
    ["已跳过", "a skipped run in the history"],
    ["DSH 未运行期间错过了这次调度", "why that run was skipped"],
    ["开始同步", "a log line of the selected run"],
    ["结果：同步 3 个文件", "the selected run's summary"]
  ].filter(function (entry) {
    return !runsText.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missingHistory, [], "the history tab is missing something");

  // And the tabs must actually separate the two, or they are decoration: a
  // page that renders everything at once is the page this replaced.
  assert.equal(
    runsText.some(function (line) { return line.indexOf("随机选择多少个场景图") !== -1; }),
    false,
    "the settings form must not render on the history tab"
  );
  assert.equal(
    settingsText.some(function (line) { return line.indexOf("开始同步") !== -1; }),
    false,
    "the run log must not render on the settings tab"
  );

  // The inputs must show the values actually in force, not the defaults.
  const values = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "input" && node.props && node.props.value !== undefined) values.push(String(node.props.value));
    walk(node.children);
  })(render(loadClient(patched, { __DEMO_WORKFLOWS__: [workflow], __DEMO_RUNS__: runs, __DEMO_RUN__: run }).view({}), 0));
  assert.equal(values.indexOf("3") !== -1, true, "the overridden setting shows its saved value, got " + JSON.stringify(values));
  assert.equal(values.indexOf("4") !== -1, true, "and the untouched one shows its default");
});

test("the composer can be collapsed from a shell.overlay pill", () => {
  // The workbench wants the composer's height, but the composer is shell-owned —
  // so the control has to live in the shell's own floating layer, where it is
  // still reachable once the composer is gone. Two things can break silently and
  // are asserted here: the entry landing in the wrong slot (or shadowing another
  // one), and the pill rendering without a label that says what it does.
  const loaded = loadClient(CLIENT_SOURCE, {});
  const toggle = loaded.entries["shell.overlay:ecom-composer-toggle"];
  assert.equal(typeof toggle, "function", "the toggle must register into shell.overlay");
  assert.deepEqual(
    Object.keys(loaded.entries).sort(),
    ["conversation.view:ecom-workbench", "shell.overlay:ecom-composer-toggle"],
    "the plugin registers exactly two things — an additive overlay entry must not shadow another slot"
  );
  // The overlay is a list slot: a fresh id sits beside the shipped entries. A
  // registration without an id would still be additive, but ids are what owners
  // use to address an entry, so the contract asks for one.
  assert.match(CLIENT_SOURCE, /id: "ecom-composer-toggle"/, "the overlay entry must carry an id");

  // Injected name and registered name have to agree. A slot is only wired up if
  // the plugin declared a dependency on it, so a typo in `inject(...)` leaves the
  // entry dangling — the registration itself still looks perfectly fine.
  assert.deepEqual(loaded.injected, ["shell.overlay", "conversation.view"],
    "the plugin must inject each slot it registers into");
  Object.keys(loaded.entries).forEach(function (key) {
    const slotName = key.slice(0, key.indexOf(":"));
    assert.equal(loaded.injected.indexOf(slotName) !== -1, true,
      key + " registers into a slot the plugin never injected");
  });

  const text = collectText(render(toggle({}), 0), []);
  assert.equal(text.some(function (line) { return line.indexOf("收起输入框") !== -1; }), true,
    "the pill must say what pressing it does, got " + JSON.stringify(text));
  assert.equal(text.some(function (line) { return line.indexOf("展开输入框") !== -1; }), false,
    "it starts expanded, so it must not offer to expand");

  // Walking the real click path, not seeding the state: the click must ask for
  // the collapsed state, which is what the effect then applies to the shell.
  let pill = null;
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "button") pill = pill || node;
    walk(node.children);
  })(render(toggle({}), 0));
  assert.ok(pill, "the overlay entry must render a button");
  assert.equal(typeof pill.props.onClick, "function", "the pill must be clickable");
  pill.props.onClick();
  assert.equal(loaded.stateCalls.indexOf(true) !== -1, true,
    "clicking must ask for the collapsed state, got " + JSON.stringify(loaded.stateCalls));

  // The hook it hangs that state on is the shell's own declared attribute, and
  // the plugin must be able to render with no DOM at all (effects included).
  assert.match(CLIENT_SOURCE, /\[data-composer-seat\]/,
    "collapsing is only legitimate through the seat the conversation UI declares");
  assert.equal(render(loadClient(CLIENT_SOURCE, {}, { runEffects: true }).entries["shell.overlay:ecom-composer-toggle"]({}), 0) !== null, true,
    "the pill must render even when there is no document (the effect body guards on it)");
});

test("collapsing hides the seat the shell declares, and unmounting gives it back", () => {
  // The collapse writes to an element this plugin does not own, so it is the
  // riskiest part of the feature and gets a real (if hand-rolled) DOM rather than
  // a promise that the browser will like it. What is asserted: the seat the shell
  // marks is the one hidden, the previous inline style is remembered rather than
  // assumed, and unmounting puts it back — "no input box and no button" must not
  // be reachable.
  const seat = {
    style: { display: "flex" },
    dataset: {},
    getBoundingClientRect: function () { return { top: 600, bottom: 700, left: 0, right: 900, width: 900, height: 100 }; }
  };
  const layer = { getBoundingClientRect: function () { return { top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 }; } };
  const before = {
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    localStorage: globalThis.localStorage,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval
  };
  const ticks = [];
  globalThis.document = {
    body: {},
    querySelector: function (selector) {
      if (selector === "[data-composer-seat]") return seat;
      if (selector === "[data-shell-overlay]") return layer;
      return null;
    }
  };
  globalThis.MutationObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };
  globalThis.localStorage = { getItem: function () { return "1"; }, setItem: function () {} };
  // Never a real timer: an interval left running would keep the test process up.
  globalThis.setInterval = function (fn) { ticks.push(fn); return ticks.length; };
  globalThis.clearInterval = function () {};

  try {
    const loaded = loadClient(CLIENT_SOURCE, {}, { runEffects: true });
    render(loaded.entries["shell.overlay:ecom-composer-toggle"]({}), 0);

    assert.equal(seat.style.display, "none", "the remembered preference must hide the composer's seat on mount");
    assert.equal(seat.dataset.ecomComposerCollapsed, "1", "and it must be marked, so the plugin knows it owns that display");
    assert.equal(seat.dataset.ecomPrevDisplay, "flex", "the previous inline display is remembered, not assumed to be empty");

    // While collapsed it re-asserts (the shell rebuilds the seat on a session
    // bind); the tick must not throw with the seat present and must leave it
    // collapsed.
    assert.equal(ticks.length, 1, "collapsed state is the one that needs upkeep");
    ticks[0]();
    assert.equal(seat.style.display, "none", "re-asserting keeps it collapsed");

    // Unmount: the plugin gives the shell its composer back.
    loaded.effectCleanups.forEach(function (cleanup) { cleanup(); });
    assert.equal(seat.style.display, "flex", "unmounting must restore the composer, not leave the shell without an input box");
    assert.equal(seat.dataset.ecomComposerCollapsed, undefined, "and drop its claim on the element");
  } finally {
    Object.keys(before).forEach(function (key) {
      if (before[key] === undefined) delete globalThis[key];
      else globalThis[key] = before[key];
    });
  }
});

test("the workbench nav and its view list cannot drift apart", () => {
  // `viewEls` and `viewNames` are parallel arrays indexed by position, and the
  // nav is built from two more lists. A mismatch shows the wrong view under a
  // nav label — silently, and only for the tabs after the insertion point.
  function navLabels(name) {
    const match = new RegExp("var " + name + " = \\[([\\s\\S]*?)\\]\\.map\\(navButton\\);").exec(CLIENT_SOURCE);
    assert.ok(match, name + " not found in the client source");
    return Array.from(match[1].matchAll(/"([^"]+)"/g)).map(function (m) { return m[1]; });
  }
  const viewNamesMatch = /var viewNames = \[([^\]]*)\]/.exec(CLIENT_SOURCE);
  assert.ok(viewNamesMatch, "viewNames not found in the client source");
  const viewNames = JSON.parse("[" + viewNamesMatch[1] + "]");
  const navOrder = navLabels("primaryNav").concat(navLabels("secondaryNav"));

  const viewElsBlock = /var viewEls = \[([\s\S]*?)\n {8}\];/.exec(CLIENT_SOURCE);
  assert.ok(viewElsBlock, "viewEls not found in the client source");
  const viewElsCount = viewElsBlock[1].split("\n").filter(function (line) { return /^\s+h\(/.test(line); }).length;

  assert.equal(viewElsCount, viewNames.length, "viewEls and viewNames have different lengths");
  assert.deepEqual(viewNames, navOrder, "the nav order and the view order disagree");
  // 工作流 belongs directly under T恤二创, in the generation group.
  assert.equal(viewNames[viewNames.indexOf("工作流") - 1], "T恤二创");
  assert.ok(navLabels("primaryNav").indexOf("工作流") !== -1, "工作流 must be in the primary nav group");
});

test("the pipeline panel renders its groups, estimate and four result stages", () => {
  // 印花流水线's own panel — the queue, the cost estimate and the product view —
  // is the only place its 225-call cost is shown before it is spent, so it gets
  // the same treatment as the rest of the client: the real component tree, with
  // its internal state seeded, rather than trusting a syntax check.
  const now = Date.now();
  const pipelineWorkflow = {
    id: "print.pipeline", name: "印花流水线", description: "一组参考图 → 四步",
    enabled: true, schedule: null, nextRunAt: null,
    lastRunAt: now - 1000, lastRunId: "run-1", lastStatus: "success", running: false, runId: null
  };
  const estimate = {
    workflowId: "print.pipeline",
    group: { key: "商品A", name: "商品A", source: "inbox", imageCount: 3, images: ["a.png", "b.png", "c.png"] },
    prompts: {
      extract: { name: "印花提取", found: true },
      recreate: [{ name: "印花二创-1", outputs: 2 }, { name: "印花二创-2", outputs: 2 }],
      tshirt: { name: "印花T恤融合", found: true },
      scene: { name: "换装+裂变", found: true }
    },
    // Three 款式, one shot each — the shape the estimate has to describe. `selected`
    // is the flattened 白底图 list, which is NOT the 款式 count.
    tshirt: {
      id: "t1", name: "测试T恤", photos: ["p1", "p2", "p3"], selected: ["p1", "p2", "p3"],
      colorways: [
        { id: "cw1", name: "白色", white: ["p1"], detail: [], model: [] },
        { id: "cw2", name: "杏色", white: ["p2"], detail: [], model: [] },
        { id: "cw3", name: "黑色", white: ["p3"], detail: [], model: [] }
      ],
      sizeImages: []
    },
    scenes: { available: 228 },
    plan: { extract: 1, recreate: 8, tshirt: 24, scene: 192, total: 225 },
    pending: { extract: 1, recreate: 8, tshirt: 24, scene: 192, total: 225, printsAvailable: 0 },
    warnings: ["该分组之前选的款式已经不在这件T恤里了，本次按全部 3 个款式处理。"],
    cap: { max: 400, exceeded: false },
    settings: { recreateOutputs: 2, scenePasses: 2, sceneOutputs: 4, concurrency: 2 }
  };
  const demo = {
    workflows: [pipelineWorkflow],
    runs: [],
    run: null,
    groups: [
      { key: "商品A", name: "商品A", source: "inbox", images: ["a.png", "b.png"], imageCount: 2, status: "done", approvedAt: now, tshirtId: null, tshirtImages: null, counts: { extract: 1, recreate: 8, tshirt: 24, scene: 192 }, failures: 0, lastRunAt: now, lastRunId: "run-1", updatedAt: now },
      { key: "商品B", name: "商品B", source: "loose", images: ["c.png"], imageCount: 1, status: "pending", approvedAt: null, tshirtId: null, tshirtImages: null, counts: null, failures: 0, lastRunAt: null, lastRunId: null, updatedAt: null }
    ],
    results: { key: "商品A", total: 2, outputs: [{ id: "o1", file: "out-1.png" }, { id: "o2", file: "out-2.png" }] },
    library: [{ id: "l1", file: "print.png", groupKey: "商品A" }],
    recreations: [{ id: "r1", groupKey: "商品A", prints: [{ id: "r1p1", file: "re-1.png" }, { id: "r1p2", file: "re-2.png" }] }],
    tshirtRecreations: [{ id: "t1r", groupKey: "商品A", prints: [{ id: "t1p1", file: "comp-1.png" }] }]
  };

  const patched = CLIENT_SOURCE
    .replace("var workflowsState = React.useState([]);", "var workflowsState = React.useState(__DEMO_WORKFLOWS__);")
    .replace("var libraryState = React.useState([]);", "var libraryState = React.useState(__DEMO_LIBRARY__);")
    .replace("var recreationsState = React.useState([]);", "var recreationsState = React.useState(__DEMO_RECREATIONS__);")
    .replace("var tshirtRecreationsState = React.useState([]);", "var tshirtRecreationsState = React.useState(__DEMO_TSHIRT_RECREATIONS__);")
    // Open the pipeline's page, where its queue and estimate now live.
    .replace(
      /var detailState = React\.useState\(null\);\s*\n\s*var detailId = detailState\[0\];/,
      "var detailState = React.useState(__DEMO_WORKFLOWS__[0].id);\n        var detailId = detailState[0];"
    )
    .replace("var groupsState = React.useState([]);", "var groupsState = React.useState(__DEMO_GROUPS__);")
    .replace("var inboxState = React.useState(\"\");", "var inboxState = React.useState(__DEMO_INBOX__);")
    .replace("var estimateState = React.useState(null);", "var estimateState = React.useState(__DEMO_ESTIMATE__);")
    .replace("var resultsState = React.useState(null);", "var resultsState = React.useState(__DEMO_RESULTS__);");
  assert.notEqual(patched, CLIENT_SOURCE, "the in-memory seed no longer applies — update it");
  assert.match(patched, /useState\(__DEMO_GROUPS__\)/);

  const loaded = loadClient(patched, {
    __DEMO_WORKFLOWS__: demo.workflows,
    __DEMO_RUNS__: demo.runs,
    __DEMO_RUN__: demo.run,
    __DEMO_GROUPS__: demo.groups,
    __DEMO_INBOX__: "E:/inbox/print.pipeline",
    __DEMO_ESTIMATE__: estimate,
    __DEMO_RESULTS__: demo.results,
    __DEMO_LIBRARY__: demo.library,
    __DEMO_RECREATIONS__: demo.recreations,
    __DEMO_TSHIRT_RECREATIONS__: demo.tshirtRecreations
  });
  const view = loaded.view;
  const text = collectText(render(view({}), 0), []);

  const missing = [
    ["参考图分组", "the panel heading"],
    ["收图目录", "where to drop folders by hand"],
    // The upload flow is staged-then-submit. It used to write on file-select,
    // which quietly required the group name to be typed FIRST — picking the
    // screenshots and then naming them (the natural order) silently failed.
    ["选择图片", "the picker button"],
    ["创建分组", "the explicit submit for the staged screenshots"],
    ["还没有选图", "the staged-count hint, so a pick that did nothing is visible"],
    ["商品A", "an inbox group"],
    ["商品B", "a second group"],
    ["已完成", "a finished group's status"],
    ["未确认", "an unapproved group's status"],
    ["估算并运行", "the estimate entry point"],
    ["已排队", "a group handed to the scheduler"],
    ["合计 225 次生成调用", "the cost, before it is spent"],
    // 融合 is one call per 款式 (a colour), so the label has to name the 款式 count —
    // showing the 白底图 count as 款式 reads as "6 款式" for a 3-colour T恤 shot
    // twice each, which is what it was doing.
    ["T恤融合 24（3 个款式 · 3 张白底图）", "the 款式 count, not the photo count"],
    ["本次还需 225 次", "what this run would actually do"],
    ["上限 400 次", "the ceiling it will be checked against"],
    ["已经不在这件T恤里", "the stale-selection warning"],
    ["① 提取印花", "stage 1 results"],
    ["② 二创印花", "stage 2 results"],
    ["③ 二创T恤", "stage 3 results"],
    ["④ 场景成片", "stage 4 results"],
    ["与场景图管理的参考图池分开", "why the products are not scene references"],
    ["前三步的产物同时也进了", "where the intermediates can be reused"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "the pipeline panel is missing something the user needs");

  // The estimate and the outputs belong to *one group*, so they must render
  // inside that group's own row. They used to be appended under the whole list,
  // which put the answer — and the three buttons that act on it — arbitrarily
  // far from the row that was clicked.
  const flat = text.join("|");
  const rowA = flat.indexOf("商品A");
  const estimateAt = flat.indexOf("这一组要花多少");
  const rowB = flat.indexOf("商品B");
  assert.ok(rowA !== -1 && rowB !== -1, "both groups must be on the page");
  assert.ok(estimateAt > rowA && estimateAt < rowB,
    "the estimate for 商品A must sit inside its row, before the next group");
  assert.ok(flat.indexOf("① 提取印花") > rowA && flat.indexOf("① 提取印花") < rowB,
    "so must the group's own outputs");
  // The raw file-name list under every row was noise at this density; the names
  // now live in the row's tooltip instead of in the layout.
  assert.equal(text.some(function (line) { return line === "a.png、b.png"; }), false,
    "the row must not print its reference file names inline");

  // The four stages must actually render their own artefacts. Image file names
  // live in `src`, not in text, so the tree is walked rather than the text.
  function collectImgSrcs(node, out) {
    const found = out || [];
    if (node === null || node === undefined || typeof node !== "object") return found;
    if (Array.isArray(node)) { node.forEach(function (child) { collectImgSrcs(child, found); }); return found; }
    if (node.type === "img" && node.props && node.props.src) found.push(String(node.props.src));
    collectImgSrcs(node.children, found);
    return found;
  }
  const srcs = collectImgSrcs(render(view({}), 0), []);
  ["print.png", "re-1.png", "comp-1.png", "out-1.png"].forEach(function (file) {
    assert.equal(srcs.some(function (src) { return src.indexOf(file) !== -1; }), true,
      "stage result " + file + " is not rendered (got " + srcs.length + " images)");
  });
});

/**
 * The product page's own subtree (the overlay ProductModal renders).
 *
 * Scoping is not optional: `collectText` walks the whole tree, and **every** workbench
 * view stays mounted — inactive ones hidden with `display:none`, not unmounted — so
 * 尺码图 and its images also appear in T恤管理. An unscoped assertion therefore passes
 * whatever the modal does, which is exactly what the first version of this test did.
 */
function findModal(tree) {
  let found = null;
  (function walk(node) {
    if (found !== null || node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const style = node.props && node.props.style;
    if (style && style.position === "fixed" && style.zIndex === 900) { found = node; return; }
    walk(node.children);
  })(tree);
  return found;
}

test("the product page's image strip carries the 白底图 and the T恤's 尺码图, neither generated", () => {
  // Both already exist and were simply not reachable: the 白底图 is the 融合 output
  // (the composite the whole card is named after) and the 尺码图 is an upload on the
  // T恤. Showing the 尺码图 is the whole of what it needs — a size table is a diagram
  // with numbers on it, and a model asked to draw one invents the numbers.
  //
  // The modal only mounts once a 商品 is open, which a single render pass cannot
  // reach by clicking, so the open state is seeded — exactly the shortcut the shelf
  // test uses for its loading state.
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    .replace("var tshirtsState = React.useState([]);", "var tshirtsState = React.useState(__DEMO_SHELF_TSHIRTS__);")
    .replace("var tshirtRecreationsState = React.useState([]);", "var tshirtRecreationsState = React.useState(__DEMO_SHELF_RECREATIONS__);")
    .replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);")
    // p3 is the shot whose composite (t2.png) resolves through 二创T恤 to 白色 of the
    // T恤 — the only path that reaches a 尺码图.
    .replace("var openState = React.useState(null);", "var openState = React.useState(__DEMO_OPEN__);");
  assert.match(patched, /useState\(__DEMO_OPEN__\)/, "the open-商品 seed no longer applies — update it");

  const loaded = loadClient(patched, {
    __DEMO_PRODUCTS__: DEMO_PRODUCTS,
    __DEMO_SHELF_TSHIRTS__: DEMO_SHELF_TSHIRTS,
    __DEMO_SHELF_RECREATIONS__: DEMO_SHELF_RECREATIONS,
    __DEMO_OPEN__: { groupKey: "商品A", shotId: "p3" }
  });
  const tree = render(loaded.view({}), 0);
  const modal = findModal(tree);
  assert.notEqual(modal, null, "the seeded 商品 must actually open the product page");

  // The strip is 产品展示图 + 成片 + 尺码图, so all three are reachable from the one
  // list the big viewer, the arrows and the counter all walk.
  const srcs = collectImgSrcsOf(modal);
  assert.equal(srcs.some(function (src) { return src.indexOf("t2.png") !== -1; }), true,
    "the 产品展示图 is the 融合 output — the composite this 款式 is named after, got " + JSON.stringify(srcs));
  assert.equal(srcs.some(function (src) { return src.indexOf("size.png") !== -1; }), true,
    "the 尺码图 comes from the T恤 record, got " + JSON.stringify(srcs));
  assert.equal(srcs.some(function (src) { return src.indexOf("b-1.png") !== -1; }), true,
    "and the 款式's own 成片 is still in there with them");

  // Labelled, so the two non-shot entries are not mistaken for more 成片. The labels
  // live on the buttons' titles (a strip 54px wide has no room for text).
  const flat = JSON.stringify(modal);
  assert.equal(flat.indexOf("产品展示图") !== -1, true, "the 白底图 must be labelled");
  assert.equal(flat.indexOf("尺码图") !== -1, true, "and so must the 尺码图");
});

test("参考图分组 takes pasted images, and only while 工作流 is the view on screen", () => {
  // The composer accepts a paste the way the other composers do, so a screenshot
  // does not have to be saved to disk first. Two things have to hold, and a
  // render-only check sees neither: the listener must be registered, and it must
  // NOT be registered while another view is showing. Every view stays mounted —
  // inactive ones are hidden with `display:none`, not unmounted — so an ungated
  // listener silently takes an image pasted into 印花提取, and the symptom is an
  // image in the wrong place rather than any error at all.
  const now = Date.now();
  const pipelineWorkflow = {
    id: "print.pipeline", name: "印花流水线", description: "一组参考图 → 四步",
    enabled: true, schedule: null, nextRunAt: null,
    lastRunAt: now - 1000, lastRunId: "run-1", lastStatus: "success", running: false, runId: null
  };
  const before = { document: globalThis.document };
  const listeners = [];
  globalThis.document = {
    activeElement: null,
    // The workbench injects its layout stylesheet on render, so the stub needs
    // enough of a DOM for that one call. Only the paste registration is asserted.
    head: { appendChild: function () {} },
    createElement: function () { return { style: {}, dataset: {}, textContent: "", appendChild: function () {} }; },
    addEventListener: function (type, fn) { if (type === "paste") listeners.push(fn); },
    removeEventListener: function () {}
  };

  function pasteListenersOn(view) {
    listeners.length = 0;
    const patched = CLIENT_SOURCE
      .replace("var workflowsState = React.useState([]);", "var workflowsState = React.useState(__DEMO_WORKFLOWS__);")
      .replace("var viewState = React.useState(\"印花提取\");", "var viewState = React.useState(__DEMO_VIEW__);")
      // Open the pipeline's page, where the group composer lives.
      .replace(
        /var detailState = React\.useState\(null\);\s*\n\s*var detailId = detailState\[0\];/,
        "var detailState = React.useState(__DEMO_WORKFLOWS__[0].id);\n        var detailId = detailState[0];"
      );
    assert.notEqual(patched, CLIENT_SOURCE, "the in-memory seed no longer applies — update it");
    const loaded = loadClient(patched, { __DEMO_WORKFLOWS__: [pipelineWorkflow], __DEMO_VIEW__: view }, { runEffects: true });
    render(loaded.view({}), 0);
    return listeners.length;
  }

  try {
    assert.equal(pasteListenersOn("工作流") > 0, true,
      "the group composer must listen for a paste while 工作流 is on screen");
    assert.equal(pasteListenersOn("印花提取"), 0,
      "and must not while another view is — a hidden view still runs its effects");
  } finally {
    globalThis.document = before.document;
  }
});

test("a pipeline group row shows the 款式 it is set to run, not just the first T恤", () => {
  // The host has always stored a per-group T恤 choice, but the UI never let anyone
  // set one and never showed which was in force, so every run silently used the
  // first T恤. The picker now selects a **款式** (a colour), which is what brings
  // that colour's 白底图 and its 细节图 along.
  //
  // Rendering the stored choice is the entire point, and it is exactly what
  // "renders without throwing" would miss: getting it wrong still produces a
  // perfectly valid row, just one that names the wrong colour.
  const now = Date.now();
  const pipelineWorkflow = {
    id: "print.pipeline", name: "印花流水线", description: "一组参考图 → 四步",
    enabled: true, schedule: null, nextRunAt: null,
    lastRunAt: now - 1000, lastRunId: "run-1", lastStatus: "success", running: false, runId: null
  };
  const tshirts = [
    // A record from before 款式 existed: read as one 款式 per photo.
    { id: "ta", name: "基础白T", images: ["a1.png", "a2.png", "a3.png"] },
    {
      id: "tb", name: "重磅黑T",
      colorways: [
        { id: "cw-white", name: "白色", white: ["b1.png", "b2.png"], detail: ["b-d1.png"] },
        { id: "cw-black", name: "黑色", white: ["b3.png"], detail: [] }
      ],
      sizeImages: ["b-size.png"],
      images: ["b1.png", "b2.png", "b3.png"]
    }
  ];
  const group = function (key, tshirtId, tshirtImages, tshirtColorways) {
    return {
      key: key, name: key, source: "inbox", images: ["x.png"], imageCount: 1,
      status: "pending", approvedAt: null, tshirtId: tshirtId, tshirtImages: tshirtImages,
      tshirtColorways: tshirtColorways,
      counts: null, failures: 0, lastRunAt: null, lastRunId: null, updatedAt: null
    };
  };
  const demo = {
    __DEMO_WORKFLOWS__: [pipelineWorkflow],
    __DEMO_TSHIRTS__: tshirts,
    // A: a T恤, nothing narrowed. B: nothing stored at all. C: one 款式 picked.
    // D: the pre-款式 per-photo form, which must read as the 款式 owning that photo.
    __DEMO_GROUPS__: [
      group("商品A", "tb", null, null),
      group("商品B", null, null, null),
      group("商品C", "tb", null, ["cw-black"]),
      group("商品D", "tb", ["b2.png"], null)
    ]
  };

  const patched = CLIENT_SOURCE
    .replace("var workflowsState = React.useState([]);", "var workflowsState = React.useState(__DEMO_WORKFLOWS__);")
    .replace("var tshirtsState = React.useState([]);", "var tshirtsState = React.useState(__DEMO_TSHIRTS__);")
    // Open the pipeline's page, which is where its group rows live.
    .replace(
      /var detailState = React\.useState\(null\);\s*\n\s*var detailId = detailState\[0\];/,
      "var detailState = React.useState(__DEMO_WORKFLOWS__[0].id);\n        var detailId = detailState[0];"
    )
    .replace("var groupsState = React.useState([]);", "var groupsState = React.useState(__DEMO_GROUPS__);");
  assert.notEqual(patched, CLIENT_SOURCE, "the in-memory seed no longer applies — update it");
  assert.match(patched, /useState\(__DEMO_TSHIRTS__\)/);

  const view = loadClient(patched, demo).view;
  const text = collectText(render(view({}), 0), []);
  const count = function (needle) {
    return text.filter(function (line) { return line.indexOf(needle) !== -1; }).length;
  };

  // No picker was opened, so every row is showing a *resolved* choice. If the
  // list never reached the panel every row would say so instead.
  assert.equal(count("还没有 T恤"), 0,
    "the T恤 list did not reach the group rows — every row degrades to the empty picker");

  // The exact set is the assertion that matters, and it is deliberately a
  // multiset: five labels for four groups, because 创建分组 carries the same
  // picker — that is the moment the group is being set up, so the choice belongs
  // there and not only on a row that does not exist yet.
  //
  // Every one of these would collapse to 基础白T · 全部 3 个款式 ▾ if the stored
  // choice were ignored, and 商品D's line is the one that proves the pre-款式
  // per-photo selection still reads as the 款式 owning that photo.
  const labels = text.filter(function (l) { return /^(基础白T|重磅黑T) · /.test(l); }).sort();
  assert.deepEqual(labels, [
    "基础白T · 全部 3 个款式 ▾", // 创建分组's own picker, nothing picked yet
    "基础白T · 全部 3 个款式 ▾", // 商品B — nothing stored, so the host's default
    "重磅黑T · 全部 2 个款式 ▾", // 商品A — stored a T恤, no 款式 narrowed
    "重磅黑T · 黑色 ▾", //        商品C — one 款式 picked, named
    "重磅黑T · 白色 ▾" //         商品D — a photo from before 款式, read as its 款式
  ].sort());
});

test("the mount-time state load hydrates every module, 工作流 included", async () => {
  // The bug this guards, and why it needs a behavioural test: the mount path
  // carried its own copy of the field list, so the module added to the *other*
  // copy was never loaded on a page load. The host answered perfectly, the
  // bundle was current, and 工作流 still rendered as empty — a render-only test
  // cannot see that, because the render is fine; the load is what was wrong.
  const state = {
    ok: true,
    library: [{ id: "l1", file: "a.png" }],
    recreations: [],
    tshirts: [],
    tshirtRecreations: [],
    prompts: [{ id: "p1", name: "印花提取", text: "x" }],
    generations: [],
    scenes: [{ id: "s1", file: "b.png" }],
    workflows: [{ id: "print.pipeline", name: "印花流水线", enabled: false, running: false }]
  };
  const loaded = loadClient(CLIENT_SOURCE, {}, {
    runEffects: true,
    fetch: function () {
      return Promise.resolve({ json: function () { return Promise.resolve(state); } });
    }
  });
  render(loaded.view({}), 0);
  // apiGet resolves on a microtask; let the hydration land before asserting.
  await new Promise(function (resolve) { setTimeout(resolve, 0); });

  function hydrated(id) {
    return loaded.stateCalls.some(function (value) {
      return Array.isArray(value) && value.length > 0 && value[0] && value[0].id === id;
    });
  }
  assert.equal(hydrated("print.pipeline"), true, "the mount-time load must include 工作流 — an empty list here means the workbench renders that module as empty no matter what the host returns");
  assert.equal(hydrated("s1"), true, "and the other modules still load");
  assert.equal(hydrated("l1"), true);

  // The hydration list lives in exactly one place. Two copies is what caused the
  // bug above, and a list that must be kept in sync in two places will not be.
  ["setLibrary(state.library", "setScenes(state.scenes", "setWorkflows(state.workflows"].forEach(function (marker) {
    const occurrences = CLIENT_SOURCE.split(marker + " || [])").length - 1;
    assert.equal(occurrences, 1, marker + " appears " + occurrences + " times — the hydration list has been duplicated");
  });
});

// ---------------------------------------------------------------------------
// 成品库 — the finished shelf. Its shape is the data's own: a reference group
// is a 商品, each 二创T恤 is a 款式, and that 款式's 场景成片 are its gallery.
// ---------------------------------------------------------------------------

/** Two 款式 under one 商品: t1 has two shots, t2 has one (never measured). */
const DEMO_PRODUCTS = [
  { id: "p1", groupKey: "商品A", groupName: "商品A", file: "a-1.png", tshirtFile: "t1.png", sceneFile: "s1.png", tshirtName: "180G女士纯棉T恤", width: 600, height: 800, sceneIndex: 0, createdAt: 3 },
  { id: "p2", groupKey: "商品A", groupName: "商品A", file: "a-2.png", tshirtFile: "t1.png", sceneFile: "s2.png", tshirtName: "180G女士纯棉T恤", width: 600, height: 800, sceneIndex: 1, createdAt: 2 },
  // No `tshirtName` on purpose: this is what the second pipeline run wrote, and
  // what every record written before those fields existed looks like. The card has
  // to recover the garment anyway.
  { id: "p3", groupKey: "商品A", groupName: "商品A", file: "b-1.png", tshirtFile: "t2.png", sceneFile: "s3.png", sceneIndex: 0, createdAt: 1 }
];

/**
 * The 二创T恤 row and T恤 the shelf resolves `t2.png` through.
 *
 * `t2.png` is the composite; its row names the T恤 photo it was composited onto
 * (`wb.png`), and that photo belongs to 白色 of the T恤. Nothing here is copied
 * onto the shot record — the whole point is that the shelf works it out, so a
 * rename shows up without a backfill.
 */
const DEMO_SHELF_RECREATIONS = [
  { id: "r1", tshirtFile: "wb.png", tshirtName: "180G女士纯棉T恤", prints: [{ id: "c1", file: "t2.png" }] }
];
const DEMO_SHELF_TSHIRTS = [
  { id: "ta", name: "180G女士纯棉T恤", colorways: [{ id: "cw-white", name: "白色", white: ["wb.png"], detail: [], model: [] }], sizeImages: ["size.png"] }
];

/** Every `src` in the rendered tree — images carry file names, text does not. */
function collectImgSrcsOf(node) {
  const found = [];
  (function walk(current) {
    if (current === null || current === undefined || typeof current !== "object") return;
    if (Array.isArray(current)) { current.forEach(walk); return; }
    if (current.type === "img" && current.props && current.props.src) found.push(String(current.props.src));
    walk(current.children);
  })(node);
  return found;
}

test("成品库 is a feed of 款式 — one card each, shaped like a listing", () => {
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    .replace("var tshirtsState = React.useState([]);", "var tshirtsState = React.useState(__DEMO_SHELF_TSHIRTS__);")
    .replace("var tshirtRecreationsState = React.useState([]);", "var tshirtRecreationsState = React.useState(__DEMO_SHELF_RECREATIONS__);")
    // The shelf shows a loading state until the fetch lands; with a single render
    // pass it would never get past it, so the loaded state is seeded too.
    .replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);");
  assert.match(patched, /useState\(__DEMO_PRODUCTS__\)/, "the product seed no longer applies — update it");

  const loaded = loadClient(patched, {
    __DEMO_PRODUCTS__: DEMO_PRODUCTS,
    __DEMO_SHELF_TSHIRTS__: DEMO_SHELF_TSHIRTS,
    __DEMO_SHELF_RECREATIONS__: DEMO_SHELF_RECREATIONS
  });
  const tree = render(loaded.view({}), 0);
  const text = collectText(tree, []);

  // Every line a Taobao card carries, filled with something we actually know:
  // the title, a strong spec line where the price would be, the tag row, and the
  // T恤 underneath as the closest thing this data has to a shop.
  const missing = [
    ["2 个款式", "how many 款式 the shelf holds"],
    ["商品A · 款式 #1", "the listing title: 商品 + 款式"],
    ["款式 #2", "the other 款式, titled the same way"],
    ["2 张成片", "the spec line, where a price would sit"],
    ["1/2", "how many shots that 款式 has, and which one is showing"],
    ["2 个场景", "the first tag: how many scenes it was shot in"],
    ["每场景 1 张", "the second tag: how many shots per scene"],
    ["3:4", "the measured ratio, as a tag"],
    ["180G女士纯棉T恤", "the T恤 line, standing in for the shop"],
    // …and the colour, recovered for the shot that carries no name at all. This is
    // the line that says *which* garment a card is: six products of one T恤 are six
    // identical lines without it.
    ["180G女士纯棉T恤 · 白色", "the 款式, resolved from the T恤 records rather than the shot"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[0] + " — " + entry[1]; });
  assert.deepEqual(missing, [], "the feed is missing something");

  // No invented marketplace numbers. This shelf is used to decide what to
  // publish, so a made-up price or 销量 would be worse than an empty slot.
  assert.equal(/[¥￥]\s*\d/.test(text.join("|")), false, "the shelf must not show a price it does not have");
  assert.equal(/人付款|销量|已售/.test(text.join("|")), false, "nor sales figures");

  // Scoped to the cards themselves (`.ecom-card`): `collectImgSrcsOf` walks the whole
  // tree, and the pipeline's stage results render the same composite files, so an
  // unscoped count picks up images that are not covers at all.
  const cardImgs = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props && node.props.className === "ecom-card") {
      collectImgSrcsOf(node).forEach(function (src) { cardImgs.push(src); });
      return;
    }
    walk(node.children);
  })(tree);

  // ONE tile per 款式, and the tile is its **白底图** — the 融合 output — not a 成片.
  // The shots of one 款式 are one garment in several scenes, so covering a card with a
  // 成片 makes a grid read as many products instead of one, and the backgrounds make it
  // noisy; against white the only thing that varies is the print.
  assert.equal(cardImgs.length, 2, "one cover per 款式, got " + JSON.stringify(cardImgs));
  const covers = cardImgs.filter(function (src) { return /t1\.png|t2\.png/.test(src); });
  assert.equal(covers.length, 2, "and each cover is the 款式's 白底图, got " + JSON.stringify(cardImgs));
  // The 成片 live behind a swipe on the card, not as tiles of their own, or the shelf is
  // 192 near-identical images again.
  assert.deepEqual(cardImgs.filter(function (src) { return /a-1\.png|a-2\.png|b-1\.png/.test(src); }), [],
    "no 成片 may be on the feed itself, got " + JSON.stringify(cardImgs));

  // The tile is a fixed SQUARE with the shot contained, which is Taobao's shape
  // *without* Taobao's crop: these are 3:4 shots and cropping one to a square
  // cuts the garment. A square also cannot jump as images load, which is what
  // the old measured-ratio box was working around.
  const stages = [];
  const feedImgs = [];
  (function walk(node, inStage) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(function (child) { walk(child, inStage); }); return; }
    // Scoped to the shelf's own stages. Other modules crop their thumbnails on
    // purpose — T恤管理's 52px tiles are `objectFit: cover` — and the claim being
    // checked is about the shelf, not about every image the page happens to hold.
    const isStage = !!(node.props && node.props.style && node.props.style.aspectRatio === "1 / 1");
    if (isStage) stages.push(node);
    const inside = inStage || isStage;
    if (node.type === "img" && node.props && inside) feedImgs.push({ src: String(node.props.src), style: node.props.style || {} });
    walk(node.children, inside);
  })(tree, false);
  assert.equal(stages.length, 2, "every card needs its own square stage, got " + stages.length);
  assert.equal(
    feedImgs.some(function (img) { return img.style.objectFit === "cover"; }),
    false,
    "nothing on the shelf may be cropped to fit"
  );
  assert.equal(
    feedImgs.some(function (img) { return img.src.indexOf("t1.png") !== -1 && img.style.maxWidth === "100%" && img.style.maxHeight === "100%"; }),
    true,
    "the cover must be bounded by its stage so it is letterboxed, never stretched"
  );
});

test("a 商品 opens as a modal: 款式 rail, cover, arrows, image strip — and the rail stays vertical", () => {
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    // Seeded too: with `loading` still true the feed never renders, and the modal
    // would be tested against an empty shelf behind it.
    .replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);")
    .replace("var openState = React.useState(null);", "var openState = React.useState(__DEMO_OPEN__);");
  assert.match(patched, /useState\(__DEMO_OPEN__\)/, "the open-商品 seed no longer applies — update it");

  // Opened the way a card click opens it — naming the shot the feed was showing.
  const loaded = loadClient(patched, { __DEMO_PRODUCTS__: DEMO_PRODUCTS, __DEMO_OPEN__: { groupKey: "商品A", shotId: "p1" } });
  const tree = render(loaded.view({}), 0);
  const text = collectText(tree, []);

  const missing = [
    ["商品A", "the 商品 name"],
    ["2 个款式 · 3 张成片", "the summary"],
    // The strip is 产品展示图 + the 款式's two 成片. The card named p1, which is the first
    // 成片 and therefore 2 of 3 — the 产品展示图 leads the strip but is not what the feed
    // was showing, so the modal must not silently jump to it.
    ["第 2 / 3 张", "the image counter, so the arrows mean something"],
    ["‹", "the previous-image arrow"],
    ["›", "the next-image arrow"],
    ["点击图片可全屏放大", "that the cover itself can be enlarged"],
    ["这一张的来源", "what the shot is made of"],
    ["商品信息", "the product block"],
    ["删除这张", "removing a shot"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "the product modal is missing something");

  // Every part of the modal must actually render its images: the cover, the two
  // references, and the strip. The feed's cards now cover with the 白底图, so t1.png
  // and t2.png appear as covers as well as in the 款式 rail.
  const srcs = collectImgSrcsOf(tree);
  ["a-1.png", "a-2.png", "t1.png", "s1.png"].forEach(function (file) {
    assert.equal(srcs.some(function (src) { return src.indexOf(file) !== -1; }), true,
      file + " is not rendered (got " + JSON.stringify(srcs) + ")");
  });
  // t2.png is the OTHER 款式: it must never be the open 款式's content — only its rail
  // entry and its own feed cover.
  assert.equal(srcs.filter(function (src) { return src.indexOf("t2.png") !== -1; }).length, 2,
    "the other 款式's composite belongs in the rail and on its own card, nowhere else (got " + JSON.stringify(srcs) + ")");

  // The rail is a rail, not the horizontal image strip below the cover: one entry per
  // 款式, stacked in a COLUMN — a horizontal row of 款式 was rejected because it spent
  // the image's height. The strip under the cover is a different thing and is the row;
  // asserting the direction here is how the two stay distinct.
  let rail = null;
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const kids = Array.isArray(node.children) ? node.children : (node.children ? [node.children] : []);
    const holdsStyles = kids.some(function (kid) {
      return kid && kid.type === "button" && JSON.stringify(kid).indexOf("t1.png") !== -1;
    });
    if (holdsStyles) rail = rail || node;
    walk(node.children);
  })(tree);
  assert.ok(rail, "the modal must render a rail holding the 款式 thumbnails");
  assert.equal(rail.props.style.flexDirection, "column", "the 款式 list must be a vertical rail, not a horizontal row");
  const railEntries = (Array.isArray(rail.children) ? rail.children : [rail.children])
    .filter(function (kid) { return kid && kid.type === "button"; });
  assert.equal(railEntries.length, 2, "one rail entry per 款式, got " + railEntries.length);
  assert.notEqual(rail.props.style.overflowX, "auto", "and it must not scroll sideways like the strip");

  // The cover must be BOUNDED by its stage, never sized to the file. The page's
  // first version used `width/height: 100%` inside an indefinite-height row, so
  // the height resolved to the image's intrinsic one and the picture grew past
  // the pane — it simply did not fit on screen.
  const imgs = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "img" && node.props) imgs.push({ src: String(node.props.src), style: node.props.style || {} });
    walk(node.children);
  })(tree);
  assert.deepEqual(
    imgs.filter(function (img) { return img.style.width === "100%" && img.style.height === "100%"; }),
    [],
    "no image may be sized 100%×100% inside an indefinite-height box"
  );
  assert.equal(
    imgs.some(function (img) { return img.src.indexOf("a-1.png") !== -1 && img.style.maxHeight === "100%" && img.style.width === "auto"; }),
    true,
    "the cover must be capped by its stage so it always fits"
  );

  // It must be a MODAL: an overlay over the feed, closable by backdrop or Esc —
  // not a page that replaces the shelf.
  let overlay = null;
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props && node.props.style && node.props.style.position === "fixed") overlay = overlay || node;
    walk(node.children);
  })(tree);
  assert.ok(overlay, "the product view must be a fixed overlay, not an inline page");
  assert.equal(typeof overlay.props.onClick, "function", "clicking the backdrop must close it");
  // The close control is an icon, so its affordance lives in the tooltip.
  const tooltips = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props && typeof node.props.title === "string") tooltips.push(node.props.title);
    walk(node.children);
  })(overlay);
  assert.equal(
    tooltips.some(function (t) { return t.indexOf("关闭") !== -1; }),
    true,
    "there must be a visible close affordance"
  );

  // No 款式 strip *along the bottom* — asserted as structure (above), not as
  // text: 款式 legitimately appears now that the rail lists them, and the info
  // block still has to say which one is showing.
  const modalText = collectText(overlay, []);
  assert.equal(
    modalText.some(function (line) { return line.indexOf("款式：") !== -1; }),
    true,
    "the info block still says which 款式 this is"
  );
});

test("the 成品库 scroller is mounted in every state, so pagination can be rooted on it", () => {
  // Why this needs its own assertion: the pagination sentinel observes the
  // scroll container, so a container that only appears once the products arrive
  // leaves the sentinel with nothing to observe. (This guard was written when
  // the same mistake also collapsed the feed to a single, enormous column — the
  // tiles were all present and correct, only their size was wrong, which is
  // invisible to any assertion about content.)
  function feedCount(source, demo) {
    const loaded = loadClient(source, demo);
    const tree = render(loaded.view({}), 0);
    let found = 0;
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.props && node.props["data-ecom-feed"] === "products") found++;
      walk(node.children);
    })(tree);
    return found;
  }

  const seeded = CLIENT_SOURCE.replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);");
  const loadedState = seeded.replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);");
  const emptyState = loadedState.replace("var productsState = React.useState(__DEMO_PRODUCTS__);", "var productsState = React.useState([]);");

  assert.equal(feedCount(CLIENT_SOURCE, {}), 1, "while loading, the scroller must already be mounted");
  assert.equal(feedCount(emptyState, {}), 1, "when empty, the scroller must still be mounted");
  assert.equal(feedCount(loadedState, { __DEMO_PRODUCTS__: DEMO_PRODUCTS }), 1, "when loaded, the scroller must be mounted");
});

test("clicking a card opens its 商品 (not its own composite key)", () => {
  // Walking the actual click path, which the other 成品库 tests skip by seeding
  // the open state directly. That gap let a real bug through: the card passed its
  // composite `group|style` key where the 商品 key was expected, so the page
  // lookup missed and clicking a card did nothing at all.
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    .replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);");
  const loaded = loadClient(patched, { __DEMO_PRODUCTS__: DEMO_PRODUCTS });
  const tree = render(loaded.view({}), 0);

  let cover = null;
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    // The cover is the 款式's 白底图 now, so the card is showing t1.png — not a 成片.
    if (node.type === "img" && node.props && String(node.props.src).indexOf("t1.png") !== -1) cover = node;
    walk(node.children);
  })(tree);
  assert.ok(cover, "the feed must render a card cover to click");
  assert.equal(typeof cover.props.onClick, "function", "the cover must be clickable");

  cover.props.onClick();
  const opened = loaded.stateCalls.filter(function (value) {
    return value && typeof value === "object" && value.groupKey !== undefined;
  });
  assert.equal(opened.length, 1, "clicking must ask to open exactly one page");
  assert.equal(opened[0].groupKey, "商品A", "it must open the 商品, not the card's composite key");
  // null, because the cover is not a shot: the product page opens on its own
  // 产品展示图, which is the very image the card was showing.
  assert.equal(opened[0].shotId, null, "opening from the cover names no shot");
});

test("tapping a shot in the waterfall opens its 商品 on that shot", () => {
  // The tile knows which shot it is; the page must not drop that on the floor and
  // open on the first shot of the 款式 instead.
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    .replace("var openState = React.useState(null);", "var openState = React.useState(__DEMO_OPEN__);");
  assert.match(patched, /useState\(__DEMO_OPEN__\)/, "the open-商品 seed no longer applies — update it");

  const loaded = loadClient(patched, {
    __DEMO_PRODUCTS__: DEMO_PRODUCTS,
    // p2 is the second shot of 款式 #1 (t1.png), which holds two shots.
    __DEMO_OPEN__: { groupKey: "商品A", shotId: "p2" }
  });
  const text = collectText(render(loaded.view({}), 0), []);
  // The counter is its own text node, so assert on the node, not on a substring
  // of it (the info block also contains numbers in the same shape).
  //
  // 3 of 3, not 2 of 2: p2 is the second 成片 of 款式 #1, and the strip it lives in now
  // leads with that 款式's 产品展示图. The offset is the point — the feed's shot id must
  // still land on that shot rather than on whatever now sits at the same index.
  const counters = text.filter(function (line) { return /^第 \d+ \/ \d+ 张$/.test(line); });
  assert.deepEqual(counters, ["第 3 / 3 张"], "the modal must open on the tapped shot, not on the first one");
});
