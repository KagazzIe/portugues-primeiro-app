const $ = (id) => document.getElementById(id);
const VIEWS = ["setup-view", "quiz-view", "result-view", "done-view"];
const MAX_OVERRIDES = 2;

const fromUrl = (() => {
  const raw = new URLSearchParams(location.search).get("from");
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
})();

let settings;
let syllabus = null;   // synced doc
let progress;          // synced doc
let review;            // synced doc
let vocab;             // synced doc
let currentLesson = 0;
let dailyLesson = null; // today's generated lesson for currentLesson
let view = null;

let quiz = null;       // { lesson, hash, source, questions: [...] }
let quizLessonIndex = null;
let quizMode = "daily"; // "daily", "practice" (counts for nothing), or "review" (only updates the review queue)
let idx = 0;
let results = [];      // { question, q, given, correct, expected }
let overridesLeft = MAX_OVERRIDES;

const lessonTextCache = new Map();

function show(v) {
  view = v;
  for (const id of VIEWS) $(id).hidden = id !== v;
}

const lesson = () => syllabus?.lessons[currentLesson];

// ---------- Copy-and-paste quiz prompt (fallback when Gemini is unavailable) ----------

function focusText() {
  const l = lesson();
  if (!l) return "";
  return `${l.sources.map((s) => s.title).join(" + ")} of the open textbook "${syllabus.title}" (${l.sources.map((s) => s.link).join(" and ")})`;
}

function quizPrompt(focus, n) {
  return `Create a Portuguese practice quiz for me ${focus ? `covering: ${focus}` : "covering the lesson we just studied"}.

Rules:
- Exactly ${n} questions, based on that lesson.
- Mix roughly 60% multiple choice and 40% short written answers (translate English to Portuguese, fill in the blank, conjugate a verb).
- Written answers must be short (one word up to one sentence) so they can be checked automatically. List every reasonable alternative in "accept" (with/without subject pronoun, masculine/feminine, etc.).
- Each multiple-choice question has exactly ONE correct option. The others must be clearly wrong, never a rewording of the correct answer or another valid way to say the same thing. Check every question for this before you reply.
- Respond with ONLY valid JSON. No markdown, no commentary. Use exactly this shape:

{"lesson":"short lesson title","questions":[
  {"type":"mc","q":"Which verb completes: Ela ___ médica.","options":["está","é","tem","fica"],"answer":1,"explain":"Professions use ser."},
  {"type":"text","q":"Translate: I am tired.","answer":"Estou cansado.","accept":["Eu estou cansado.","Estou cansada.","Eu estou cansada."],"explain":"Temporary states use estar."}
]}

For "mc", "answer" is the zero-based index of the correct option, and add "translation": a full English translation of the correct answer (the whole completed sentence when the question is a Portuguese sentence with a blank).`;
}

// ---------- Quiz parsing ----------

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function parseQuiz(text, { minQuestions = settings.questionCount } = {}) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("That doesn't look like JSON. Copy the chatbot's whole reply.");
  let data;
  try {
    data = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Couldn't read the JSON (${e.message}). Ask the chatbot to "return only valid JSON".`);
  }
  const raw = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(raw)) throw new Error('No "questions" list found.');

  const questions = [];
  raw.forEach((q, i) => {
    const n = i + 1;
    const text = q.q || q.question;
    if (!text) throw new Error(`Question ${n} has no text.`);
    if (q.type === "mc" || Array.isArray(q.options)) {
      const opts = q.options;
      if (!Array.isArray(opts) || opts.length < 2) throw new Error(`Question ${n} needs at least 2 options.`);
      let ans = q.answer;
      if (typeof ans === "string") {
        const byText = opts.findIndex((o) => String(o).trim() === ans.trim());
        ans = byText !== -1 ? byText : /^\d+$/.test(ans) ? Number(ans) : -1;
      }
      if (!Number.isInteger(ans) || ans < 0 || ans >= opts.length) throw new Error(`Question ${n} has an invalid answer index.`);
      // Drop wrong options that repeat another option apart from case, punctuation, or spacing.
      const options = [{ text: String(opts[ans]), correct: true }];
      const seen = new Set([norm(String(opts[ans]))]);
      opts.forEach((o, j) => {
        const key = norm(String(o));
        if (j === ans || seen.has(key)) return;
        seen.add(key);
        options.push({ text: String(o), correct: false });
      });
      if (options.length < 2) throw new Error(`Question ${n} has only one distinct option.`);
      questions.push({
        type: "mc",
        q: text,
        options: shuffleArray(options),
        expected: String(opts[ans]),
        translation: typeof q.translation === "string" ? q.translation.trim() : "",
        explain: q.explain || "",
        reviewOf: q.reviewOf || "",
      });
    } else {
      if (!q.answer) throw new Error(`Question ${n} has no answer.`);
      questions.push({
        type: "text",
        q: text,
        answers: [String(q.answer), ...(q.accept || []).map(String)],
        expected: String(q.answer),
        explain: q.explain || "",
        reviewOf: q.reviewOf || "",
      });
    }
  });

  if (questions.length < minQuestions) {
    throw new Error(`Only ${questions.length} questions. This quiz needs at least ${minQuestions}.`);
  }
  const hash = hashString(JSON.stringify(raw.map((q) => q.q || q.question)));
  return { lesson: data.lesson || lesson()?.title || "Lição", hash, questions: shuffleArray(questions) };
}

// ---------- Grading ----------

