import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getDB, saveDB, newID, ROOT, UPLOADS } from "./lib/db.mjs";
import { hashPassword, verifyPassword, createSession, sessionUser, sessionCookie, COOKIE } from "./lib/auth.mjs";

const PORT = Number(process.env.PORT || 3200);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(ROOT, "public");
const MAX_UPLOAD = 250 * 1024 * 1024;
const API_RE = /^\/api\//;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
const TEXTUAL = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg"]);

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function json(res, code, data, headers = {}) {
  send(res, code, JSON.stringify(data), { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
}

function bad(res, code, msg, codeName) {
  json(res, code, { error: codeName || msg, message: msg });
}

function readJSONBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { code: "BAD_JSON" }));
      }
    });
    req.on("error", reject);
  });
}

function publicUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email } : null;
}

function videoView(v, user, db) {
  const cCount = (db.comments || []).filter((c) => c.videoId === v.id).length;
  return {
    id: v.id,
    title: v.title,
    category: v.category,
    views: v.views,
    likes: v.likes.length,
    liked: user ? v.likes.includes(user.id) : false,
    hasFile: Boolean(v.file),
    thumbUrl: v.file ? `/api/videos/${v.id}/thumb` : null,
    duration: v.duration || null,
    myProgress: user && v.progress && v.progress[user.id] ? v.progress[user.id] : 0,
    comments: cCount,
    createdAt: v.createdAt,
    ownerName: v.ownerName || null,
    ownerId: v.ownerId || null,
    owned: Boolean(user && v.ownerId && v.ownerId === user.id),
  };
}

function listVideos(db, user, { q, category }) {
  let list = db.videos.slice();
  if (category && category !== "All") list = list.filter((v) => v.category === category);
  if (q) {
    const s = q.toLowerCase();
    list = list.filter((v) => v.title.toLowerCase().includes(s) || v.category.toLowerCase().includes(s));
  }
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return list.map((v) => videoView(v, user, db));
}

async function handleAuth(req, res, url, db) {
  const action = url.pathname;

  if (action === "/api/me") {
    const user = sessionUser(req, db);
    if (!user) return bad(res, 401, "Not signed in", "UNAUTHENTICATED");
    return json(res, 200, { user: publicUser(user) });
  }

  const body = await readJSONBody(req);

  if (action === "/api/auth/register") {
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const pw = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 400, "Invalid email", "INVALID_EMAIL");
    if (!name || name.length > 40) return bad(res, 400, "Invalid name", "INVALID_NAME");
    if (pw.length < 6) return bad(res, 400, "Password needs 6+ characters", "WEAK_PASSWORD");
    if (db.users.some((u) => u.email === email)) return bad(res, 409, "Email already registered", "EMAIL_TAKEN");
    const { hash, salt } = hashPassword(pw);
    const user = { id: newID(), name, email, hash, salt, createdAt: new Date().toISOString() };
    db.users.push(user);
    saveDB(db);
    json(res, 201, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(createSession(user.id)) });
    return;
  }

  if (action === "/api/auth/login") {
    const email = String(body.email || "").trim().toLowerCase();
    const pw = String(body.password || "");
    const user = db.users.find((u) => u.email === email);
    if (!user || !verifyPassword(pw, user.salt, user.hash)) {
      return bad(res, 401, "Wrong email or password", "BAD_LOGIN");
    }
    json(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(createSession(user.id)) });
    return;
  }

  if (action === "/api/auth/logout") {
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(null, true) });
    return;
  }
}

function streamFile(res, absPath, mime, rangeHeader) {
  const stat = fs.statSync(absPath);
  const base = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (rangeHeader && /^bytes=/.test(rangeHeader)) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (!m || (m[1] === "" && m[2] === "")) {
      return bad(res, 400, "Invalid Range header", "INVALID_RANGE");
    }
    let start = m[1] === "" ? NaN : Number(m[1]);
    let end = m[2] === "" ? NaN : Number(m[2]);
    if (isNaN(start)) { start = 0; end = stat.size - 1; }
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end || start < 0) {
      return send(res, 416, "", { "Content-Range": `bytes */${stat.size}` });
    }
    res.writeHead(206, {
      ...base,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, "Content-Length": stat.size });
  fs.createReadStream(absPath).pipe(res);
  return true;
}

function serveVideoFile(res, v, rangeHeader) {
  if (!v.file) return bad(res, 404, "Demo entry has no uploaded file", "NO_FILE");
  const ext = path.extname(v.file);
  const mime = MIME[ext] || "application/octet-stream";
  streamFile(res, v.file, mime, rangeHeader);
}

