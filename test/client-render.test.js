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
  return {
    Fragment: "Fragment",
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
    useEffect: function (fn) {
      if (settings.runEffects !== true) return;
      try { fn(); } catch (error) { /* browser-only effect body */ }
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
 * Evaluate the client bundle, run its `apply`, and return the view component it
 * registers.
 *
 * @param {string} source - client source (possibly patched in memory).
 * @param {object} demo - values bound to the `__DEMO_*` names a patch inserts;
 *   the keys ARE the parameter names, so each test declares only what it seeds.
 * @param {object} [options]
 * @param {boolean} [options.runEffects] - run `useEffect` bodies, which is what
 *   exercises the mount-time state load.
 * @param {Function} [options.fetch] - replaces `fetch` for apiGet/apiPost.
 * @returns {{view: Function, stateCalls: any[]}} the registered view and every
 *   value any `useState` setter was called with.
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
  const fakeWindow = { __ModuleLoader__: { load: function (mod) { captured = mod; } } };
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
  const slots = {
    inject: function (name, fn) { fn(); },
    register: function (opts, comp) { registered = comp; return function () {}; }
  };
  mod.apply({ get: function (key) { return key === "slots" ? slots : null; } });
  assert.equal(typeof registered, "function", "the workbench registered no conversation view");
  return { view: registered, stateCalls: react.stateCalls };
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
    tshirt: { id: "t1", name: "测试T恤", photos: ["p1", "p2", "p3"], selected: ["p1", "p2", "p3"] },
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
  { id: "p1", groupKey: "商品A", groupName: "商品A", file: "a-1.png", tshirtFile: "t1.png", sceneFile: "s1.png", width: 600, height: 800, pass: 0, createdAt: 3 },
  { id: "p2", groupKey: "商品A", groupName: "商品A", file: "a-2.png", tshirtFile: "t1.png", sceneFile: "s2.png", width: 600, height: 800, pass: 1, createdAt: 2 },
  { id: "p3", groupKey: "商品A", groupName: "商品A", file: "b-1.png", tshirtFile: "t2.png", sceneFile: "s3.png", pass: 0, createdAt: 1 }
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

test("成品库 is a feed of 款式 — one card each, not one per shot", () => {
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    // The shelf shows a loading state until the fetch lands; with a single render
    // pass it would never get past it, so the loaded state is seeded too.
    .replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);");
  assert.match(patched, /useState\(__DEMO_PRODUCTS__\)/, "the product seed no longer applies — update it");

  const loaded = loadClient(patched, { __DEMO_PRODUCTS__: DEMO_PRODUCTS });
  const tree = render(loaded.view({}), 0);
  const text = collectText(tree, []);

  const missing = [
    ["2 个款式", "how many 款式 the shelf holds"],
    ["商品A", "the 商品 name on a card"],
    ["#1", "which 款式 a card is"],
    ["#2", "the other 款式"],
    ["1/2", "how many shots that 款式 has, and which one is showing"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[0] + " — " + entry[1]; });
  assert.deepEqual(missing, [], "the feed is missing something");

  // The caption is one short line at this tile size, so the full description
  // lives in the tooltip — and must still be there.
  const titles = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props && typeof node.props.title === "string") titles.push(node.props.title);
    walk(node.children);
  })(tree);
  assert.equal(titles.some(function (t) { return t.indexOf("张成片") !== -1; }), true,
    "the card tooltip must still say which 商品 and 款式 it is, and how many shots it has");

  // ONE image per 款式. Three shots exist across two 款式, so the feed must show
  // two tiles — the other shots of a 款式 live behind a swipe on its own card,
  // not as tiles of their own, or the shelf is 192 near-identical images again.
  const srcs = collectImgSrcsOf(tree).filter(function (src) { return /a-1\.png|a-2\.png|b-1\.png/.test(src); });
  assert.equal(srcs.length, 2, "the feed must show one image per 款式, got " + JSON.stringify(srcs));
  assert.equal(srcs.some(function (src) { return src.indexOf("a-1.png") !== -1; }), true, "the newest shot of 款式 #1 is its cover");
  assert.equal(srcs.some(function (src) { return src.indexOf("a-2.png") !== -1; }), false, "the other shot of 款式 #1 must be behind a swipe");
  assert.equal(srcs.some(function (src) { return src.indexOf("b-1.png") !== -1; }), true, "款式 #2 is its own card");

  // The box comes from the measured ratio, so swiping never changes a card's
  // height; an unmeasured 款式 falls back rather than being stretched by a guess.
  const ratios = [];
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "img" && node.props && node.props.style) ratios.push(node.props.style.aspectRatio);
    walk(node.children);
  })(tree);
  assert.equal(ratios.indexOf("600 / 800") !== -1, true, "a measured 款式 must reserve its real ratio");
  assert.equal(ratios.indexOf("3 / 4") !== -1, true, "an unmeasured 款式 falls back to the 3:4 the pipeline asks for");
});

