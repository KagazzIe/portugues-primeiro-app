const $ = (id) => document.getElementById(id);

const flash = (id, text, ms = 2500) => {
  $(id).textContent = text;
  if (ms) setTimeout(() => ($(id).textContent === text ? ($(id).textContent = "") : null), ms);
};

async function render() {
  const s = await getSettings();
  for (const k of ["githubRepo", "githubToken", "geminiApiKey", "geminiModel", "bookUrl", "questionCount", "passPercent", "advancePercent"]) {
    if (document.activeElement !== $(k)) $(k).value = s[k];
  }
  $("allowlist").value = s.allowlist.join("\n");
  $("skipPronunciation").checked = !!s.skipPronunciation;
  $("sounds").checked = s.sounds !== false;
  $("min-q").textContent = MIN_QUESTIONS;
  $("min-p").textContent = MIN_PASS_PERCENT;

  const [progress, review, syllabus] = await Promise.all([getDoc("progress"), getDoc("review"), getDoc("syllabus")]);
  const last = completeDate(progress);
  const alive = last === todayKey() || last === yesterdayKey();
  const st = await browser.storage.local.get(["sync:error", "sync:last"]);
  const sync = !s.githubRepo
    ? "Not syncing"
    : st["sync:error"]
      ? `Sync problem: ${st["sync:error"]}`
      : st["sync:last"] ? `Synced ${new Date(st["sync:last"]).toLocaleTimeString()}` : "Sync set up";
  $("status").textContent = `${dayDone(progress) ? "✅ Done for today" : "🔒 Locked"} · 🔥 ${alive ? progress.streak || 0 : 0}-day streak · ${sync}`;

  const digests = new Set(await listRepoDir(`${DATA_DIR}/digests`).catch(() => []));
  renderSyllabus(syllabus, progress, digests);

  const due = dueMistakes(review, Infinity).length;
  const total = review.mistakes?.length || 0;
  $("review-status").textContent = total ? `${total} missed question${total === 1 ? "" : "s"} in review, ${due} due now.` : "";

  const list = $("history");
  list.replaceChildren();
  const history = progress.history || [];
  if (!history.length) list.textContent = "No quizzes yet.";
  for (const h of history.slice(0, 60)) {
    const div = document.createElement("div");
    div.className = "review-item";
    div.textContent = `${h.passed ? "✅" : "❌"} ${h.date}: ${h.lesson} (${h.right}/${h.total})${h.missed?.length ? `. Missed: ${h.missed.join("; ")}` : ""}`;
    list.append(div);
  }
}

// digests: file names present in data/digests/ (empty when not syncing).
function renderSyllabus(syllabus, progress, digests) {
  const list = $("lesson-list");
  list.replaceChildren();
  if (!syllabus) {
    $("syllabus-status").textContent = "Lessons load automatically the first time you open the lock page, or click Reload.";
    $("syllabus-json").value = "";
    return;
  }
  const hasDigest = (l) => digests.has(`${lessonSlug(l)}.json`);
  const withDigest = syllabus.lessons.filter(hasDigest).length;
  $("syllabus-status").textContent =
    `${syllabus.title}${syllabus.variety !== "Unclear" ? ` (${syllabus.variety} Portuguese)` : ""}: ${syllabus.lessons.length} lessons, ` +
    `${withDigest} with a digest (✓). Lessons without one get a digest from Gemini when you reach them.`;
  const current = progress.currentLesson || 0;
  syllabus.lessons.forEach((l, i) => {
    const li = document.createElement("li");
    li.textContent = `${l.title}${l.sources.length > 1 ? ` + ${l.sources.slice(1).map((s) => s.title).join(" + ")}` : ""}${hasDigest(l) ? " ✓" : ""}${l.skip ? " (skipped)" : ""}${i === current ? " ← current" : ""}`;
    if (i === current) li.className = "current";
    else if (!hasDigest(l)) li.className = "pending";
    list.append(li);
  });
  if (document.activeElement !== $("syllabus-json")) $("syllabus-json").value = JSON.stringify(syllabus, null, 2);
}

// ---------- Sync ----------

$("connect").addEventListener("click", async () => {
  const cfg = { repo: $("githubRepo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""), token: $("githubToken").value.trim() };
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo) || !cfg.token) return flash("sync-msg", "Enter the repo as owner/name and a token.", 0);
  flash("sync-msg", "Connecting…", 0);
  try {
    const report = await connectGitHub(cfg);
    flash("sync-msg", `Connected ✓ ${report.join(", ")}`, 0);
  } catch (e) {
    flash("sync-msg", `Couldn't connect: ${e.message}`, 0);
  }
  render();
});