async function handleUpload(req, res, db, user) {
  const filename = String(req.headers["x-bs-filename"] || "");
  const title = String(req.headers["x-bs-title"] || "").trim() || "Untitled";
  const categoryRaw = String(req.headers["x-bs-category"] || "Other").trim();
  const key = req.headers["x-bs-key"];
  if (!filename || !key) return bad(res, 400, "Missing upload metadata headers", "INVALID_UPLOAD");
  const safeName = path.basename(filename).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const ext = path.extname(safeName).toLowerCase();
  if (ext !== ".mp4" && ext !== ".webm") return bad(res, 415, "Only .mp4 or .webm files", "UNSUPPORTED_TYPE");
  const category = categoryRaw.slice(0, 24) || "Other";

  const id = newID();
  const tmp = path.join(UPLOADS, `${id}.part`);
  const finalPath = path.join(UPLOADS, `${id}${ext}`);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        try {
          if (!res.writableEnded) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "FILE_TOO_LARGE", message: "File exceeds the 250 MB cap" }));
          }
        } catch {}
        req.destroy();
        fs.rmSync(tmp, { force: true });
        reject(Object.assign(new Error("file too large"), { code: "FILE_TOO_LARGE" }));
        return;
      }
      ws.write(c);
    });
    req.on("end", () => { ws.end(null, null, null); ws.on("finish", resolve); });
    req.on("error", reject);
    ws.on("error", reject);
  });
  try { fs.accessSync(tmp); } catch { return bad(res, 400, "Empty upload", "EMPTY_UPLOAD"); }
  fs.renameSync(tmp, finalPath);

  const v = {
    id,
    title,
    category,
    views: 0,
    likes: [],
    file: finalPath,
    ext,
    mime: ext === ".webm" ? "video/webm" : "video/mp4",
    duration: null,
    size: fs.statSync(finalPath).size,
    ownerId: user.id,
    ownerName: user.name,
    createdAt: new Date().toISOString(),
  };
  db.videos.push(v);
  saveDB(db);
  json(res, 201, { video: videoView(v, user, db) });
}

