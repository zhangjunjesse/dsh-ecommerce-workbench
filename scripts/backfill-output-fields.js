#!/usr/bin/env node
/**
 * One-off: name the 款式 on 成品 records that were written before those fields
 * existed.
 *
 * Why it is needed: a 场景成片 record used to carry only `groupKey` + `groupName`
 * + `tshirtFile` (the composite image). The 成品库 now renders a listing-shaped
 * card — title, spec line, tags, and the T恤 it is a colourway of — and that last
 * line, plus the 印花 the shot used, comes from fields added later. Products
 * already in the library would simply show less than new ones.
 *
 * Nothing is invented: every value is copied from the 二创T恤 row the shot was
 * generated from, found by the composite file the shot references. A shot whose
 * row is gone is left untouched and reported.
 *
 * Idempotent: records that already carry the fields are skipped, so running it
 * twice changes nothing. The outputs document is backed up and then replaced
 * atomically (temp file + rename), like the store itself does.
 *
 * Usage: node scripts/backfill-output-fields.js [--dry-run]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DRY_RUN = process.argv.indexOf("--dry-run") !== -1;
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const dir = path.join(home, "ecommerce-workbench");
const statePath = path.join(dir, "state.json");
const outputsPath = path.join(dir, "workflow-outputs.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function main() {
  if (!fs.existsSync(statePath) || !fs.existsSync(outputsPath)) {
    console.log("no store at " + dir + " — nothing to do");
    return;
  }
  const state = readJson(statePath);
  const doc = readJson(outputsPath);
  const outputs = doc.outputs || [];

  // composite file -> the 二创T恤 row it came from. That row is where the T恤 and
  // the 二创印花 are named; a shot only ever stored the composite's file name.
  const byComposite = new Map();
  (state.tshirtRecreations || []).forEach((row) => {
    (row.prints || []).forEach((print) => byComposite.set(print.file, row));
  });

  let filled = 0;
  let already = 0;
  const orphaned = [];

  outputs.forEach((shot) => {
    if (shot.tshirtName !== undefined && shot.tshirtName !== null) { already++; return; }
    const row = byComposite.get(shot.tshirtFile);
    if (!row) { orphaned.push(shot.id); return; }
    shot.tshirtId = row.tshirtId || null;
    shot.tshirtName = row.tshirtName || null;
    shot.tshirtPhoto = row.tshirtFile || null;
    shot.printId = row.printId || null;
    shot.printFile = row.printFile || null;
    filled++;
  });

  console.log("store:    " + dir);
  console.log("outputs:  " + outputs.length);
  console.log("filled:   " + filled);
  console.log("skipped:  " + already + " (already named)");
  console.log("orphaned: " + orphaned.length + (orphaned.length > 0 ? " (" + orphaned.slice(0, 5).join(", ") + (orphaned.length > 5 ? ", …" : "") + ")" : ""));

  if (DRY_RUN) { console.log("dry run — nothing written"); return; }
  if (filled === 0) { console.log("nothing to write"); return; }

  const backup = outputsPath + ".bak-" + stamp();
  fs.copyFileSync(outputsPath, backup);
  writeJsonAtomic(outputsPath, doc);
  console.log("backup:   " + backup);
  console.log("written:  " + outputsPath);
}

main();
