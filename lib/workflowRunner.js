/**
 * Execute hardcoded workflows and keep an honest record of every attempt.
 *
 * The engine is deliberately small and boring, and three properties are load
 * bearing:
 *
 * 1. **A run is never lost, and never silently vanished.** A run is written to
 *    disk as `running` before its body starts, and re-written with its final
 *    status before it leaves the in-memory active map. Readers therefore always
 *    find it in one place or the other. (The generation jobs elsewhere in this
 *    plugin mark themselves `done` *before* awaiting their store write, which is
 *    exactly the race that makes a poller miss a finished row — this deliberately
 *    does not repeat it.)
 *
 * 2. **One run per workflow at a time.** A schedule that fires while the previous
 *    run is still going is *skipped and counted*, not queued: queueing would let
 *    a slow workflow build an unbounded backlog, and each queued run would in
 *    turn be a real (possibly billable) execution. The count is reported in the
 *    running run's log at the end, so the skip is visible without spamming a
 *    history entry per tick.
 *
 * 3. **A workflow cannot bypass the global generation cap.** The provider handed
 *    to a workflow is a wrapper whose every method acquires the shared
 *    `withGeneration` slot, so there is no unguarded path by construction rather
 *    than by convention. `withGeneration` itself is deliberately *not* exposed:
 *    nesting it (an outer slot around a guarded provider call) lets two
 *    concurrent workflows each hold one slot while waiting for a second, which
 *    deadlocks against the cap of 2.
 *
 * Logs are kept in memory for the duration of a run and written to disk **once**,
 * at the end: a log line per write would mean thousands of state.json rewrites
 * for a chatty workflow. The cost is that a host that dies mid-run loses that
 * run's partial log — the run itself is still recorded (see `recoverInterrupted`).
 */
const { randomUUID } = require("node:crypto");

/** Runs kept per workflow. History is for "what happened lately", not an archive. */
const RUN_KEEP_PER_WORKFLOW = positiveInt(process.env.ECOM_WORKFLOW_RUN_KEEP, 50);
/** Total runs kept across all workflows, so the file cannot grow without bound. */
const RUN_KEEP_TOTAL = positiveInt(process.env.ECOM_WORKFLOW_RUN_TOTAL, 500);
/** Log lines kept per run; beyond this the run says so and stops recording. */
const MAX_LOG_LINES = positiveInt(process.env.ECOM_WORKFLOW_LOG_LINES, 500);
const MAX_LOG_LINE_CHARS = 2000;
const MAX_SUMMARY_CHARS = 500;
const LOG_LEVELS = ["info", "warn", "error"];

