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
  urlScore, normalizeNeighborhood, normalizeCategory, normalizeAge, TRACKS
} from "./sweep.mjs";

let n = 0; const fails = [];
const t = (name, cond) => { n++; if (!cond) fails.push(name); };
const NOW = "2026-06-11T10:00:00Z"; // a Thursday; first covered Sat = 2026-06-13
const WINDOW = { firstSat: "2026-06-13", lastSun: "2026-07-19" };
const quiet = () => {};

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
t("eventId venue+title+year", eventId({ venue: "Arena Stage (Kreeger Theater)", title: "The Glass Door", startDate: "2026-06-16", date: null })
  === "arena-stage-kreeger-theater-the-glass-door-2026");
t("eventId uses date year for singles", eventId({ venue: "V", title: "T", date: "2027-01-02", startDate: null }) === "v-t-2027");

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
t("id computed in code", v.event.id === "district-pier-at-the-wharf-wharf-summerfest-kickoff-2026");
v = validateAndNormalize(mk({ id: "model-made-this-up" }), WINDOW);
t("model id ignored", v.event.id === "district-pier-at-the-wharf-wharf-summerfest-kickoff-2026");
t("bad category dropped", !!validateAndNormalize(mk({ category: "festivals" }), WINDOW).drop);
t("bad neighborhood dropped", !!validateAndNormalize(mk({ neighborhood: "Adams Morgan" }), WINDOW).drop);
t("single outside window dropped", !!validateAndNormalize(mk({ date: "2026-08-01" }), WINDOW).drop);
t("single before window dropped", !!validateAndNormalize(mk({ date: "2026-06-12" }), WINDOW).drop);
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
t("run fully before window dropped", !!validateAndNormalize(mk({ eventType: "run", date: null, startDate: "2026-05-01", endDate: "2026-06-12" }), WINDOW).drop);
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
  t("callModel sends web_search max_uses 6", calls[0].tools[0].type === "web_search_20250305" && calls[0].tools[0].max_uses === 6);
  t("callModel uses sonnet", calls[0].model === "claude-sonnet-4-6");
  t("callModel caps max_tokens", calls[0].max_tokens === 8192);

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
{
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
  t("s1 ids recomputed", !!nonRec.find((e) => e.id === "arena-stage-kreeger-theater-the-glass-door-2026"));
  t("s1 recurring merged last", out.events.filter((e) => e.recurring).length === RECURRING_JSON.events.length);
  t("s1 sorted recurring/runs first", out.events[0].recurring === true && out.events.findIndex((e) => e.eventType === "single") > out.events.findIndex((e) => e.eventType === "run"));
}

// --- scenario 2: theater fresh — tracks 5–7 skipped, carry-forward ----------
{
  const existing = {
    generatedAt: "2026-06-04T10:00:00Z",
    weekStartsCovered: ["2026-06-06", "2026-06-13", "2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11"],
    lastTheaterRefresh: "2026-06-04T10:00:00Z", // 7 days old -> fresh
    events: [
      { ...validateAndNormalize(theaterRun, WINDOW).event },
      { ...validateAndNormalize(musicSingle, WINDOW).event },
      { id: "old-festival", title: "Old Festival", venue: "X", eventType: "single", date: "2026-06-06", category: "outdoor", recurring: false, confidence: "high", url: "https://x.org", neighborhood: "Capitol Hill" }
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
  t("s2 theater run carried unchanged", !!out.events.find((e) => e.id === "arena-stage-kreeger-theater-the-glass-door-2026"));
  t("s2 music single carried", !!out.events.find((e) => e.title === "Glass Harbor"));
  t("s2 non-theater old entries NOT carried", !out.events.find((e) => e.id === "old-festival"));
  t("s2 fresh weekly results present", !!out.events.find((e) => e.title === "Lib Day"));
}

// --- scenario 3: carried vs fresh dedup — fresh searched wins tie -----------
{
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
}

// --- scenario 4: safety — too few events -> keep old file, exit 1 -----------
{
  const existing = { generatedAt: "old", weekStartsCovered: ["2026-06-06"], lastTheaterRefresh: "2026-01-01T00:00:00Z", events: [{ id: "keep-me", recurring: false, eventType: "single", title: "Keep", venue: "V", category: "outdoor", date: "2026-06-06" }] };
  const dir = tmpRepo(existing);
  const before = fs.readFileSync(path.join(dir, "events.json"), "utf8");
  const model = cannedModel({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] }); // theater due (jan) but empty
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  t("s4 exit 1 on thin results", code === 1);
  t("s4 events.json untouched", fs.readFileSync(path.join(dir, "events.json"), "utf8") === before);
}

// --- scenario 5: safety — >2 track errors -> abort even with plenty ---------
{
  const dir = tmpRepo(null);
  const boom = () => new Error("track exploded");
  const many = [];
  for (let i = 0; i < 12; i++) many.push(mk({ title: "Ev" + i, venue: "Venue" + i, date: "2026-06-13", isFree: false }));
  const model = cannedModel({ 1: many, 2: boom(), 3: boom(), 4: boom(), 5: [], 6: [], 7: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  t("s5 exit 1 on 3 track errors", code === 1);
  t("s5 no events.json written", !fs.existsSync(path.join(dir, "events.json")));
}

// --- scenario 6: boundaries — exactly 8 events / exactly 2 errors -> write --
{
  const dir = tmpRepo(null);
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push(mk({ title: "Ev" + i, venue: "Venue" + i, date: "2026-06-13" }));
  const model = cannedModel({ 1: eight, 2: new Error("x"), 3: new Error("y"), 4: [], 5: [], 6: [], 7: [] });
  const code = await main({ rootDir: dir, now: NOW, callModel: model, log: quiet, env: {} });
  const out = readEvents(dir);
  t("s6 exactly-8 + exactly-2-errors still writes", code === 0 && out.events.filter((e) => !e.recurring).length === 8);
}

// --- scenario 7: recurring collision — searched entry wins ------------------
{
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
}

// --- scenario 8: missing API key with real model path -> exit 1, no write ---
{
  const dir = tmpRepo(null);
  const code = await main({ rootDir: dir, now: NOW, log: quiet, env: {} }); // no callModel injection, no key
  t("s8 missing key -> exit 1", code === 1);
  t("s8 nothing written", !fs.existsSync(path.join(dir, "events.json")));
}

console.log(fails.length ? `FAIL (${fails.length}/${n}):\n - ` + fails.join("\n - ") : `All ${n} sweep tests passed.`);
process.exit(fails.length ? 1 : 0);
