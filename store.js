// Shared state lives as JSON files in a private GitHub repo, so it survives reinstalls and
// follows you across devices. storage.local keeps a cached copy of each file ("doc:<name>")
// so everything still works offline; offline changes are pushed on the next sync.
// Files go in a data/ folder so the same repo can also hold the extension's code.

const DATA_DIR = "data";

const DOCS = {
  settings: { path: `${DATA_DIR}/settings.json`, init: () => ({ ...SYNCED_DEFAULTS }) },
  progress: {
    path: `${DATA_DIR}/progress.json`,
    init: () => ({ currentLesson: 0, streak: 0, lastPassDate: null, history: [], recentQuestions: [], usedQuizHashes: [] }),
  },
  review: { path: `${DATA_DIR}/review.json`, init: () => ({ mistakes: [] }) },
  vocab: { path: `${DATA_DIR}/vocab.json`, init: () => ({ words: {} }) },
  syllabus: { path: `${DATA_DIR}/syllabus.json`, init: () => null },
};

const DATA_REPO_README = `# Português Primeiro data

Synced state for the [Português Primeiro](https://github.com/KagazzIe/portugues-primeiro) Firefox extension.
The extension reads and writes these files; edit them by hand only if you know what you're changing.

| File | Contents |
|---|---|
| \`settings.json\` | Quiz length, pass marks, allowed sites, Gemini model, skip-pronunciation preference |
| \`progress.json\` | Current lesson, streak, and a summary of each quiz |
| \`review.json\` | Spaced-repetition queue of missed questions |
| \`vocab.json\` | Spaced repetition for vocabulary words from completed lessons |
| \`syllabus.json\` | Lesson list from the textbook; \`"skip": true\` marks lessons to step over |
| \`digests/\` | One digest per textbook lesson: the complete summary daily lessons and quizzes are built from |
| \`lessons/\` | Each day's generated lesson |
| \`results/\` | One file per quiz with every question, your answer, and whether it was right |

See \`AGENTS.md\` at the repo root for how digests are written.

Digests and lessons are derived from
[*Português para principiantes*](https://wisc.pb.unizin.org/portuguese/) by the Department of Spanish &
Portuguese, UW-Madison, licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/),
and are shared under the same license.
`;

async function githubConfig() {
  const { githubToken, githubRepo } = await browser.storage.local.get(["githubToken", "githubRepo"]);
  return githubToken && githubRepo ? { token: githubToken, repo: githubRepo } : null;
}

async function getDoc(name) {
  const key = `doc:${name}`;
  const st = await browser.storage.local.get(key);
  return st[key] ?? DOCS[name].init();
}

const setLocalDoc = (name, data) => browser.storage.local.set({ [`doc:${name}`]: data });

async function setDirty(name, dirty) {
  const { "sync:dirty": list = [] } = await browser.storage.local.get("sync:dirty");
  const next = dirty ? [...new Set([...list, name])] : list.filter((n) => n !== name);
  await browser.storage.local.set({ "sync:dirty": next });
}

async function setSyncError(message) {
  await browser.storage.local.set({ "sync:error": message || null, ...(message ? {} : { "sync:last": Date.now() }) });
}

// Applies fn to the latest copy of a doc and saves it everywhere.
// fn must be pure (no side effects, don't mutate its argument): it may run more than once.
async function mutate(name, fn, message) {
  const local = await getDoc(name);
  const cfg = await githubConfig();
  if (cfg) {
    try {
      const next = await ghUpdateJson(cfg, DOCS[name].path, (remote) => fn(remote ?? local), message);
      await setLocalDoc(name, next);
      await setDirty(name, false);
      await setSyncError(null);
      return next;
    } catch (e) {
      await setSyncError(e.message);
    }
  }
  const next = fn(local);
  await setLocalDoc(name, next);
  if (cfg) await setDirty(name, true);
  return next;
}

// Pushes changes made while offline. Dirty docs win over the remote copy (last write wins).
async function flushPending(cfg) {
  const st = await browser.storage.local.get(["sync:dirty", "sync:results"]);
  for (const name of st["sync:dirty"] || []) {
    const local = await getDoc(name);
    await ghUpdateJson(cfg, DOCS[name].path, () => local, `Sync ${name} from offline changes`);
    await setDirty(name, false);
  }
  const pending = st["sync:results"] || [];
  while (pending.length) {
    const r = pending[0];
    try {
      await ghWriteJson(cfg, r.path, r.data, null, r.message);
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422)) throw e; // 422: already uploaded
    }
    pending.shift();
    await browser.storage.local.set({ "sync:results": pending });
  }
}

// Downloads the latest docs. Returns false if GitHub isn't configured.
async function syncDown(names = Object.keys(DOCS)) {
  const cfg = await githubConfig();
  if (!cfg) return false;
  try {
    await flushPending(cfg);
    const { "sync:dirty": dirty = [] } = await browser.storage.local.get("sync:dirty");
    await Promise.all(
      names
        .filter((n) => !dirty.includes(n))
        .map(async (n) => {
          const r = await ghReadJson(cfg, DOCS[n].path);
          if (r) await setLocalDoc(n, r.data);
        })
    );
    await setSyncError(null);
    return true;
  } catch (e) {
    await setSyncError(e.message);
    throw e;
  }
}