$("sync-now").addEventListener("click", async () => {
  flash("sync-msg", "Syncing…", 0);
  try {
    const ok = await syncDown();
    flash("sync-msg", ok ? "Synced ✓" : "Connect a repo first.");
  } catch (e) {
    flash("sync-msg", `Sync failed: ${e.message}`, 0);
  }
  render();
});

// ---------- Gemini ----------

$("test-gemini").addEventListener("click", async () => {
  const apiKey = $("geminiApiKey").value.trim();
  if (!apiKey) return flash("test-status", "Enter an API key first.");
  flash("test-status", "Testing…", 0);
  try {
    const text = await generateJson({
      apiKey,
      model: $("geminiModel").value.trim() || SYNCED_DEFAULTS.geminiModel,
      parts: [{ text: 'Reply with {"ok": true, "word": "<one Portuguese greeting>"}' }],
      schema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" }, word: { type: "STRING" } }, required: ["ok", "word"] },
      temperature: 1,
    });
    const { word } = JSON.parse(text);
    flash("test-status", `Works!${word ? ` Gemini says "${word}".` : ""} Remember to Save.`, 0);
  } catch (e) {
    flash("test-status", `Failed: ${e.message}`, 0);
  }
});

// ---------- Textbook ----------

$("reload-lessons").addEventListener("click", async () => {
  const bookUrl = $("bookUrl").value.trim() || SYNCED_DEFAULTS.bookUrl;
  flash("reload-status", "Loading…", 0);
  try {
    const fresh = await fetchBookSyllabus(bookUrl);
    const s = await mutate("syllabus", (cur) => mergeSyllabus(cur?.bookUrl === bookUrl ? cur : null, fresh), `Reload lessons from ${fresh.title}`);
    flash("reload-status", `Loaded ${s.lessons.length} lessons ✓`);
  } catch (e) {
    flash("reload-status", `Failed: ${e.message}`, 0);
  }
  render();
});

$("save-syllabus").addEventListener("click", async () => {
  try {
    const s = JSON.parse($("syllabus-json").value);
    if (!Array.isArray(s.lessons) || !s.lessons.length) throw new Error('needs a "lessons" list');
    s.lessons.forEach((l, i) => {
      if (!l.title || !l.sources?.length) throw new Error(`lesson ${i + 1} needs a "title" and "sources"`);
    });
    await mutate("syllabus", () => s, "Edit syllabus by hand");
    await mutate("progress", (p) => ({ ...p, currentLesson: Math.min(p.currentLesson || 0, s.lessons.length - 1) }), "Keep lesson in range");
    flash("syllabus-json-status", "Saved ✓");
  } catch (e) {
    flash("syllabus-json-status", `Not saved: ${e.message}`, 0);
  }
  render();
});

// ---------- Save ----------

$("save").addEventListener("click", async () => {
  const domain = (d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const allowlist = $("allowlist").value.split(/\s+/).map(domain).filter(Boolean);
  const bookUrl = $("bookUrl").value.trim() || SYNCED_DEFAULTS.bookUrl;

  // The textbook must stay reachable while locked.
  try {
    const host = new URL(bookUrl).hostname;
    if (!hostAllowed(host, allowlist)) allowlist.unshift(host);
  } catch {}

  await browser.storage.local.set({ geminiApiKey: $("geminiApiKey").value.trim() });
  const synced = clampSettings({
    ...(await getDoc("settings")),
    geminiModel: $("geminiModel").value.trim() || SYNCED_DEFAULTS.geminiModel,
    bookUrl,
    questionCount: parseInt($("questionCount").value, 10),
    passPercent: parseInt($("passPercent").value, 10),
    advancePercent: parseInt($("advancePercent").value, 10),
    skipPronunciation: $("skipPronunciation").checked,
    sounds: $("sounds").checked,
    allowlist,
  });
  await mutate("settings", (cur) => {
    const { notebookUrl, ...rest } = { ...(cur || {}), ...synced }; // notebookUrl: retired setting
    return rest;
  }, "Update settings");
  flash("saved", "Saved ✓");
  render();
});

migrateLegacy().catch(() => {}).then(render);