test("a 商品 opens as a modal: cover, arrows, left rail — and no 款式 strip", () => {
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    // Seeded too: with `loading` still true the feed never renders, and the modal
    // would be tested against an empty shelf behind it.
    .replace("var loadingState = React.useState(true);", "var loadingState = React.useState(false);")
    .replace("var openState = React.useState(null);", "var openState = React.useState(__DEMO_OPEN__);");
  assert.match(patched, /useState\(__DEMO_OPEN__\)/, "the open-商品 seed no longer applies — update it");

  const loaded = loadClient(patched, { __DEMO_PRODUCTS__: DEMO_PRODUCTS, __DEMO_OPEN__: { groupKey: "商品A", shotId: null } });
  const tree = render(loaded.view({}), 0);
  const text = collectText(tree, []);

  const missing = [
    ["商品A", "the 商品 name"],
    ["2 个款式 · 3 张成片", "the summary"],
    ["第 1 / 2 张", "the shot counter, so the arrows mean something"],
    ["‹", "the previous-shot arrow"],
    ["›", "the next-shot arrow"],
    ["点击图片可全屏放大", "that the cover itself can be enlarged"],
    ["这一张的来源", "what the shot is made of"],
    ["商品信息", "the product block"],
    ["删除这张", "removing a shot"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "the product modal is missing something");

  // Every part of the modal must actually render its images: the left rail of
  // this 款式's shots, the cover, and the two references. t2.png (the OTHER
  // 款式's composite) is deliberately absent — the modal shows one 款式 only.
  const srcs = collectImgSrcsOf(tree);
  ["a-1.png", "a-2.png", "b-1.png", "t1.png", "s1.png"].forEach(function (file) {
    assert.equal(srcs.some(function (src) { return src.indexOf(file) !== -1; }), true,
      file + " is not rendered (got " + JSON.stringify(srcs) + ")");
  });
  assert.equal(srcs.some(function (src) { return src.indexOf("t2.png") !== -1; }), false,
    "a 款式 that is not open must not be rendered at all");

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

  // No 款式 strip: switching 款式 is the shelf's job, and that row's height now
  // belongs to the image. Asserted on the modal subtree only — the feed behind it
  // legitimately shows one card per 款式.
  const modalText = collectText(overlay, []);
  assert.equal(modalText.indexOf("款式"), -1, "the 款式 strip's own label must be gone from the modal");
  assert.equal(modalText.indexOf("#1"), -1, "so must its per-款式 tiles");
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
    if (node.type === "img" && node.props && String(node.props.src).indexOf("a-1.png") !== -1) cover = node;
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
  assert.equal(opened[0].shotId, "p1", "and land on the shot the card is showing");
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
  const counters = text.filter(function (line) { return /^第 \d+ \/ \d+ 张$/.test(line); });
  assert.deepEqual(counters, ["第 2 / 2 张"], "the modal must open on the tapped shot, not on the first one");
});
