// Spaced repetition for missed questions (Leitner boxes).
// A miss is due again tomorrow; each correct review pushes it further out until it's mastered.
// These are pure functions over the review doc ({ mistakes: [...] }) so they can run inside mutate().

const REVIEW_INTERVALS = [1, 3, 7, 14, 30]; // days until next review, by box

function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}

function dueMistakes(review, limit) {
  const today = todayKey();
  return (review.mistakes || [])
    .filter((m) => m.due <= today)
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.box - b.box))
    .slice(0, limit);
}

// results: [{ question, correct }] from a finished quiz.
function applyReviews(review, results, lessonIndex, newId) {
  const today = todayKey();
  const byId = new Map((review.mistakes || []).map((m) => [m.id, { ...m }]));

  results.forEach(({ question, correct }, i) => {
    const existing = question.reviewOf && byId.get(question.reviewOf);
    if (existing) {
      if (correct) {
        existing.box++;
        if (existing.box >= REVIEW_INTERVALS.length) byId.delete(existing.id);
        else existing.due = addDays(today, REVIEW_INTERVALS[existing.box]);
      } else {
        existing.box = 0;
        existing.due = addDays(today, REVIEW_INTERVALS[0]);
      }
    } else if (!correct) {
      const id = `${newId}-${i}`;
      byId.set(id, {
        id,
        q: question.q,
        expected: question.expected,
        explain: question.explain,
        lesson: question.lessonIndex ?? lessonIndex,
        box: 0,
        due: addDays(today, REVIEW_INTERVALS[0]),
      });
    }
  });
  return { ...review, mistakes: [...byId.values()].slice(-300) };
}

// ---------- Review quiz rounds ----------
// The review quiz asks one open question per earlier lesson. A lesson answered right is cleared for the day;
// the rest come back in another round until every lesson is cleared. progress.reviewCleared: { date, lessons: [slug] }.

const clearedToday = (progress) => (progress?.reviewCleared?.date === todayKey() ? progress.reviewCleared.lessons || [] : []);

// slugs: every lesson the review quiz covers. Returns the ones still to clear today.
const reviewLeft = (progress, slugs) => {
  const cleared = new Set(clearedToday(progress));
  return slugs.filter((s) => !cleared.has(s));
};

// Pure: records the lessons answered right this round; once none are left, the review task is done.
function withReviewRound(progress, clearedSlugs, allSlugs) {
  const lessons = [...new Set([...clearedToday(progress), ...clearedSlugs])];
  const p = { ...progress, reviewCleared: { date: todayKey(), lessons } };
  return reviewLeft(p, allSlugs).length ? p : withTaskDone(p, "review");
}

// ---------- Daily completion ----------

// The day's three tasks: the lesson quiz (passed), the review quiz, and the vocab quiz (just completed).
const DAILY_TASKS = { lesson: "lastPassDate", review: "lastReviewDate", vocab: "lastVocabDate" };

const taskDone = (progress, task) => progress?.[DAILY_TASKS[task]] === todayKey();

// Marks one task done today and, once all three are, completes the day and updates the streak.
// Pure, so it can run inside mutate().
function withTaskDone(progress, task) {
  const today = todayKey();
  // Data from before the three-quiz change has no lastCompleteDate; carry the old pass date over.
  const prevComplete = completeDate(progress);
  const p = { ...progress, lastCompleteDate: prevComplete, [DAILY_TASKS[task]]: today };
  if (Object.keys(DAILY_TASKS).every((t) => taskDone(p, t)) && prevComplete !== today) {
    p.streak = prevComplete === yesterdayKey() ? (p.streak || 0) + 1 : 1;
    p.lastCompleteDate = today;
  }
  return p;
}

// ---------- Vocabulary ----------
// Words come from the digests of lessons already done. vocab.json tracks each word tested:
// { words: { [key]: { pt, en, lesson, box, due, seen, wrong } } }.

const vocabKey = (lessonSlugValue, pt) => `${lessonSlugValue}:${pt}`;

// Words per vocab quiz (separate from the lesson quiz's question count).
const VOCAB_QUESTIONS = 15;
// A word whose last answer was wrong counts as "missed recently" for this many days.
const VOCAB_RECENT_DAYS = 14;

