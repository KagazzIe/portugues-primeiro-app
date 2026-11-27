const $ = (id) => document.getElementById(id);
const VIEWS = ["setup-view", "quiz-view", "result-view", "done-view"];

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

const lessonTextCache = new Map();

function show(v) {
  view = v;
  for (const id of VIEWS) $(id).hidden = id !== v;
}

const lesson = () => syllabus?.lessons[currentLesson];
// The lesson today's quizzes are on. Picking another lesson in the list only browses it.
const todayLesson = () => (syllabus ? Math.min(progress.currentLesson || 0, syllabus.lessons.length - 1) : 0);
const browsing = () => !!syllabus && currentLesson !== todayLesson();

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
- Each multiple-choice question has exactly ONE correct option. The others must be clearly wrong, never a rewording of the correct answer or another valid way to say the same thing. For a fill-in-the-blank, try every option in the blank: if more than one makes a correct sentence (e.g. "a mim / a ti / a ela" when nothing says who is meant), add context to the question that picks one. Check every question for this before you reply.
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
    // Gemini sometimes sends "options": [] on written questions, or too few on a multiple-choice one that
    // still has an answer. Treat those as written questions rather than failing the whole quiz.
    const optCount = Array.isArray(q.options) ? q.options.filter((o) => String(o).trim()).length : 0;
    const isMc = q.type === "mc" ? optCount >= 2 || !q.answer : q.type !== "text" && optCount > 0;
    if (isMc) {
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
        lessonId: q.lessonId || "",
        topic: typeof q.topic === "string" ? q.topic : "",
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
        lessonId: q.lessonId || "",
        topic: typeof q.topic === "string" ? q.topic : "",
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
    // "Which sentence correctly uses 'menos'?" where only the correct option contains menos.
    // Quoted English words ('fewer') never match Portuguese options, so only the tested word counts.
    if (Array.isArray(q.options) && q.options.length >= 3) {
      const has = (text, term) => ` ${words(text).join(" ")} `.includes(` ${term} `);
      const quoted = [...String(q.q || q.question || "").matchAll(/(?<![a-z])['"‘“]([^'"‘’“”]{1,40})['"’”](?![a-z])/gi)] // not apostrophes in "doesn't"
        .map((m) => words(m[1]).join(" "))
        .filter((t) => t && t.split(" ").length <= 3);
      const telling = quoted.find((t) => has(answer, t) && q.options.filter((o) => has(o, t)).length === 1);
      if (telling) {
        problems.push(`Question ${i + 1} ("${q.q || q.question}"): the question names "${telling}" and the correct option is the only one containing it, so the answer is given away. Make every option use "${telling}" (correctly in one, wrongly in the others) or don't name it.`);
        return;
      }
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
  $("q-progress").textContent = `${label}${q.lessonTitle ? `${q.lessonTitle} · ` : ""}Pergunta ${idx + 1} de ${total}`;
  $("q-bar").style.width = `${(idx / total) * 100}%`;
  $("q-text").textContent = q.q;
  $("feedback").hidden = true;
  $("next-btn").hidden = true;
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

const GEMINI_CHECK_SECONDS = 15;

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
    return;
  }

  // Not in the answer key. Ask Gemini whether it's still valid Portuguese for this question.
  // If it's slow (busy retries can take minutes), offer a button to self-grade after GEMINI_CHECK_SECONDS.
  const fb = $("feedback");
  fb.className = "feedback";
  fb.hidden = false;
  let settled = false;
  let timer;
  const offline = quiz.source === "offline";
  const selfNote = offline ? "(Self-graded: quiz built without Gemini.)" : "(Self-graded: Gemini took too long.)";
  const settle = (...args) => {
    if (settled) return false;
    settled = true;
    clearInterval(timer);
    record(...args);
    return true;
  };
  if (offline) return selfGrade();
  let left = GEMINI_CHECK_SECONDS;
  const status = () => (fb.textContent = `Not in the answer key. Checking with Gemini… ${left}s`);
  status();
  timer = setInterval(() => {
    if (--left > 0) return status();
    clearInterval(timer);
    const skipGemini = el("button", "Skip Gemini and grade myself");
    skipGemini.addEventListener("click", selfGrade);
    const row = el("div", null, "row");
    row.append(skipGemini);
    fb.replaceChildren(el("p", "Gemini is taking a while. Still checking…"), row);
  }, 1000);
  function selfGrade() {
    if (settled) return;
    fb.replaceChildren(
      el("p", "Compare your answer with the answer key and grade yourself:"),
      el("p", `Your answer: ${given}`),
      el("p", `Answer key: ${q.expected}`),
    );
    const row = el("div", null, "row");
    const right = el("button", "I was right", "primary");
    const wrong = el("button", "I was wrong");
    right.addEventListener("click", () => settle(q, given, true, selfNote));
    wrong.addEventListener("click", () => settle(q, given, false, selfNote));
    row.append(right, wrong);
    fb.append(row);
  }
  try {
    const verdict = q.vocab
      ? await judgeVocab({ apiKey: settings.geminiApiKey, model: settings.geminiModel, pt: q.vocab.pt, en: q.vocab.en, given })
      : await judgeAnswer({
          apiKey: settings.geminiApiKey,
          model: settings.geminiModel,
          syllabus,
          question: q.q,
          expected: q.expected,
          accept: q.answers.slice(1),
          given,
        });
    settle(q, given, verdict.correct, verdict.feedback);
  } catch {
    settle(q, given, false, "(Couldn't reach Gemini to double-check.)");
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
  if (!correct) {
    const link = textbookLink(q);
    if (link) fb.append(link);
  }
  fb.hidden = false;
  $("next-btn").hidden = false;
  $("next-btn").textContent = idx === quiz.questions.length - 1 ? "See results" : "Next →";
  $("next-btn").focus();
}

function next() {
  idx++;
  if (idx < quiz.questions.length) renderQuestion();
  else showResults();
}

// The only place to count a question as right by hand: the results screen, before anything is saved.
// Each question marked wrong (skipped ones included) is a card; clicking it toggles it between wrong and
// right, and the score updates. "Save results" saves, then the same screen shows the outcome.
// With nothing to mark, it saves straight away.
function showResults() {
  const misses = results.filter((r) => !r.correct);
  if (!misses.length) return finish();
  startResults();
  $("result-title").textContent = "Check your answers";
  const reviewEl = $("review");
  reviewEl.replaceChildren(
    el("p", "Click any question you want counted as right (click again to undo), then save.", "hint")
  );
  for (const r of misses) {
    const state = el("div", null, "state");
    const card = el("button", null, "option mark");
    const paint = () => {
      card.classList.toggle("wrong", !r.correct);
      card.classList.toggle("correct", r.correct);
      card.setAttribute("aria-pressed", String(r.correct));
      state.textContent = r.correct ? "✓ Counted as right" : "✗ Counted as wrong";
    };
    card.addEventListener("click", () => {
      r.correct = !r.correct;
      if (r.correct) r.overridden = true;
      else delete r.overridden;
      paint();
      showScore();
    });
    card.append(
      el("div", r.q, "q"),
      el("div", r.skipped ? "You: skipped" : `You: ${r.given}`, "yours"),
      el("div", `Answer key: ${r.expected}${r.question.translation ? ` (${r.question.translation})` : ""}`, "right"),
      state
    );
    paint();
    reviewEl.append(card);
  }
  const save = $("save-btn");
  save.textContent = quizMode === "practice" ? "Finish" : "Save results";
  save.hidden = false;
  save.focus();
}

function saveResults() {
  $("save-btn").hidden = true;
  for (const b of $("review").querySelectorAll("button")) b.disabled = true;
  finish();
}

// Review questions only: a link that opens the question's lesson in the textbook (its first chapter).
function textbookLink(q) {
  if (quizMode !== "review" || q.lessonIndex == null) return null;
  const url = syllabus?.lessons[q.lessonIndex]?.sources?.[0]?.link;
  if (!url) return null;
  const a = el("a", `Read ${q.lessonTitle || "this lesson"} in the textbook ↗`);
  a.href = url;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    browser.tabs.create({ url });
  });
  const p = el("p", null, "textbook-link");
  p.append(a);
  return p;
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
    const link = textbookLink(r.question);
    if (link) div.append(link);
    reviewEl.append(div);
  }
}

