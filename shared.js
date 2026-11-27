// Shared between the background script and extension pages.

// Synced to the data repo (settings.json), so every device behaves the same.
const SYNCED_DEFAULTS = {
  bookUrl: "https://wisc.pb.unizin.org/portuguese/",
  questionCount: 10,
  passPercent: 80,
  advancePercent: 80,
  skipPronunciation: false,
  sounds: true,
  geminiModel: "gemini-3.5-flash-lite",
  videoModel: "gemini-3.5-flash", // writes video captions: needs to be stronger than the daily model
  allowlist: [
    "wisc.pb.unizin.org",
    "gemini.google.com",
    "aistudio.google.com",
    "accounts.google.com",
    "accounts.youtube.com",
    "github.com",
    "translate.google.com",
    "www.wordreference.com",
    "www.conjuga-me.net",
    "dicionario.priberam.org",
  ],
};

// Secrets stay on each device and are never synced.
const LOCAL_DEFAULTS = {
  geminiApiKey: "",
  githubToken: "",
  githubRepo: "",
};

// Hard floors so the settings page can't be used to make the quiz trivial.
const MIN_QUESTIONS = 5;
const MIN_PASS_PERCENT = 60;

const EMERGENCY_MINUTES = 10;
const EMERGENCY_PHRASE = "Eu prometo que vou estudar português hoje.";

// The study day rolls over at 4am local time, so a late-night session still counts for the day before.
const DAY_START_HOUR = 4;

// Calendar date as YYYY-MM-DD (no day-start shift).
function dateKey(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The current study day, which starts at DAY_START_HOUR.
function studyDate() {
  const d = new Date();
  d.setHours(d.getHours() - DAY_START_HOUR);
  return d;
}

function todayKey() {
  return dateKey(studyDate());
}

function yesterdayKey() {
  const d = studyDate();
  d.setDate(d.getDate() - 1);
  return dateKey(d);
}

function clampSettings(s) {
  s.questionCount = Math.max(MIN_QUESTIONS, Number(s.questionCount) || SYNCED_DEFAULTS.questionCount);
  s.passPercent = Math.min(100, Math.max(MIN_PASS_PERCENT, Number(s.passPercent) || SYNCED_DEFAULTS.passPercent));
  s.advancePercent = Math.min(100, Math.max(s.passPercent, Number(s.advancePercent) || SYNCED_DEFAULTS.advancePercent));
  return s;
}

async function getSettings() {
  const keys = Object.keys(LOCAL_DEFAULTS);
  const st = await browser.storage.local.get(["doc:settings", ...keys]);
  const s = { ...SYNCED_DEFAULTS, ...(st["doc:settings"] || {}), ...LOCAL_DEFAULTS };
  for (const k of keys) if (st[k] != null) s[k] = st[k];
  return clampSettings(s);
}

// The day is done (Firefox unlocks) once all three daily quizzes are finished: the lesson quiz passed,
// and the review and vocab quizzes completed. Data written before that change only has lastPassDate.
function completeDate(progress) {
  if (!progress) return null;
  return progress.lastCompleteDate !== undefined ? progress.lastCompleteDate : progress.lastPassDate || null;
}

const dayDone = (progress) => completeDate(progress) === todayKey();

// ---------- Streak ----------
// One missed day per week doesn't break the streak: a missed day is forgiven if no other missed day was
// forgiven in the 6 days before it. Two missed days in a row always break it. Forgiven days are kept in
// progress.forgivenMisses (date keys) and don't add to the streak count.
const MISS_WINDOW_DAYS = 7;

function addDaysToKey(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}

function canForgiveMiss(progress, missKey) {
  const since = addDaysToKey(missKey, -(MISS_WINDOW_DAYS - 1));
  return !(progress?.forgivenMisses || []).some((k) => k >= since && k < missKey);
}

// Whether yesterday was missed but will be forgiven if today is finished.
function missForgivable(progress) {
  const yesterday = yesterdayKey();
  return completeDate(progress) === addDaysToKey(yesterday, -1) && canForgiveMiss(progress, yesterday);
}

// The streak still counts if the last finished day was today or yesterday, or the day before with a forgivable miss.
function streakAlive(progress) {
  const last = completeDate(progress);
  return last === todayKey() || last === yesterdayKey() || missForgivable(progress);
}

function hostAllowed(host, allowlist) {
  return allowlist.some((a) => host === a || host.endsWith("." + a));
}
