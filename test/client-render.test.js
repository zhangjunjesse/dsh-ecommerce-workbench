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
function makeReactStub() {
  return {
    Fragment: "Fragment",
    createElement: function (type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      const merged = Object.assign({}, props);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type: type, props: merged };
    },
    // No re-rendering, so a setter that does nothing is enough; the initial
    // value is what the single pass renders.
    useState: function (initial) {
      return [typeof initial === "function" ? initial() : initial, function () {}];
    },
    useEffect: function () {},
    useLayoutEffect: function () {},
    useRef: function (initial) { return { current: initial === undefined ? null : initial }; },
    useMemo: function (fn) { return fn(); },
    useCallback: function (fn) { return fn; },
    createContext: function () { return {}; }
  };
}

/** Expand function components into a plain tree, guarding against a runaway loop. */
function render(node, depth) {
  if (depth > 60) throw new Error("render depth exceeded — a component is recursing");
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(function (child) { return render(child, depth + 1); });
  if (typeof node === "string" || typeof node === "number") return node;
  if (typeof node.type === "function") return render(node.type(node.props || {}), depth + 1);
  return { type: node.type, children: render(node.props && node.props.children, depth + 1) };
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
 * @param {string} source - client source (possibly patched in memory).
 * @param {object} demo - values bound to the `__DEMO_*` names the patch inserts.
 */
function loadClient(source, demo) {
  let captured = null;
  const fakeWindow = { __ModuleLoader__: { load: function (mod) { captured = mod; } } };
  const react = makeReactStub();
  function shim(name) {
    if (name === "react") return react;
    throw new Error("unexpected require(" + name + ")");
  }
  const run = new Function("window", "require", "__DEMO_WORKFLOWS__", "__DEMO_RUNS__", "__DEMO_RUN__", source);
  run(fakeWindow, shim, demo.workflows, demo.runs, demo.run);

  assert.ok(captured, "the bundle did not call window.__ModuleLoader__.load");
  const mod = captured.factory(shim);

  let registered = null;
  const slots = {
    inject: function (name, fn) { fn(); },
    register: function (opts, comp) { registered = comp; return function () {}; }
  };
  mod.apply({ get: function (key) { return key === "slots" ? slots : null; } });
  assert.equal(typeof registered, "function", "the workbench registered no conversation view");
  return registered;
}

/** Render the whole workbench once and return every string it produced. */
function renderWorkbench(source, demo) {
  return collectText(render(loadClient(source, demo)({}), 0), []);
}

test("with nothing registered, 工作流 renders an honest empty state", () => {
  const text = renderWorkbench(CLIENT_SOURCE, { workflows: [], runs: [], run: null }).join("|");
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
    .replace("var workflowsState = React.useState([]);", "var workflowsState = React.useState(__DEMO_WORKFLOWS__);")
    .replace("var openState = React.useState(null);", "var openState = React.useState(__DEMO_WORKFLOWS__[0].id);")
    .replace("var runsState = React.useState([]);", "var runsState = React.useState(__DEMO_RUNS__);")
    .replace("var detailState = React.useState(null);", "var detailState = React.useState(__DEMO_RUN__);");
  // Guard the guard: if these stop matching (the code was refactored), this test
  // would quietly render the empty state and still "pass".
  assert.notEqual(patched, CLIENT_SOURCE, "the in-memory seed no longer applies — update it");
  assert.match(patched, /useState\(__DEMO_WORKFLOWS__\)/);

  const text = renderWorkbench(patched, demo);
  const missing = [
    ["示例同步", "a workflow's name"],
    ["把二创印花同步到外部目录", "its description"],
    ["已启用", "an enabled workflow's toggle"],
    ["已停用", "a disabled workflow's toggle"],
    ["运行中…", "a workflow whose run is in flight"],
    ["每 30 分钟", "an interval schedule in words"],
    ["每天 09:00", "a daily schedule in words"],
    ["开始同步", "a log line of the selected run"],
    ["结果：同步 3 个文件", "the selected run's summary"],
    ["已跳过", "a skipped run in the history"],
    ["DSH 未运行期间错过了这次调度", "why that run was skipped"]
  ].filter(function (entry) {
    return !text.some(function (line) { return line.indexOf(entry[0]) !== -1; });
  }).map(function (entry) { return entry[1]; });
  assert.deepEqual(missing, [], "nothing the user needs is missing from the rendered UI");
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
