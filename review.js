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
        lesson: lessonIndex,
        box: 0,
        due: addDays(today, REVIEW_INTERVALS[0]),
      });
    }
  });
  return { ...review, mistakes: [...byId.values()].slice(-300) };
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

// pool: [{ key, pt, en, lesson }]. Picks up to n words: missed and overdue words first, then words never
// tested, then the ones seen longest ago. A word missed earlier today (box 0) counts as due, so extra
// rounds start with it.
function pickVocab(pool, vocabDoc, n) {
  const today = todayKey();
  const words = vocabDoc?.words || {};
  const seen = pool.filter((w) => words[w.key]);
  const isDue = (w) => words[w.key].due <= today || words[w.key].box === 0;
  const due = seen
    .filter(isDue)
    .sort((a, b) => words[a.key].box - words[b.key].box || (words[a.key].due < words[b.key].due ? -1 : 1));
  const fresh = shuffleArray(pool.filter((w) => !words[w.key]));
  const rest = seen
    .filter((w) => !isDue(w))
    .sort((a, b) => (words[a.key].seen < words[b.key].seen ? -1 : 1));
  return [...due, ...fresh, ...rest].slice(0, n);
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