/** Accept a positive integer from the environment, else fall back to the default. */
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** Coerce anything a workflow might log into text, without throwing. */
function text(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (value instanceof Error) return String(value.message || value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Cut `value` down to `max` characters, saying so rather than truncating in silence. */
function clip(value, max) {
  const string = text(value);
  return string.length > max ? string.slice(0, max) + "…（已截断）" : string;
}

/** Deep copy through JSON; run records are small, plain JSON data by construction. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Of two records of the *same* run, return the more advanced one.
 *
 * A run can settle between a reader's two sources being read — the in-memory
 * record may be captured while the run is still going and the persisted document
 * read a moment later, or the reverse. A record that has finished always beats
 * one that still says "running", whichever side it came from; otherwise the
 * reader would briefly resurrect a completed run as in-progress.
 */
function preferMoreAdvanced(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.status === "running" && b.status !== "running") return b;
  if (b.status === "running" && a.status !== "running") return a;
  return a;
}

/** Wrap a provider so every call holds one shared generation slot. */
function buildGuardedProvider(provider, withGeneration) {
  const guarded = {};
  for (const name of Object.keys(provider || {})) {
    const method = provider[name];
    if (typeof method !== "function") continue;
    guarded[name] = function (args) {
      return withGeneration(function () { return method.call(provider, args); });
    };
  }
  return Object.freeze(guarded);
}

/**
 * @param {object} options
 * @param {object} options.store - durable store (metadata + the runs document).
 * @param {object} options.registry - from lib/workflows.js.
 * @param {object} [options.provider] - image provider; exposed concurrency-guarded.
 * @param {Function} [options.withGeneration] - the shared generation semaphore.
 * @param {Function} [options.now] - injectable clock (tests drive time directly).
 */
function createWorkflowRunner(options) {
  const store = options.store;
  const registry = options.registry;
  const withGeneration = typeof options.withGeneration === "function"
    ? options.withGeneration
    : function (fn) { return Promise.resolve().then(fn); };
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const guardedProvider = buildGuardedProvider(options.provider, withGeneration);

  /** workflowId -> the live record of its one in-flight run. */
  const active = new Map();
  /** runId -> promise settling when that run has been written to disk for the last time. */
  const pending = new Map();
  /**
   * workflowId -> the last outcome this *process* observed: `{id, status, startedAt}`.
   *
   * Deliberately mirrors the shape of a live run record's identifying fields, so
   * a caller can treat "the live record" and "the last outcome" interchangeably.
   *
   * Exists so a reader never has to reconcile two sources that can disagree.
   * The config on disk is written asynchronously while a run starts and ends, so
   * a caller that reads the state file and *then* asks about the in-memory run
   * can catch the instant in between and report a finished run as still running.
   * This map is updated in the same synchronous block that changes `active`, so
   * an in-process reader always sees one consistent story; the config remains
   * the fallback for a workflow that has not run since the host started.
   */
  const outcomes = new Map();

  function warnPersist(error) {
    console.warn("[ecommerce-workbench] could not persist workflow run: " + text(error));
  }

  /** Newest-first, capped per workflow and overall. */
  function trimRuns(runs) {
    const perWorkflow = new Map();
    const kept = [];
    for (const run of runs) {
      if (kept.length >= RUN_KEEP_TOTAL) break;
      const seen = perWorkflow.get(run.workflowId) || 0;
      if (seen >= RUN_KEEP_PER_WORKFLOW) continue;
      perWorkflow.set(run.workflowId, seen + 1);
      kept.push(run);
    }
    return kept;
  }

  async function persist(record) {
    const snapshot = clone(record);
    await store.updateRuns(function (doc) {
      doc.runs = trimRuns([snapshot].concat(doc.runs.filter(function (run) {
        return run.id !== snapshot.id;
      })));
    });
  }

  /**
   * Mirror the outcome onto the workflow's config entry, so the list can show
   * "上次运行" without reading the whole run history.
   */
  async function touchConfig(record, status) {
    await store.update(function (state) {
      const existing = state.workflows.filter(function (w) { return w.id === record.workflowId; })[0];
      const next = existing
        ? Object.assign({}, existing)
        : { id: record.workflowId, enabled: false, schedule: null, nextRunAt: null };
      next.lastRunAt = record.startedAt;
      next.lastRunId = record.id;
      next.lastStatus = status;
      state.workflows = existing
        ? state.workflows.map(function (w) { return w.id === record.workflowId ? next : w; })
        : state.workflows.concat([next]);
    });
  }

  /** The `log()` handed to a workflow: append to this run, bounded. */
  function makeLogSink(record) {
    let overflowed = false;
    return function log(message, level) {
      if (record.logs.length >= MAX_LOG_LINES) {
        if (!overflowed) {
          overflowed = true;
          record.logs.push({
            t: clock(),
            level: "warn",
            message: "日志已达 " + MAX_LOG_LINES + " 行上限，后续输出不再记录。"
          });
        }
        return;
      }
      record.logs.push({
        t: clock(),
        level: LOG_LEVELS.indexOf(level) >= 0 ? level : "info",
        message: clip(message, MAX_LOG_LINE_CHARS)
      });
    };
  }

  function buildContext(record) {
    return {
      runId: record.id,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      trigger: record.trigger,
      log: makeLogSink(record),
      store: store,
      provider: guardedProvider,
      now: clock
    };
  }

  /** The body of a run: durable marker, execute, final status, durable record. */
  async function execute(record, definition) {
    await persist(record).catch(warnPersist);
    await touchConfig(record, "running").catch(warnPersist);
    try {
      const summary = await definition.run(buildContext(record));
      record.summary = summary === undefined ? null : clip(summary, MAX_SUMMARY_CHARS);
      record.status = "success";
    } catch (error) {
      record.status = "failed";
      record.error = clip((error && error.message) || error, MAX_LOG_LINE_CHARS);
      record.logs.push({ t: clock(), level: "error", message: "运行失败：" + record.error });
    }
    record.finishedAt = clock();
    record.durationMs = Math.max(0, record.finishedAt - record.startedAt);
    if (record.skippedTicks > 0) {
      record.logs.push({
        t: clock(),
        level: "warn",
        message: "本次运行期间有 " + record.skippedTicks + " 次调度被跳过：上一次运行还没有结束。"
      });
    }
    // Written before leaving `active` on purpose: a reader arriving during this
    // write still sees the run in memory (already carrying its final status),
    // instead of a hole between "no longer active" and "not yet on disk".
    await persist(record).catch(warnPersist);
    await touchConfig(record, record.status).catch(warnPersist);
    // Same synchronous block as the delete below: a reader can never observe the
    // run as both absent from `active` and still running in `outcomes`.
    outcomes.set(record.workflowId, {
      id: record.id,
      status: record.status,
      startedAt: record.startedAt
    });
    active.delete(record.workflowId);
    pending.delete(record.id);
  }

  /**
   * Begin a run and return its live record immediately; the body runs in the
   * background. Throws (synchronously) when the workflow is unknown or already
   * running, so an HTTP caller can answer 404/409 without racing.
   */
  function start(workflowId, trigger) {
    const definition = registry.get(workflowId);
    if (!definition) {
      const error = new Error("unknown workflow: " + workflowId);
      error.code = "UNKNOWN_WORKFLOW";
      throw error;
    }
    const running = active.get(workflowId);
    if (running) {
      const error = new Error("workflow already running: " + workflowId);
      error.code = "ALREADY_RUNNING";
      error.runId = running.id;
      throw error;
    }
    const startedAt = clock();
    const record = {
      id: randomUUID(),
      workflowId: definition.id,
      workflowName: definition.name,
      trigger: trigger === "schedule" ? "schedule" : "manual",
      status: "running",
      startedAt: startedAt,
      finishedAt: null,
      durationMs: null,
      error: null,
      summary: null,
      skippedReason: null,
      skippedTicks: 0,
      logs: []
    };
    active.set(workflowId, record);
    // Recorded together with `active`, in one synchronous block, so the two can
    // never be seen disagreeing (see the note on `outcomes`).
    outcomes.set(workflowId, { id: record.id, status: "running", startedAt: startedAt });
    pending.set(record.id, execute(record, definition));
    return record;
  }

  /** `start`, but resolved once the run is durable — for tests and the scheduler. */
  async function run(workflowId, trigger) {
    const record = start(workflowId, trigger);
    const settled = pending.get(record.id);
    if (settled) await settled;
    return record;
  }

  /** Strip logs for the history table; the detail view fetches them per run. */
  function toListEntry(record) {
    return {
      id: record.id,
      workflowId: record.workflowId,
      workflowName: record.workflowName,
      trigger: record.trigger,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      error: record.error,
      summary: record.summary,
      skippedReason: record.skippedReason,
      logCount: (record.logs || []).length
    };
  }

  return {
    /** @returns {object|null} the live record of `workflowId`'s in-flight run. */
    activeRun(workflowId) {
      return active.get(workflowId) || null;
    },

    isRunning(workflowId) {
      return active.has(workflowId);
    },

    /**
     * The last outcome this process observed for `workflowId` — set the instant a
     * run starts and again the instant it is dropped from `active` — or null when
     * the workflow has not run since the host started. Lets a caller read a
     * workflow's run state from memory alone, instead of combining a config file
     * that a run may have been writing at that very moment with a memory snapshot
     * taken at a different moment.
     */
    lastOutcome(workflowId) {
      return outcomes.get(workflowId) || null;
    },

    /**
     * Record that a scheduled occurrence was skipped because the previous run
     * had not finished. Returns false when nothing is running.
     */
    noteSkipped(workflowId) {
      const running = active.get(workflowId);
      if (!running) return false;
      running.skippedTicks = running.skippedTicks + 1;
      return true;
    },

    /**
     * History entry for an occurrence that was missed entirely — the host was
     * not running when it came due. Deliberately does *not* touch the config's
     * `lastRunAt`/`lastStatus`: "上次运行" should keep meaning the last time it
     * actually ran, so a skipped occurrence is visible in history without
     * pretending to be a run.
     */
    async recordSkippedRun(workflowId, reason) {
      const definition = registry.get(workflowId);
      const at = clock();
      const message = clip(reason, MAX_LOG_LINE_CHARS);
      const record = {
        id: randomUUID(),
        workflowId: workflowId,
        workflowName: definition ? definition.name : workflowId,
        trigger: "schedule",
        status: "skipped",
        startedAt: at,
        finishedAt: at,
        durationMs: 0,
        error: null,
        summary: null,
        skippedReason: message,
        skippedTicks: 0,
        logs: [{ t: at, level: "warn", message: message }]
      };
      await persist(record);
      return record;
    },

    /**
     * Run history, newest first, without logs (see `getRun` for one run's logs).
     * An in-flight run is served from memory: it is persisted only as a bare
     * "running" marker, so the live record is strictly fresher than its snapshot.
     */
    async listRuns(workflowId, limit) {
      const wanted = typeof workflowId === "string" && workflowId !== "" ? workflowId : null;
      const doc = await store.readRuns();
      const byId = new Map();
      for (const stored of doc.runs) {
        if (wanted && stored.workflowId !== wanted) continue;
        byId.set(stored.id, stored);
      }
      for (const live of active.values()) {
        if (wanted && live.workflowId !== wanted) continue;
        byId.set(live.id, preferMoreAdvanced(byId.get(live.id), live));
      }
      const sorted = Array.from(byId.values()).sort(function (a, b) {
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
      const capped = Math.min(Math.max(Number(limit) || 20, 1), 200);
      return sorted.slice(0, capped).map(toListEntry);
    },

    /** One run in full, including its logs. */
    async getRun(runId) {
      if (typeof runId !== "string" || runId === "") return null;
      for (const live of active.values()) {
        if (live.id === runId) return clone(live);
      }
      const doc = await store.readRuns();
      const found = doc.runs.filter(function (stored) { return stored.id === runId; })[0];
      return found ? clone(found) : null;
    },

    /**
     * Drop recorded runs — one workflow's, or every workflow's with no id.
     * A run that is still in flight is not removable: it lives in memory and
     * re-persists itself when it finishes.
     * @returns {Promise<number>} how many records were removed.
     */
    async clearRuns(workflowId) {
      let removed = 0;
      await store.updateRuns(function (doc) {
        const before = doc.runs.length;
        doc.runs = workflowId
          ? doc.runs.filter(function (stored) { return stored.workflowId !== workflowId; })
          : [];
        removed = before - doc.runs.length;
      });
      return removed;
    },

    /**
     * On mount, close out runs left as `running` by a host that exited mid-run.
     * Without this they would sit in history claiming to be in progress forever.
     * @returns {Promise<number>} how many records were closed.
     */
    async recoverInterrupted() {
      const at = clock();
      let recovered = 0;
      await store.updateRuns(function (doc) {
        doc.runs = doc.runs.map(function (stored) {
          if (stored.status !== "running") return stored;
          recovered++;
          return Object.assign({}, stored, {
            status: "failed",
            finishedAt: at,
            durationMs: Math.max(0, at - (stored.startedAt || at)),
            error: "宿主在这次运行期间退出，它没有跑完。",
            logs: (stored.logs || []).concat([
              { t: at, level: "error", message: "宿主在这次运行期间退出，它没有跑完。" }
            ])
          });
        });
      });
      return recovered;
    },

    start,
    run,
    toListEntry
  };
}

module.exports = {
  createWorkflowRunner,
  RUN_KEEP_PER_WORKFLOW,
  RUN_KEEP_TOTAL,
  MAX_LOG_LINES
};
