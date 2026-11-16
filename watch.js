// Watch page: a library of YouTube videos, each with Portuguese + English captions written by Gemini
// (data/videos/<id>.json), played in an embedded player with the captions synced underneath.

const $ = (id) => document.getElementById(id);

let settings;
let videos; // synced doc: { videos: [{ id, title, channel, duration, lines, addedAt }] }

const videoPath = (id) => `${DATA_DIR}/videos/${id}.json`;
const homeUrl = () => (window.IS_WEB_APP ? "index.html" : "lock.html");

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return "";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function showError(id, msg) {
  $(id).textContent = msg || "";
  $(id).hidden = !msg;
}

// The 11-character video id from any usual YouTube link (or a bare id).
function parseVideoId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v") || (u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/) || [])[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// Title and channel from YouTube's oEmbed endpoint. It also says whether the video can be embedded.
// The phone version may not be allowed to call it (CORS); then the player fills the title in later.
async function fetchVideoInfo(id) {
  let res;
  try {
    res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) throw new Error("That video doesn't allow embedding, so it can't be played here. Try another one.");
  if (res.status === 404 || res.status === 400) throw new Error("YouTube can't find that video. Is it public?");
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return j ? { title: j.title || "", channel: j.author_name || "" } : null;
}

async function loadDocs() {
  settings = await getSettings();
  videos = await getDoc("videos");
  if (!videos || !Array.isArray(videos.videos)) videos = { videos: [] };
}

function renderSyncStatus() {
  browser.storage.local.get("sync:error").then((st) => {
    const err = st["sync:error"];
    $("sync-status").hidden = !err;
    $("sync-status").textContent = err ? `Sync problem: ${err}. Changes are saved on this device and sent later.` : "";
  });
}

// Patches one video's entry in the index (e.g. the title or length, once the player knows it).
async function updateEntry(id, patch, message) {
  videos = await mutate("videos", (cur) => {
    const list = cur?.videos || [];
    return { ...(cur || {}), videos: list.map((v) => (v.id === id ? { ...v, ...patch } : v)) };
  }, message);
}

// ---------- Library ----------

function renderLibrary() {
  $("page-loading").hidden = true;
  $("library-view").hidden = false;
  $("watch-view").hidden = true;
  const list = $("library");
  list.textContent = "";
  const items = [...videos.videos].reverse(); // newest first
  $("library-empty").hidden = items.length > 0;
  for (const v of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `?v=${encodeURIComponent(v.id)}`;
    a.textContent = v.title || v.id;
    a.className = "video-link";
    const meta = document.createElement("span");
    meta.className = "hint";
    meta.textContent = [v.channel, v.duration ? fmtTime(v.duration) : "", v.lines ? `${v.lines} lines` : "", v.addedAt ? `added ${v.addedAt}` : ""]
      .filter(Boolean)
      .join(" · ");
    const remove = document.createElement("button");
    remove.className = "link";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove "${v.title || v.id}" from your videos?`)) return;
      videos = await mutate("videos", (cur) => ({ ...(cur || {}), videos: (cur?.videos || []).filter((x) => x.id !== v.id) }), `Remove video: ${v.title || v.id}`);
      renderLibrary();
    });
    li.append(a, meta, remove);
    list.append(li);
  }
}

// Asks Gemini for captions and saves them. Returns the caption file.
async function writeCaptions(id, info) {
  const model = settings.videoModel || SYNCED_DEFAULTS.videoModel;
  const lines = await generateCaptions({ apiKey: settings.geminiApiKey, model, videoId: id });
  const file = {
    format: 1,
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: info?.title || "",
    channel: info?.channel || "",
    generatedBy: model,
    generatedAt: dateKey(new Date()),
    lines,
  };
  await writeRepoFile(videoPath(id), file, `Captions for ${file.title || id}`);
  return file;
}

async function addVideo() {
  showError("add-error", "");
  const id = parseVideoId($("video-url").value);
  if (!id) return showError("add-error", "That doesn't look like a YouTube link.");
  if (videos.videos.some((v) => v.id === id)) {
    location.search = `?v=${encodeURIComponent(id)}`;
    return;
  }
  if (!settings.geminiApiKey) return showError("add-error", "Add a Gemini API key in Settings first: Gemini writes the captions.");

  $("add-video").disabled = true;
  try {
    $("add-status").textContent = "Checking the video…";
    const info = await fetchVideoInfo(id);
    $("add-status").textContent = `Gemini is watching ${info?.title ? `"${info.title}"` : "the video"} and writing captions. This usually takes a minute or two…`;
    const file = await writeCaptions(id, info);
    const entry = {
      id,
      title: file.title,
      channel: file.channel,
      duration: null,
      lines: file.lines.length,
      addedAt: dateKey(new Date()),
    };
    videos = await mutate("videos", (cur) => ({ ...(cur || {}), videos: [...(cur?.videos || []).filter((v) => v.id !== id), entry] }), `Add video: ${entry.title || id}`);
    location.search = `?v=${encodeURIComponent(id)}`;
  } catch (e) {
    showError("add-error", `Couldn't add it: ${e.message}`);
    $("add-status").textContent = "";
  } finally {
    $("add-video").disabled = false;
  }
}

