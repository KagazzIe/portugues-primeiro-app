// Minimal GitHub contents API client for reading and writing JSON files in the data repo.

const GH_API = "https://api.github.com";

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

async function gh(cfg, method, path, body) {
  const res = await fetch(`${GH_API}/repos/${cfg.repo}${path ? `/${path}` : ""}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).message || msg;
    } catch {}
    throw new GitHubError(msg, res.status);
  }
  return res.json();
}

async function ghCheckRepo(cfg) {
  const repo = await gh(cfg, "GET", "");
  if (!repo) throw new GitHubError(`Repo "${cfg.repo}" not found, or the token can't see it.`, 404);
  return repo;
}

async function ghReadJson(cfg, path) {
  const file = await gh(cfg, "GET", `contents/${encodePath(path)}`);
  if (!file) return null;
  // Files over 1 MB come back without content; fetch the blob instead.
  const b64 = file.encoding === "base64" ? file.content : (await gh(cfg, "GET", `git/blobs/${file.sha}`)).content;
  return { data: JSON.parse(base64ToUtf8(b64)), sha: file.sha };
}

// File names in a folder, or [] if it doesn't exist.
async function ghListDir(cfg, path) {
  const items = await gh(cfg, "GET", `contents/${encodePath(path)}`);
  return Array.isArray(items) ? items.filter((i) => i.type === "file").map((i) => i.name) : [];
}

function ghWriteJson(cfg, path, data, sha, message) {
  return gh(cfg, "PUT", `contents/${encodePath(path)}`, {
    message,
    content: utf8ToBase64(JSON.stringify(data, null, 2) + "\n"),
    ...(sha ? { sha } : {}),
  });
}

function ghWriteText(cfg, path, text, sha, message) {
  return gh(cfg, "PUT", `contents/${encodePath(path)}`, { message, content: utf8ToBase64(text), ...(sha ? { sha } : {}) });
}

// Read-modify-write. fn must be pure: it's re-run against the latest copy if another device wrote in between.
async function ghUpdateJson(cfg, path, fn, message) {
  for (let attempt = 0; ; attempt++) {
    const cur = await ghReadJson(cfg, path);
    const next = fn(cur ? cur.data : null);
    try {
      await ghWriteJson(cfg, path, next, cur?.sha, message);
      return next;
    } catch (e) {
      if (!(e instanceof GitHubError) || ![409, 422].includes(e.status) || attempt >= 3) throw e;
    }
  }
}
