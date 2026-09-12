/**
 * Workflow settings: the knobs a workflow declares so the user can turn it
 * without a code change.
 *
 * Lives in its own module on purpose. `lib/workflows.js` (the registry) and
 * `lib/printPipeline.js` (a definition) both need these helpers, and the registry
 * already requires the definition — putting them in the registry would make that
 * a cycle, and a cycle here fails in the quiet way: the definition's `require`
 * gets a half-built exports object and `effectiveSettings` is simply undefined
 * at the moment a run needs it.
 *
 * A declaration is:
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
 * The engine never interprets a value; it validates and stores it against this
 * declaration, hands the effective values to `run` as `ctx.settings`, and shows
 * the same declaration to the client so the form is generated from it.
 */

const SETTING_TYPES = ["number", "checkbox"];

/** Reject a malformed setting field at registration time. */
function assertSetting(workflowId, field) {
  function bad(message) {
    const error = new Error("workflow " + workflowId + " setting: " + message);
    error.code = "BAD_WORKFLOW";
    return error;
  }
  if (!field || typeof field !== "object") throw bad("a setting must be an object");
  if (typeof field.key !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(field.key)) {
    throw bad("key must match /^[A-Za-z][A-Za-z0-9._-]{0,63}$/ (got " + JSON.stringify(field.key) + ")");
  }
  if (typeof field.label !== "string" || field.label.trim() === "") throw bad(field.key + " needs a non-empty label");
  if (SETTING_TYPES.indexOf(field.type) < 0) throw bad(field.key + " has an unsupported type: " + JSON.stringify(field.type));
  if (field.type === "number") {
    if (typeof field.default !== "number" || !Number.isFinite(field.default)) throw bad(field.key + " needs a numeric default");
    if (field.min !== undefined && (typeof field.min !== "number" || field.min > field.default)) {
      throw bad(field.key + " has a min above its default");
    }
    if (field.max !== undefined && (typeof field.max !== "number" || field.max < field.default)) {
      throw bad(field.key + " has a max below its default");
    }
  } else if (typeof field.default !== "boolean") {
    throw bad(field.key + " needs a boolean default");
  }
  if (field.help !== undefined && typeof field.help !== "string") throw bad(field.key + " has a non-string help");
}

/**
 * The values a workflow should run with: what the user stored, clamped to the
 * declared range, with anything missing or unusable falling back to its default.
 *
 * A stored value is never trusted straight through — a hand-edited state.json, a
 * field whose range shrank in a later release, or a string where a number belongs
 * all resolve to something the workflow can actually use. Clamping rather than
 * rejecting is deliberate: a number box that snaps back to the accepted value is
 * clearer than one that refuses to save.
 *
 * @param {object} definition - a workflow definition carrying `settings`.
 * @param {object} [stored] - what the user last saved.
 * @returns {object} one entry per declared field.
 */
function effectiveSettings(definition, stored) {
  const values = {};
  const saved = stored && typeof stored === "object" ? stored : {};
  for (const field of (definition && definition.settings) || []) {
    const raw = saved[field.key];
    if (field.type === "checkbox") {
      values[field.key] = typeof raw === "boolean" ? raw : field.default;
      continue;
    }
    let value = Number(raw);
    if (!Number.isFinite(value)) value = field.default;
    value = Math.round(value);
    if (typeof field.min === "number") value = Math.max(field.min, value);
    if (typeof field.max === "number") value = Math.min(field.max, value);
    values[field.key] = value;
  }
  return values;
}

module.exports = { SETTING_TYPES, assertSetting, effectiveSettings };
