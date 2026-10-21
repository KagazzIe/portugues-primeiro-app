// Gemini API integration: lesson notes, quiz generation, and answer judging.
// Used by extension pages (lock + options), not the background script.

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function geminiFetch(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error.message || msg;
    } catch {}
    throw new GeminiError(msg, res.status);
  }
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateJson({ apiKey, model, parts, schema, temperature }) {
  const request = () =>
    geminiFetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature },
      }),
    });
  // The free tier rate-limits per minute (429) and the service is sometimes overloaded (503).
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await request();
      break;
    } catch (e) {
      if (!(e instanceof GeminiError) || ![429, 503].includes(e.status) || attempt >= 3) throw e;
      await sleep(20000 * (attempt + 1));
    }
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new GeminiError(`Gemini returned no text (${data.candidates?.[0]?.finishReason || "unknown reason"}).`);
  return text;
}

const varietyOf = (syllabus) => (syllabus.variety && syllabus.variety !== "Unclear" ? `${syllabus.variety} ` : "");

const PAIR = {
  type: "OBJECT",
  properties: { pt: { type: "STRING" }, en: { type: "STRING" } },
  required: ["pt", "en"],
};

// ---------- Lesson digest (format 1) ----------
// Normally written ahead of time and committed to data/digests/. This builds one with Gemini
// from the raw chapter text when a lesson doesn't have one yet.

const DIGEST_SCHEMA = {
  type: "OBJECT",
  properties: {
    objectives: { type: "ARRAY", items: { type: "STRING" } },
    overview: { type: "STRING" },
    grammar: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          topic: { type: "STRING" },
          explanation: { type: "STRING" },
          table: {
            type: "OBJECT",
            nullable: true,
            properties: {
              headers: { type: "ARRAY", items: { type: "STRING" } },
              rows: { type: "ARRAY", items: { type: "ARRAY", items: { type: "STRING" } } },
            },
            required: ["headers", "rows"],
          },
          examples: { type: "ARRAY", items: PAIR },
          pitfalls: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["topic", "explanation", "examples", "pitfalls"],
      },
    },
    pronunciation: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { topic: { type: "STRING" }, explanation: { type: "STRING" }, examples: { type: "ARRAY", items: PAIR } },
        required: ["topic", "explanation", "examples"],
      },
    },
    vocabulary: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { pt: { type: "STRING" }, en: { type: "STRING" }, category: { type: "STRING" } },
        required: ["pt", "en", "category"],
      },
    },
    dialogue: {
      type: "OBJECT",
      nullable: true,
      properties: {
        title: { type: "STRING" },
        summary: { type: "STRING" },
        lines: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { speaker: { type: "STRING" }, pt: { type: "STRING" }, en: { type: "STRING" } },
            required: ["speaker", "pt", "en"],
          },
        },
      },
      required: ["title", "summary", "lines"],
    },
    culture: { type: "ARRAY", items: { type: "STRING" } },
    exercises: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { prompt: { type: "STRING" }, answer: { type: "STRING" } }, required: ["prompt", "answer"] },
    },
  },
  required: ["objectives", "overview", "grammar", "pronunciation", "vocabulary", "culture", "exercises"],
};

async function generateDigest({ apiKey, model, syllabus, lesson, lessonText }) {
  const text = await generateJson({
    apiKey,
    model,
    temperature: 0,
    schema: DIGEST_SCHEMA,
    parts: [{
      text: `Write a complete study digest of this lesson from the ${varietyOf(syllabus)}Portuguese textbook "${syllabus.title}".
Another model will later teach the lesson using ONLY your digest, so include everything a learner is expected to learn: every rule, every table, all the vocabulary, the dialogue, pronunciation points, and cultural notes. Be faithful to the textbook; don't add content it doesn't teach.

- "grammar": one entry per teachable topic (grammar, and other content like greetings or numbers). "explanation" in English, as a teacher would explain it. "table" is the topic's table (rows match headers) or null.
- "pronunciation": pronunciation topics, or [] if none.
- "vocabulary": all the lesson's vocabulary, nouns with their article, grouped by "category".
- "dialogue": the lesson's dialogue with English translations, or null.
- "exercises": 5-15 practice items from the chapter's exercises, rewritten to stand alone, with answers.

LESSON: ${lesson.title}
"""
${lessonText}
"""`,
    }],
  });
  return {
    format: 1,
    lesson: lesson.title,
    sources: lesson.sources,
    variety: syllabus.variety,
    generatedBy: model,
    generatedAt: todayKey(),
    dialogue: null,
    ...JSON.parse(text),
  };
}