async function handleAPI(req, res, url, db) {
  const action = url.pathname;
  const method = req.method;
  const user = sessionUser(req, db);

  if (action === "/api/me" || action.startsWith("/api/auth/")) {
    if (action === "/api/me") {
      if (method !== "GET") return bad(res, 405, "Use GET for /api/me", "METHOD");
      return handleAuth(req, res, url, db);
    }
    if (method === "POST") {
      if (["/api/auth/register", "/api/auth/login", "/api/auth/logout"].includes(action)) {
        return handleAuth(req, res, url, db);
      }
      return bad(res, 404, "Unknown auth route", "NOT_FOUND");
    }
    return bad(res, 405, "Method not allowed", "METHOD");
  }

  if (action === "/api/videos" && method === "GET") {
    return json(res, 200, { videos: listVideos(db, user, { q: url.searchParams.get("q"), category: url.searchParams.get("category") }) });
  }

  const cm = action.match(/^\/api\/comments\/([^/]+)$/);
  if (cm && method === "DELETE") {
    if (!user) return bad(res, 401, "Sign in first", "UNAUTHENTICATED");
    const c = (db.comments || []).find((x) => x.id === cm[1]);
    if (!c) return bad(res, 404, "Comment not found", "NOT_FOUND");
    const v = db.videos.find((x) => x.id === c.videoId);
    if (c.userId !== user.id && (!v || v.ownerId !== user.id)) return bad(res, 403, "Not your comment", "FORBIDDEN");
    db.comments = db.comments.filter((x) => x.id !== c.id);
    saveDB(db);
    return json(res, 200, { ok: true });
  }

  const pm = action.match(/^\/api\/users\/([^/]+)(\/videos)?$/);
  if (pm && method === "GET") {
    const target = db.users.find((u) => u.id === pm[1]);
    if (!target) return bad(res, 404, "User not found", "NOT_FOUND");
    const vids = db.videos.filter((v) => v.ownerId === target.id);
    const stats = {
      uploads: vids.length,
      views: vids.reduce((s, v) => s + v.views, 0),
      likeHits: vids.reduce((s, v) => s + v.likes.length, 0),
      commentsHit: (db.comments || []).filter((c) => vids.some((v) => v.id === c.videoId)).length,
    };
    if (pm[2]) return json(res, 200, { videos: vids.map((v) => videoView(v, user, db)) });
    return json(res, 200, {
      profile: { id: target.id, name: target.name, joined: target.createdAt, mine: user && user.id === target.id, stats },
    });
  }

  if (action === "/api/videos" && method === "POST") {
    if (!user) return bad(res, 401, "Sign in to upload", "UNAUTHENTICATED");
    return handleUpload(req, res, db, user);
  }

  const m = action.match(/^\/api\/videos\/([^/]+)(\/(stream|thumb|like|progress|comments))?$/);
  if (m) {
    const id = m[1];
    const op = m[3] || null;
    const v = db.videos.find((x) => x.id === id);
    if (!v) return bad(res, 404, "Video not found", "NOT_FOUND");

    if (op === "comments" && method === "GET") {
      const list = (db.comments || [])
        .filter((c) => c.videoId === id)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((c) => ({
          id: c.id,
          userName: c.userName,
          text: c.text,
          createdAt: c.createdAt,
          canDelete: Boolean(user && (c.userId === user.id || v.ownerId === user.id)),
        }));
      return json(res, 200, { comments: list });
    }

    if (op === "comments" && method === "POST") {
      if (!user) return bad(res, 401, "Sign in to comment", "UNAUTHENTICATED");
      const body = await readJSONBody(req);
      const text = String(body.text || "").trim();
      if (!text || text.length > 500) return bad(res, 400, "Comment must be 1-500 characters", "INVALID_COMMENT");
      const c = { id: newID(), videoId: id, userId: user.id, userName: user.name, text, createdAt: new Date().toISOString() };
      db.comments = db.comments || [];
      db.comments.push(c);
      saveDB(db);
      return json(res, 201, { comment: c });
    }

    if (!op && method === "GET") {
      v.views += 1;
      saveDB(db);
      return json(res, 200, { video: videoView(v, user, db) });
    }

    if (!op && method === "DELETE") {
      if (!user) return bad(res, 401, "Sign in to manage videos", "UNAUTHENTICATED");
      if (v.ownerId !== user.id) return bad(res, 403, "You can only delete your own uploads", "FORBIDDEN");
      try { fs.rmSync(v.file, { force: true }); } catch {}
      db.videos = db.videos.filter((x) => x.id !== v.id);
      saveDB(db);
      return json(res, 200, { ok: true });
    }

    if (op === "stream" && method === "GET") {
      return serveVideoFile(res, v, req.headers.range);
    }

    if (op === "thumb" && method === "GET") {
      const thumbPath = path.join(ROOT, "data", "thumbs", `${id}.jpg`);
      if (fs.existsSync(thumbPath)) return streamFile(res, thumbPath, "image/jpeg", null);
      return bad(res, 404, "No thumbnail", "NOT_FOUND");
    }

    if (op === "progress" && method === "POST") {
      if (!user) return bad(res, 401, "Sign in to save progress", "UNAUTHENTICATED");
      const body = await readJSONBody(req);
      const t = Math.max(0, Math.min(Number(body.t || 0), 1e6));
      v.progress = v.progress || {};
      v.progress[user.id] = Math.round(t * 10) / 10;
      saveDB(db);
      return json(res, 200, { ok: true, t: v.progress[user.id] });
    }

    if (op === "like" && method === "POST") {
      if (!user) return bad(res, 401, "Sign in to like", "UNAUTHENTICATED");
      const i = v.likes.indexOf(user.id);
      if (i === -1) v.likes.push(user.id); else v.likes.splice(i, 1);
      saveDB(db);
      return json(res, 200, { likes: v.likes.length, liked: i === -1 });
    }

    return bad(res, 405, "Method not allowed", "METHOD");
  }

  return bad(res, 404, "Unknown API route", "NOT_FOUND");
}

function exitCodeForBodyError(err) {
  return err && err.code === "FILE_TOO_LARGE" ? 413 : err && err.code === "BODY_TOO_LARGE" ? 413 : err && err.code === "BAD_JSON" ? 400 : err.code === "EMPTY_UPLOAD" ? 400 : 500;
}

function staticServeSync(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const abs = path.resolve(path.join(PUBLIC, rel));
  const rootOut = path.resolve(PUBLIC);
  if (!abs.startsWith(rootOut)) {
    return bad(res, 403, "Forbidden", "FORBIDDEN");
  }
  let target = abs;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    target = path.join(PUBLIC, "index.html");
  }
  const ext = path.extname(target).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";

  if (TEXTUAL.has(ext)) {
    let raw = fs.readFileSync(target);
    const enc = req.headers["accept-encoding"] || "";
    if (enc.includes("gzip")) {
      raw = zlib.gzipSync(raw, { level: 6 });
      res.writeHead(200, { "Content-Type": mime, "Content-Encoding": "gzip", "Cache-Control": "no-store", Vary: "Accept-Encoding" });
      res.end(raw);
      return;
    }
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(raw);
    return;
  }
  streamFile(res, target, mime, null);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const db = getDB();

  if (API_RE.test(url.pathname)) {
    res.on("close", () => { if (res.writableEnded) return; });
    try {
      await handleAPI(req, res, url, db);
    } catch (err) {
      const code = typeof exitCodeForBodyError === "function" ? exitCodeForBodyError(err) : 500;
      const codeName = err && err.code ? String(err.code) : "SERVER_ERROR";
      bad(res, code, err && err.message ? err.message : "Server error", codeName);
    }
    return;
  }
  staticServeSync(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`GlassStream Pro listening on http://${HOST}:${PORT}`);
});