const norm = (s) =>
  s.normalize("NFC").toLowerCase()
    .replace(/[.,!?;:¿¡"'“”‘’«»()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const stripAccents = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

const words = (s) => stripAccents(norm(String(s))).split(/[^a-z0-9]+/).filter(Boolean);

// Questions whose answer is already written in the question text: every word of a 2+ word answer
// appears in it (accents and case ignored). Single words are skipped to avoid false alarms in
// fill-in-the-blank sentences that legitimately reuse a short word.
function findGiveaways(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const problems = [];
  (data.questions || []).forEach((q, i) => {
    let answer = q.answer;
    if (Array.isArray(q.options) && /^\d+$/.test(String(answer))) answer = q.options[Number(answer)];
    const questionWords = new Set(words(q.q || q.question || ""));
    const answerWords = words(answer || "");
    if (answerWords.length >= 2 && answerWords.every((w) => questionWords.has(w))) {
      problems.push(`Question ${i + 1} ("${q.q || q.question}"): its answer "${answer}" is already written in the question.`);
      return;
    }
    // Options like "a casa / o problema / a aula" where the correct one is the only one with its article.
    if (Array.isArray(q.options) && q.options.length >= 3) {
      const article = (o) => {
        const w = words(o);
        return w.length >= 2 && ARTICLES.has(w[0]) ? w[0] : null;
      };
      const articles = q.options.map(article);
      const mine = article(answer);
      if (mine && articles.every(Boolean) && articles.filter((a) => a === mine).length === 1) {
        problems.push(`Question ${i + 1} ("${q.q || q.question}"): the correct option "${answer}" is the only one starting with "${mine}", so the article gives the answer away. Use bare nouns without articles.`);
      }
    }
  });
  return problems;
}

const ARTICLES = new Set(["o", "a", "os", "as", "um", "uma", "uns", "umas"]);

// Vocab answers are English: compare against each listed meaning ("house / home", "to speak (formal)"),
// ignoring a leading "to", "the", "a" or "an". Anything else goes to Gemini to judge synonyms.
const plainEnglish = (s) => words(s).filter((w, i) => !(i === 0 && ["to", "the", "a", "an"].includes(w))).join(" ");

function gradeVocab(q, given) {
  const g = plainEnglish(given);
  const meanings = q.vocab.en.replace(/\([^)]*\)/g, " ").split(/[\/;,]| or /i).map(plainEnglish).filter(Boolean);
  return { correct: !!g && (meanings.includes(g) || plainEnglish(q.vocab.en) === g) };
}

// Accents don't count against an answer (the correct accents are shown instead). Letters still do.
function gradeText(q, given) {
  const g = norm(given);
  if (q.answers.some((a) => norm(a) === g)) return { correct: true };
  const accentMatch = q.answers.find((a) => stripAccents(norm(a)) === stripAccents(g));
  if (accentMatch) return { correct: true, note: `With accents it's written: ${accentMatch}` };
  return { correct: false };
}

// ---------- Quiz flow ----------

function renderQuestion() {
  const q = quiz.questions[idx];
  const total = quiz.questions.length;
  const label = { practice: "Practice (doesn't count) · ", review: "Review · ", vocab: "Vocab · " }[quizMode] || "";
  $("q-progress").textContent = `${label}Pergunta ${idx + 1} de ${total}`;
  $("q-bar").style.width = `${(idx / total) * 100}%`;
  $("q-text").textContent = q.q;
  $("feedback").hidden = true;
  $("next-btn").hidden = true;
  $("override-btn").hidden = true;
  $("skip-btn").hidden = false;

  const area = $("q-answer");
  area.replaceChildren();

  if (q.type === "mc") {
    $("check-btn").hidden = true;
    q.options.forEach((opt) => {
      const b = document.createElement("button");
      b.className = "option";
      b.textContent = opt.text;
      b.addEventListener("click", () => answerMc(q, opt));
      area.append(b);
    });
  } else {
    $("check-btn").hidden = false;
    const input = document.createElement("input");
    input.type = "text";
    input.id = "text-answer";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Escreva a sua resposta…";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("check-btn").click();
    });
    area.append(input);
    input.focus();
  }
}

function answerMc(q, chosen) {
  for (const b of $("q-answer").querySelectorAll("button")) {
    const opt = q.options.find((o) => o.text === b.textContent);
    b.disabled = true;
    if (opt.correct) b.classList.add("correct");
    else if (opt === chosen) b.classList.add("wrong");
  }
  record(q, chosen.text, chosen.correct);
}

async function answerText() {
  const q = quiz.questions[idx];
  const input = $("text-answer");
  const given = input.value.trim();
  if (!given) return input.focus();
  input.disabled = true;
  $("check-btn").hidden = true;
  $("skip-btn").hidden = true;

  const local = q.vocab ? gradeVocab(q, given) : gradeText(q, given);
  if (local.correct || !settings.geminiApiKey) {
    record(q, given, local.correct, local.note);
    if (!local.correct && !settings.geminiApiKey && overridesLeft > 0) $("override-btn").hidden = false;
    return;
  }

  // Not in the answer key. Ask Gemini whether it's still valid Portuguese for this question.
  const fb = $("feedback");
  fb.className = "feedback";
  fb.textContent = "Not in the answer key. Checking with Gemini…";
  fb.hidden = false;
  try {
    const verdict = q.vocab
      ? await judgeVocab({ apiKey: settings.geminiApiKey, model: settings.geminiModel, pt: q.vocab.pt, en: q.vocab.en, given })
      : await judgeAnswer({
          apiKey: settings.geminiApiKey,
          model: settings.geminiModel,
          question: q.q,
          expected: q.expected,
          accept: q.answers.slice(1),
          given,
        });
    record(q, given, verdict.correct, verdict.feedback);
  } catch {
    record(q, given, false, "(Couldn't reach Gemini to double-check.)");
    if (overridesLeft > 0) $("override-btn").hidden = false;
  }
}

// Shows the answer and counts the question as wrong (it joins the review queue like any miss).
function skip() {
  const q = quiz.questions[idx];
  if (q.type === "mc") {
    for (const b of $("q-answer").querySelectorAll("button")) {
      b.disabled = true;
      if (q.options.find((o) => o.text === b.textContent)?.correct) b.classList.add("correct");
    }
  } else {
    $("text-answer").disabled = true;
    $("check-btn").hidden = true;
  }
  record(q, "", false, null, { skipped: true });
}

// Short synthesized chimes: two rising notes when right, a low falling tone when wrong.
let audioCtx;
function playSound(correct) {
  if (!settings.sounds) return;
  try {
    audioCtx ||= new AudioContext();
    const t0 = audioCtx.currentTime;
    const notes = correct ? [[659, 0], [988, 0.09]] : [[311, 0], [233, 0.12]];
    for (const [freq, delay] of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = correct ? "sine" : "triangle";
      osc.frequency.value = freq;
      const start = t0 + delay;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + (correct ? 0.25 : 0.3));
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    }
  } catch {}
}

function record(q, given, correct, note, { skipped = false } = {}) {
  results[idx] = { question: q, q: q.q, given, correct, expected: q.expected, skipped };
  if (!skipped) playSound(correct);
  $("skip-btn").hidden = true;
  const fb = $("feedback");
  fb.className = `feedback ${correct ? "good" : "bad"}`;
  fb.replaceChildren();
  const add = (text, bold) => {
    const p = document.createElement("p");
    if (bold) p.style.fontWeight = "600";
    p.textContent = text;
    fb.append(p);
  };
  add(correct ? "Correto! 🎉" : skipped ? `Resposta: ${q.expected}` : `Não exatamente. Resposta: ${q.expected}`, true);
  if (note) add(note);
  if (q.translation) add(`Translation: ${q.translation}`);
  if (q.explain) add(q.explain);
  fb.hidden = false;
  $("next-btn").hidden = false;
  $("next-btn").textContent = idx === quiz.questions.length - 1 ? "See results" : "Next →";
  $("next-btn").focus();
}