// The learner can opt out of pronunciation (settings.skipPronunciation).
const NO_PRONUNCIATION_RULE =
  "\n- Don't teach or test pronunciation: no questions about sounds, stress, syllable division, or which accent mark a word takes. Spelling a word correctly (with its accents) is still fine.";

// Compact plain-text rendering of a digest for prompts.
function digestText(d, { brief = false, skipPronunciation = false } = {}) {
  const pairs = (xs) => xs.map((x) => `${x.pt} = ${x.en}`).join("; ");
  const lines = [`${d.lesson}: ${d.overview}`];
  if (!brief && d.objectives?.length) lines.push(`Objectives: ${d.objectives.join(" / ")}`);
  for (const g of d.grammar || []) {
    if (brief) {
      lines.push(`- ${g.topic}`);
      continue;
    }
    lines.push(`\n## ${g.topic}\n${g.explanation}`);
    if (g.table) lines.push([g.table.headers, ...g.table.rows].map((r) => r.join(" | ")).join("\n"));
    if (g.examples?.length) lines.push(`Examples: ${pairs(g.examples)}`);
    if (g.pitfalls?.length) lines.push(`Watch out: ${g.pitfalls.join(" / ")}`);
  }
  if (!brief && !skipPronunciation) {
    for (const p of d.pronunciation || []) lines.push(`\n## Pronunciation: ${p.topic}\n${p.explanation}${p.examples?.length ? `\nExamples: ${pairs(p.examples)}` : ""}`);
  }
  if (d.vocabulary?.length) lines.push(`\nVocabulary: ${pairs(brief ? d.vocabulary.slice(0, 12) : d.vocabulary)}`);
  if (!brief && d.dialogue) {
    lines.push(`\n## Dialogue: ${d.dialogue.title}\n${d.dialogue.summary}\n${d.dialogue.lines.map((l) => `${l.speaker}: ${l.pt} (${l.en})`).join("\n")}`);
  }
  if (!brief && d.culture?.length) lines.push(`\nCulture: ${d.culture.join(" / ")}`);
  return lines.join("\n");
}

// ---------- Daily lesson ----------

const DAILY_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    intro: { type: "STRING" },
    focus: { type: "STRING" },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { heading: { type: "STRING" }, body: { type: "STRING" }, examples: { type: "ARRAY", items: PAIR } },
        required: ["heading", "body", "examples"],
      },
    },
    vocabulary: { type: "ARRAY", items: PAIR },
    practice: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { prompt: { type: "STRING" }, answer: { type: "STRING" } }, required: ["prompt", "answer"] },
    },
    recap: { type: "STRING" },
  },
  required: ["title", "intro", "focus", "sections", "vocabulary", "practice", "recap"],
};

// How many days (including today) have been spent on this lesson.
function dayOnLesson(progress, lessonIndex) {
  const days = new Set((progress.history || []).filter((h) => h.lessonIndex === lessonIndex).map((h) => h.date));
  days.add(todayKey());
  return days.size;
}

// The digest's tables are shown as they are rather than rewritten: Gemini only picks which section each goes in.
function digestTables(digest) {
  return (digest.grammar || []).filter((g) => g.table?.headers?.length).map((g) => ({ topic: g.topic, ...g.table }));
}

function dailySchema(tables) {
  if (!tables.length) return DAILY_SCHEMA;
  const section = DAILY_SCHEMA.properties.sections.items;
  const tablesProp = { type: "ARRAY", items: { type: "STRING", format: "enum", enum: tables.map((t) => t.topic) } };
  return {
    ...DAILY_SCHEMA,
    properties: {
      ...DAILY_SCHEMA.properties,
      sections: { type: "ARRAY", items: { ...section, properties: { ...section.properties, tables: tablesProp } } },
    },
  };
}

