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
    lastRunAt: now - 60000, lastRunId: "run-a", lastStatus: "success", running: false, runId: null
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

  const text = renderWorkbench(patched, {
    __DEMO_WORKFLOWS__: [workflow],
    __DEMO_RUNS__: runs,
    __DEMO_RUN__: run
  });
  const missing = [
    ["← 返回工作流", "the way back to the list"],
    ["示例同步", "the workflow's name"],
    ["已启用", "its enabled state"],
    ["每 30 分钟", "its schedule in words"],
    ["下次运行", "when it runs next"],
    ["运行记录", "the history section"],
    ["已跳过", "a skipped run in the history"],
    ["DSH 未运行期间错过了这次调度", "why that run was skipped"],
    ["开始同步", "a log line of the selected run"],
    ["结果：同步 3 个文件", "the selected run's summary"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "nothing the user needs is missing from the workflow page");
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
    ["确认排队", "handing a group to the scheduler"],
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

/** Two 款式 under one 商品: t1 has two shots, t2 has one. */
const DEMO_PRODUCTS = [
  { id: "p1", groupKey: "商品A", groupName: "商品A", file: "a-1.png", tshirtFile: "t1.png", sceneFile: "s1.png", createdAt: 3 },
  { id: "p2", groupKey: "商品A", groupName: "商品A", file: "a-2.png", tshirtFile: "t1.png", sceneFile: "s2.png", createdAt: 2 },
  { id: "p3", groupKey: "商品A", groupName: "商品A", file: "b-1.png", tshirtFile: "t2.png", sceneFile: "s3.png", createdAt: 1 }
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

test("成品库 lists each 商品 as a cover card with its counts", () => {
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
    ["1 个商品 · 3 张成片", "the shelf summary"],
    ["商品A", "the 商品 name"],
    ["3 张", "how many shots the 商品 has"],
    ["2 个款式", "how many 款式 it has"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[0] + " — " + entry[1]; });
  assert.deepEqual(missing, [], "the 商品 grid is missing something");

  // The card shows a cover, not just a label.
  assert.equal(collectImgSrcsOf(tree).some(function (src) { return src.indexOf("a-1.png") !== -1; }), true,
    "the 商品 card must show a cover image");
});

test("a 商品 opens as an app-style page: cover, arrows, left rail and 款式 switcher", () => {
  const patched = CLIENT_SOURCE
    .replace("var productsState = React.useState([]);", "var productsState = React.useState(__DEMO_PRODUCTS__);")
    .replace("var openState = React.useState(null);", "var openState = React.useState(__DEMO_OPEN__);");
  assert.match(patched, /useState\(__DEMO_OPEN__\)/, "the open-商品 seed no longer applies — update it");

  const loaded = loadClient(patched, { __DEMO_PRODUCTS__: DEMO_PRODUCTS, __DEMO_OPEN__: "商品A" });
  const tree = render(loaded.view({}), 0);
  const text = collectText(tree, []);

  const missing = [
    ["← 返回成品库", "the way back to the shelf"],
    ["2 个款式 · 3 张成片", "the page summary"],
    ["1 / 2", "the shot counter, so the arrows mean something"],
    ["‹", "the previous-shot arrow"],
    ["›", "the next-shot arrow"],
    ["款式", "the 款式 switcher"],
    ["这一张的来源", "what the shot is made of"],
    ["商品信息", "the product block"],
    ["删除这张", "removing a shot"],
    ["#1", "a 款式 entry"],
    ["#2", "the other 款式 entry"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "the product page is missing something");

  // Every part of the page must actually render its images: the left rail of
  // this 款式's shots, the cover, the 款式 switcher, and the two references.
  const srcs = collectImgSrcsOf(tree);
  ["a-1.png", "a-2.png", "t1.png", "t2.png", "s1.png"].forEach(function (file) {
    assert.equal(srcs.some(function (src) { return src.indexOf(file) !== -1; }), true,
      file + " is not rendered (got " + srcs.length + " images)");
  });
});