// pool: [{ key, pt, en, lesson }]. Sorts the pool into three groups:
//   missed:  last answer wrong, in the last VOCAB_RECENT_DAYS days (most recent first)
//   fresh:   never tested (random order)
//   longAgo: everything else tested, the ones gone longest without being seen first
function vocabBuckets(pool, vocabDoc) {
  const words = vocabDoc?.words || {};
  const since = addDays(todayKey(), -VOCAB_RECENT_DAYS);
  const bySeen = (a, b) => (words[a.key].seen < words[b.key].seen ? -1 : words[a.key].seen > words[b.key].seen ? 1 : 0);
  const seen = shuffleArray(pool.filter((w) => words[w.key]));
  const isMissed = (w) => words[w.key].box === 0 && words[w.key].seen >= since;
  return {
    missed: seen.filter(isMissed).sort((a, b) => bySeen(b, a)),
    fresh: shuffleArray(pool.filter((w) => !words[w.key])),
    longAgo: seen.filter((w) => !isMissed(w)).sort(bySeen),
  };
}

// Picks up to n words, a mix of the three groups: about a third each. If a group runs short, the others
// fill its places. The picks are shuffled so the groups don't come in blocks.
function pickVocab(pool, vocabDoc, n = VOCAB_QUESTIONS) {
  const { missed, fresh, longAgo } = vocabBuckets(pool, vocabDoc);
  const groups = [missed, fresh, longAgo];
  const share = Math.floor(n / groups.length);
  const picks = groups.flatMap((g) => g.slice(0, share));
  const rest = groups.flatMap((g) => g.slice(share));
  return shuffleArray([...picks, ...rest.slice(0, n - picks.length)]);
}

// results: [{ question: { vocab: { key, pt, en, lesson } }, correct }].
function applyVocab(vocabDoc, results) {
  const today = todayKey();
  const words = { ...(vocabDoc?.words || {}) };
  for (const { question, correct } of results) {
    const w = question.vocab;
    if (!w) continue;
    // A new word answered right comes back in 3 days; a miss, tomorrow.
    const cur = words[w.key] || { pt: w.pt, en: w.en, lesson: w.lesson, box: 0, wrong: 0 };
    const box = correct ? Math.min(cur.box + 1, REVIEW_INTERVALS.length - 1) : 0;
    words[w.key] = {
      ...cur,
      pt: w.pt,
      en: w.en,
      box,
      due: addDays(today, REVIEW_INTERVALS[box]),
      seen: today,
      wrong: cur.wrong + (correct ? 0 : 1),
    };
  }
  return { ...vocabDoc, words };
}

// ---------- Lesson topics covered ----------
// progress.topicsAsked: { [lesson slug]: { [topic]: { asked, wrong, last } } }, counted from daily lesson
// quizzes and review quizzes together. Each question is tagged with one of its lesson digest's topics (see
// quizTopics); the next lesson quiz spends most of its questions on that lesson's topics asked least, and
// the review quiz aims each lesson's question at its topic asked least.

// Pure: adds a finished quiz's tagged questions. slugOf(result) gives the lesson each question was on.
function withTopicsAsked(progress, results, slugOf) {
  const today = todayKey();
  const all = { ...(progress.topicsAsked || {}) };
  for (const r of results) {
    const slug = slugOf(r);
    const topic = r.question.topic;
    if (!slug || !topic) continue;
    const lesson = (all[slug] = { ...(all[slug] || {}) });
    const cur = lesson[topic] || { asked: 0, wrong: 0 };
    lesson[topic] = { asked: cur.asked + 1, wrong: cur.wrong + (r.correct ? 0 : 1), last: today };
  }
  return { ...progress, topicsAsked: all };
}

// ---------- Recently asked questions ----------
// progress.askedQuestions: [{ date, lesson (slug), q, correct }], newest first, for the last few days. Quiz
// prompts list them so Gemini doesn't ask the same questions again (especially ones answered right).

const ASKED_DAYS = 7; // today plus the 7 days before

const askedSince = () => addDays(todayKey(), -ASKED_DAYS);

// Pure: adds a finished quiz's questions. slugOf(result) gives the lesson each question was on.
function withAskedQuestions(progress, results, slugOf) {
  const today = todayKey();
  const added = results
    .map((r) => ({ date: today, lesson: slugOf(r) || "", q: r.q, correct: !!r.correct }))
    .filter((a) => a.q);
  const since = askedSince();
  const kept = (progress.askedQuestions || []).filter((a) => a.date >= since);
  return { ...progress, askedQuestions: [...added, ...kept].slice(0, 600) };
}

// The recently asked questions on one lesson (by slug), newest first, without duplicates.
function recentAsked(progress, slug) {
  const since = askedSince();
  const seen = new Set();
  return (progress?.askedQuestions || []).filter((a) => {
    if (a.date < since || a.lesson !== slug || seen.has(a.q)) return false;
    seen.add(a.q);
    return true;
  });
}
