/**
 * Workflow registry: the set of workflows this workbench knows how to run.
 *
 * A workflow is **hardcoded**. A user can enable or disable one, give it a
 * schedule, trigger it by hand and read its run history — but they cannot author
 * one, because the body of a workflow is necessarily code. This module is
 * therefore the single place a workflow is declared, and it holds **no state at
 * all**: the durable side (enabled flags, schedules, run history) belongs to the
 * store, so a definition stays a pure value that code owns outright.
 *
 * Shape of a definition:
 *
 *   {
 *     id:          stable, URL-safe, unique. It is the key in API calls and in
 *                  persisted config, so changing it silently orphans whatever
 *                  schedule and history the user had accumulated under the old
 *                  id — treat it as immutable once shipped.
 *     name:        shown in the 工作流 list.
 *     description: one line, shown under the name, saying what it actually does.
 *     settings:    optional array of fields the user may tune (see below).
 *     run:         async (ctx) => summary | undefined
 *                  The summary is a short string (or any JSON value, which is
 *                  stringified) recorded against the run, so history says what
 *                  happened rather than merely that it finished.
 *   }
 *
 * A **setting** is a knob the workflow declares so the user can turn it without a
 * code change — the shape of the work (how many of a thing, which mode), never
 * the work itself:
 *
 *   {
 *     key: "sceneCount",              // key in ctx.settings
 *     label: "随机选择多少个场景图",     // shown in the UI
 *     type: "number" | "checkbox",
 *     default: 2,
 *     min: 1, max: 24, step: 1,       // numbers only
 *     help: "每件二创T恤随机挑这么多张"  // one line under the field
 *   }
 *
 * The engine never interprets a setting — it validates and stores values against
 * this declaration, hands the effective values to `run` as `ctx.settings`, and
 * shows the same declaration to the client so the settings form is generated from
 * it rather than hand-written. Values are clamped into range rather than rejected:
 * a number box that silently snaps back to the accepted value is clearer than one
 * that refuses to save.
 *
 * `ctx` is built by lib/workflowRunner.js: it carries the run's log sink, the
 * durable store, a concurrency-guarded view of the image provider, the trigger
 * that started this run, and the effective `settings`.
 *
 * Registration is validated up front and throws. A malformed definition is a
 * programming error, and it should stop the host at mount time — loud, immediate,
 * in front of whoever just wrote it — rather than surface hours later as a
 * scheduled run failing in the dark.
 */

const { printPipeline } = require("./printPipeline.js");

/**
 * The workflows shipped with the workbench.
 *
 * The engine holds no workflows of its own; this array is the one line a new
 * workflow is added to.
 *
 * To add one: write the definition, list it here (or pass it to `createRegistry`
 * from a test), and it appears in the 工作流 view with its own schedule and
 * history — no client change needed. The view's own panels, however, are not
 * generic: 印花流水线 additionally drives a group/estimate/results UI, which
 * the client looks up by id (see `PIPELINE_VIEW_ID` in lib/client.js).
 */
const BUILT_IN_WORKFLOWS = [printPipeline];

/** A definition's `id` is used in URLs and in persisted config, so keep it boring. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const { assertSetting, effectiveSettings } = require("./workflowSettings.js");

/**
 * Reject a malformed definition at registration time.
 * @param {object} definition
 * @throws {Error} with `code: "BAD_WORKFLOW"` when the shape is wrong.
 */
function assertDefinition(definition) {
  function bad(message) {
    const error = new Error(message);
    error.code = "BAD_WORKFLOW";
    return error;
  }
  if (!definition || typeof definition !== "object") throw bad("a workflow definition must be an object");
  if (typeof definition.id !== "string" || !ID_PATTERN.test(definition.id)) {
    throw bad("workflow id must match " + ID_PATTERN + " (got " + JSON.stringify(definition.id) + ")");
  }
  if (typeof definition.name !== "string" || definition.name.trim() === "") {
    throw bad("workflow " + definition.id + " needs a non-empty name");
  }
  if (typeof definition.run !== "function") {
    throw bad("workflow " + definition.id + " needs a run(ctx) function");
  }
  if (definition.description !== undefined && typeof definition.description !== "string") {
    throw bad("workflow " + definition.id + " has a non-string description");
  }
  if (definition.settings !== undefined) {
    if (!Array.isArray(definition.settings)) throw bad("workflow " + definition.id + " has a non-array settings declaration");
    const seen = new Set();
    for (const field of definition.settings) {
      assertSetting(definition.id, field);
      if (seen.has(field.key)) throw bad("workflow " + definition.id + " declares setting " + field.key + " twice");
      seen.add(field.key);
    }
  }
}

/**
 * Build the registry from a list of definitions.
 *
 * The registry is read-only by design: workflows are added in code, at startup,
 * never at runtime from a request — there is deliberately no `register()` that a
 * route could reach.
 *
 * @param {object[]} [definitions] - defaults to {@link BUILT_IN_WORKFLOWS}.
 * @returns {{list: Function, get: Function, has: Function, size: number}}
 */
function createRegistry(definitions) {
  const source = definitions === undefined ? BUILT_IN_WORKFLOWS : definitions;
  if (!Array.isArray(source)) throw new Error("workflow definitions must be an array");
  const byId = new Map();
  for (const definition of source) {
    assertDefinition(definition);
    if (byId.has(definition.id)) throw new Error("duplicate workflow id: " + definition.id);
    byId.set(definition.id, definition);
  }
  return {
    /** @returns {object[]} every definition, in declaration order. */
    list() {
      return Array.from(byId.values());
    },
    /** @returns {object|undefined} the definition for `id`, if it is still in code. */
    get(id) {
      return typeof id === "string" ? byId.get(id) : undefined;
    },
    has(id) {
      return typeof id === "string" && byId.has(id);
    },
    size: byId.size
  };
}

// effectiveSettings/assertSetting are re-exported so callers that already talk to
// the registry do not need a second import; the implementations live in
// ./workflowSettings.js, which this module can require but which must not require
// this one (a definition requires it too — see the note there).
module.exports = { createRegistry, BUILT_IN_WORKFLOWS, ID_PATTERN, effectiveSettings, assertSetting };