function override() {
  overridesLeft--;
  results[idx].correct = true;
  $("override-btn").hidden = true;
  const fb = $("feedback");
  fb.className = "feedback good";
  fb.firstChild.textContent = `Counted as correct (${overridesLeft} override${overridesLeft === 1 ? "" : "s"} left).`;
}

function next() {
  idx++;
  if (idx < quiz.questions.length) renderQuestion();
  else finish();
}

const kindOf = (q) => (!q.reviewOf ? "new" : q.reviewOf === "earlier" ? "earlier" : "review");

function renderMisses(intro) {
  const reviewEl = $("review");
  reviewEl.replaceChildren();
  const misses = results.filter((r) => !r.correct);
  if (misses.length) reviewEl.append(el("p", intro));
  for (const r of misses) {
    const div = el("div", null, "review-item");
    div.append(el("div", r.q, "q"), el("div", r.skipped ? "You: skipped" : `You: ${r.given}`, "yours"), el("div", `Correct: ${r.expected}${r.question.translation ? ` (${r.question.translation})` : ""}`, "right"));
    reviewEl.append(div);
  }
}

// Shows the score and hides every results button; returns the counts.
function startResults() {
  const total = results.length;
  const right = results.filter((r) => r.correct).length;
  const pct = Math.round((right / total) * 100);
  $("result-title").textContent = "Saving…";
  $("result-score").textContent = `${right}/${total} (${pct}%)`;
  $("result-score").style.color = pct >= settings.passPercent ? "var(--green)" : "var(--red)";
  $("review").replaceChildren();
  $("next-lesson").hidden = true;
  for (const id of ["retry-btn", "continue-btn", "to-practice", "practice-again", "practice-done"]) $(id).hidden = true;
  $("q-bar").style.width = "100%";
  show("result-view");
  return { total, right, pct };
}

// A practice quiz only shows the score and what was missed; nothing is saved.
function finishPractice() {
  startResults();
  $("result-title").textContent = "Practice done. This one doesn't count.";
  renderMisses("What you missed:");
  $("practice-done").textContent = "Done";
  offerAgain("Another practice quiz", startPractice);
  $("practice-done").hidden = false;
}

// The results screen's "again" button: back to the done screen, then start another of the same quiz.
let againAction = null;
function offerAgain(label, start) {
  $("practice-again").textContent = label;
  $("practice-again").hidden = false;
  againAction = () => {
    backToDone();
    start();
  };
}

const startMoreVocab = () => startVocab(["vocab-more-btn", "vocab-more-status", "vocab-more-error"]);

// The review quiz updates the review queue (items answered right move further out, misses come back
// tomorrow, new misses on earlier-lesson questions join it), notes which lessons were checked, and
// counts as done whatever the score.
async function finishReview() {
  const { total, right } = startResults();
  const today = todayKey();
  const message = `Review quiz ${today}: ${right}/${total}`;
  review = await mutate("review", (r) => applyReviews(r, results, null, `${today}-review-${quiz.hash}`), message);
  const checked = Object.fromEntries((quiz.reviewLessons || []).map((slug) => [slug, today]));
  progress = await mutate(
    "progress",
    (p) => ({ ...withTaskDone(p, "review"), lessonChecked: { ...(p.lessonChecked || {}), ...checked } }),
    message
  );
  renderStreak();
  renderSyncStatus();
  renderMisses("What you missed. These come back tomorrow:");
  renderAfterTask("Review quiz done!");
}

// The vocab quiz updates each word's schedule in vocab.json and counts as done whatever the score.
async function finishVocab() {
  const extraRound = dayDone(progress); // an extra quiz from the "More vocab" card
  const { total, right } = startResults();
  const message = `Vocab quiz ${todayKey()}: ${right}/${total}`;
  vocab = await mutate("vocab", (v) => applyVocab(v, results), message);
  if (!extraRound) progress = await mutate("progress", (p) => withTaskDone(p, "vocab"), message);
  renderStreak();
  renderSyncStatus();
  renderMisses("Words you missed. These come back tomorrow:");
  if (extraRound) {
    $("result-title").textContent = "Vocab quiz done! Those words' schedules are updated.";
    $("practice-done").textContent = "Done";
    $("practice-done").hidden = false;
  } else {
    renderAfterTask("Vocab quiz done!");
  }
  if (dayDone(progress)) offerAgain("Another vocab quiz", startMoreVocab);
}

