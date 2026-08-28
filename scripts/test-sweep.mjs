#!/usr/bin/env node
// =============================================================================
// test-sweep.mjs — offline tests for sweep.mjs. NO live API calls:
// the model layer is mocked via main({ callModel }) injection, and the
// pause_turn/retry loop is tested with a fake fetch.
// Run: node scripts/test-sweep.mjs
// =============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main, callModel, validateAndNormalize, dedup, mergeRecurring, sortForFile,
  parseEventArray, slugify, eventId, nextSaturdays, todayInNewYorkISO,
  urlScore, normalizeNeighborhood, normalizeCategory, normalizeAge, TRACKS, TRACK_CONCURRENCY, REQUEST_TIMEOUT_MS,
  titleKey, hostnameOf, isAllowedHost, showsInWindow, dedupNear, titleOverlap,
  validateRecurringLayer, salvageObjects, searchErrorsIn, estimateCost, isWeekendDay, isNearDuplicate,
  MODEL, WEB_SEARCH_TOOL, MAX_TOKENS, USE_STRUCTURED_OUTPUT, ALLOWED_URL_HOSTS
} from "./sweep.mjs";

let n = 0; const fails = [];
const t = (name, cond) => { n++; if (!cond) fails.push(name); };
const NOW = "2026-06-11T10:00:00Z"; // a Thursday; first covered Sat = 2026-06-13
const WINDOW = { firstFri: "2026-06-12", firstSat: "2026-06-13", lastSun: "2026-07-19" };
const quiet = () => {};

// A scenario that throws (as scenario 9 did — it asserted on a file main() had
// deliberately not written) used to kill the run before any result printed, so
// every other check went unreported. Now a crash is just a failed check.
async function scenario(name, fn) {
  try { await fn(); }
  catch (e) { n++; fails.push(`${name} threw: ${e.message}`); }
}

// Base valid model entry (the shape the system prompt demands — no id)
const base = {
  title: "Wharf SummerFest Kickoff", eventType: "single", date: "2026-06-13",
  startDate: null, endDate: null, time: "12 PM–9 PM",
  venue: "District Pier at The Wharf", neighborhood: "Southwest / The Wharf",
  worthTheTrip: false, category: "outdoor", price: "Free", isFree: true,
  isLowCost: true, goodForTeens: true, ageRestriction: "All ages",
  description: "Waterfront festival.", url: "https://www.wharfdc.com/whats-happening/",
  source: "wharfdc.com", recurring: false, confidence: "high"
};
const mk = (over) => ({ ...base, ...over });

// ---------------------------------------------------------------------------
// slugify / eventId
// ---------------------------------------------------------------------------
t("slugify punctuation", slugify("9:30 Club") === "9-30-club");
t("slugify dashes/quotes", slugify("CrazySexyCool – The TLC Musical") === "crazysexycool-the-tlc-musical");
t("slugify diacritics", slugify("Café Citrón") === "cafe-citron");
t("eventId is host+title+year", eventId({ url: "https://www.arenastage.org/x", venue: "Arena Stage (Kreeger Theater)", title: "The Glass Door", startDate: "2026-06-16", date: null })
  === "arenastage-org-glass-door-2026");
t("eventId uses date year for singles", eventId({ url: "https://930.com/s", venue: "V", title: "Tourmaline", date: "2027-01-02", startDate: null }) === "930-com-tourmaline-2027");
t("eventId falls back to venue with no usable url", eventId({ url: "not a url", venue: "Yards Park", title: "Movie Night", date: "2026-06-13" }) === "yards-park-movie-night-2026");

// the churn that broke favourites: same event, venue string rewritten between runs
t("eventId survives a rewritten venue string", eventId({ url: "https://wharfdc.com/a", venue: "The Wharf (multiple stages: Arena Stage, Union Stage)", title: "DC JazzFest at The Wharf", date: "2026-06-13" })
  === eventId({ url: "https://www.wharfdc.com/b", venue: "The Wharf — District Pier, Arena Stage", title: "DC JazzFest at The Wharf – 22nd Annual Grand Finale Weekend", date: "2026-06-13" }));
t("eventId still separates different shows at one venue",
  eventId({ url: "https://930.com/a", venue: "9:30 Club", title: "Frog", date: "2026-06-13" }) !==
  eventId({ url: "https://930.com/b", venue: "9:30 Club", title: "Woods", date: "2026-06-13" }));

// ---------------------------------------------------------------------------
// titleKey — the stable part of a title
// ---------------------------------------------------------------------------
t("titleKey drops a trailing subtitle", titleKey("DC JazzFest at The Wharf – 22nd Annual Grand Finale Weekend") === titleKey("DC JazzFest at The Wharf"));
t("titleKey drops a colon subtitle", titleKey("Rock the Dock: Perfekt Blend") === titleKey("Rock the Dock"));
t("titleKey keeps a one-word head intact", titleKey("Nikola – A New Musical") === "nikola-new-musical");
t("titleKey ignores filler words", titleKey("The Fruits of Our Labor") === titleKey("Fruits of Our Labor"));
t("titleKey separates unrelated titles", titleKey("Venus") !== titleKey("Measure for Measure"));

