// Reads lessons from a Pressbooks textbook (such as https://wisc.pb.unizin.org/portuguese/)
// through its public REST API.

function bookApi(bookUrl, path) {
  const base = bookUrl.endsWith("/") ? bookUrl : `${bookUrl}/`;
  return new URL(`wp-json/pressbooks/v2/${path}`, base).href;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url} (${res.status}).`);
  return res.json();
}

const decodeEntities = (s) => new DOMParser().parseFromString(s, "text/html").documentElement.textContent;

// Builds the lesson list. Each "Diálogo N" is folded into the lesson before it;
// front matter only contributes its "Preliminary Lesson" chapters.
async function fetchBookSyllabus(bookUrl) {
  const [toc, meta] = await Promise.all([fetchJson(bookApi(bookUrl, "toc")), fetchJson(bookApi(bookUrl, "metadata")).catch(() => ({}))]);
  const lessons = [];
  const source = (ch, type) => ({ id: ch.id, type, title: decodeEntities(ch.title), link: ch.link });

  for (const ch of toc["front-matter"] || []) {
    if (ch.word_count > 0 && /lesson|li[cç][aã]o/i.test(ch.title)) {
      lessons.push({ title: decodeEntities(ch.title), sources: [source(ch, "front-matter")] });
    }
  }
  for (const part of toc.parts || []) {
    for (const ch of part.chapters || []) {
      if (!ch.word_count) continue;
      const src = source(ch, "chapters");
      if (/^di[aá]logo/i.test(src.title) && lessons.length) lessons.at(-1).sources.push(src);
      else lessons.push({ title: src.title, sources: [src] });
    }
  }
  if (!lessons.length) throw new Error("No lessons found in that book.");

  const about = `${meta.description || ""} ${meta.disambiguatingDescription || ""}`;
  return {
    bookUrl,
    title: meta.name ? decodeEntities(meta.name) : "Textbook",
    variety: /brazil/i.test(about) ? "Brazilian" : /portugal|european/i.test(about) ? "European" : "Unclear",
    license: meta.license?.name || "",
    lessons,
  };
}

// A lesson's files are named after its first chapter's slug, e.g. "licao-1".
function lessonSlug(lesson) {
  const link = lesson.sources[0].link;
  return new URL(link).pathname.split("/").filter(Boolean).pop() || String(lesson.sources[0].id);
}

const digestPath = (lesson) => `${DATA_DIR}/digests/${lessonSlug(lesson)}.json`;
const dailyLessonPath = (date, lesson) => `${DATA_DIR}/lessons/${date.slice(0, 4)}/${date}-${lessonSlug(lesson)}.json`;

// Keeps per-lesson additions (skip flags) for lessons that still exist, matched by their first
// chapter, when the table of contents is reloaded.
function mergeSyllabus(old, fresh) {
  if (!old) return fresh;
  const extras = new Map(old.lessons.map((l) => [l.sources?.[0]?.id, { skip: l.skip, skipReason: l.skipReason }]));
  return {
    ...fresh,
    lessons: fresh.lessons.map((l) => {
      const x = extras.get(l.sources[0].id) || {};
      return Object.fromEntries(Object.entries({ ...l, ...x }).filter(([, v]) => v !== undefined));
    }),
  };
}

// Lessons marked "skip": true (e.g. pronunciation-only ones) are stepped over when moving on and reviewing.
const isSkipped = (syllabus, i) => !!syllabus.lessons[i]?.skip;

// The next lesson after `from` that isn't skipped, or -1 at the end of the book.
function nextLessonIndex(syllabus, from) {
  for (let i = from + 1; i < syllabus.lessons.length; i++) if (!isSkipped(syllabus, i)) return i;
  return -1;
}

const earlierLessonIndexes = (syllabus, i) => [...Array(i).keys()].filter((j) => !isSkipped(syllabus, j));

// Converts chapter HTML to plain text, keeping tables (conjugations, vocabulary) as rows of cells.
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, audio, video, iframe, img, svg, noscript, button").forEach((e) => e.remove());
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|UL|OL|TR|BR|HR|BLOCKQUOTE|DL|DT|DD|FIGURE|FIGCAPTION|HEADER|FOOTER)$/;
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const out = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return out.push(node.nodeValue.replace(/\s+/g, " "));
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === "TABLE") {
      const rows = [...node.rows].map((r) => [...r.cells].map((c) => clean(c.textContent)).join(" | "));
      return out.push(`\n${rows.join("\n")}\n`);
    }
    if (/^H[1-6]$/.test(tag)) return out.push(`\n\n## ${clean(node.textContent)}\n`);
    out.push(tag === "LI" ? "\n- " : BLOCK.test(tag) ? "\n" : "");
    node.childNodes.forEach(walk);
    if (BLOCK.test(tag)) out.push("\n");
  };
  walk(doc.body);
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchLessonText(syllabus, lesson) {
  const parts = await Promise.all(
    lesson.sources.map(async (s) => {
      const ch = await fetchJson(bookApi(syllabus.bookUrl, `${s.type}/${s.id}`));
      return `# ${s.title}\n\n${htmlToText(ch.content?.rendered || "")}`;
    })
  );
  return parts.join("\n\n");
}