// ---------- Standalone files (digests, daily lessons) ----------
// Read through a local cache ("file:<path>") that's refreshed after a day, so an improved digest
// committed from elsewhere still reaches every device.

const FILE_CACHE_MS = 24 * 60 * 60 * 1000;

async function readRepoFile(path) {
  const key = `file:${path}`;
  const cached = (await browser.storage.local.get(key))[key];
  const cfg = await githubConfig();
  if (cached && (!cfg || Date.now() - cached.at < FILE_CACHE_MS)) return cached.data;
  if (!cfg) return null;
  try {
    const r = await ghReadJson(cfg, path);
    if (r) await browser.storage.local.set({ [key]: { data: r.data, at: Date.now() } });
    return r ? r.data : cached?.data ?? null;
  } catch {
    return cached?.data ?? null;
  }
}

async function writeRepoFile(path, data, message) {
  await browser.storage.local.set({ [`file:${path}`]: { data, at: Date.now() } });
  const cfg = await githubConfig();
  if (!cfg) return;
  try {
    await ghUpdateJson(cfg, path, () => data, message);
  } catch (e) {
    await setSyncError(e.message);
    const { "sync:results": pending = [] } = await browser.storage.local.get("sync:results");
    await browser.storage.local.set({ "sync:results": [...pending, { path, data, message }] });
  }
}

async function listRepoDir(path) {
  const cfg = await githubConfig();
  return cfg ? ghListDir(cfg, path) : [];
}

// Saves one quiz's full record as its own file, so results never conflict between devices.
async function saveResult(record) {
  const d = new Date();
  const day = todayKey(); // study day; a 2am quiz files under the day before
  const pad = (n) => String(n).padStart(2, "0");
  const path = `${DATA_DIR}/results/${day.slice(0, 4)}/${day}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  const message = `Quiz ${day}: ${record.lesson} ${record.right}/${record.total}`;
  const cfg = await githubConfig();
  if (cfg) {
    try {
      await ghWriteJson(cfg, path, record, null, message);
      return;
    } catch (e) {
      await setSyncError(e.message);
    }
  }
  if (!cfg) return;
  const { "sync:results": pending = [] } = await browser.storage.local.get("sync:results");
  await browser.storage.local.set({ "sync:results": [...pending, { path, data: record, message }] });
}

// First connection on a device: adopt what's in the repo, or seed the repo from this device.
async function connectGitHub(cfg) {
  await ghCheckRepo(cfg);
  await browser.storage.local.set({ githubToken: cfg.token, githubRepo: cfg.repo, "sync:dirty": [] });
  const report = [];
  for (const [name, doc] of Object.entries(DOCS)) {
    const remote = await ghReadJson(cfg, doc.path);
    if (remote) {
      await setLocalDoc(name, remote.data);
      report.push(`${doc.path}: downloaded`);
    } else {
      const local = await getDoc(name);
      if (local) {
        await ghWriteJson(cfg, doc.path, local, null, `Add ${doc.path}`);
        report.push(`${doc.path}: uploaded from this device`);
      }
    }
  }
  const readmePath = `${DATA_DIR}/README.md`;
  const readme = await gh(cfg, "GET", `contents/${readmePath}`);
  if (!readme || base64ToUtf8(readme.content || "") !== DATA_REPO_README) {
    await ghWriteText(cfg, readmePath, DATA_REPO_README, readme?.sha, "Describe the data files");
  }
  await setSyncError(null);
  return report;
}

// One-time move from the pre-sync storage layout (loose keys + PDF textbook) to docs.
async function migrateLegacy() {
  const legacyKeys = [
    "history", "streak", "lastPassDate", "unlockedDate", "mistakes", "currentLesson", "syllabus",
    "usedQuizHashes", "recentQuestions", "lessonFocus", "geminiFile",
    "notebookUrl", "questionCount", "passPercent", "allowlist", "geminiModel",
  ];
  const st = await browser.storage.local.get([...legacyKeys, "doc:progress"]);
  if (!legacyKeys.some((k) => k in st)) return;
  if (!st["doc:progress"]) {
    await setLocalDoc("progress", {
      ...DOCS.progress.init(),
      streak: st.streak || 0,
      lastPassDate: st.lastPassDate || null,
      history: st.history || [],
      recentQuestions: st.recentQuestions || [],
      usedQuizHashes: st.usedQuizHashes || [],
    });
    await setLocalDoc("review", { mistakes: st.mistakes || [] });
    const settings = { ...SYNCED_DEFAULTS };
    for (const k of ["questionCount", "passPercent", "geminiModel"]) if (st[k] != null) settings[k] = st[k];
    if (st.allowlist) settings.allowlist = [...new Set([...SYNCED_DEFAULTS.allowlist, ...st.allowlist])];
    await setLocalDoc("settings", settings);
  }
  // The old syllabus was built from a PDF and doesn't match the website's lessons.
  await browser.storage.local.remove(legacyKeys);
  try {
    indexedDB.deleteDatabase("portugues-primeiro");
  } catch {}
}