async function finish() {
  if (quizMode === "practice") return finishPractice();
  if (quizMode === "review") return finishReview();
  if (quizMode === "vocab") return finishVocab();
  const total = results.length;
  const right = results.filter((r) => r.correct).length;
  const pct = Math.round((right / total) * 100);
  const passed = pct >= settings.passPercent;
  const today = todayKey();
  const lessonIndex = quizLessonIndex;
  // Only the day's first lesson quiz on this lesson can move you on; retries still pass the day's task.
  const isFirstAttempt = (p) => !(p.history || []).some((h) => h.date === today && h.lessonIndex === lessonIndex);
  const firstToday = isFirstAttempt(progress);
  const earnedAdvance = passed && firstToday && pct >= settings.advancePercent;
  const lastIndex = syllabus ? syllabus.lessons.length - 1 : 0;
  $("result-title").textContent = "Saving…";
  $("result-score").textContent = `${right}/${total} (${pct}%)`;
  $("result-score").style.color = passed ? "var(--green)" : "var(--red)";
  $("review").replaceChildren();
  $("next-lesson").hidden = true;
  $("retry-btn").hidden = $("continue-btn").hidden = $("to-practice").hidden = true;
  $("practice-again").hidden = $("practice-done").hidden = true;
  show("result-view");

  const entry = {
    date: today,
    lessonIndex,
    lesson: quiz.lesson,
    right,
    total,
    passed,
    firstToday,
    missed: [...new Set(results.filter((r) => !r.correct).map((r) => r.question.explain || r.q))].slice(0, 6),
  };
  const message = `Quiz ${today}: ${quiz.lesson} ${right}/${total}`;
  progress = await mutate("progress", (p) => {
    let nextP = {
      ...p,
      history: [entry, ...(p.history || [])].slice(0, 365),
      usedQuizHashes: [quiz.hash, ...(p.usedQuizHashes || []).filter((h) => h !== quiz.hash)].slice(0, 200),
      recentQuestions: [...quiz.questions.map((q) => q.q), ...(p.recentQuestions || [])].slice(0, 40),
    };
    if (passed) {
      nextP = withTaskDone(nextP, "lesson");
      const nextIndex = syllabus ? nextLessonIndex(syllabus, lessonIndex) : -1;
      // Rechecked against the latest synced history, in case a quiz was taken on another device meanwhile.
      const advance = pct >= settings.advancePercent && isFirstAttempt(p);
      if (advance && p.currentLesson === lessonIndex && nextIndex !== -1) nextP.currentLesson = nextIndex;
    }
    return nextP;
  }, message);
  review = await mutate("review", (r) => applyReviews(r, results, lessonIndex, `${today}-${quiz.hash}`), `Review queue after ${message}`);
  await saveResult({
    date: today,
    time: new Date().toISOString(),
    lessonIndex,
    lesson: quiz.lesson,
    sources: syllabus?.lessons[lessonIndex]?.sources.map((s) => s.link) || [],
    quizSource: quiz.source,
    model: quiz.source === "gemini" ? settings.geminiModel : null,
    right,
    total,
    percent: pct,
    passed,
    questions: results.map((r) => ({
      kind: kindOf(r.question),
      type: r.question.type,
      q: r.q,
      given: r.given,
      skipped: r.skipped,
      correct: r.correct,
      expected: r.expected,
      explain: r.question.explain,
    })),
  });
  currentLesson = Math.min(progress.currentLesson || 0, lastIndex);
  renderStreak();
  renderSyncStatus();

  renderMisses("What you missed. These go into your review queue:");
  if (passed) {
    renderAfterTask("Lesson quiz passed!");
    if (syllabus) renderNextLesson(lessonIndex, earnedAdvance, firstToday);
  } else {
    $("result-title").textContent = `Quase! You need ${settings.passPercent}% to pass the lesson quiz.`;
    $("retry-btn").hidden = false;
  }
  $("q-bar").style.width = "100%";
}

const TASK_NAMES = { lesson: "the lesson quiz", review: "the review quiz", vocab: "the vocab quiz" };

// After a daily task: if the whole day is done, say Firefox is unlocked; otherwise list what's left
// and offer a way back to today's quizzes.
function renderAfterTask(doneText) {
  const left = Object.keys(DAILY_TASKS).filter((t) => !taskDone(progress, t)).map((t) => TASK_NAMES[t]);
  if (dayDone(progress)) {
    $("result-title").textContent = window.IS_WEB_APP
      ? `${doneText} Parabéns! The day is done: your streak is safe and Firefox on your computer will unlock.`
      : `${doneText} Parabéns! Firefox is unlocked for today.`;
    $("continue-btn").hidden = false;
    if (!fromUrl) $("continue-btn").textContent = "Close";
    $("to-practice").hidden = !syllabus || !settings.geminiApiKey;
  } else {
    const list = left.length > 1 ? `${left.slice(0, -1).join(", ")} and ${left.at(-1)}` : left[0];
    $("result-title").textContent = `${doneText} To ${window.IS_WEB_APP ? "complete the day" : "unlock Firefox"}, finish ${list}.`;
    $("practice-done").textContent = "Back to today's quizzes";
    $("practice-done").hidden = false;
  }
}

function renderNextLesson(lessonIndex, earnedAdvance, firstToday) {
  const box = $("next-lesson");
  box.replaceChildren();
  box.hidden = false;
  const nextIndex = nextLessonIndex(syllabus, lessonIndex);
  const title = (i) => syllabus.lessons[i].title;
  const button = (label, target, after) => {
    const b = el("button", label, "link");
    b.style.padding = "0";
    b.addEventListener("click", async () => {
      progress = await mutate("progress", (p) => ({ ...p, currentLesson: target }), `Set lesson to ${title(target)}`);
      currentLesson = target;
      box.textContent = after;
    });
    return b;
  };

  if (nextIndex === -1) {
    box.textContent = "That was the last lesson in the book. Parabéns! Pick any lesson to keep reviewing.";
  } else if (progress.currentLesson === nextIndex) {
    box.append(`Tomorrow: ${title(nextIndex)}. `, button("Stay on this lesson instead", lessonIndex, `Tomorrow: ${title(lessonIndex)} again.`));
  } else if (!earnedAdvance) {
    const why = firstToday
      ? `Moving on takes ${settings.advancePercent}% on your first lesson quiz of the day`
      : "Only your first lesson quiz of the day counts toward moving on";
    box.append(
      `${why}, so tomorrow is ${title(lessonIndex)} again, focused on what you missed. `,
      button("Move on anyway", nextIndex, `Tomorrow: ${title(nextIndex)}.`)
    );
  } else {
    box.hidden = true;
  }
}

// Returns an error message, or null once the quiz has started.
// Starts an already-built quiz. extra: fields to keep on the quiz (e.g. which lessons a review covered).
function startPreparedQuiz(prepared, { mode, lessonIndex, extra = {} }) {
  quizMode = mode;
  quiz = { ...prepared, ...extra };
  quizLessonIndex = syllabus ? lessonIndex : null;
  idx = 0;
  results = [];
  overridesLeft = MAX_OVERRIDES;
  show("quiz-view");
  renderQuestion();
}

async function beginQuiz(text, source, { mode = "daily", lessonIndex = currentLesson, minQuestions, extra } = {}) {
  let parsed;
  try {
    parsed = parseQuiz(text, minQuestions ? { minQuestions } : undefined);
  } catch (e) {
    return e.message;
  }
  if (mode === "daily") {
    // Burned locally on start (failing shows the answers); synced to progress when the quiz finishes.
    const { burnedHashes = [] } = await browser.storage.local.get("burnedHashes");
    if (burnedHashes.includes(parsed.hash) || (progress.usedQuizHashes || []).includes(parsed.hash)) {
      return "You've already used this quiz. Get a fresh one.";
    }
    await browser.storage.local.set({ burnedHashes: [parsed.hash, ...burnedHashes].slice(0, 50) });
  }
  startPreparedQuiz({ ...parsed, source }, { mode, lessonIndex, extra });
  return null;
}

async function startPastedQuiz() {
  const err = $("parse-error");
  err.hidden = true;
  const msg = await beginQuiz($("quiz-json").value, "pasted");
  if (msg) {
    err.textContent = msg;
    err.hidden = false;
  } else {
    $("quiz-json").value = "";
  }
}