// ---------- Embedded player ----------
// Talks to the YouTube iframe through postMessage (the same protocol as YouTube's iframe API, without
// loading its script, which extension pages can't do).
// YouTube refuses to play embeds on pages that aren't on a website (error 153), which includes extension
// pages. So in Firefox the player goes through a relay page on the phone site (web/player.html), which embeds
// YouTube and passes messages both ways. The phone version embeds YouTube directly.
// "?relay" in the page address forces the relay from the same site, for testing the phone build.
const RELAY_URL = "https://kagazzie.github.io/portugues-primeiro-app/player.html";
function playerSource(videoId) {
  const useRelay = new URLSearchParams(location.search).has("relay");
  if (window.IS_WEB_APP && !useRelay) {
    const params = new URLSearchParams({ enablejsapi: "1", playsinline: "1", rel: "0", iv_load_policy: "3", cc_load_policy: "0", fs: "0", hl: "pt-BR", origin: location.origin });
    return { src: `https://www.youtube.com/embed/${videoId}?${params}`, origins: ["https://www.youtube.com", "https://www.youtube-nocookie.com"] };
  }
  const relay = new URL(useRelay ? "player.html" : RELAY_URL, location.href);
  relay.searchParams.set("v", videoId);
  return { src: relay.href, origins: [relay.origin] };
}

class YouTubePlayer {
  constructor(iframe, videoId, { onInfo, onError }) {
    this.iframe = iframe;
    this.onInfo = onInfo;
    this.onError = onError;
    this.time = 0;
    this.timeAt = performance.now();
    this.state = -1; // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    this.rate = 1;
    this.connected = false;

    const source = playerSource(videoId);
    this.origins = source.origins;
    iframe.src = source.src;

    window.addEventListener("message", (e) => this.receive(e));
    // Keep saying hello until the player answers.
    iframe.addEventListener("load", () => {
      let tries = 0;
      clearInterval(this.hello);
      this.hello = setInterval(() => {
        if (this.connected || ++tries > 40) return clearInterval(this.hello);
        this.post({ event: "listening", id: "pp", channel: "widget" });
      }, 250);
    });
  }

  post(msg) {
    this.iframe.contentWindow?.postMessage(JSON.stringify(msg), "*");
  }

  command(func, args = []) {
    this.post({ event: "command", func, args, id: "pp", channel: "widget" });
  }