// ---------------------------------------------------------------------------
// (S1) url host allowlist
// ---------------------------------------------------------------------------
t("hostnameOf strips www", hostnameOf("https://www.930.com/x") === "930.com");
t("hostnameOf on garbage", hostnameOf("not a url") === "");
t("allowlist accepts a listed host", isAllowedHost("https://www.arenastage.org/tickets"));
t("allowlist accepts a subdomain", isAllowedHost("https://tickets.wharfdc.com/e/1"));
t("allowlist rejects an unknown host", !isAllowedHost("https://free-dc-events.example.com/x"));
t("allowlist rejects a lookalike suffix", !isAllowedHost("https://not-930.com/x"));
t("allowlist rejects garbage", !isAllowedHost("javascript:alert(1)"));
t("allowlist is non-trivial", ALLOWED_URL_HOSTS.length > 30);

// ---------------------------------------------------------------------------
// Fri–Sun weekend
// ---------------------------------------------------------------------------
t("Friday is a weekend day", isWeekendDay("2026-06-12"));
t("Saturday is a weekend day", isWeekendDay("2026-06-13"));
t("Sunday is a weekend day", isWeekendDay("2026-06-14"));
t("Monday is not", !isWeekendDay("2026-06-15"));
t("Thursday is not", !isWeekendDay("2026-06-11"));

// ---------------------------------------------------------------------------
// date helpers
// ---------------------------------------------------------------------------
t("todayInNewYorkISO", todayInNewYorkISO(new Date(NOW)) === "2026-06-11");
t("nextSaturdays from Thu", JSON.stringify(nextSaturdays("2026-06-11", 3)) === JSON.stringify(["2026-06-13", "2026-06-20", "2026-06-27"]));
t("nextSaturdays includes Sat itself", nextSaturdays("2026-06-13", 1)[0] === "2026-06-13");

// ---------------------------------------------------------------------------
// normalizers
// ---------------------------------------------------------------------------
t("hood exact", normalizeNeighborhood("Capitol Hill") === "Capitol Hill");
t("hood case/space remap", normalizeNeighborhood("  southwest/the wharf ") === "Southwest / The Wharf");
t("hood unknown -> null", normalizeNeighborhood("Georgetown") === null);
t("cat exact", normalizeCategory("museums-culture") === "museums-culture");
t("cat case remap", normalizeCategory(" Theater ") === "theater");
t("cat derived free-lowcost rejected", normalizeCategory("free-lowcost") === null);
t("cat unknown -> null", normalizeCategory("street-festivals") === null);
t("age 21+ normalize", normalizeAge("21+ only, 2-drink min") === "21+");
t("age 18 + spaced", normalizeAge("18 +") === "18+");
t("age all ages passthrough", normalizeAge("All ages") === "All ages");
t("age null", normalizeAge(null) === null);

// ---------------------------------------------------------------------------
// validateAndNormalize
// ---------------------------------------------------------------------------
let v = validateAndNormalize(mk({}), WINDOW);
t("valid single accepted", !!v.event);
t("id computed in code", v.event.id === "wharfdc-com-wharf-summerfest-kickoff-2026");
v = validateAndNormalize(mk({ id: "model-made-this-up" }), WINDOW);
t("model id ignored", v.event.id === "wharfdc-com-wharf-summerfest-kickoff-2026");
t("bad category dropped", !!validateAndNormalize(mk({ category: "festivals" }), WINDOW).drop);
t("bad neighborhood dropped", !!validateAndNormalize(mk({ neighborhood: "Adams Morgan" }), WINDOW).drop);
t("single outside window dropped", !!validateAndNormalize(mk({ date: "2026-08-01" }), WINDOW).drop);
t("single before window dropped", !!validateAndNormalize(mk({ date: "2026-06-05" }), WINDOW).drop);
t("Friday inside window kept", !!validateAndNormalize(mk({ date: "2026-06-12" }), WINDOW).event);
t("Friday at the window edge kept", !!validateAndNormalize(mk({ date: "2026-06-19" }), WINDOW).event);
t("weekday event dropped", /not a Fri\/Sat\/Sun/.test(validateAndNormalize(mk({ date: "2026-06-17" }), WINDOW).drop || ""));
t("weekday drop names the day rule", /Fri/.test(validateAndNormalize(mk({ date: "2026-06-16" }), WINDOW).drop || ""));
t("off-allowlist url dropped", /not allowlisted/.test(validateAndNormalize(mk({ url: "https://spam.example.com/e" }), WINDOW).drop || ""));
t("allowlisted url kept", !!validateAndNormalize(mk({ url: "https://www.dclibrary.org/attend" }), WINDOW).event);
t("source is derived from the url, not the model", validateAndNormalize(mk({ source: "dc.theater / dc.events" }), WINDOW).event.source === "wharfdc.com");
t("garbage date dropped", !!validateAndNormalize(mk({ date: "June 13" }), WINDOW).drop);
t("missing url dropped", !!validateAndNormalize(mk({ url: null }), WINDOW).drop);
t("missing description dropped", !!validateAndNormalize(mk({ description: "" }), WINDOW).drop);
t("missing confidence dropped", !!validateAndNormalize(mk({ confidence: null }), WINDOW).drop);
t("eventType recurring from search dropped", !!validateAndNormalize(mk({ eventType: "recurring", date: null }), WINDOW).drop);

v = validateAndNormalize(mk({ ageRestriction: "21+", goodForTeens: true }), WINDOW);
t("21+ forces goodForTeens=false", v.event && v.event.goodForTeens === false);
v = validateAndNormalize(mk({ ageRestriction: "18+ w/ ID", goodForTeens: true }), WINDOW);
t("18+ variants coerced too", v.event && v.event.ageRestriction === "18+" && v.event.goodForTeens === false);