async function getLessonText(i) {
  const l = syllabus.lessons[i];
  const key = l.sources.map((s) => s.id).join(",");
  if (!lessonTextCache.has(key)) lessonTextCache.set(key, await fetchLessonText(syllabus, l));
  return lessonTextCache.get(key);
}

// Writes a quiz for one lesson and starts it. ids: the button, status, and error elements to update.
// Lessons before the current one that can be reviewed, with whatever digests already exist (none are built here).
// Lessons checked longest ago (or never) come first; ties are random.
async function earlierWithDigests(beforeIndex, limit) {
  const checked = progress.lessonChecked || {};
  const picks = shuffleArray(earlierLessonIndexes(syllabus, beforeIndex))
    .map((j) => syllabus.lessons[j])
    .sort((a, b) => (checked[lessonSlug(a)] || "").localeCompare(checked[lessonSlug(b)] || ""))
    .slice(0, limit);
  return Promise.all(picks.map(async (l) => ({ lesson: l, digest: await readRepoFile(digestPath(l)).catch(() => null) })));
}

// Vocabulary from lessons already done (before the current one, not skipped), taken from their digests.
async function vocabPool() {
  if (!syllabus) return [];
  const lessons = earlierLessonIndexes(syllabus, currentLesson).map((j) => syllabus.lessons[j]);
  const digests = await Promise.all(lessons.map((l) => readRepoFile(digestPath(l)).catch(() => null)));
  const pool = [];
  const seen = new Set();
  lessons.forEach((l, i) => {
    for (const v of digests[i]?.vocabulary || []) {
      const key = vocabKey(lessonSlug(l), v.pt);
      if (!v.pt || !v.en || seen.has(key)) continue;
      seen.add(key);
      pool.push({ key, pt: v.pt, en: v.en, lesson: l.title });
    }
  });
  return pool;
}

// The vocab quiz is built locally from the pool: no AI needed to write it.
// ids: the button, status, and error elements to update (the daily task's, or the "More vocab" card's).
async function startVocab(ids = ["vocab-btn", "vocab-status", "vocab-error"]) {
  const [btn, status, err] = ids.map($);
  err.hidden = true;
  btn.disabled = true;
  status.textContent = "Picking words…";
  try {
    const picks = pickVocab(await vocabPool(), vocab, settings.questionCount);
    if (!picks.length) throw new Error("There's no vocabulary from completed lessons yet.");
    const questions = picks.map((w) => ({
      type: "text",
      q: `What does "${w.pt}" mean in English?`,
      answers: [w.en],
      expected: w.en,
      explain: `From ${w.lesson}.`,
      reviewOf: "",
      vocab: w,
    }));
    startPreparedQuiz({ lesson: "Vocab", hash: "", questions, source: "vocab" }, { mode: "vocab", lessonIndex: null });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    status.textContent = "";
  }
}

// Writes a quiz and starts it.
//   mode "daily":    today's lesson; counts.
//   mode "practice": any lesson; counts for nothing.
//   mode "review":   due review items + earlier lessons; only updates the review queue.
// ids: the button, status, and error elements to update.
async function generateWithGemini({ mode = "daily", lessonIndex = currentLesson, ids = ["generate-quiz", "gemini-status", "gemini-error"] } = {}) {
  const [btn, status, err] = ids.map($);
  err.hidden = true;
  btn.disabled = true;
  try {
    if (!syllabus) throw new Error("The lessons haven't loaded yet.");
    const common = { apiKey: settings.geminiApiKey, model: settings.geminiModel, syllabus, skipPronunciation: settings.skipPronunciation };
    let text, digest, minQuestions;
    const extra = {};

    if (mode === "review") {
      status.textContent = "Gathering your review items…";
      const due = dueMistakes(review, settings.questionCount);
      const earlier = await earlierWithDigests(currentLesson, 3);
      if (!due.length && !earlier.length) throw new Error("Nothing to review yet.");
      // The checker compares hints against vocabulary, so give it the reviewed lessons' combined list.
      digest = { vocabulary: earlier.flatMap((e) => e.digest?.vocabulary || []) };
      status.textContent = "Writing a review quiz…";
      const result = await generateReviewQuiz({ ...common, due, earlier, progress, n: settings.questionCount });
      text = result.text;
      minQuestions = result.count;
      extra.reviewLessons = earlier.map((e) => lessonSlug(e.lesson));
    } else {
      status.textContent = "Getting the lesson…";
      digest = await ensureDigest(lessonIndex);
      if (!digest) throw new Error("This lesson has no digest yet.");
      status.textContent = mode === "practice" ? "Writing a practice quiz…" : "Writing today's quiz…";
      text = await generateLessonQuiz({
        ...common,
        lessonIndex,
        digest,
        dailyLesson: dailyLesson?.lessonIndex === lessonIndex ? dailyLesson : null,
        progress,
        n: settings.questionCount,
      });
      minQuestions = settings.questionCount;
    }

    // Second pass: catch duplicate answers, wrong keys, and incomplete hints. Keep the original if it fails.
    status.textContent = "Double-checking the questions…";
    try {
      const reviewed = await reviewQuiz({ ...common, digest, quizText: text });
      parseQuiz(reviewed, { minQuestions });
      text = reviewed;
    } catch {}
    // Our own check for answers already written in the question; ask for those to be rewritten once.
    const problems = findGiveaways(text);
    if (problems.length) {
      status.textContent = `Rewriting ${plural(problems.length, "question")} that gave away the answer…`;
      try {
        const fixed = await reviewQuiz({ ...common, digest, quizText: text, problems });
        parseQuiz(fixed, { minQuestions });
        text = fixed;
      } catch {}
    }
    const msg = await beginQuiz(text, "gemini", { mode, lessonIndex: mode === "review" ? null : lessonIndex, minQuestions, extra });
    if (msg) throw new Error(`Gemini's quiz didn't work: ${msg} Try generating again.`);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    status.textContent = "";
  }
}

// ---------- Lessons ----------

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

// Paragraphs separated by blank lines, with **bold** for key forms.
function richText(text) {
  return text.split(/\n\s*\n/).filter((p) => p.trim()).map((para) => {
    const p = el("p");
    para.split(/\*\*(.+?)\*\*/g).forEach((part, i) => p.append(i % 2 ? el("strong", part) : part));
    return p;
  });
}

