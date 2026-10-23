import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const DB_PATH = path.join(DATA, "db.json");

fs.mkdirSync(UPLOADS, { recursive: true });

export { ROOT, DATA, UPLOADS };

function seed() {
  const t = [
    ["Quantum Drift", "Sci-Fi"], ["Neon Nights", "Drama"], ["Glass Horizon", "Docuseries"],
    ["Signal Lost", "Thriller"], ["Aurora Protocol", "Action"], ["Paper Moon", "Romance"],
    ["Static Bloom", "Animation"], ["Deep Field", "Documentary"], ["Night Market", "Drama"],
    ["Zero Kernel", "Sci-Fi"], ["Echo Valley", "Mystery"], ["Titan Loop", "Action"],
    ["Solar Rent", "Comedy"], ["Frost Trace", "Thriller"], ["Lumen Reef", "Documentary"],
    ["Cobalt Sky", "Action"], ["Paper Machines", "Animation"], ["Midnight Cartel", "Mystery"],
    ["Glass Coast", "Documentary"], ["Echo Chamber", "Comedy"], ["Frozen Orbit", "Sci-Fi"],
    ["Peak Signal", "Action"], ["Velvet Hours", "Romance"], ["Iron Sleeve", "Thriller"],
  ];
  const cats = t.length;
  return {
    users: [],
    comments: [],
    videos: t.map(([title, cat], i) => ({
      id: `demo_${i + 1}`,
      title,
      category: cat,
      views: 4000 + Math.round(Math.abs(Math.sin(i * 7.3)) * 900000),
      likes: [],
      file: null,
      mime: null,
      size: 0,
      ownerId: null,
      createdAt: new Date(Date.now() - i * 3600e3).toISOString(),
    })),
    counts: Math.round(cats * 0) || t.length,
  };
}

let dbCache = null;

export function getDB() {
  if (dbCache) return dbCache;
  try {
    dbCache = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!dbCache || !Array.isArray(dbCache.videos) || !Array.isArray(dbCache.users)) throw new Error("bad shape");
    if (!Array.isArray(dbCache.comments)) dbCache.comments = [];
  } catch {
    dbCache = seed();
    saveDB(dbCache);
  }
  return dbCache;
}

export function saveDB(db) {
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), "utf8");
  fs.renameSync(tmp, DB_PATH);
}

export function newID() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
