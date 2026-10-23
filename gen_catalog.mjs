import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DATA, UPLOADS } from "./lib/db.mjs";

const dbPath = path.join(DATA, "db.json");
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

const HUES = [
  ["#ff9000", "#5a3cff", "#ff3d71"], ["#00d4ff", "#7b2fff", "#ff9000"], ["#7bffb2", "#0088ff", "#8f7bff"],
  ["#ffb42e", "#ff3d00", "#5a3cff"], ["#8f7bff", "#ff71ce", "#00d4ff"], ["#ff9000", "#00d4ff", "#ff3d00"],
];
const FF = process.env.FFMPEG || "ffmpeg";

let ok = 0, fail = 0;
for (let i = 0; i < db.videos.length; i++) {
  const v = db.videos[i];
  const dur = 3 + (i % 5);
  const out = path.join(UPLOADS, `${v.id}.mp4`);
  if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
    const [c0, c1, c2] = HUES[i % HUES.length];
    const src = `gradients=n=3:s=640x360:c0=${c0}:c1=${c1}:c2=${c2}:speed=0.08:nb_colors=3:x0=${
      40 + (i % 7) * 60
    }:y0=${30 + (i % 5) * 70}:x1=${400 + (i % 4) * 40}:y1=${240 + (i % 3) * 40}`;
    const args = [
      "-y", "-f", "lavfi", "-i", src,
      "-t", String(dur), "-r", "30",
      "-pix_fmt", "yuv420p", "-crf", "33", "-preset", "ultrafast",
      "-movflags", "+faststart", out,
    ];
    const r = spawnSync(FF, args, { stdio: "ignore" });
    if (r.status !== 0) { fail++; console.error(`FAIL ${v.id}`); continue; }
  }
  v.file = out;
  v.ext = ".mp4";
  v.mime = "video/mp4";
  v.duration = dur;
  ok++;
}

fs.writeFileSync(dbPath, JSON.stringify(db, null, 1), "utf8");
console.log(`generated/catalogued: ${ok} clips to ${UPLOADS} (failed: ${fail})`);