// Loads the lesson list from the textbook site the first time (or when the book URL changes).
async function ensureSyllabus() {
  if (syllabus && syllabus.bookUrl === settings.bookUrl) return;
  try {
    const fresh = await fetchBookSyllabus(settings.bookUrl);
    syllabus = await mutate(
      "syllabus",
      (cur) => (cur && cur.bookUrl === fresh.bookUrl ? cur : fresh),
      `Load lessons from ${fresh.title}`
    );
    currentLesson = Math.min(progress.currentLesson || 0, syllabus.lessons.length - 1);
    $("lesson-error").hidden = true;
  } catch (e) {
    $("lesson-error").textContent = `Couldn't load the textbook's lessons: ${e.message}`;
    $("lesson-error").hidden = false;
  }
}

function setDailyStatus(text) {
  $("daily-status").textContent = text || "";
  $("daily-status").hidden = !text;
}

// Digests are normally committed ahead of time (data/digests/). If one is missing, build it with Gemini once.
async function ensureDigest(i, onStatus = setDailyStatus) {
  const l = syllabus.lessons[i];
  const path = digestPath(l);
  const existing = await readRepoFile(path);
  if (existing || !settings.geminiApiKey) return existing;
  onStatus("Preparing a digest of this lesson from the textbook (first time only)…");
  const digest = await generateDigest({
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel,
    syllabus,
    lesson: l,
    lessonText: await getLessonText(i),
  });
  await writeRepoFile(path, digest, `Add digest for ${l.title} (${settings.geminiModel})`);
  return digest;
}

// Today's lesson is written once per day and lesson, then saved so every device shows the same one.
let dailyRequest = 0;
async function ensureDailyLesson({ rewrite = false } = {}) {
  if (!syllabus) return;
  const i = currentLesson;
  const l = syllabus.lessons[i];
  const path = dailyLessonPath(todayKey(), l);
  const request = ++dailyRequest;
  const stale = () => request !== dailyRequest || i !== currentLesson;
  $("daily-error").hidden = true;
  try {
    let dl = rewrite ? null : await readRepoFile(path);
    if (!dl && settings.geminiApiKey) {
      const digest = await ensureDigest(i);
      if (stale()) return;
      setDailyStatus(rewrite ? "Rewriting today's lesson…" : "Writing today's lesson…");
      dl = await generateDailyLesson({
        apiKey: settings.geminiApiKey,
        model: settings.geminiModel,
        syllabus,
        lessonIndex: i,
        digest,
        progress,
        skipPronunciation: settings.skipPronunciation,
      });
      await writeRepoFile(path, dl, `Lesson for ${todayKey()}: ${l.title}`);
    }
    if (stale()) return;
    dailyLesson = dl;
    setDailyStatus(dl || settings.geminiApiKey ? "" : "Add a Gemini API key in settings and a lesson will be written for you each day.");
  } catch (e) {
    if (stale()) return;
    setDailyStatus("");
    $("daily-error").textContent = `Couldn't write today's lesson: ${e.message}`;
    $("daily-error").hidden = false;
  }
  renderDaily();
}

function renderDaily() {
  const dl = dailyLesson?.lessonIndex === currentLesson ? dailyLesson : null;
  $("daily").hidden = !dl;
  $("rewrite-lesson").hidden = !dl;
  if (!dl) return;
  $("daily-title").textContent = dl.title;
  $("daily-intro").textContent = dl.intro;
  $("daily-focus").textContent = dl.focus ? `Focus today: ${dl.focus}` : "";
  $("daily-focus").hidden = !dl.focus;

  $("daily-sections").replaceChildren(...dl.sections.map((s) => {
    const section = el("section");
    section.append(el("h4", s.heading), ...richText(s.body));
    for (const t of s.tables || []) section.append(grammarTable(t));
    if (s.examples?.length) {
      const ul = el("ul", null, "examples");
      for (const ex of s.examples) {
        const li = el("li", `${ex.pt} `);
        li.append(el("span", ex.en, "en"));
        ul.append(li);
      }
      section.append(ul);
    }
    return section;
  }));

  $("daily-vocab").replaceChildren(...(dl.vocabulary || []).map((v) => {
    const tr = el("tr");
    tr.append(el("td", v.pt), el("td", v.en));
    return tr;
  }));

  $("daily-practice").replaceChildren(...(dl.practice || []).map((p) => {
    const li = el("li", p.prompt);
    const reveal = el("details");
    reveal.append(el("summary", "Answer"), ` ${p.answer}`);
    li.append(reveal);
    return li;
  }));
  $("daily-recap").textContent = dl.recap || "";
}

function renderLesson() {
  $("lesson-loading").hidden = !!syllabus;
  $("lesson-card").hidden = !syllabus;
  if (!syllabus) return;

  const select = $("lesson-select");
  if (select.options.length !== syllabus.lessons.length) {
    select.replaceChildren(...syllabus.lessons.map((l, i) => new Option(`Lesson ${i + 1} of ${syllabus.lessons.length}: ${l.title}${l.skip ? " (skipped)" : ""}`, i)));
  }
  select.value = currentLesson;

  const l = lesson();
  const day = dayOnLesson(progress, currentLesson);
  $("lesson-meta").textContent = `${syllabus.title} · ${l.sources.map((s) => s.title).join(" + ")} · day ${day} on this lesson`;
  renderDaily();
  $("prompt-preview").textContent = quizPrompt(focusText(), settings.questionCount);
  renderPlan();
}

function renderPlan() {
  if (!syllabus) return;
  $("gemini-plan").textContent =
    `Gemini will write a ${settings.questionCount}-question quiz on what today's lesson taught. ` +
    "Earlier lessons and past mistakes are reviewed separately, after you pass.";
}

// ---------- Misc ----------

function renderStreak() {
  const last = completeDate(progress);
  const alive = last === todayKey() || last === yesterdayKey();
  const n = alive ? progress.streak || 0 : 0;
  $("streak").textContent = n ? `🔥 ${n}-day streak` : "No streak yet. Start one today!";
}

async function renderSyncStatus() {
  const st = await browser.storage.local.get(["githubRepo", "sync:error"]);
  const el = $("sync-status");
  if (!st.githubRepo) {
    el.textContent = "Progress is only saved on this device. Set up GitHub sync in settings to keep it safe.";
  } else if (st["sync:error"]) {
    el.textContent = `Couldn't sync with GitHub (${st["sync:error"]}). Changes are saved here and will sync later.`;
  } else {
    el.textContent = "";
  }
  el.hidden = !el.textContent;
}

