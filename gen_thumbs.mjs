import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DATA, UPLOADS } from "./lib/db.mjs";

const THUMBS = path.join(DATA, "thumbs");
fs.mkdirSync(THUMBS, { recursive: true });
const db = JSON.parse(fs.readFileSync(path.join(DATA, "db.json"), "utf8"));
const FF = process.env.FFMPEG || "ffmpeg";

let ok = 0, skip = 0, fail = 0;
for (const v of db.videos) {
  const out = path.join(THUMBS, `${v.id}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).size > 512) { skip++; continue; }
  const src = v.file || path.join(UPLOADS, `${v.id}.mp4`);
  if (!fs.existsSync(src)) { fail++; console.error(`no source for ${v.id}`); continue; }
  const r = spawnSync(FF, [
    "-y", "-ss", String(Math.min(1, (v.duration || 4) * 0.35)),
    "-i", src, "-frames:v", "1", "-q:v", "4",
    "-vf", "scale=640:-2", out,
  ], { stdio: "ignore" });
  if (r.status === 0) ok++; else { fail++; console.error(`FAIL ${v.id} status=${r.status}`); }
}
console.log(`thumbs: ${ok} new, ${skip} kept, ${fail} failed -> ${THUMBS}`);