function showScore() {
  const total = results.length;
  const right = results.filter((r) => r.correct).length;
  const pct = Math.round((right / total) * 100);
  $("result-score").textContent = `${right}/${total} (${pct}%)`;
  $("result-score").style.color = pct >= settings.passPercent ? "var(--green)" : "var(--red)";
  return { total, right, pct };
}

// Shows the score and hides every results button; returns the counts. The list of misses stays on
// screen (with its buttons disabled) until the caller redraws it.
function startResults() {
  const score = showScore();
  $("result-title").textContent = "Saving…";
  $("next-lesson").hidden = true;
  for (const id of ["retry-btn", "continue-btn", "to-practice", "practice-again", "practice-done", "save-btn"]) $(id).hidden = true;
  $("q-bar").style.width = "100%";
  show("result-view");
  return score;
}

// A practice quiz only shows the score and what was missed; nothing is saved.
function finishPractice() {
  startResults();
  $("result-title").textContent = "Practice done. This one doesn't count.";
  renderMisses("What you missed:");
  $("practice-done").textContent = "Done";
  offerAgain("Another practice quiz", () => (practiceAgain || startPractice)());
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

// The review quiz updates the review queue (items answered right move further out, misses join it and
// come back tomorrow) and clears each lesson answered right. It's done once every earlier lesson is
// cleared; until then each round asks only the lessons still left.
async function finishReview() {
  const { total, right } = startResults();
  const today = todayKey();
  const message = `Review quiz ${today}: ${right}/${total}`;
  review = await mutate("review", (r) => applyReviews(r, results, null, `${today}-review-${quiz.hash}`), message);
  const cleared = [...results.filter((r) => r.correct && r.question.lessonSlug).map((r) => r.question.lessonSlug), ...(quiz.freeLessons || [])];
  const all = reviewSlugs();
  progress = await mutate(
    "progress",
    (p) => withTopicsAsked(
      withAskedQuestions(withReviewRound(p, cleared, all), results, (r) => r.question.lessonSlug),
      results,
      (r) => r.question.lessonSlug
    ),
    message
  );
  renderStreak();
  renderSyncStatus();
  const left = reviewLeft(progress, all);
  if (!left.length) {
    renderMisses("What you missed. These come back in tomorrow's review:");
    renderAfterTask("Review quiz done! Every lesson cleared.");
    return;
  }
  renderMisses("What you missed:");
  const titles = left.map((slug) => syllabus.lessons.find((l) => lessonSlug(l) === slug)?.title || slug);
  $("result-title").textContent =
    `${plural(left.length, "lesson")} still to clear: ${titles.join(", ")}. The next round asks a new question on ${left.length === 1 ? "it" : "each of those"}.`;
  offerAgain(`Next round (${plural(left.length, "question")})`, quiz.source === "offline" ? startOfflineReview : startReview);
  $("practice-done").textContent = "Back to today's quizzes";
  $("practice-done").hidden = false;
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
  renderMisses("Words you missed. These come back in your next vocab quizzes:");
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
  const { total, right, pct } = startResults();
  const passed = pct >= settings.passPercent;
  const today = todayKey();
  const lessonIndex = quizLessonIndex;
  // Only the day's first lesson quiz on this lesson can move you on; retries still pass the day's task.
  const isFirstAttempt = (p) => !(p.history || []).some((h) => h.date === today && h.lessonIndex === lessonIndex);
  const firstToday = isFirstAttempt(progress);
  const earnedAdvance = passed && firstToday && pct >= settings.advancePercent;
  const lastIndex = syllabus ? syllabus.lessons.length - 1 : 0;

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
    const slug = syllabus?.lessons[lessonIndex] ? lessonSlug(syllabus.lessons[lessonIndex]) : "";
    nextP = withAskedQuestions(nextP, results, () => slug);
    nextP = withTopicsAsked(nextP, results, () => slug);
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
      ...(r.question.topic ? { topic: r.question.topic } : {}),
      q: r.q,
      given: r.given,
      skipped: r.skipped,
      correct: r.correct,
      ...(r.overridden ? { overridden: true } : {}),
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
// Every lesson the review quiz covers: the completed ones (before the current lesson, not skipped).
const reviewSlugs = () => (syllabus ? earlierLessonIndexes(syllabus, currentLesson).map((j) => lessonSlug(syllabus.lessons[j])) : []);

// This round's lessons: the ones not yet cleared today, in book order, with their digests (none are built
// here) and the most overdue review-queue item from that lesson, if any.
async function reviewItems() {
  const left = new Set(reviewLeft(progress, reviewSlugs()));
  const due = dueMistakes(review, Infinity);
  const indexes = earlierLessonIndexes(syllabus, currentLesson).filter((j) => left.has(lessonSlug(syllabus.lessons[j])));
  return Promise.all(indexes.map(async (j) => {
    const l = syllabus.lessons[j];
    return {
      id: lessonSlug(l),
      index: j,
      lesson: l,
      digest: await readRepoFile(digestPath(l)).catch(() => null),
      mistake: due.find((m) => m.lesson === j) || null,
    };
  }));
}

// Ties each review question to its lesson (for the label and for clearing it) (one per lesson).
// Gemini can skip or double up a lesson: extras are dropped, and a missing lesson gets one of its digest's
// exercises instead, if it has any.
function matchReviewQuestions(questions, items) {
  const out = [];
  for (const it of items) {
    let q = questions.find((x) => x.lessonId === it.id && !out.includes(x));
    if (!q) {
      const x = shuffleArray((it.digest?.exercises || []).filter((e) => e.prompt && e.answer))[0];
      if (!x) continue;
      q = { type: "text", q: x.prompt, answers: [String(x.answer)], expected: String(x.answer), explain: "", reviewOf: "earlier" };
    }
    if (q.reviewOf && q.reviewOf !== "earlier" && q.reviewOf !== it.mistake?.id) q.reviewOf = "earlier";
    // Only count topics the lesson's digest actually has.
    if (!quizTopics(it.digest).includes(q.topic)) q.topic = "";
    out.push(Object.assign(q, { lessonSlug: it.id, lessonIndex: it.index, lessonTitle: it.lesson.title }));
  }
  return out;
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
    const picks = pickVocab(await vocabPool(), vocab);
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

// The lesson quiz asks Gemini for a few more questions than it needs, so ones that copy a question
// answered right in the last few days can be dropped.
const SPARE_QUESTIONS = 4;

// Word overlap (Jaccard, accents and case ignored) between two questions.
function questionSimilarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

// Keeps n of a generated quiz's questions. Ones like a question recently answered right (at or above
// REPEAT_SIMILARITY) go last. The rest are picked one at a time from the topic asked least so far (counting
// earlier quizzes, from coverage = progress.topicsAsked[slug], and the questions already picked), in the
// order Gemini wrote them. Returns the quiz JSON text.
const REPEAT_SIMILARITY = 0.8;
function pickQuestions(text, asked, n, coverage = {}) {
  let data;
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
  } catch {
    return text; // parseQuiz will report it
  }
  const all = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(all)) return text;
  // Leave out multiple-choice questions Gemini sent without real options while there are spares.
  const broken = (q) => q.type === "mc" && !(Array.isArray(q.options) && q.options.filter((o) => String(o).trim()).length >= 2);
  const raw = all.filter((q) => !broken(q)).length >= n ? all.filter((q) => !broken(q)) : all;
  if (raw.length <= n) return JSON.stringify(Array.isArray(data) ? raw : { ...data, questions: raw });
  const right = asked.filter((a) => a.correct).map((a) => a.q);
  const scored = raw.map((q, i) => {
    const s = Math.max(0, ...right.map((r) => questionSimilarity(q.q || q.question || "", r)));
    return { q, i, repeat: s >= REPEAT_SIMILARITY };
  });
  const count = new Map();
  const timesAsked = (q) => (coverage[q.topic]?.asked || 0) + (count.get(q.topic) || 0);
  const fresh = scored.filter((x) => !x.repeat);
  const picked = [];
  while (picked.length < n && fresh.length) {
    let best = 0;
    for (let k = 1; k < fresh.length; k++) if (timesAsked(fresh[k].q) < timesAsked(fresh[best].q)) best = k;
    const [x] = fresh.splice(best, 1);
    count.set(x.q.topic, (count.get(x.q.topic) || 0) + 1);
    picked.push(x);
  }
  // Repeats only if there aren't enough fresh ones. Back in the order Gemini wrote them.
  const kept = [...picked, ...scored.filter((x) => x.repeat)].slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.q);
  return JSON.stringify(Array.isArray(data) ? kept : { ...data, questions: kept });
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
    let text, digest, minQuestions, items, schema;

    if (mode === "review") {
      status.textContent = "Gathering the lessons to review…";
      items = await reviewItems();
      if (!items.length) throw new Error("Nothing to review yet.");
      // The checker compares hints against vocabulary, so give it the reviewed lessons' combined list.
      digest = { vocabulary: items.flatMap((it) => it.digest?.vocabulary || []) };
      status.textContent = `Writing a review quiz (${plural(items.length, "lesson")})…`;
      text = await generateReviewQuiz({ ...common, items, progress });
      minQuestions = items.length;
      schema = reviewSchema(items.map((it) => it.id));
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
        n: settings.questionCount + SPARE_QUESTIONS,
      });
      minQuestions = settings.questionCount;
      schema = lessonQuizSchema(quizTopics(digest));
    }

    // Second pass: catch duplicate answers, wrong keys, and incomplete hints. Keep the original if it fails.
    status.textContent = "Double-checking the questions…";
    try {
      const reviewed = await reviewQuiz({ ...common, digest, quizText: text, schema });
      parseQuiz(reviewed, { minQuestions });
      text = reviewed;
    } catch {}
    // Our own check for answers already written in the question; ask for those to be rewritten once.
    const problems = findGiveaways(text);
    if (problems.length) {
      status.textContent = `Rewriting ${plural(problems.length, "question")} that gave away the answer…`;
      try {
        const fixed = await reviewQuiz({ ...common, digest, quizText: text, problems, schema });
        parseQuiz(fixed, { minQuestions });
        text = fixed;
      } catch {}
    }
    if (mode === "review") return startReviewQuiz(parseQuiz(text, { minQuestions: 1 }), items, "gemini");
    const slug = lessonSlug(syllabus.lessons[lessonIndex]);
    text = pickQuestions(text, recentAsked(progress, slug), settings.questionCount, progress.topicsAsked?.[slug]);
    const msg = await beginQuiz(text, "gemini", { mode, lessonIndex, minQuestions });
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
  const today = todayLesson();
  [...select.options].forEach((o, i) => {
    const label = o.text.replace(/ \(today\)$/, "");
    o.text = i === today ? `${label} (today)` : label;
  });
  select.value = currentLesson;

  const l = lesson();
  const day = dayOnLesson(progress, currentLesson);
  $("lesson-meta").textContent = `${syllabus.title} · ${l.sources.map((s) => s.title).join(" + ")}${browsing() ? "" : ` · day ${day} on this lesson`}`;
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
  const n = streakAlive(progress) ? progress.streak || 0 : 0;
  const saved = n && !dayDone(progress) && missForgivable(progress);
  $("streak").textContent = !n
    ? "No streak yet. Start one today!"
    : `🔥 ${n}-day streak${saved ? " · You missed yesterday. That's your one free miss this week: finish today to keep the streak." : ""}`;
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