v = validateAndNormalize(mk({ neighborhood: "Worth the Trip", worthTheTrip: false }), WINDOW);
t("WTT hood coerces flag true", v.event && v.event.worthTheTrip === true);
v = validateAndNormalize(mk({ worthTheTrip: true }), WINDOW); // DC hood, stray flag
t("DC hood coerces flag false", v.event && v.event.worthTheTrip === false);

v = validateAndNormalize(mk({ recurring: true }), WINDOW);
t("searched entry recurring forced false", v.event && v.event.recurring === false);

// runs
const run = mk({ eventType: "run", date: null, startDate: "2026-06-16", endDate: "2026-08-09" });
v = validateAndNormalize(run, WINDOW);
t("run overlapping window kept (extends past end)", !!v.event);
t("run keeps null date", v.event.date === null);
t("run id from startDate year", v.event.id.endsWith("-2026"));
t("run fully before window dropped", !!validateAndNormalize(mk({ eventType: "run", date: null, startDate: "2026-05-01", endDate: "2026-06-10" }), WINDOW).drop);
t("run start>end dropped", !!validateAndNormalize(mk({ eventType: "run", date: null, startDate: "2026-07-01", endDate: "2026-06-01" }), WINDOW).drop);
t("run missing endDate dropped", !!validateAndNormalize(mk({ eventType: "run", date: null, startDate: "2026-06-16", endDate: null }), WINDOW).drop);
v = validateAndNormalize(mk({ eventType: "single", startDate: "2026-06-13", endDate: "2026-06-14" }), WINDOW);
t("single nulls run fields", v.event && v.event.startDate === null && v.event.endDate === null);

// string booleans + source derivation
v = validateAndNormalize(mk({ isFree: "true", isLowCost: "false", source: "" }), WINDOW);
t("string booleans normalized", v.event && v.event.isFree === true && v.event.isLowCost === false);
t("source derived from url", v.event.source === "wharfdc.com");

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------
const dA = validateAndNormalize(mk({ confidence: "medium" }), WINDOW).event;
const dB = validateAndNormalize(mk({ confidence: "high", url: "https://www.eventbrite.com/e/123" }), WINDOW).event;
let dd = dedup([dA, dB]);
t("dedup same id keeps higher confidence", dd.length === 1 && dd[0].confidence === "high");

const dC = validateAndNormalize(mk({ confidence: "high" }), WINDOW).event;                          // official
const dD = validateAndNormalize(mk({ confidence: "high", url: "https://www.eventbrite.com/e/9" }), WINDOW).event; // aggregator
dd = dedup([dD, dC]);
t("dedup conf tie prefers official url", dd.length === 1 && dd[0].url.includes("wharfdc.com"));
dd = dedup([dC, dD]);
t("dedup full tie keeps incumbent (fresh first)", dd.length === 1 && dd[0].url.includes("wharfdc.com"));

// same normalized title+venue, different punctuation/case -> same event
const dE = validateAndNormalize(mk({ title: "WHARF SUMMERFEST  KICKOFF!", venue: "District Pier at the Wharf" }), WINDOW).event;
dd = dedup([dC, dE]);
t("dedup via normalized title+venue", dd.length === 1);
t("urlScore aggregator", urlScore("https://www.ticketmaster.com/x") === 0 && urlScore("https://www.930.com/") === 1);

// ---------------------------------------------------------------------------
// mergeRecurring — recurring layer never overwrites searched
// ---------------------------------------------------------------------------
const recurringLayer = [
  { id: "eastern-market-weekend", title: "Eastern Market — Weekend Market & Flea", venue: "Eastern Market", eventType: "recurring", recurring: true, confidence: "high" },
  { id: "lincoln-park", title: "Lincoln Park", venue: "Lincoln Park (E Capitol St btwn 11th & 13th)", eventType: "recurring", recurring: true, confidence: "high" }
];
const searchedEastern = validateAndNormalize(mk({
  title: "Eastern Market — Weekend Market & Flea", venue: "Eastern Market",
  url: "https://easternmarket-dc.org/special", date: "2026-06-20"
}), WINDOW).event;
let mg = mergeRecurring([searchedEastern], recurringLayer);
t("recurring never overwrites searched", mg.length === 2 && mg.filter((e) => e.venue === "Eastern Market").length === 1 && !mg.find((e) => e.venue === "Eastern Market").recurring);
t("non-colliding recurring appended", !!mg.find((e) => e.id === "lincoln-park"));

// sortForFile
const sorted = sortForFile([
  { eventType: "single", date: "2026-07-04", title: "b" },
  { eventType: "recurring", title: "r" },
  { eventType: "single", date: "2026-06-13", title: "a" },
  { eventType: "run", endDate: "2026-07-26", startDate: "2026-06-16", title: "z" }
]);
t("sort: recurring+runs first, singles by date", sorted[0].title === "r" && sorted[1].title === "z" && sorted[2].title === "a" && sorted[3].title === "b");

// ---------------------------------------------------------------------------
// parseEventArray — fences + stray prose
// ---------------------------------------------------------------------------
t("parse plain array", parseEventArray('[{"a":1}]').length === 1);
t("parse fenced array", parseEventArray('Here you go:\n```json\n[{"a":1},{"b":2}]\n```\nDone!').length === 2);
t("parse empty array", parseEventArray("[]").length === 0);
let threw = false; try { parseEventArray("no array here"); } catch { threw = true; }
t("parse throws without array", threw);