// Swaps the topic names Gemini picked for the tables themselves. Any table it didn't place goes in a last section.
function attachTables(sections, tables) {
  const byTopic = new Map(tables.map((t) => [t.topic, t]));
  const placed = new Set();
  const out = sections.map((s) => {
    const picked = (s.tables || []).filter((t) => byTopic.has(t) && !placed.has(t));
    picked.forEach((t) => placed.add(t));
    return { ...s, tables: picked.map((t) => byTopic.get(t)) };
  });
  const rest = tables.filter((t) => !placed.has(t.topic));
  if (rest.length) out.push({ heading: "Tables for this lesson", body: "", examples: [], tables: rest });
  return out;
}

// Teaches only this lesson. Older mistakes are reviewed in the quiz, not here, so they aren't sent.
async function generateDailyLesson({ apiKey, model, syllabus, lessonIndex, digest, progress, skipPronunciation }) {
  const day = dayOnLesson(progress, lessonIndex);
  const performance = performanceNotes(progress, lessonIndex);
  const variety = varietyOf(syllabus);
  const tables = digestTables(digest);
  const text = await generateJson({
    apiKey,
    model,
    temperature: 0.8,
    schema: dailySchema(tables),
    parts: [{
      text: `You are a friendly, clear Portuguese tutor. Write today's lesson for an English-speaking learner of ${variety}Portuguese. It should take 5-10 minutes to read.

This is day ${day} on this textbook lesson. ${day === 1
        ? "Introduce the whole lesson in a sensible order."
        : "Don't repeat day 1. Re-teach with new examples and a different angle, spending most of the time on what I've struggled with, and briefly recap the rest."}

Teach ONLY this lesson, from the digest below. Don't introduce grammar or vocabulary beyond it, and don't teach or practise earlier lessons (they're reviewed separately in the quiz).

- "title": a short, friendly title for today.
- "intro": 2-3 sentences on what today covers.
- "focus": 1-2 sentences on what to pay attention to in this lesson, based on my results on this lesson below, or "" if there are none.
- "sections": 3-6 sections, each teaching one topic from this lesson. "body" is 1-3 short paragraphs separated by blank lines; use **bold** for key forms. 2-5 "examples" each, in ${variety}Portuguese with English.${tables.length ? `
- "tables": the digest tables to show in this section, by topic name. The page shows each table exactly as the digest has it, so don't write its contents out in "body"; teach around it. Place every table, each in one section: ${tables.map((t) => `"${t.topic}"`).join(", ")}.` : ""}
- "vocabulary": the 8-20 words and phrases to learn today, from this lesson, nouns with their article.
- "practice": 4-6 quick self-check items with answers, all testing what this lesson's sections taught. Don't give away the answer in the item.
- "recap": 2-3 sentences summing up.${skipPronunciation ? NO_PRONUNCIATION_RULE : ""}
${performance ? `\nMY RESULTS ON THIS LESSON\n${performance}\n` : ""}
LESSON DIGEST
${digestText(digest, { skipPronunciation })}`,
    }],
  });
  const dl = JSON.parse(text);
  return { ...dl, sections: attachTables(dl.sections || [], tables), date: todayKey(), lessonIndex, lesson: syllabus.lessons[lessonIndex].title, day, generatedBy: model };
}

function dailyLessonText(d) {
  return [
    `${d.title}\n${d.intro}`,
    ...d.sections.map((s) => `## ${s.heading}\n${s.body}${s.examples?.length ? `\nExamples: ${s.examples.map((e) => `${e.pt} = ${e.en}`).join("; ")}` : ""}`),
    d.vocabulary?.length ? `Vocabulary: ${d.vocabulary.map((v) => `${v.pt} = ${v.en}`).join("; ")}` : "",
  ].filter(Boolean).join("\n\n");
}

// ---------- Daily quiz ----------

const QUIZ_SCHEMA = {
  type: "OBJECT",
  properties: {
    lesson: { type: "STRING" },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["mc", "text"] },
          q: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          answer: { type: "STRING" },
          accept: { type: "ARRAY", items: { type: "STRING" } },
          explain: { type: "STRING" },
          reviewOf: { type: "STRING" },
          translation: { type: "STRING" },
        },
        required: ["type", "q", "answer", "explain"],
      },
    },
  },
  required: ["lesson", "questions"],
};