function continueBrowsing() {
  if (fromUrl) location.href = fromUrl;
  else window.close();
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = "Copied ✓";
  setTimeout(() => (btn.textContent = old), 1500);
}

async function useEmergency() {
  const msg = $("em-msg");
  const { emergencyDate } = await browser.storage.local.get("emergencyDate");
  if (emergencyDate === todayKey()) {
    msg.textContent = "You've already used today's emergency pass.";
    return;
  }
  if ($("em-input").value.trim() !== EMERGENCY_PHRASE) {
    msg.textContent = "That doesn't match. Type the phrase exactly, accents included.";
    return;
  }
  await browser.storage.local.set({
    emergencyDate: todayKey(),
    emergencyUntil: Date.now() + EMERGENCY_MINUTES * 60 * 1000,
  });
  continueBrowsing();
}

async function loadDocs() {
  settings = await getSettings();
  [progress, review, vocab, syllabus] = await Promise.all([getDoc("progress"), getDoc("review"), getDoc("vocab"), getDoc("syllabus")]);
  currentLesson = syllabus ? Math.min(progress.currentLesson || 0, syllabus.lessons.length - 1) : 0;
}

// Practice card on the "done for today" screen: any lesson that isn't skipped, defaulting to the last one quizzed.
function renderPractice() {
  const card = $("practice-card");
  card.hidden = !syllabus || !settings.geminiApiKey;
  if (card.hidden) return;
  const select = $("practice-lesson");
  const choices = syllabus.lessons.map((l, i) => [l, i]).filter(([, i]) => !isSkipped(syllabus, i));
  if (select.options.length !== choices.length) {
    select.replaceChildren(...choices.map(([l, i]) => new Option(`Lesson ${i + 1}: ${l.title}`, i)));
    const last = progress.history?.[0]?.lessonIndex;
    select.value = Number.isInteger(last) && !isSkipped(syllabus, last) ? last : currentLesson;
    renderOverview();
  }
}

function grammarTable({ headers, rows }) {
  const table = el("table", null, "grammar-table");
  const head = el("tr");
  headers.forEach((h) => head.append(el("th", h)));
  table.append(head);
  for (const row of rows || []) {
    const tr = el("tr");
    row.forEach((c) => tr.append(el("td", c)));
    table.append(tr);
  }
  return table;
}

// The selected practice lesson's digest, laid out for reading: summary, grammar, vocabulary.
let overviewRequest = 0;
async function renderOverview() {
  const i = Number($("practice-lesson").value);
  const request = ++overviewRequest;
  const status = $("overview-status");
  const body = $("overview-body");
  const setStatus = (text) => {
    status.textContent = text || "";
    status.hidden = !text;
  };
  body.replaceChildren();
  setStatus("Loading the lesson overview…");
  let d;
  try {
    d = await ensureDigest(i, setStatus);
  } catch (e) {
    if (request === overviewRequest) setStatus(`Couldn't load the overview: ${e.message}`);
    return;
  }
  if (request !== overviewRequest) return;
  if (!d) return setStatus("No overview for this lesson yet.");
  setStatus("");

  const parts = [el("p", d.overview)];
  if (d.objectives?.length) {
    const ul = el("ul");
    d.objectives.forEach((o) => ul.append(el("li", o)));
    parts.push(el("h4", "You'll be able to"), ul);
  }
  for (const g of d.grammar || []) {
    const section = el("section");
    section.append(el("h4", g.topic), ...richText(g.explanation));
    if (g.table?.headers?.length) section.append(grammarTable(g.table));
    if (g.examples?.length) {
      const ul = el("ul", null, "examples");
      for (const ex of g.examples) {
        const li = el("li", `${ex.pt} `);
        li.append(el("span", ex.en, "en"));
        ul.append(li);
      }
      section.append(ul);
    }
    if (g.pitfalls?.length) {
      const ul = el("ul", null, "pitfalls");
      g.pitfalls.forEach((p) => ul.append(el("li", `Watch out: ${p}`)));
      section.append(ul);
    }
    parts.push(section);
  }
  if (!settings.skipPronunciation) {
    for (const p of d.pronunciation || []) {
      const section = el("section");
      section.append(el("h4", `Pronunciation: ${p.topic}`), ...richText(p.explanation));
      parts.push(section);
    }
  }
  if (d.vocabulary?.length) {
    const vocab = el("details");
    vocab.id = "overview-vocab";
    vocab.append(el("summary", `Vocabulary (${d.vocabulary.length} words)`));
    const table = el("table", null, "vocab");
    for (const v of d.vocabulary) {
      const tr = el("tr");
      tr.append(el("td", v.pt), el("td", v.en));
      table.append(tr);
    }
    vocab.append(table);
    parts.push(vocab);
  }
  body.replaceChildren(...parts);
}

// "More vocab" card on the done screen: extra vocab quizzes that update each word's schedule.
async function renderVocabCard() {
  const pool = await vocabPool();
  const words = vocab?.words || {};
  const due = pool.filter((w) => words[w.key]?.due <= todayKey()).length;
  const fresh = pool.filter((w) => !words[w.key]).length;
  $("vocab-card").hidden = !pool.length;
  $("vocab-more-summary").textContent =
    `${plural(pool.length, "word")} from completed lessons: ${due} due, ${fresh} not tested yet. ` +
    "Each quiz picks due words first, then new ones, then the ones you've gone longest without seeing.";
}

function startPractice() {
  generateWithGemini({
    mode: "practice",
    lessonIndex: Number($("practice-lesson").value),
    ids: ["practice-btn", "practice-status", "practice-error"],
  });
}

function startReview() {
  generateWithGemini({ mode: "review", ids: ["review-btn", "review-status", "review-error"] });
}