t("parse: trailing citation [1] ignored", parseEventArray('[{"x":1}]\n\nSee [1].').length === 1);
t("parse: leading citation [1][2] ignored", parseEventArray('See [1][2]:\n[{"x":2}]')[0].x === 2);
t("parse: bracket inside string value", parseEventArray('[{"p":"[free]","n":"a]b"}]')[0].p === "[free]");
t("parse: escaped backslash in string", parseEventArray('[{"p":"a\\\\b"}]')[0].p === "a\\b");
t("parse: nested array in object", Array.isArray(parseEventArray('[{"tags":["a","b"]}]')[0].tags));

// ---------------------------------------------------------------------------
// callModel — pause_turn continuation + retry, via fake fetch
// ---------------------------------------------------------------------------
{
  const calls = [];
  const responses = [
    { status: 429, ok: false, body: "rate limited" },
    { status: 200, ok: true, json: { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "x" }], usage: {} } },
    { status: 200, ok: true, json: { stop_reason: "end_turn", usage: { output_tokens: 5 }, content: [{ type: "text", text: '```json\n[{"ok":true}]\n```' }] } }
  ];
  const fakeFetch = async (url, init) => {
    const r = responses[calls.length]; calls.push(JSON.parse(init.body));
    return { ok: r.ok, status: r.status, json: async () => r.json, text: async () => r.body || "" };
  };
  const text = await callModel({ system: "s", prompt: "p", apiKey: "k", fetchImpl: fakeFetch, log: quiet, retryDelayMs: 1 });
  t("callModel retries 429 once", calls.length === 3);
  t("callModel continues pause_turn with assistant content", calls[2].messages.length === 2 && calls[2].messages[1].role === "assistant");
  t("callModel returns final text", parseEventArray(text)[0].ok === true);
  t("callModel sends web_search max_uses 6", calls[0].tools[0].type === WEB_SEARCH_TOOL && calls[0].tools[0].max_uses === 6);
  t("callModel uses the current search tool", WEB_SEARCH_TOOL === "web_search_20260209");
  t("callModel uses sonnet 5", calls[0].model === "claude-sonnet-5" && MODEL === "claude-sonnet-5");
  t("callModel caps max_tokens", calls[0].max_tokens === MAX_TOKENS && MAX_TOKENS >= 16000);
  t("no search domain filter unless a track asks", calls[0].tools[0].allowed_domains === undefined);
  t("structured output stays off until verified live", USE_STRUCTURED_OUTPUT === false && calls[0].output_config === undefined);

  let failed = false;
  try {
    await callModel({ system: "s", prompt: "p", apiKey: "k", retryDelayMs: 1, log: quiet,
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => "bad request" , json: async()=>({})}) });
  } catch (e) { failed = /400/.test(e.message); }
  t("callModel throws on non-retryable error", failed);
}

// ---------------------------------------------------------------------------
// main() end-to-end with mocked model
// ---------------------------------------------------------------------------
// repo layout: this file lives in /scripts, recurring.json at repo root
const RECURRING_JSON = JSON.parse(fs.readFileSync(new URL("../recurring.json", import.meta.url), "utf8"));

function tmpRepo(existingEvents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweeptest-"));
  fs.writeFileSync(path.join(dir, "recurring.json"), JSON.stringify(RECURRING_JSON));
  if (existingEvents) fs.writeFileSync(path.join(dir, "events.json"), JSON.stringify(existingEvents, null, 2));
  return dir;
}
const readEvents = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8"));

// canned model output: enough valid events + deliberate junk to exercise drops
const goodSingles = (datePrefix) => ([
  mk({ title: "Festival One", venue: "Venue A", date: "2026-06-13" }),
  mk({ title: "Festival Two", venue: "Venue B", date: "2026-06-20", confidence: "medium" }),
  mk({ title: "Festival Three", venue: "Venue C", date: "2026-06-27" }),
  mk({ title: "Bad Cat", venue: "Venue D", category: "nonsense", date: "2026-06-13" }),          // drop
  mk({ title: "Too Late", venue: "Venue E", date: "2026-09-01" }),                                // drop
  mk({ title: "Unsure", venue: "Venue F", date: "2026-06-13", confidence: "low" })                // drop (low)
]);
const theaterRun = mk({
  title: "The Glass Door", venue: "Arena Stage (Kreeger Theater)", category: "theater",
  eventType: "run", date: null, startDate: "2026-06-16", endDate: "2026-08-09", isFree: false
});
const musicSingle = mk({ title: "Glass Harbor", venue: "9:30 Club", neighborhood: "U Street", category: "music", date: "2026-06-14", isFree: false, ageRestriction: null });
const comedy21 = mk({ title: "Late Show", venue: "DC Comedy Loft", neighborhood: "Other DC", category: "comedy", date: "2026-06-20", ageRestriction: "21+", goodForTeens: true, isFree: false });

function cannedModel(byTrackNum) {
  const seen = [];
  const fn = async ({ prompt }) => {
    // Identify the track by the unique text AFTER its {WEEKEND_LIST} placeholder
    const track = TRACKS.find((tr) => prompt.includes(tr.prompt.split("{WEEKEND_LIST}")[1].slice(0, 60)));
    if (!track) throw new Error("mock could not identify track for prompt: " + prompt.slice(0, 80));
    seen.push({ num: track.num, prompt });
    const payload = byTrackNum[track.num];
    if (payload instanceof Error) throw payload;
    return JSON.stringify(payload || []);
  };
  fn.seen = seen;
  return fn;
}

