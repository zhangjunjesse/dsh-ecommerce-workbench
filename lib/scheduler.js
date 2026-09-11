/**
 * Workflow scheduling: when a workflow is next due, and firing it.
 *
 * Two honest bounds are designed in rather than documented away:
 *
 * - **The scheduler lives inside the host process.** A workflow can only fire
 *   while DSH itself is running; nothing is scheduled at the OS level. So
 *   "每 30 分钟" means "every 30 minutes *while the workbench is up*".
 *
 * - **A missed occurrence is skipped, never caught up.** If the host was down
 *   when an occurrence came due, running it afterwards would mean a burst of
 *   real (possibly billable) executions the moment DSH starts — the opposite of
 *   what "每 30 分钟" was understood to mean. Instead the miss is recorded once
 *   in the run history so it is visible, and the schedule moves on. This applies
 *   while the host is up too: a host that was busy for three intervals fires
 *   once, not three times.
 *
 * The next due time is always recomputed from the wall clock rather than by
 * adding an interval to the previous one, so a long-running host cannot drift
 * and a daily time stays on its wall-clock time across a DST change.
 */

const DEFAULT_TICK_MS = 20000;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10080; // 7 days — longer than this is a calendar concern, not an interval.
const DAILY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function describe(error) {
  return String((error && error.message) || error);
}

/** Reject anything that is not one of the two supported schedule shapes. */
function badSchedule(message) {
  const error = new Error(message);
  error.code = "BAD_SCHEDULE";
  return error;
}

/**
 * Validate a schedule coming off the wire.
 *
 * Only two shapes exist, and both are unambiguous on purpose: an interval is a
 * number of minutes, a daily schedule is a local wall-clock time. A cron
 * expression was considered and rejected — it would add a parser, a timezone
 * model and a DST story to answer a question nobody has asked yet.
 *
 * @param {object|null|undefined} value - `null`/`undefined` clears the schedule.
 * @returns {{type: "interval", everyMinutes: number}|{type: "daily", atTime: string}|null}
 * @throws {Error} with `code: "BAD_SCHEDULE"`.
 */
function normalizeSchedule(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw badSchedule("schedule must be an object or null");
  if (value.type === "interval") {
    const minutes = Number(value.everyMinutes);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw badSchedule("everyMinutes must be an integer between " + MIN_INTERVAL_MINUTES + " and " + MAX_INTERVAL_MINUTES);
    }
    return { type: "interval", everyMinutes: minutes };
  }
  if (value.type === "daily") {
    if (typeof value.atTime !== "string" || !DAILY_PATTERN.test(value.atTime)) {
      throw badSchedule("atTime must be a 24-hour HH:MM string");
    }
    return { type: "daily", atTime: value.atTime };
  }
  throw badSchedule("unknown schedule type: " + JSON.stringify(value.type));
}

/**
 * The first occurrence strictly after `fromMs`.
 *
 * @param {object|null} schedule - a normalized schedule.
 * @param {number} fromMs - reference instant.
 * @returns {number|null} epoch ms, or null when the schedule is unusable.
 */