function vocabSummary(pool) {
  const { missed, fresh } = vocabBuckets(pool, vocab);
  return `${plural(pool.length, "word")} from completed lessons: ${missed.length} missed recently, ${fresh.length} not tested yet.`;
}

// "More vocab" card on the done screen: extra vocab quizzes that update each word's schedule.
async function renderVocabCard() {
  const pool = await vocabPool();
  $("vocab-card").hidden = !pool.length;
  $("vocab-more-summary").textContent =
    `${vocabSummary(pool)} Each quiz is a mix of ${VOCAB_QUESTIONS} words: ones you missed recently, ` +
    "ones you haven't seen in the longest time, and new ones.";
}

// Practice quizzes come from the done screen's lesson list or from browsing a lesson; "again" repeats the last one.
let practiceAgain = null;
function startPractice() {
  practiceAgain = startPractice;
  generateWithGemini({
    mode: "practice",
    lessonIndex: Number($("practice-lesson").value),
    ids: ["practice-btn", "practice-status", "practice-error"],
  });
}

function startBrowsePractice() {
  const lessonIndex = currentLesson;
  practiceAgain = () => {
    currentLesson = lessonIndex;
    render();
    startBrowsePractice();
  };
  generateWithGemini({ mode: "practice", lessonIndex, ids: ["browse-practice", "browse-status", "browse-error"] });
}