  receive(e) {
    if (e.source !== this.iframe.contentWindow || !this.origins.includes(e.origin)) return;
    let d;
    try {
      d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (!d || !d.event) return;
    if (!this.connected) {
      this.connected = true;
      for (const ev of ["onStateChange", "onPlaybackRateChange", "onError"]) this.command("addEventListener", [ev]);
    }
    if (d.event === "onError") return this.onError(d.info);
    if (d.event === "onStateChange") this.setState(d.info);
    if (d.event === "onPlaybackRateChange") this.rate = d.info || 1;
    if ((d.event === "infoDelivery" || d.event === "initialDelivery") && d.info) {
      const i = d.info;
      if (typeof i.playerState === "number") this.setState(i.playerState);
      if (typeof i.playbackRate === "number") this.rate = i.playbackRate;
      if (typeof i.currentTime === "number") {
        this.time = i.currentTime;
        this.timeAt = performance.now();
      }
      this.onInfo(i);
    }
  }

  setState(s) {
    if (this.state === 1 && s !== 1) this.time = this.currentTime(); // freeze the estimate
    // YouTube's own captions would sit on top of ours. The captions module loads once playback starts.
    if (s === 1 && !this.ccOff) {
      this.ccOff = true;
      this.command("unloadModule", ["captions"]);
      this.command("unloadModule", ["cc"]);
    }
    this.state = s;
    this.timeAt = performance.now();
  }

  // YouTube reports the time a few times a second; in between, estimate it from the clock.
  currentTime() {
    return this.state === 1 ? this.time + ((performance.now() - this.timeAt) / 1000) * this.rate : this.time;
  }

  seek(t) {
    this.time = t;
    this.timeAt = performance.now();
    this.command("seekTo", [t, true]);
  }
  play() {
    this.command("playVideo");
  }
  pause() {
    this.command("pauseVideo");
  }
  setRate(r) {
    this.rate = r;
    this.command("setPlaybackRate", [r]);
  }
}

// ---------- Watching one video ----------

const PREF_KEY = "watch:prefs";
let prefs = { showEn: true, pauseEach: false, follow: true, rate: 1, overlay: true };
let captions = null; // caption file
let player = null;
let active = -1;       // index of the line being shown
let pausedAfter = -1;  // the line "Pause after each line" last stopped at
const glossCache = new Map();

async function savePrefs() {
  await browser.storage.local.set({ [PREF_KEY]: prefs });
}

// The line playing at time t: the last line that has started (a gap between lines keeps the previous one).
function lineAt(t) {
  const lines = captions.lines;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t + 0.05) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// Each word is a button that looks itself up; punctuation and spaces stay plain text.
function renderWords(el, line) {
  el.textContent = "";
  for (const part of line.pt.split(/([\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}]+)*)/u)) {
    if (!part) continue;
    if (/^[\p{L}\p{N}]/u.test(part)) {
      const w = document.createElement("button");
      w.className = "word";
      w.textContent = part;
      w.addEventListener("click", () => lookUp(part, line.pt));
      el.append(w);
    } else el.append(part);
  }
}

// The current line, in the card under the video and on the video itself.
function renderNow() {
  const line = captions.lines[active];
  $("gloss").hidden = true;
  $("overlay").hidden = !line;
  if (!line) {
    $("now-pt").textContent = "…";
    $("now-en").textContent = "";
    return;
  }
  renderWords($("now-pt"), line);
  renderWords($("ov-pt"), line);
  $("now-en").textContent = line.en;
  $("ov-en").textContent = line.en;
}

function setActive(i, { scroll = prefs.follow } = {}) {
  if (i === active) return;
  const items = $("transcript").children;
  items[active]?.classList.remove("active");
  active = i;
  items[active]?.classList.add("active");
  renderNow();
  if (scroll && items[active]) {
    const box = $("transcript");
    const el = items[active];
    box.scrollTo({ top: el.offsetTop - box.offsetTop - box.clientHeight / 3, behavior: "smooth" });
  }
}

function tick() {
  if (!player || !captions) return;
  const t = player.currentTime();
  // Pause after each line: stop once the line being heard has finished, then wait for the learner.
  if (prefs.pauseEach && player.state === 1 && active >= 0 && active !== pausedAfter) {
    const line = captions.lines[active];
    if (t >= line.end - 0.05) {
      pausedAfter = active;
      player.pause();
      return;
    }
  }
  const i = lineAt(t);
  if (i !== active) setActive(i);
}

function goToLine(i, { play = true } = {}) {
  if (!captions.lines[i]) return;
  pausedAfter = -1;
  player.seek(Math.max(0, captions.lines[i].start - 0.15));
  setActive(i, { scroll: true });
  if (play) player.play();
}