function nextRunAfter(schedule, fromMs) {
  if (!schedule || typeof schedule !== "object") return null;
  if (schedule.type === "interval") {
    const minutes = Number(schedule.everyMinutes);
    if (!Number.isInteger(minutes) || minutes <= 0) return null;
    return fromMs + minutes * 60000;
  }
  if (schedule.type === "daily") {
    if (typeof schedule.atTime !== "string" || !DAILY_PATTERN.test(schedule.atTime)) return null;
    const parts = schedule.atTime.split(":");
    const hour = Number(parts[0]);
    const minute = Number(parts[1]);
    const at = new Date(fromMs);
    // Built in local time, so the wall-clock time is what it says it is; on the
    // one day a year a DST jump skips that time, Date normalizes it forward.
    const candidate = new Date(at.getFullYear(), at.getMonth(), at.getDate(), hour, minute, 0, 0);
    if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  return null;
}

/**
 * @param {object} options
 * @param {object} options.store - durable store.
 * @param {object} options.registry - from lib/workflows.js.
 * @param {object} options.runner - from lib/workflowRunner.js.
 * @param {Function} [options.now] - injectable clock.
 * @param {number} [options.tickMs] - how often to look for due workflows.
 */
function createScheduler(options) {
  const store = options.store;
  const registry = options.registry;
  const runner = options.runner;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const tickMs = positiveInt(options.tickMs, positiveInt(process.env.ECOM_WORKFLOW_TICK_MS, DEFAULT_TICK_MS));

  let timer = null;
  let ticking = false;

  async function setNextRunAt(workflowId, nextRunAt) {
    await store.update(function (state) {
      state.workflows = state.workflows.map(function (config) {
        return config.id === workflowId ? Object.assign({}, config, { nextRunAt: nextRunAt }) : config;
      });
    });
  }

  /**
   * Close out occurrences that came due while the host was not running.
   *
   * Runs once, at mount. Detection uses the persisted `nextRunAt`, which is only
   * ever advanced when an occurrence is consumed — so a timestamp left in the
   * past is exactly the evidence that the host was down for it.
   *
   * @returns {Promise<number>} how many misses were recorded.
   */
  async function recoverMissed() {
    const at = clock();
    const state = await store.read();
    let recorded = 0;
    for (const config of state.workflows) {
      if (config.enabled !== true) continue;
      const schedule = config.schedule;
      if (!schedule || !registry.has(config.id)) continue;
      if (typeof config.nextRunAt !== "number") {
        // Enabled but never scheduled (e.g. an enable that predates this field).
        const seeded = nextRunAfter(schedule, at);
        if (seeded !== null) await setNextRunAt(config.id, seeded);
        continue;
      }
      if (at < config.nextRunAt) continue;
      const next = nextRunAfter(schedule, at);
      if (next === null) continue;
      await runner.recordSkippedRun(config.id, "DSH 未运行期间错过了这次调度，已跳过（不补跑）。");
      await setNextRunAt(config.id, next);
      recorded++;
    }
    return recorded;
  }

  /** One pass over every enabled workflow; never throws. */
  async function tick() {
    if (ticking) return; // a slow pass must not overlap the next one
    ticking = true;
    try {
      const at = clock();
      const state = await store.read();
      for (const config of state.workflows) {
        if (config.enabled !== true) continue;
        const schedule = config.schedule;
        if (!schedule || !registry.has(config.id)) continue;
        const due = typeof config.nextRunAt === "number" ? config.nextRunAt : null;
        if (due === null) {
          const seeded = nextRunAfter(schedule, at);
          if (seeded !== null) await setNextRunAt(config.id, seeded);
          continue;
        }
        if (at < due) continue;
        const next = nextRunAfter(schedule, at);
        if (next === null) {
          console.warn("[ecommerce-workbench] workflow " + config.id + " has an unusable schedule; skipping it");
          continue;
        }
        // Consume the occurrence BEFORE starting the run, so a crash, a restart
        // or an overlong run can never make this same occurrence fire twice.
        await setNextRunAt(config.id, next);
        try {
          runner.start(config.id, "schedule");
        } catch (error) {
          if (error && error.code === "ALREADY_RUNNING") runner.noteSkipped(config.id);
          else console.warn("[ecommerce-workbench] workflow " + config.id + " did not start: " + describe(error));
        }
      }
    } finally {
      ticking = false;
    }
  }

  function onTick() {
    tick().catch(function (error) {
      console.warn("[ecommerce-workbench] workflow tick failed: " + describe(error));
    });
  }

  /**
   * Recover misses, then poll. The interval is `unref`ed: a background scheduler
   * must never be the reason the host process stays alive.
   */
  async function start() {
    await recoverMissed().catch(function (error) {
      console.warn("[ecommerce-workbench] workflow missed-run recovery skipped: " + describe(error));
    });
    if (timer) return;
    timer = setInterval(onTick, tickMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick, recoverMissed, tickMs };
}

module.exports = {
  createScheduler,
  normalizeSchedule,
  nextRunAfter,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  DEFAULT_TICK_MS
};