const QUESTION_RULES = `- About 60% "mc" (multiple choice, 4 options, "answer" is the exact text of the correct option) and 40% "text" (translate English to Portuguese, fill in the blank, or conjugate a verb).
- "text" answers must be short (one word up to one sentence). Put every reasonable alternative in "accept" (with/without subject pronoun, masculine/feminine, etc.).
- "explain" is one short sentence in English teaching the rule.
- For "mc", "translation" is a full, natural English translation of the correct answer. If the question is a Portuguese sentence with a blank, translate the whole completed sentence (e.g. "Ela ___ médica." with answer "é" → "She is a doctor."); otherwise translate the correct option itself (e.g. "o problema" → "the problem"). Leave it "" if the correct option is already English. Never give the translation away in the question.
- Multiple choice must have exactly ONE correct option. Every other option must be clearly wrong: not a rewording of the correct answer, not another valid way to state the same rule (e.g. "drop the m and add ns" vs "change m to n and add s" are the same answer), and not correct under some reasonable reading. No duplicate options, and no "all of the above" / "none of the above".
- Make the wrong options plausible mistakes a learner might actually make (wrong verb, wrong ending, wrong gender), so each question tests one clear point.
- Options that lead to the same result count as the same answer (e.g. "change -m to -n and add -s" and "change -m to -ns" both turn homem into homens).
- If a question gives Portuguese for some words, it must give it for every word the learner needs that isn't in the lesson vocabulary, and say so when two English words in it map to the same Portuguese word (e.g. "trip" and "voyage" are both viagem).
- Never give away the answer. An example in the question must not already contain it: no conjugated form of the verb being asked about, and no Portuguese for the word being translated. Use a blank instead: ask "Which verb completes: Isabel ___ na Europa?", not "Which verb do you use in 'Isabel está na Europa'?".
- When a question tests gender, number, or articles, don't let the options reveal it: list bare nouns ("casa, problema, aula, porta"), not "a casa, o problema, a aula, a porta", where the lone "o" gives away the masculine one.
- Translation prompts must be fully in English apart from names: never put Portuguese from the answer in the English sentence (titles like seu/dona, the target word or form), and hints must never cover the point being tested. "Translate: 'Good morning, seu Antônio.' (use 'bom dia')" gives away the whole answer; ask "Say 'Good morning, Mr. Antônio' to an older man, using the respectful title." instead.
- Before you answer, check every question: if a multiple-choice question has two acceptable options, a written question has an answer missing from "accept", or a question gives away its answer, fix it or replace the question.`;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Recent results on one lesson, to aim its lesson and quiz at what the learner has struggled with.
// Other lessons are left out: they belong to the review quiz.
function performanceNotes(progress, lessonIndex) {
  return (progress.history || [])
    .filter((h) => h.lessonIndex === lessonIndex)
    .slice(0, 3)
    .map((h) => `- ${h.date}, this lesson: ${h.right}/${h.total}${h.missed?.length ? `. Missed: ${h.missed.join("; ")}` : ""}`)
    .join("\n");
}

// The daily (and practice) quiz: today's lesson only. Older material is covered by the review quiz.
async function generateLessonQuiz({ apiKey, model, syllabus, lessonIndex, digest, dailyLesson, progress, n, skipPronunciation }) {
  const lesson = syllabus.lessons[lessonIndex];
  const performance = performanceNotes(progress, lessonIndex);
  const variety = varietyOf(syllabus);

  const prompt = `You are a Portuguese tutor writing today's quiz for an English-speaking learner studying ${variety}Portuguese with the textbook "${syllabus.title}". Use ${variety}Portuguese spelling and vocabulary.

${dailyLesson ? `WHAT I WAS TAUGHT TODAY
"""
${dailyLessonText(dailyLesson)}
"""

` : ""}COMPLETE LESSON DIGEST: ${lesson.title}
"""
${digestText(digest, { skipPronunciation })}
"""
${performance ? `
MY RESULTS ON THIS LESSON
${performance}
Aim the questions at the parts of this lesson I've struggled with, while still covering the rest.
` : ""}
Write exactly ${plural(n, "question")}, all on this lesson only (nothing from earlier lessons). Leave "reviewOf" empty.

Rules:
${QUESTION_RULES}
- Base the questions on what I was taught today, using new sentences rather than copying its examples. The digest is the full reference for this lesson.
- Only use vocabulary and grammar from this lesson (plus basics it relies on).${skipPronunciation ? NO_PRONUNCIATION_RULE : ""}
- "lesson" is "${lesson.title}".${progress.recentQuestions?.length ? `\n- Don't repeat any of these recent questions:\n${progress.recentQuestions.slice(0, 20).map((q) => `  - ${q}`).join("\n")}` : ""}`;

  return generateJson({ apiKey, model, parts: [{ text: prompt }], schema: QUIZ_SCHEMA, temperature: 1 });
}