// "Today's quizzes": a check per task. The review and vocab quizzes are ticked off automatically when
// there's nothing for them to test yet (early in the book, or no Gemini key for the review quiz).
let renderTasksRun = 0;
let dataReady = false; // set once the synced docs and lesson list have loaded; until then nothing auto-completes
async function renderTasks() {
  const run = ++renderTasksRun;
  const hasGemini = !!settings.geminiApiKey;
  const mark = (task, done) => {
    $(`task-${task}`).classList.toggle("done", done);
    $(`${task}-check`).textContent = done ? "✓" : "";
  };

  const lessonDone = taskDone(progress, "lesson");
  mark("lesson", lessonDone);
  $("generate-quiz").hidden = lessonDone || !hasGemini;
  $("gemini-plan").hidden = lessonDone;
  $("lesson-task-note").textContent = lessonDone
    ? "Passed today."
    : hasGemini ? `You need ${settings.passPercent}% to pass.` : "Use \"Paste a quiz from any chatbot\" below to take it.";

  const reviewDone = taskDone(progress, "review");
  const due = dueMistakes(review, Infinity).length;
  const total = review.mistakes?.length || 0;
  const hasEarlier = !!syllabus && earlierLessonIndexes(syllabus, currentLesson).length > 0;
  const canReview = hasGemini && (due > 0 || hasEarlier);
  mark("review", reviewDone);
  $("review-btn").hidden = reviewDone || !canReview;
  $("review-summary").textContent = reviewDone
    ? "Done today."
    : due
      ? `${plural(due, "item")} you got wrong ${due === 1 ? "is" : "are"} due${total > due ? ` (${total - due} more later)` : ""}, then earlier lessons you haven't checked in a while.`
      : "Nothing is due today, so it checks the earlier lessons you haven't seen in the longest.";

  const vocabDone = taskDone(progress, "vocab");
  mark("vocab", vocabDone);
  $("vocab-btn").hidden = vocabDone;
  if (vocabDone) $("vocab-summary").textContent = "Done today.";
  const pool = vocabDone ? [] : await vocabPool();
  if (run !== renderTasksRun) return;
  if (!vocabDone) {
    const words = vocab?.words || {};
    const dueWords = pool.filter((w) => words[w.key]?.due <= todayKey()).length;
    const fresh = pool.filter((w) => !words[w.key]).length;
    $("vocab-summary").textContent = pool.length
      ? `${plural(pool.length, "word")} from completed lessons: ${dueWords} due, ${fresh} not tested yet.`
      : "No vocabulary from completed lessons yet.";
  }

  // Nothing to test: count it as done so it doesn't block the day. Only once everything has loaded,
  // or an empty lesson list on first load would look like "nothing to review".
  const autoDone = [];
  if (!dataReady) return;
  if (!reviewDone && !canReview) autoDone.push("review");
  if (!vocabDone && !pool.length) autoDone.push("vocab");
  if (autoDone.length) {
    progress = await mutate("progress", (p) => autoDone.reduce(withTaskDone, p), `Nothing to ${autoDone.join(" or ")} yet`);
    if (run === renderTasksRun) render();
  }
}

function backToDone() {
  quizMode = "daily";
  view = null;
  render();
}

// Redraws the home screen from the current docs. Leaves an in-progress quiz or result alone.
function render() {
  renderStreak();
  renderSyncStatus();
  if (view === "quiz-view" || view === "result-view") return;
  if (dayDone(progress)) {
    $("done-continue").hidden = !fromUrl;
    renderPractice();
    renderVocabCard();
    show("done-view");
    return;
  }
  const hasGemini = !!settings.geminiApiKey;
  $("gemini-setup-hint").hidden = hasGemini;
  renderTasks();
  document.querySelectorAll(".count-label").forEach((e) => (e.textContent = settings.questionCount));
  document.querySelectorAll(".pass-label").forEach((e) => (e.textContent = settings.passPercent));
  renderLesson();
  show("setup-view");
}

function wire() {
  $("open-options").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("header-settings").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("hint-options").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("done-continue").addEventListener("click", continueBrowsing);
  $("lesson-select").addEventListener("change", async (e) => {
    currentLesson = Number(e.target.value);
    renderLesson();
    ensureDailyLesson();
    progress = await mutate("progress", (p) => ({ ...p, currentLesson }), `Set lesson to ${lesson().title}`);
  });
  $("read-lesson").addEventListener("click", () => lesson() && browser.tabs.create({ url: lesson().sources[0].link }));
  $("rewrite-lesson").addEventListener("click", () => ensureDailyLesson({ rewrite: true }));
  $("copy-quiz").addEventListener("click", (e) => copy(quizPrompt(focusText(), settings.questionCount), e.currentTarget));
  $("toggle-prompt").addEventListener("click", (e) => {
    const pre = $("prompt-preview");
    pre.hidden = !pre.hidden;
    e.currentTarget.textContent = pre.hidden ? "Show prompt" : "Hide prompt";
  });
  $("start-quiz").addEventListener("click", startPastedQuiz);
  $("generate-quiz").addEventListener("click", () => generateWithGemini());
  $("practice-btn").addEventListener("click", startPractice);
  $("review-btn").addEventListener("click", startReview);
  $("vocab-btn").addEventListener("click", () => startVocab());
  $("practice-lesson").addEventListener("change", renderOverview);
  $("overview-original").addEventListener("click", () => {
    const l = syllabus?.lessons[Number($("practice-lesson").value)];
    if (l) browser.tabs.create({ url: l.sources[0].link });
  });
  $("practice-again").addEventListener("click", () => againAction?.());
  $("vocab-more-btn").addEventListener("click", startMoreVocab);
  $("practice-done").addEventListener("click", backToDone);
  $("to-practice").addEventListener("click", backToDone);
  $("check-btn").addEventListener("click", answerText);
  $("skip-btn").addEventListener("click", skip);
  $("override-btn").addEventListener("click", override);
  $("next-btn").addEventListener("click", next);
  $("retry-btn").addEventListener("click", () => {
    show("setup-view");
    render();
  });
  $("continue-btn").addEventListener("click", continueBrowsing);
  $("em-btn").addEventListener("click", useEmergency);
  $("em-minutes").textContent = EMERGENCY_MINUTES;
  $("em-phrase").textContent = EMERGENCY_PHRASE;
}

async function init() {
  wire();
  await migrateLegacy().catch(() => {});
  await loadDocs();
  $("manual").open = !settings.geminiApiKey;
  render();

  // Show the cached copy immediately, then refresh from GitHub (another device may have moved things on).
  try {
    if (await syncDown()) {
      await loadDocs();
      render();
    }
  } catch {
    renderSyncStatus();
  }
  await ensureSyllabus();
  if (dayDone(progress)) return render(); // done for today: only practice remains
  // If you're parked on a lesson that's since been marked skipped, move to the next one.
  if (syllabus && isSkipped(syllabus, currentLesson) && nextLessonIndex(syllabus, currentLesson) !== -1) {
    const from = currentLesson;
    currentLesson = nextLessonIndex(syllabus, from);
    progress = await mutate("progress", (p) => (p.currentLesson === from ? { ...p, currentLesson } : p), `Skip ${syllabus.lessons[from].title}`);
    currentLesson = progress.currentLesson;
  }
  dataReady = true;
  render();
  await ensureDailyLesson();
}

init();