async function lookUp(word, line) {
  const box = $("gloss");
  box.hidden = false;
  box.textContent = "";
  const head = document.createElement("strong");
  head.textContent = word;
  box.append(head);
  if (!settings.geminiApiKey) {
    box.append(" · add a Gemini API key in Settings to look words up.");
    return;
  }
  const key = `${word.toLowerCase()}|${line}`;
  const span = document.createElement("span");
  span.textContent = " · looking it up…";
  box.append(span);
  try {
    if (!glossCache.has(key)) glossCache.set(key, explainWord({ apiKey: settings.geminiApiKey, model: settings.geminiModel, word, line }));
    const g = await glossCache.get(key);
    if (head.isConnected) {
      span.textContent = ` · ${g.base !== word ? `${g.base}: ` : ""}${g.meaning}`;
      if (g.note) {
        const note = document.createElement("div");
        note.className = "hint";
        note.style.margin = "2px 0 0";
        note.textContent = g.note;
        box.append(note);
      }
    }
  } catch (e) {
    glossCache.delete(key);
    span.textContent = ` · couldn't look it up (${e.message})`;
  }
}

function renderTranscript() {
  const ol = $("transcript");
  ol.textContent = "";
  captions.lines.forEach((l, i) => {
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = fmtTime(l.start);
    const pt = document.createElement("span");
    pt.className = "pt";
    pt.textContent = l.pt;
    const en = document.createElement("span");
    en.className = "en";
    en.textContent = l.en;
    li.append(time, pt, en);
    li.addEventListener("click", () => goToLine(i));
    ol.append(li);
  });
  active = -1;
}

function applyPrefs() {
  document.body.classList.toggle("hide-en", !prefs.showEn);
  $("show-en").checked = prefs.showEn;
  $("pause-each").checked = prefs.pauseEach;
  $("follow").checked = prefs.follow;
  $("on-video").checked = prefs.overlay;
  document.body.classList.toggle("captions-on-video", prefs.overlay);
  // Word lookups show where the captions are, so they're visible in fullscreen too.
  if (prefs.overlay) $("overlay").prepend($("gloss"));
  else $("now-en").after($("gloss"));
  $("speed").textContent = `Speed ${prefs.rate}×`;
}

// Fullscreen for the video and the captions on it together. (YouTube's own button would leave the captions
// behind, so it's hidden.) iPhones only allow fullscreen for a bare video, so there the button is hidden.
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFullscreen() {
  const box = document.querySelector(".player");
  if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (box.requestFullscreen || box.webkitRequestFullscreen).call(box);
}

async function openVideo(id) {
  $("page-loading").hidden = true;
  $("library-view").hidden = true;
  $("watch-view").hidden = false;
  const entry = videos.videos.find((v) => v.id === id);
  $("video-title").textContent = entry?.title || "Loading…";
  $("open-youtube").href = `https://www.youtube.com/watch?v=${id}`;

  captions = await readRepoFile(videoPath(id));
  if (!captions) {
    $("video-title").textContent = entry?.title || id;
    showError("player-error", entry
      ? "Couldn't load this video's captions. Check your connection, or rewrite them below."
      : "This video isn't in your list. Go back and add it.");
    $("redo-captions").hidden = !entry;
    return;
  }
  $("video-title").textContent = entry?.title || captions.title || id;
  const meta = () => {
    const e = videos.videos.find((v) => v.id === id) || {};
    $("video-meta").textContent = [e.channel || captions.channel, e.duration ? fmtTime(e.duration) : "", `${captions.lines.length} caption lines by ${captions.generatedBy}`]
      .filter(Boolean)
      .join(" · ");
  };
  meta();
  renderTranscript();
  renderNow();

  let saving = false;
  player = new YouTubePlayer($("player"), id, {
    onInfo: (info) => {
      // Fill in what the index doesn't know yet (oEmbed can be unavailable on the phone).
      const e = videos.videos.find((v) => v.id === id);
      if (!e || saving) return;
      const patch = {};
      if (!e.duration && info.duration > 0) patch.duration = Math.round(info.duration);
      if (!e.title && info.videoData?.title) patch.title = info.videoData.title;
      if (!e.channel && info.videoData?.author) patch.channel = info.videoData.author;
      if (!Object.keys(patch).length) return;
      saving = true;
      Object.assign(e, patch); // so this doesn't fire again while saving
      updateEntry(id, patch, `Video details: ${patch.title || e.title || id}`)
        .then(() => {
          if (patch.title) $("video-title").textContent = patch.title;
          meta();
        })
        .finally(() => (saving = false));
    },
    onError: (code) => {
      const msg = code === 101 || code === 150 || code === 152
        ? "The owner doesn't allow this video to be played outside YouTube."
        : code === 100 ? "This video was removed or made private." : `The player reported error ${code}.`;
      showError("player-error", msg);
    },
  });
  // Apply the saved speed once the player is ready.
  const applyRate = setInterval(() => {
    if (!player.connected) return;
    clearInterval(applyRate);
    if (prefs.rate !== 1) player.setRate(prefs.rate);
  }, 300);
  setInterval(tick, 100);
  setTimeout(() => {
    if (!player.connected) showError("player-error", "Captions can't follow the video: the player isn't responding. Tapping lines won't work either. Try reloading the page.");
  }, 15000);
}