// The review quiz: a new question for each due review item, topped up with earlier-lesson questions.
// due: review items to test; earlier: [{ lesson, digest|null }]. Returns { text, count }.
async function generateReviewQuiz({ apiKey, model, syllabus, due, earlier, progress, n, skipPronunciation }) {
  const variety = varietyOf(syllabus);
  const reviewCount = Math.min(due.length, n);
  const earlierCount = earlier.length ? n - reviewCount : 0;
  const count = reviewCount + earlierCount;
  const sections = [];
  if (reviewCount) {
    sections.push(`- ${plural(reviewCount, "question")}, one for each item I got wrong before (listed below). Write a NEW question testing the same point with a different sentence or wording. Set "reviewOf" to the item's id.`);
  }
  if (earlierCount) {
    sections.push(`- ${plural(earlierCount, "question")} reviewing the earlier lessons below, spread across them. Set "reviewOf" to "earlier".`);
  }

  const prompt = `You are a Portuguese tutor writing a review quiz for an English-speaking learner studying ${variety}Portuguese with the textbook "${syllabus.title}". Use ${variety}Portuguese spelling and vocabulary.
${reviewCount ? `
ITEMS I GOT WRONG BEFORE
${due.slice(0, reviewCount).map((m) => `  [${m.id}] Question: ${m.q} | Correct answer: ${m.expected}${m.explain ? ` | Rule: ${m.explain}` : ""}`).join("\n")}
` : ""}${earlierCount ? `
EARLIER LESSONS
${earlier.map((e) => (e.digest ? digestText(e.digest, { brief: true }) : e.lesson.title)).join("\n\n")}
` : ""}
Write exactly ${plural(count, "question")}:
${sections.join("\n")}

Rules:
${QUESTION_RULES}
- Only use vocabulary and grammar from the lessons and items above.${skipPronunciation ? NO_PRONUNCIATION_RULE : ""}
- "lesson" is "Review".${progress.recentQuestions?.length ? `\n- Don't repeat any of these recent questions:\n${progress.recentQuestions.slice(0, 20).map((q) => `  - ${q}`).join("\n")}` : ""}`;

  const text = await generateJson({ apiKey, model, parts: [{ text: prompt }], schema: QUIZ_SCHEMA, temperature: 1 });
  return { text, count };
}

// ---------- Quiz review ----------
// A second pass that checks a generated quiz against a checklist and returns a corrected copy.

