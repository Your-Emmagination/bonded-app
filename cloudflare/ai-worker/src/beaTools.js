// cloudflare/ai-worker/src/beaTools.js
//
// The only doors B.E.A.'s AI has into BondED's data. The AI never talks
// to Firestore: it asks for one of these tools by name, this Worker checks
// the arguments, runs that one fixed query, and hands back only the fields
// listed below.
//
// Why this matters: the Worker reads Firestore with a service account, which
// is NOT bound by firestore.rules. The phone's old chatbot was protected by
// the rules; here, these allowlists are the protection. A field that isn't
// listed is never read from the database, and never reaches the AI.

// ═══════════════════════════════════════════════════════════════════════
// CONFIG — change these if your collection or field names differ.
// ═══════════════════════════════════════════════════════════════════════

/** Where each tool reads. The keys are what the code uses; edit the values. */
export const BEA_COLLECTIONS = {
  events: "events",
  programs: "programs",
  campusFaq: "campusFaq",
  // AI Memory entries live in communityServers, marked recordType "aiMemory"
  // (see utils/aiMemory.ts). Only "global" ones are used here: server and
  // channel memories belong to one server, which may be private.
  aiMemory: "communityServers",
  posts: "posts",
  profiles: "students",
  // Doesn't exist yet. Expected shape of each document:
  //   { position: "President", name: "Juan Santos", schoolYear: "2026-2027",
  //     order: 1, active: true }
  // Until an admin creates it, B.E.A. says the officers aren't in the database.
  schoolOfficers: "schoolOfficers",
};

/**
 * The only fields ever read from each collection. The query asks Firestore for
 * these alone, and the tools copy a subset of them into their answers.
 */
export const BEA_FIELDS = {
  events: [
    "title", "description", "date", "endDate", "startTime", "endTime",
    "category", "venue", "forPrograms", "cancelled", "status", "parentEventId",
  ],
  programs: ["name", "code", "description"],
  campusFaq: ["question", "answer"],
  aiMemory: ["recordType", "title", "content", "scopeType", "tags", "active", "priority"],
  posts: [
    "flair", "content", "moderationStatus", "createdAt", "isAnonymous",
    "username", "lostFoundStatus", "resolvedAt",
  ],
  // position: a teacher's Faculty / Program Chair / Dean.
  profiles: ["firstname", "lastname", "role", "position"],
  schoolOfficers: ["position", "name", "schoolYear", "order", "active"],
};

/** Post flairs, as saved on posts. */
export const BEA_FLAIRS = { announcement: "announcement", lostFound: "lost_found" };

/** Staff roles B.E.A. may name. Only first name, last name, role and a teacher's position, ever. */
export const BEA_STAFF_ROLES = ["teacher", "moderator", "admin"];

/** The school's clock, for "today". The Worker itself runs on UTC. */
export const BEA_UTC_OFFSET_HOURS = 8;

// ═══════════════════════════════════════════════════════════════════════

/** Never returned by any tool, whatever the data looks like. The tests check this. */
export const BEA_FORBIDDEN_KEYS = [
  "email", "recoveryEmail", "phone", "studentID", "uid", "userId",
  "realUserId", "id", "password", "address", "birthday",
];

const MAX_TEXT = 100;
const MAX_RESULTS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "in", "on",
  "at", "for", "and", "or", "what", "who", "whom", "when", "where", "which",
  "how", "why", "do", "does", "did", "our", "we", "i", "me", "my", "you",
  "your", "it", "its", "this", "that", "there", "can", "could", "please",
  "tell", "about", "with", "from", "any", "have", "has", "school",
]);

/** A trimmed string no longer than `max`, or "" for anything else. */
export function cleanText(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** A whole number from 1 to `max`; `fallback` when missing or unusable. */
export function clampLimit(value, fallback = 5, max = MAX_RESULTS) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(1, Math.round(number)));
}