async function redoCaptions() {
  const id = new URLSearchParams(location.search).get("v");
  if (!settings.geminiApiKey) return showError("redo-error", "Add a Gemini API key in Settings first.");
  if (!confirm("Ask Gemini to write this video's captions again? The current ones are replaced.")) return;
  showError("redo-error", "");
  $("redo-captions").disabled = true;
  $("redo-status").textContent = "Gemini is watching the video and writing new captions. This usually takes a minute or two…";
  try {
    const entry = videos.videos.find((v) => v.id === id);
    const file = await writeCaptions(id, { title: entry?.title || captions?.title, channel: entry?.channel || captions?.channel });
    await updateEntry(id, { lines: file.lines.length }, `New captions for ${file.title || id}`);
    location.reload();
  } catch (e) {
    showError("redo-error", `Couldn't rewrite them: ${e.message}`);
    $("redo-status").textContent = "";
  } finally {
    $("redo-captions").disabled = false;
  }
}

function wire() {
  $("back-home").addEventListener("click", () => (location.href = homeUrl()));
  $("to-library").addEventListener("click", () => (location.search = ""));
  $("add-video").addEventListener("click", addVideo);
  $("video-url").addEventListener("keydown", (e) => e.key === "Enter" && addVideo());
  $("redo-captions").addEventListener("click", redoCaptions);

  $("replay-line").addEventListener("click", () => goToLine(Math.max(0, active)));
  $("prev-line").addEventListener("click", () => goToLine(Math.max(0, active - 1)));
  $("next-line").addEventListener("click", () => goToLine(Math.min(captions.lines.length - 1, active + 1)));
  $("speed").addEventListener("click", () => {
    prefs.rate = prefs.rate === 1 ? 0.75 : prefs.rate === 0.75 ? 0.5 : 1;
    player?.setRate(prefs.rate);
    applyPrefs();
    savePrefs();
  });
  const box = document.querySelector(".player");
  $("fullscreen").hidden = !(box.requestFullscreen || box.webkitRequestFullscreen);
  $("fullscreen").addEventListener("click", toggleFullscreen);
  for (const [id, key] of [["show-en", "showEn"], ["pause-each", "pauseEach"], ["follow", "follow"], ["on-video", "overlay"]]) {
    $(id).addEventListener("change", () => {
      prefs[key] = $(id).checked;
      if (key === "pauseEach") pausedAfter = active; // don't stop straight away at the current line
      applyPrefs();
      savePrefs();
    });
  }
  document.addEventListener("keydown", (e) => {
    if ($("watch-view").hidden || !captions || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.key === "r" || e.key === "R") goToLine(Math.max(0, active));
    else if (e.key === "ArrowLeft") goToLine(Math.max(0, active - 1));
    else if (e.key === "ArrowRight") goToLine(Math.min(captions.lines.length - 1, active + 1));
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else if (e.key === "e" || e.key === "E") {
      prefs.showEn = !prefs.showEn;
      applyPrefs();
      savePrefs();
    } else return;
    e.preventDefault();
  });
}

async function init() {
  wire();
  const st = await browser.storage.local.get(PREF_KEY);
  prefs = { ...prefs, ...(st[PREF_KEY] || {}) };
  applyPrefs();
  await loadDocs();
  // Refresh the list from GitHub first (it may have been added to on another device).
  try {
    if (await syncDown(["videos", "settings"])) await loadDocs();
  } catch {}
  renderSyncStatus();
  const id = new URLSearchParams(location.search).get("v");
  if (id) await openVideo(id);
  else renderLibrary();
}

init();