// problems: optional specific issues found by the extension's own checks, to fix first.
async function reviewQuiz({ apiKey, model, syllabus, digest, quizText, skipPronunciation, problems = [] }) {
  const variety = varietyOf(syllabus);
  const vocab = (digest?.vocabulary || []).map((v) => `${v.pt} = ${v.en}`).join("; ");
  return generateJson({
    apiKey,
    model,
    temperature: 0,
    schema: QUIZ_SCHEMA,
    parts: [{
      text: `You are checking a ${variety}Portuguese quiz another tutor wrote, before a learner takes it. Return the full quiz in the same JSON shape, fixing any problems.

Check every question:
1. Multiple choice must have exactly ONE correct option. If two options are both correct, say the same thing in different words, or lead to the same result (e.g. "change -m to -n and add -s" vs "change -m to -ns"), replace the extra ones with clearly wrong but plausible options. "answer" must be exactly the correct option's text.
2. The answer key must be correct ${variety}Portuguese, with correct accents. Fix any wrong answer. For "mc", "translation" must be an accurate English translation of the correct answer (the whole completed sentence when the question is a Portuguese sentence with a blank); add or fix it.
3. Written questions: "accept" must list every correct alternative (with or without the subject pronoun or article where the question allows it, masculine/feminine where the question is ambiguous) and nothing incorrect.
4. Vocabulary hints: if a question gives the Portuguese for some words, it must give it for every word needed that isn't in the lesson vocabulary below, and say when two English words map to the same Portuguese word (e.g. "trip" and "voyage" are both viagem).
5. No giveaways: a question must not contain its own answer or an obvious form of it. Check every example sentence inside a question: "Which verb states location, as in 'Isabel está na Europa'?" gives away ESTAR, and "Which verb expresses a profession, as in 'Ele é médico'?" gives away SER. Replace the giveaway word with a blank ("Isabel ___ na Europa"), or rewrite the question. Translation prompts must be fully in English apart from names, with no Portuguese from the answer in them and no hint that covers the point being tested: "Translate: 'Good morning, seu Antônio.' (use 'bom dia')" gives away the whole answer. Also check that the correct option isn't the only one that fits the question's grammar or wording, and that options don't carry markers that reveal the answer: for a gender question, "a casa / o problema / a aula / a porta" gives away the masculine noun through its article, so list bare nouns instead.
6. Each question must be answerable from its own text and must stick to the lesson.${skipPronunciation ? "\n7. No pronunciation questions (sounds, stress, syllables, which accent mark a word takes). Replace any with a question on the lesson's grammar or vocabulary." : ""}

Keep the same number of questions in the same order, and keep each question's "type", "reviewOf", and the quiz's "lesson". Only rewrite or replace questions that have a problem; leave good ones exactly as they are.
${problems.length ? `
THESE PROBLEMS WERE FOUND AUTOMATICALLY. Fix them first by rewriting those questions so the answer isn't in the question:
${problems.map((p) => `- ${p}`).join("\n")}
` : ""}
LESSON VOCABULARY
${vocab || "(not available)"}

QUIZ
${quizText}`,
    }],
  });
}

// ---------- Answer judging ----------

// Vocab quiz: is the learner's English an acceptable meaning of the Portuguese word?
async function judgeVocab({ apiKey, model, pt, en, given }) {
  const text = await generateJson({
    apiKey,
    model,
    temperature: 0,
    schema: {
      type: "OBJECT",
      properties: { correct: { type: "BOOLEAN" }, feedback: { type: "STRING" } },
      required: ["correct", "feedback"],
    },
    parts: [{
      text: `A Portuguese learner was asked what a word means in English.

Portuguese: ${pt}
Dictionary meaning: ${en}
Learner's answer: ${given}

Mark it correct if the learner's English means the same thing as the Portuguese word: synonyms and close equivalents count (e.g. "physician" for "doctor"), and spelling slips, articles ("a", "the"), "to" before verbs, singular/plural, and capitalization don't matter. Mark it incorrect if it's a different meaning.
"feedback" is one short sentence in English.`,
    }],
  });
  const r = JSON.parse(text);
  return { correct: !!r.correct, feedback: String(r.feedback || "") };
}

async function judgeAnswer({ apiKey, model, question, expected, accept, given }) {
  const text = await generateJson({
    apiKey,
    model,
    temperature: 0,
    schema: {
      type: "OBJECT",
      properties: { correct: { type: "BOOLEAN" }, feedback: { type: "STRING" } },
      required: ["correct", "feedback"],
    },
    parts: [{
      text: `You are grading a Portuguese learner's answer to a quiz question.

Question: ${question}
Answer key: ${[expected, ...(accept || [])].join(" | ")}
Learner's answer: ${given}

Mark it correct if it is grammatically correct Portuguese that answers the question with the same meaning, even if it differs from the answer key. It must still use the grammar point the question is testing.
Ignore accents, capitalization, and punctuation: missing or wrong accents never make an answer incorrect (but show the correct accents in the feedback). Letters still matter: a different spelling or form of the word being tested is incorrect even if it's close (for example "faroes" for "faróis").
"feedback" is one or two short sentences in English: why it's right or wrong, and the fix if wrong.`,
    }],
  });
  const r = JSON.parse(text);
  return { correct: !!r.correct, feedback: String(r.feedback || "") };
}