/** Words that carry meaning, for matching a question against stored text. */
export function keywordsOf(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * The entries that best match a question, best first. Words in the title or
 * question count double, since that's what an entry is about. Entries that
 * share no word with the question are dropped.
 */
export function rankByKeywords(query, entries, { titleOf, bodyOf, limit = 3 }) {
  const wanted = new Set(keywordsOf(query));
  if (wanted.size === 0) return [];
  return entries
    .map((entry) => {
      const title = keywordsOf(titleOf(entry));
      const body = keywordsOf(bodyOf(entry));
      let score = 0;
      for (const word of new Set(title)) if (wanted.has(word)) score += 2;
      for (const word of new Set(body)) if (wanted.has(word)) score += 1;
      return { entry, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.entry);
}

/** Only the named keys, and never a forbidden one. */
export function pickFields(source, keys) {
  const out = {};
  for (const key of keys) {
    if (BEA_FORBIDDEN_KEYS.includes(key)) continue;
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

const trimTo = (value, max) => {
  const text = cleanText(value, 10_000);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  return 0;
};

/** "2026-09-23", on the school's clock. */
export function schoolDate(nowMs, offsetDays = 0) {
  const shifted = new Date(nowMs + BEA_UTC_OFFSET_HOURS * 3600_000 + offsetDays * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

// ── Events, read the way the calendar shows them ────────────────────────
// A main event and its timed parts (parentEventId) are one event with a
// program, not separate events. Times are on the school's clock (UTC+8).

/** The document id select() attaches for tools that need it. Never output. */
export const DOC_ID = "__docId";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PH_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric",
});
const PH_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit",
});

/** "08:00" from "8:00" or "08:00:00"; "" when it isn't a time. */
function clockOf(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value || "").trim());
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return "";
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

const schoolMs = (dateKey, clock = "00:00") => Date.parse(`${dateKey}T${clock}:00+08:00`);

/** When an event starts and ends, or null when its dates can't be read. */
export function eventWindow(event) {
  const date = String(event?.date || "");
  const endDate = String(event?.endDate || event?.date || "");
  if (!DATE_KEY.test(date) || !DATE_KEY.test(endDate)) return null;
  const start = clockOf(event.startTime);
  const end = clockOf(event.endTime);
  const allDay = event.category === "all-day" || (!start && !end);
  const startMs = schoolMs(date, allDay ? "00:00" : start || "00:00");
  let endMs = !allDay && end ? schoolMs(endDate, end) : schoolMs(endDate) + DAY_MS;
  // Old records had no endDate, and an earlier end time meant the next day.
  if (!event.endDate && !allDay && start && end && endMs <= startMs) endMs += DAY_MS;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs, allDay, hasEnd: allDay || Boolean(end) };
}

/** "Fri, Sep 26, 8:00 AM – 5:00 PM", "Fri, Sep 26 – Sat, Sep 27", "Fri, Sep 26 (all day)". */
export function describeWhen(window) {
  const firstDay = PH_DAY.format(window.startMs);
  const lastDay = PH_DAY.format(window.endMs - 1);
  if (window.allDay) return firstDay === lastDay ? `${firstDay} (all day)` : `${firstDay} – ${lastDay}`;
  const start = `${firstDay}, ${PH_TIME.format(window.startMs)}`;
  if (!window.hasEnd) return start;
  return firstDay === lastDay
    ? `${start} – ${PH_TIME.format(window.endMs)}`
    : `${start} – ${lastDay}, ${PH_TIME.format(window.endMs)}`;
}

/** Where an event stands at nowMs. */
function eventStatus(window, nowMs) {
  if (nowMs >= window.endMs) return "done";
  if (nowMs >= window.startMs) return "happening now";
  return PH_DAY.format(window.startMs) === PH_DAY.format(nowMs) ? "later today" : "upcoming";
}

/**
 * The events still to come or running at nowMs, soonest first, each main
 * event with its program. Drafts and archived events are left out; a
 * cancelled one is kept and marked.
 */
export function upcomingEventGroups(rows, nowMs) {
  const listed = rows.filter((event) => {
    const status = String(event.status || "published");
    return status !== "draft" && status !== "archived";
  });
  const ids = new Set(listed.map((event) => event[DOC_ID]).filter(Boolean));
  const partsOf = new Map();
  const mains = [];
  for (const event of listed) {
    const parentId = String(event.parentEventId || "");
    if (parentId && ids.has(parentId)) {
      if (!partsOf.has(parentId)) partsOf.set(parentId, []);
      partsOf.get(parentId).push(event);
    } else {
      mains.push(event);
    }
  }
  return mains
    .map((event) => {
      const parts = (partsOf.get(event[DOC_ID]) || [])
        .map((part) => ({ part, window: eventWindow(part) }))
        .filter((entry) => entry.window)
        .sort((a, b) => a.window.startMs - b.window.startMs);
      const own = eventWindow(event);
      const windows = [own, ...parts.map((entry) => entry.window)].filter(Boolean);
      if (!windows.length) return null;
      return {
        event,
        parts,
        window: {
          startMs: Math.min(...windows.map((w) => w.startMs)),
          endMs: Math.max(...windows.map((w) => w.endMs)),
          allDay: own ? own.allDay : false,
          // With parts, the last part's end is a real end.
          hasEnd: parts.length > 0 || !own || own.hasEnd,
        },
        ownWindow: own,
      };
    })
    .filter((group) => group && group.window.endMs > nowMs)
    .sort((a, b) => a.window.startMs - b.window.startMs);
}

// ── The tools ───────────────────────────────────────────────────────────
// Each has a declaration for the AI, a validator that returns clean arguments or
// null, and a runner that reads through deps.select() only.

const TOOLS = {
  get_upcoming_events: {
    declaration: {
      name: "get_upcoming_events",
      description:
        "Upcoming and ongoing school events from the BondED campus calendar, soonest first: title, when (Philippine time), status (happening now / later today / upcoming), venue, which programs they are for, whether they were cancelled, and for a big event its program of timed parts still to come.",
      parameters: {
        type: "OBJECT",
        properties: {
          limit: { type: "INTEGER", description: "How many events, 1 to 10. Default 5." },
        },
      },
    },
    validate: (args) => ({ limit: clampLimit(args.limit, 5) }),
    run: async ({ limit }, caller, deps) => {
      const today = schoolDate(deps.nowMs);
      const now = `${PH_DAY.format(deps.nowMs)}, ${PH_TIME.format(deps.nowMs)}`;
      // Starting up to a month ago, so a long event still running is found.
      const rows = await deps.select("events", [
        { field: "date", op: "GREATER_THAN_OR_EQUAL", value: schoolDate(deps.nowMs, -31) },
      ], 300);
      const events = upcomingEventGroups(rows, deps.nowMs)
        .slice(0, limit)
        .map(({ event, parts, window }) => {
          // A part follows its main event's audience.
          const programs = Array.isArray(event.forPrograms)
            ? event.forPrograms.map((program) => cleanText(program)).filter(Boolean)
            : [];
          const upcomingParts = parts.filter((entry) => entry.window.endMs > deps.nowMs);
          const doneParts = parts.length - upcomingParts.length;
          return {
            ...pickFields(event, ["title", "venue"]),
            when: describeWhen(window),
            status: eventStatus(window, deps.nowMs),
            ...(event.description ? { description: trimTo(event.description, 200) } : {}),
            audience: programs.length ? programs.join(", ") : "Whole campus",
            forYourProgram: programs.length === 0 || programs.includes(String(caller.course || "")),
            ...(event.cancelled === true ? { cancelled: true } : {}),
            ...(parts.length
              ? {
                  // Its timed parts still to come or running, in order.
                  program: upcomingParts.slice(0, 10).map((entry) => ({
                    ...pickFields(entry.part, ["title", "venue"]),
                    when: describeWhen(entry.window),
                    status: eventStatus(entry.window, deps.nowMs),
                  })),
                  ...(upcomingParts.length > 10 ? { morePartsLater: upcomingParts.length - 10 } : {}),
                  ...(doneParts ? { partsAlreadyDone: doneParts } : {}),
                }
              : {}),
          };
        });
      return events.length ? { found: true, today, now, events } : { found: false, today, now };
    },
  },

  get_academic_programs: {
    declaration: {
      name: "get_academic_programs",
      description: "The academic programs (courses) the school offers, with their codes.",
    },
    validate: () => ({}),
    run: async (_args, _caller, deps) => {
      const rows = await deps.select("programs", [], 60);
      const programs = rows
        .filter((program) => cleanText(program.name))
        .map((program) => ({
          ...pickFields(program, ["name", "code"]),
          ...(program.description ? { description: trimTo(program.description, 200) } : {}),
        }));
      return programs.length ? { found: true, programs } : { found: false };
    },
  },

  search_campus_knowledge: {
    declaration: {
      name: "search_campus_knowledge",
      description:
        "Searches the school's own FAQ and knowledge notes (policies, offices, procedures, schedules, requirements, facilities). Use it for any question about how things work at this school.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "The question or its key words." },
          limit: { type: "INTEGER", description: "How many results, 1 to 5. Default 3." },
        },
        required: ["query"],
      },
    },
    validate: (args) => {
      const query = cleanText(args.query);
      return query ? { query, limit: clampLimit(args.limit, 3, 5) } : null;
    },
    run: async ({ query, limit }, _caller, deps) => {
      const [faqRows, memoryRows] = await Promise.all([
        deps.select("campusFaq", [], 400),
        deps.select("aiMemory", [{ field: "recordType", op: "EQUAL", value: "aiMemory" }], 300),
      ]);
      const entries = [
        ...faqRows
          .filter((row) => cleanText(row.question) && cleanText(row.answer))
          .map((row) => ({ source: "campus_faq", title: row.question, text: row.answer, tags: [] })),
        ...memoryRows
          .filter((row) => row.active !== false && row.scopeType === "global")
          .filter((row) => cleanText(row.title) && cleanText(row.content))
          .map((row) => ({
            source: "ai_memory",
            title: row.title,
            text: row.content,
            tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
          })),
      ];
      const results = rankByKeywords(query, entries, {
        titleOf: (entry) => `${entry.title} ${entry.tags.join(" ")}`,
        bodyOf: (entry) => entry.text,
        limit,
      }).map((entry) => ({
        source: entry.source,
        title: trimTo(entry.title, 200),
        text: trimTo(entry.text, 800),
      }));
      return results.length ? { found: true, results } : { found: false };
    },
  },

  get_announcements: {
    declaration: {
      name: "get_announcements",
      description: "The latest official announcements posted in BondED.",
      parameters: {
        type: "OBJECT",
        properties: {
          limit: { type: "INTEGER", description: "How many, 1 to 10. Default 5." },
        },
      },
    },
    validate: (args) => ({ limit: clampLimit(args.limit, 5) }),
    run: async ({ limit }, _caller, deps) => {
      const rows = await deps.select("posts", [
        { field: "flair", op: "EQUAL", value: BEA_FLAIRS.announcement },
      ], 300);
      const announcements = rows
        .filter((post) => post.moderationStatus === "approved" && cleanText(post.content))
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
        .slice(0, limit)
        .map((post) => ({
          text: trimTo(post.content, 300),
          postedOn: toMillis(post.createdAt) ? new Date(toMillis(post.createdAt)).toISOString().slice(0, 10) : undefined,
          postedBy: post.isAnonymous === true ? "Anonymous" : cleanText(post.username, 60) || "BondED",
        }));
      return announcements.length ? { found: true, announcements } : { found: false };
    },
  },

  find_lost_and_found: {
    declaration: {
      name: "find_lost_and_found",
      description:
        "Open Lost & Found posts from the last 30 days: what was lost or found and its status. Never says who posted.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "Optional: the item, e.g. 'black umbrella'." },
        },
      },
    },
    validate: (args) => ({ query: cleanText(args.query) }),
    run: async ({ query }, _caller, deps) => {
      const since = deps.nowMs - 30 * DAY_MS;
      const rows = await deps.select("posts", [
        { field: "flair", op: "EQUAL", value: BEA_FLAIRS.lostFound },
      ], 400);
      const open = rows
        .filter((post) => post.moderationStatus === "approved" && cleanText(post.content))
        .filter((post) => !post.resolvedAt && post.lostFoundStatus !== "returned")
        .filter((post) => toMillis(post.createdAt) >= since)
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      const chosen = query
        ? rankByKeywords(query, open, { titleOf: () => "", bodyOf: (post) => post.content, limit: MAX_RESULTS })
        : open.slice(0, MAX_RESULTS);
      const items = chosen.map((post) => ({
        text: trimTo(post.content, 250),
        status: cleanText(post.lostFoundStatus, 20) || "lost",
        postedOn: new Date(toMillis(post.createdAt)).toISOString().slice(0, 10),
      }));
      return items.length ? { found: true, items } : { found: false };
    },
  },

  find_staff: {
    declaration: {
      name: "find_staff",
      description:
        "Finds school staff in BondED by name, role (teacher, moderator, admin) or a teacher's position (Faculty, Program Chair, Dean) — e.g. who the dean is. Gives name, role and position only — never contact details.",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Optional: part of the person's name." },
          role: { type: "STRING", description: "Optional: teacher, moderator or admin." },
          position: { type: "STRING", description: "Optional: Faculty, Program Chair or Dean." },
        },
      },
    },
    validate: (args) => {
      const role = cleanText(args.role, 20).toLowerCase();
      if (role && !BEA_STAFF_ROLES.includes(role)) return null;
      const position = cleanText(args.position, 30).toLowerCase();
      return { name: cleanText(args.name, 60), role, position };
    },
    run: async ({ name, role, position }, _caller, deps) => {
      const rows = await deps.select("profiles", [
        { field: "role", op: "IN", value: role ? [role] : BEA_STAFF_ROLES },
      ], 300);
      const people = rows
        .map((row) => {
          const title = cleanText(row.position, 30);
          return {
            name: `${cleanText(row.firstname, 40)} ${cleanText(row.lastname, 40)}`.trim(),
            role: cleanText(row.role, 20),
            ...(title ? { position: title } : {}),
          };
        })
        .filter((person) => person.name)
        .filter((person) => !position || (person.position || "").toLowerCase() === position);
      const matched = name
        ? rankByKeywords(name, people, {
            titleOf: (person) => person.name,
            bodyOf: (person) => person.position || "",
            limit: MAX_RESULTS,
          })
        : people.slice(0, MAX_RESULTS);
      return matched.length ? { found: true, staff: matched } : { found: false };
    },
  },

  get_school_officers: {
    declaration: {
      name: "get_school_officers",
      description:
        "The current student government / school officers (president, vice president and so on) and their school year.",
    },
    validate: () => ({}),
    run: async (_args, _caller, deps) => {
      const rows = await deps.select("schoolOfficers", [], 60);
      const officers = rows
        .filter((row) => row.active !== false && cleanText(row.name) && cleanText(row.position))
        .sort((a, b) => Number(a.order || 99) - Number(b.order || 99))
        .map((row) => pickFields(row, ["position", "name", "schoolYear"]));
      return officers.length ? { found: true, officers } : { found: false };
    },
  },
};

/** What the AI is told it may call (index.js converts it to the chat API's format). */
export const BEA_TOOL_DECLARATIONS = Object.values(TOOLS).map((tool) => tool.declaration);

export const BEA_TOOL_NAMES = Object.keys(TOOLS);

/**
 * Runs one tool for the AI. `deps.select(key, filters, max)` reads the
 * collection named by BEA_COLLECTIONS[key], returning only BEA_FIELDS[key].
 * Never throws: bad input, unknown tools and database errors all come back as
 * a small { error } object the AI can explain.
 */
export async function runBeaTool(name, rawArgs, caller, deps) {
  const tool = TOOLS[name];
  if (!tool) return { error: "unknown_tool" };
  const args = tool.validate(rawArgs && typeof rawArgs === "object" ? rawArgs : {});
  if (!args) return { error: "bad_arguments" };
  try {
    return await tool.run(args, caller || {}, deps);
  } catch (error) {
    deps.log?.(`[bea] ${name} failed: ${error?.message || error}`);
    return { error: "unavailable" };
  }
}