function backToToday() {
  currentLesson = todayLesson();
  render();
  ensureDailyLesson();
  window.scrollTo(0, 0);
}

function startReview() {
  generateWithGemini({ mode: "review", ids: ["review-btn", "review-status", "review-error"] });
}

// Starts a review round from parsed questions, one per lesson in items.
function startReviewQuiz(parsed, items, source) {
  const questions = shuffleArray(matchReviewQuestions(parsed.questions, items));
  if (!questions.length) throw new Error("The review quiz came back empty. Try again.");
  const hash = hashString(JSON.stringify(questions.map((q) => q.q)));
  startPreparedQuiz({ lesson: "Review", hash, questions, source }, { mode: "review", lessonIndex: null });
}

// Fallback for when Gemini is down: builds the review round locally, one question per lesson still to clear.
// A lesson's due review item is asked again as written; otherwise it's one of its digest's exercises.
// Answers not in the key are self-graded (see answerText), since there's no Gemini to judge them.
async function startOfflineReview() {
  const [btn, status, err] = ["review-offline-btn", "review-status", "review-error"].map($);
  err.hidden = true;
  btn.disabled = true;
  status.textContent = "Building a review quiz without Gemini…";
  try {
    if (!syllabus) throw new Error("The lessons haven't loaded yet.");
    const items = await reviewItems();
    if (!items.length) throw new Error("Nothing to review yet.");
    const questions = items.filter((it) => it.mistake).map((it) => ({
      type: "text",
      q: it.mistake.q,
      answers: [String(it.mistake.expected)],
      expected: String(it.mistake.expected),
      explain: it.mistake.explain || "",
      reviewOf: it.mistake.id,
      lessonId: it.id,
    }));
    // Lessons without a due item get one of their exercises (matchReviewQuestions fills those in).
    startReviewQuiz({ questions }, items, "offline");
    // A lesson with neither has nothing to ask offline; it counts as cleared so it can't block the day.
    const asked = new Set(quiz.questions.map((q) => q.lessonSlug));
    quiz.freeLessons = items.map((it) => it.id).filter((id) => !asked.has(id));
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    status.textContent = "";
  }
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
  const allReview = reviewSlugs();
  const reviewLeftNow = reviewLeft(progress, allReview);
  const canReview = hasGemini && reviewLeftNow.length > 0;
  mark("review", reviewDone);
  $("review-btn").hidden = reviewDone || !canReview;
  $("review-offline-btn").hidden = reviewDone || !canReview;
  $("review-btn").textContent = reviewLeftNow.length < allReview.length ? "Start the next round" : "Start the review quiz";
  $("review-summary").textContent = reviewDone
    ? "Done today."
    : reviewLeftNow.length < allReview.length
      ? `${allReview.length - reviewLeftNow.length} of ${plural(allReview.length, "lesson")} cleared today. ${reviewLeftNow.length} left, with a new question on ${reviewLeftNow.length === 1 ? "it" : "each"}.`
      : `One open question on each of your ${plural(allReview.length, "earlier lesson")}. Get each one right to clear it; missed lessons come back in another round.`;

  const vocabDone = taskDone(progress, "vocab");
  mark("vocab", vocabDone);
  $("vocab-btn").hidden = vocabDone;
  if (vocabDone) $("vocab-summary").textContent = "Done today.";
  const pool = vocabDone ? [] : await vocabPool();
  if (run !== renderTasksRun) return;
  if (!vocabDone) {
    $("vocab-summary").textContent = pool.length ? vocabSummary(pool) : "No vocabulary from completed lessons yet.";
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
  const away = browsing();
  $("gemini-setup-hint").hidden = hasGemini || away;
  $("tasks-card").hidden = away;
  $("manual").hidden = away;
  $("browse-card").hidden = !away;
  $("browse-note").hidden = !away;
  $("browse-practice").hidden = !hasGemini;
  $("browse-no-gemini").hidden = hasGemini;
  $("lesson-heading").textContent = away ? "Lesson" : "Today's lesson";
  // The tasks are worked out from today's lesson, so leave them alone while browsing another one.
  if (!away) renderTasks();
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
    render();
    ensureDailyLesson();
  });
  document.querySelectorAll(".back-to-today").forEach((b) => b.addEventListener("click", backToToday));
  $("browse-practice").addEventListener("click", startBrowsePractice);
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
  $("review-offline-btn").addEventListener("click", startOfflineReview);
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
  $("save-btn").addEventListener("click", saveResults);
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