// --- scenario 1: first run (no events.json) — theater due, full write -------
await scenario("s1", async () => {
  const dir = tmpRepo(null);
  const libEvents = [
    mk({ title: "Teen Maker Day", venue: "MLK Library", neighborhood: "Downtown / National Mall", category: "family-teens", date: "2026-06-21" }),
    mk({ title: "Botanic Family Walk", venue: "US Botanic Garden", neighborhood: "Capitol Hill", category: "museums-culture", date: "2026-06-14" })
  ];
  const wharfEvent = [mk({ title: "Pier Concert", venue: "District Pier", category: "music", date: "2026-06-20", isFree: false })];
  const model = cannedModel({ 1: goodSingles(), 2: libEvents, 3: wharfEvent, 4: [], 5: [theaterRun], 6: [musicSingle], 7: [comedy21] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  t("s1 exit 0", code === 0);
  const out = readEvents(dir);
  t("s1 ran all 7 tracks", model.seen.length === 7);
  t("s1 weekly tracks got 3 saturdays", model.seen.find((s) => s.num === 1).prompt.includes("2026-06-13, 2026-06-20, 2026-06-27") && !model.seen.find((s) => s.num === 1).prompt.includes("2026-07-04"));
  t("s1 theater tracks got 6 saturdays", model.seen.find((s) => s.num === 5).prompt.includes("2026-07-18"));
  t("s1 weekStartsCovered = 6 sats", JSON.stringify(out.weekStartsCovered) === JSON.stringify(["2026-06-13", "2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11", "2026-07-18"]));
  t("s1 generatedAt = now", out.generatedAt === new Date(NOW).toISOString());
  t("s1 lastTheaterRefresh = now (ran)", out.lastTheaterRefresh === new Date(NOW).toISOString());
  const nonRec = out.events.filter((e) => !e.recurring);
  t("s1 junk dropped: 9 fresh events", nonRec.length === 9);
  t("s1 low confidence gone", !nonRec.find((e) => e.title === "Unsure"));
  t("s1 out-of-window gone", !nonRec.find((e) => e.title === "Too Late"));
  t("s1 21+ coerced", nonRec.find((e) => e.title === "Late Show").goodForTeens === false);
  t("s1 ids recomputed", !!nonRec.find((e) => e.id === eventId(validateAndNormalize(theaterRun, WINDOW).event)));
  t("s1 recurring merged last", out.events.filter((e) => e.recurring).length === RECURRING_JSON.events.length);
  t("s1 sorted recurring/runs first", out.events[0].recurring === true && out.events.findIndex((e) => e.eventType === "single") > out.events.findIndex((e) => e.eventType === "run"));
});

// --- scenario 2: theater fresh — tracks 5–7 skipped, carry-forward ----------
await scenario("s2", async () => {
  const existing = {
    generatedAt: "2026-06-04T10:00:00Z",
    weekStartsCovered: ["2026-06-06", "2026-06-13", "2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11"],
    lastTheaterRefresh: "2026-06-04T10:00:00Z", // 7 days old -> fresh
    events: [
      { ...validateAndNormalize(theaterRun, WINDOW).event },
      { ...validateAndNormalize(musicSingle, WINDOW).event },
      { id: "old-festival", title: "Old Festival", venue: "X", eventType: "single", date: "2026-06-06", category: "outdoor", recurring: false, confidence: "high", url: "https://arenastage.org/show", neighborhood: "Capitol Hill" }
    ]
  };
  const dir = tmpRepo(existing);
  const filler3 = [
    mk({ title: "Yards Movie Night", venue: "Yards Park Lawn", neighborhood: "Navy Yard / Ballpark", date: "2026-06-20" }),
    mk({ title: "Riverfront Fete", venue: "Capitol Riverfront", neighborhood: "Navy Yard / Ballpark", date: "2026-06-27" }),
    mk({ title: "Market Day Special", venue: "Eastern Market Plaza", neighborhood: "Capitol Hill", date: "2026-06-14" })
  ];
  const model = cannedModel({ 1: goodSingles(), 2: [mk({ title: "Lib Day", venue: "MLK Library", neighborhood: "Downtown / National Mall", category: "family-teens", date: "2026-06-21" })], 3: filler3, 4: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  t("s2 exit 0", code === 0);
  t("s2 only tracks 1-4 ran", model.seen.length === 4 && model.seen.every((s) => s.num <= 4));
  t("s2 lastTheaterRefresh preserved", out.lastTheaterRefresh === "2026-06-04T10:00:00Z");
  t("s2 theater run carried unchanged", !!out.events.find((e) => e.id === eventId(validateAndNormalize(theaterRun, WINDOW).event)));
  t("s2 music single carried", !!out.events.find((e) => e.title === "Glass Harbor"));
  t("s2 non-theater old entries NOT carried", !out.events.find((e) => e.id === "old-festival"));
  t("s2 fresh weekly results present", !!out.events.find((e) => e.title === "Lib Day"));
});

// --- scenario 3: carried vs fresh dedup — fresh searched wins tie -----------
await scenario("s3", async () => {
  const carriedShow = { ...validateAndNormalize(musicSingle, WINDOW).event, price: "$25 OLD PRICE" };
  const existing = {
    generatedAt: "2026-06-04T10:00:00Z", weekStartsCovered: [], lastTheaterRefresh: "2026-06-04T10:00:00Z",
    events: [carriedShow]
  };
  const dir = tmpRepo(existing);
  // track 3 (waterfront) happens to re-find the same show with a new price, same confidence/url
  const fresher = mk({ ...musicSingle, price: "$30 NEW PRICE" });
  const filler4 = [];
  for (let i = 0; i < 5; i++) filler4.push(mk({ title: "Ride " + i, venue: "Trailhead " + i, category: "biking", date: "2026-06-13" }));
  const model = cannedModel({ 1: goodSingles(), 2: [], 3: [fresher], 4: filler4 });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  const show = out.events.filter((e) => e.title === "Glass Harbor");
  t("s3 exit 0 + single copy", code === 0 && show.length === 1);
  t("s3 fresh search beats carried on tie", show[0].price === "$30 NEW PRICE");
});

// --- scenario 4: safety — too few events -> keep old file, exit 1 -----------
await scenario("s4", async () => {
  const existing = { generatedAt: "old", weekStartsCovered: ["2026-06-06"], lastTheaterRefresh: "2026-01-01T00:00:00Z", events: [{ id: "keep-me", recurring: false, eventType: "single", title: "Keep", venue: "V", category: "outdoor", date: "2026-06-06" }] };
  const dir = tmpRepo(existing);
  const before = fs.readFileSync(path.join(dir, "events.json"), "utf8");
  const model = cannedModel({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] }); // theater due (jan) but empty
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  t("s4 exit 1 on thin results", code === 1);
  t("s4 events.json untouched", fs.readFileSync(path.join(dir, "events.json"), "utf8") === before);
});

// --- scenario 5: safety — >2 track errors -> abort even with plenty ---------
await scenario("s5", async () => {
  const dir = tmpRepo(null);
  const boom = () => new Error("track exploded");
  const many = [];
  for (let i = 0; i < 12; i++) many.push(mk({ title: "Ev" + i, venue: "Venue" + i, date: "2026-06-13", isFree: false }));
  const model = cannedModel({ 1: many, 2: boom(), 3: boom(), 4: boom(), 5: [], 6: [], 7: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  t("s5 exit 1 on 3 track errors", code === 1);
  t("s5 no events.json written", !fs.existsSync(path.join(dir, "events.json")));
});

// --- scenario 6: boundaries — exactly 8 events / exactly 2 errors -> write --
await scenario("s6", async () => {
  const dir = tmpRepo(null);
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push(mk({ title: "Ev" + i, venue: "Venue" + i, date: "2026-06-13" }));
  const model = cannedModel({ 1: eight, 2: new Error("x"), 3: new Error("y"), 4: [], 5: [], 6: [], 7: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  t("s6 exactly-8 + exactly-2-errors still writes", code === 0 && out.events.filter((e) => !e.recurring).length === 8);
});

// --- scenario 7: recurring collision — searched entry wins ------------------
await scenario("s7", async () => {
  const dir = tmpRepo(null);
  const searchedEM = mk({ title: RECURRING_JSON.events[0].title, venue: RECURRING_JSON.events[0].venue, category: "food-markets", neighborhood: "Capitol Hill", date: "2026-06-13", isFree: true, url: "https://easternmarket-dc.org/special-day" });
  const filler = [];
  for (let i = 0; i < 9; i++) filler.push(mk({ title: "F" + i, venue: "FV" + i, date: "2026-06-20" }));
  const model = cannedModel({ 1: [searchedEM, ...filler], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  const copies = out.events.filter((e) => e.venue === RECURRING_JSON.events[0].venue && e.title === RECURRING_JSON.events[0].title);
  t("s7 searched beats recurring on collision", code === 0 && copies.length === 1 && copies[0].recurring === false);
  t("s7 other recurring still merged", out.events.filter((e) => e.recurring).length === RECURRING_JSON.events.length - 1);
});

// --- scenario 8: missing API key with real model path -> exit 1, no write ---
await scenario("s8", async () => {
  const dir = tmpRepo(null);
  const code = await main({ rootDir: dir, now: NOW, log: quiet, env: {} }); // no callModel injection, no key
  t("s8 missing key -> exit 1", code === 1);
  t("s8 nothing written", !fs.existsSync(path.join(dir, "events.json")));
});
// --- new tunables: concurrency + request timeout are exported numbers ----
t("TRACK_CONCURRENCY is a positive number", typeof TRACK_CONCURRENCY === "number" && TRACK_CONCURRENCY >= 1);
t("REQUEST_TIMEOUT_MS is a positive number", typeof REQUEST_TIMEOUT_MS === "number" && REQUEST_TIMEOUT_MS > 0);

// --- scenario 9: tracks run concurrently, results merged in track order ---
await scenario("s9", async () => {
  const dir = tmpRepo(null);
  // Instrument the canned model to record max concurrent in-flight calls and
  // to finish out of track order (track 1 slowest), proving parallelism while
  // the merged output must still come out ordered by track number.
  // Each track returns enough events to clear MIN_NONRECURRING — otherwise
  // main() safety-aborts and there is no file to assert against.
  const trackEvents = (tag, n) => Array.from({ length: n }, (_, i) => mk({
    title: `${tag}${i}`, venue: `${tag} Venue ${i}`, date: "2026-06-20",
    url: `https://wharfdc.com/${tag.toLowerCase()}-${i}`
  }));
  const base = cannedModel({
    1: trackEvents("T1", 3), 2: trackEvents("T2", 3),
    3: trackEvents("T3", 3), 4: trackEvents("T4", 3),
    5: [], 6: [], 7: []
  });
  let inFlight = 0, maxInFlight = 0;
  const delays = { 1: 40, 2: 20, 3: 10, 4: 5 };
  const model = async (args) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const num = TRACKS.find((tr) => args.prompt.includes(tr.prompt.split("{WEEKEND_LIST}")[1].slice(0, 60))).num;
    await new Promise((r) => setTimeout(r, delays[num] || 1));
    inFlight--;
    return base(args);
  };
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  t("s9 exit 0", code === 0);
  t("s9 ran tracks concurrently (max in-flight > 1)", maxInFlight > 1);
  t("s9 concurrency capped at TRACK_CONCURRENCY", maxInFlight <= TRACK_CONCURRENCY);
  // no events.json exists, so the theater refresh is due and all seven tracks run
  t("s9 all seven tracks ran", base.seen.length === 7);
  // searched results must be ordered by track number despite finishing order
  const titles = out.events.filter((e) => !e.recurring).map((e) => e.title);
  const idx1 = titles.indexOf("T10"), idx4 = titles.indexOf("T40");
  t("s9 results merged in track order (T1 before T4)", idx1 !== -1 && idx4 !== -1 && idx1 < idx4);
});

// ---------------------------------------------------------------------------
// showsInWindow — carried entries are re-checked against the new window
// ---------------------------------------------------------------------------
{
  const single = (d) => ({ eventType: "single", date: d });
  t("window keeps a Friday inside", showsInWindow(single("2026-06-12"), WINDOW));
  t("window keeps a Sunday inside", showsInWindow(single("2026-07-19"), WINDOW));
  t("window drops a past date", !showsInWindow(single("2026-06-05"), WINDOW));
  t("window drops a weekday inside the range", !showsInWindow(single("2026-06-17"), WINDOW));
  t("window keeps an overlapping run", showsInWindow({ eventType: "run", startDate: "2026-05-01", endDate: "2026-06-20" }, WINDOW));
  t("window drops an ended run", !showsInWindow({ eventType: "run", startDate: "2026-05-01", endDate: "2026-06-10" }, WINDOW));
  t("window always keeps recurring", showsInWindow({ eventType: "recurring" }, WINDOW));
}

// ---------------------------------------------------------------------------
// near-duplicate pass
// ---------------------------------------------------------------------------
{
  const ev = (over) => validateAndNormalize(mk(over), WINDOW).event;
  const jazz1 = ev({ title: "DC JazzFest at The Wharf", venue: "The Wharf — District Pier, Arena Stage" });
  const jazz2 = ev({ title: "DC JazzFest at The Wharf – 22nd Annual Grand Finale Weekend", venue: "District Pier & Transit Pier – The Wharf (+ Arena Stage)" });
  const pints1 = ev({ title: "Pints for Paws with Pacifico", venue: "The Wharf — Transit Pier" });
  const pints2 = ev({ title: "Pints for Paws with Pacifico – Waterfront Dog Rescue Benefit", venue: "The Wharf" });
  const frog = ev({ title: "Frog", venue: "9:30 Club", neighborhood: "U Street", url: "https://930.com/a" });
  const woods = ev({ title: "Woods", venue: "9:30 Club", neighborhood: "U Street", url: "https://930.com/b" });

  t("near-dup merges a subtitled festival", dedupNear([jazz1, jazz2]).length === 1);
  t("near-dup merges a subtitled benefit", dedupNear([pints1, pints2]).length === 1);
  t("near-dup keeps two bands at one club", dedupNear([frog, woods]).length === 2);
  t("near-dup keeps different days", dedupNear([jazz1, ev({ title: "DC JazzFest at The Wharf", venue: "The Wharf", date: "2026-06-20" })]).length === 2);
  t("near-dup keeps different neighborhoods", dedupNear([jazz1, ev({ title: "DC JazzFest at The Wharf", venue: "The Wharf", neighborhood: "Capitol Hill" })]).length === 2);
  t("near-dup needs two shared words", !isNearDuplicate(ev({ title: "Ride 1", venue: "Trailhead" }), ev({ title: "Ride 2", venue: "Trailhead" })));
  t("near-dup needs compatible venues",
    !isNearDuplicate(ev({ title: "Jazz Night Downtown", venue: "Black Cat", neighborhood: "U Street", url: "https://blackcatdc.com/a" }),
                     ev({ title: "Jazz Night Downtown", venue: "DC9", neighborhood: "U Street", url: "https://dc9.club/a" })));
  t("near-dup keeps the higher-confidence copy",
    dedupNear([ev({ title: "Pints for Paws", venue: "The Wharf", confidence: "medium" }),
               ev({ title: "Pints for Paws Benefit Night", venue: "The Wharf", confidence: "high" })])[0].confidence === "high");
  t("titleOverlap identical is 1", titleOverlap("Market Day Special", "Market Day Special") === 1);
  t("titleOverlap unrelated is 0", titleOverlap("Venus", "Merrily We Roll Along") === 0);
}

// ---------------------------------------------------------------------------
// (8) recurring.json schema gate
// ---------------------------------------------------------------------------
{
  const good = JSON.parse(fs.readFileSync(new URL("../recurring.json", import.meta.url), "utf8")).events;
  t("shipped recurring.json is valid", validateRecurringLayer(good).length === 0);
  const bad = (over) => validateRecurringLayer([{ ...good[0], ...over }]);
  t("recurring bad neighborhood caught", /non-canonical neighborhood/.test(bad({ neighborhood: "Adams Morgan" })[0] || ""));
  t("recurring bad category caught", /non-canonical category/.test(bad({ category: "street-fairs" })[0] || ""));
  t("recurring wrong eventType caught", /eventType/.test(bad({ eventType: "single" })[0] || ""));
  t("recurring non-boolean flag caught", /goodForTeens/.test(bad({ goodForTeens: "yes" })[0] || ""));
  t("recurring off-allowlist url caught", /not allowlisted/.test(bad({ url: "https://spam.example.com" })[0] || ""));
  t("recurring duplicate id caught", validateRecurringLayer([good[0], good[0]]).some((m) => /duplicate id/.test(m)));
  t("recurring missing id caught", /missing id/.test(bad({ id: "" }).join(" ")));
}

// ---------------------------------------------------------------------------
// (10)(11)(12) truncation salvage, search errors, cost
// ---------------------------------------------------------------------------
{
  const full = JSON.stringify([{ title: "A" }, { title: "B" }, { title: "C" }]);
  const cut = full.slice(0, full.length - 12);
  t("truncated array salvages complete objects", parseEventArray(cut).length >= 2);
  t("salvage keeps object contents", parseEventArray(cut)[0].title === "A");
  t("salvageObjects ignores braces in strings", salvageObjects('[{"title":"a } b"}]').length === 1);
  t("garbage still throws", (() => { try { parseEventArray("nothing here"); return false; } catch { return true; } })());
  t("structured-output wrapper unwrapped", parseEventArray('{"events":[{"title":"A"}]}').length === 1);

  t("search error block detected", JSON.stringify(searchErrorsIn([{ type: "web_search_tool_result", content: { error_code: "max_uses_exceeded" } }])) === '["max_uses_exceeded"]');
  t("successful search not flagged", searchErrorsIn([{ type: "web_search_tool_result", content: [{ type: "web_search_result" }] }]).length === 0);
  t("no blocks, no errors", searchErrorsIn(undefined).length === 0);

  const cost = estimateCost({ input: 1e6, output: 1e6, searches: 1000 });
  t("cost = in + out + searches", Math.abs(cost - (2 + 10 + 10)) < 1e-9);
}

// ---------------------------------------------------------------------------
// (S1) per-track search domains reach the API
// ---------------------------------------------------------------------------
{
  t("tracks 1-4 search openly", TRACKS.filter((x) => x.weekly).every((x) => !x.searchDomains));
  t("tracks 5-7 are domain-capped", TRACKS.filter((x) => !x.weekly).every((x) => Array.isArray(x.searchDomains) && x.searchDomains.length));
  let sent = null;
  const fake = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => "", json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "[]" }], usage: { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 1 } } }) };
  };
  const usage = { input: 0, output: 0, searches: 0 };
  await callModel({ system: "s", prompt: "p", apiKey: "k", fetchImpl: fake, log: quiet, searchDomains: ["930.com", "blackcatdc.com"], usage });
  t("allowed_domains forwarded to web_search", JSON.stringify(sent.tools[0].allowed_domains) === '["930.com","blackcatdc.com"]');
  t("usage accumulated across a track", usage.input === 10 && usage.output === 2 && usage.searches === 1);
}

// --- scenario 10: carried entries that fell out of the window are dropped ---
await scenario("s10", async () => {
  const stale = validateAndNormalize(mk({ ...musicSingle, date: "2026-06-14" }), WINDOW).event;
  const past = { ...stale, id: "past-show", date: "2026-06-06", title: "Last Weekend's Show" };
  const offlist = { ...stale, id: "offlist-show", title: "Sketchy Show", url: "https://spam.example.com/x" };
  const existing = {
    generatedAt: "2026-06-04T10:00:00Z", weekStartsCovered: [],
    lastTheaterRefresh: "2026-06-04T10:00:00Z", // fresh -> tracks 5-7 skipped
    events: [stale, past, offlist]
  };
  const dir = tmpRepo(existing);
  const filler = [];
  for (let i = 0; i < 6; i++) filler.push(mk({ title: "Fete " + i, venue: "Plaza " + i, date: "2026-06-20", url: `https://wharfdc.com/f${i}` }));
  const model = cannedModel({ 1: goodSingles(), 2: [], 3: filler, 4: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  t("s10 exit 0", code === 0);
  t("s10 in-window carried entry survives", !!out.events.find((e) => e.title === "Glass Harbor"));
  t("s10 out-of-window carried entry dropped", !out.events.find((e) => e.id === "past-show"));
  t("s10 off-allowlist carried entry dropped", !out.events.find((e) => e.id === "offlist-show"));
});

// --- scenario 11: a bad recurring.json stops the run before it spends money -
await scenario("s11", async () => {
  const dir = tmpRepo(null);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "recurring.json"), "utf8"));
  rec.events[0].neighborhood = "Adams Morgan";
  fs.writeFileSync(path.join(dir, "recurring.json"), JSON.stringify(rec));
  let called = 0;
  const model = async () => { called++; return "[]"; };
  const logged = [];
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: (m) => logged.push(String(m)), env: {} });
  t("s11 exit 1", code === 1);
  t("s11 no API calls made", called === 0);
  t("s11 nothing written", !fs.existsSync(path.join(dir, "events.json")));
  t("s11 names the offending field", logged.some((l) => /non-canonical neighborhood/.test(l)));
});

console.log(fails.length ? `FAIL (${fails.length}/${n}):\n - ` + fails.join("\n - ") : `All ${n} sweep tests passed.`);
process.exit(fails.length ? 1 : 0);
