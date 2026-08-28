#!/usr/bin/env node
// =============================================================================
// test-page.mjs — offline tests for the pure logic inside index.html.
//
// index.html fences its DOM-free functions between /*__LOGIC_START__*/ and
// /*__LOGIC_END__*/. This extracts that block and exercises it in isolation:
// no browser, no DOM, no network. Run: node scripts/test-page.mjs
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const block = html.match(/\/\*__LOGIC_START__\*\/([\s\S]*?)\/\*__LOGIC_END__\*\//);
if (!block) {
  console.error("FAIL: could not find the __LOGIC_START__/__LOGIC_END__ block in index.html");
  process.exit(1);
}
const L = new Function(block[1] + `
  return { matchesTab, showsThisWeekend, passesHoods, sundayOf, fridayOf, addDaysISO,
           addOneDay, gcalUrl, nearestWeekendIndex, nextSaturdays, orderForDisplay,
           titleFingerprint, favFingerprint, rebaseSample, esc, fmtDay, whenText,
           dayRange, CATEGORIES, CHIP_LABEL, CORE_HOODS, ALL_DC_HOODS };`)();

let n = 0; const fails = [];
const t = (name, cond) => { n++; if (!cond) fails.push(name); };

const SAT = "2026-09-05", SUN = "2026-09-06", FRI = "2026-09-04";
const single = (d, over) => ({ eventType: "single", date: d, startDate: null, endDate: null, ...over });
const run = (a, b, over) => ({ eventType: "run", date: null, startDate: a, endDate: b, ...over });

// ---------------------------------------------------------------------------
// weekend date logic — Friday through Sunday
// ---------------------------------------------------------------------------
t("Friday shows", L.showsThisWeekend(single(FRI), SAT, SUN));
t("Saturday shows", L.showsThisWeekend(single(SAT), SAT, SUN));
t("Sunday shows", L.showsThisWeekend(single(SUN), SAT, SUN));
t("Thursday hidden", !L.showsThisWeekend(single("2026-09-03"), SAT, SUN));
t("Monday hidden", !L.showsThisWeekend(single("2026-09-07"), SAT, SUN));
t("next weekend's Friday hidden", !L.showsThisWeekend(single("2026-09-11"), SAT, SUN));
t("run overlapping the weekend shows", L.showsThisWeekend(run("2026-08-01", "2026-09-05"), SAT, SUN));
t("run ending on the Friday shows", L.showsThisWeekend(run("2026-08-01", FRI), SAT, SUN));
t("run ending before the Friday hidden", !L.showsThisWeekend(run("2026-08-01", "2026-09-03"), SAT, SUN));
t("run starting after the Sunday hidden", !L.showsThisWeekend(run("2026-09-07", "2026-10-01"), SAT, SUN));
t("recurring always shows", L.showsThisWeekend({ eventType: "recurring" }, SAT, SUN));
t("unknown eventType never shows", !L.showsThisWeekend({ eventType: "mystery" }, SAT, SUN));
t("fridayOf", L.fridayOf(SAT) === FRI);
t("sundayOf", L.sundayOf(SAT) === SUN);

// ---------------------------------------------------------------------------
// category tabs
// ---------------------------------------------------------------------------
const music = { category: "music", isFree: false, isLowCost: false, goodForTeens: false };
t("all matches everything", L.matchesTab(music, "all"));
t("real category matches", L.matchesTab(music, "music"));
t("other category does not", !L.matchesTab(music, "theater"));
t("free tab catches isFree", L.matchesTab({ ...music, isFree: true }, "free-lowcost"));
t("free tab catches isLowCost", L.matchesTab({ ...music, isLowCost: true }, "free-lowcost"));
t("free tab skips paid", !L.matchesTab(music, "free-lowcost"));
t("teens tab is cross-cutting", L.matchesTab({ ...music, goodForTeens: true }, "family-teens"));
t("teens tab skips 21+ show", !L.matchesTab(music, "family-teens"));
t("every canonical tab has a label", L.CATEGORIES.every((c) => typeof c[1] === "string" && c[1].length));

// ---------------------------------------------------------------------------
// neighborhood filter
// ---------------------------------------------------------------------------
const core = L.CORE_HOODS.slice();
t("core hood passes", L.passesHoods({ neighborhood: "Capitol Hill", worthTheTrip: false }, core, false));
t("non-selected hood blocked", !L.passesHoods({ neighborhood: "U Street", worthTheTrip: false }, core, false));
t("all-DC hood passes when added", L.passesHoods({ neighborhood: "U Street", worthTheTrip: false }, core.concat(L.ALL_DC_HOODS), false));
t("worth-the-trip hidden by default", !L.passesHoods({ neighborhood: "Worth the Trip", worthTheTrip: true }, core, false));
t("worth-the-trip shows when toggled", L.passesHoods({ neighborhood: "Worth the Trip", worthTheTrip: true }, core, true));
t("wtt toggle does not widen DC hoods", !L.passesHoods({ neighborhood: "U Street", worthTheTrip: false }, core, true));

// ---------------------------------------------------------------------------
// "when" text — the run label bug
// ---------------------------------------------------------------------------
const TODAY = "2026-08-28";
t("future run gets a date range", L.whenText(run("2026-09-05", "2026-09-06"), TODAY) === "Sep 5–6");
t("running show says Now through", L.whenText(run("2026-08-01", "2026-09-06"), TODAY) === "Now through Sep 6");
t("run starting today says Now through", L.whenText(run(TODAY, "2026-09-06"), TODAY) === "Now through Sep 6");
t("cross-month range keeps both months", L.dayRange("2026-09-28", "2026-10-04") === "Sep 28–Oct 4");
t("one-day run is a single date", L.dayRange("2026-09-05", "2026-09-05") === "Sep 5");
t("single event shows its weekday", L.whenText(single("2026-09-05"), TODAY) === "Sat, Sep 5");
t("recurring says every weekend", L.whenText({ eventType: "recurring" }, TODAY) === "Every weekend");

// ---------------------------------------------------------------------------
// escaping — every field on a card goes through this
// ---------------------------------------------------------------------------
t("esc closes tags", L.esc("<script>alert(1)</script>").indexOf("<") === -1);
t("esc quotes", L.esc('x" onmouseover="alert(1)') === "x&quot; onmouseover=&quot;alert(1)");
t("esc single quotes", L.esc("it's") === "it&#39;s");
t("esc ampersand first", L.esc("&lt;") === "&amp;lt;");
t("esc null is empty", L.esc(null) === "");

// ---------------------------------------------------------------------------
// calendar links
// ---------------------------------------------------------------------------
{
  const ev = single("2026-09-05", {
    title: "Jazz & Blues", description: "A night out.", time: "7 PM", price: "$20",
    url: "https://930.com/e", venue: "9:30 Club"
  });
  const url = L.gcalUrl(ev, SAT, SUN);
  t("gcal points at Google", url.indexOf("https://calendar.google.com/calendar/render") === 0);
  t("gcal uses the event's own date", url.indexOf("dates=20260905/20260906") !== -1);
  t("gcal end is exclusive", L.addOneDay("20260905") === "20260906");
  t("gcal encodes the title", url.indexOf("text=Jazz%20%26%20Blues") !== -1 || url.indexOf("text=Jazz+%26+Blues") !== -1);
  t("gcal carries no raw ampersand from data", url.split("&").length === 6);
  t("gcal sets eastern time", url.indexOf("ctz=America/New_York") !== -1);
  const rec = L.gcalUrl({ ...ev, eventType: "recurring", date: null }, SAT, SUN);
  t("gcal pins a recurring event to the Saturday", rec.indexOf("dates=20260905/20260906") !== -1);
  const later = L.gcalUrl(run("2026-09-01", "2026-10-01", { title: "T", description: "d", url: "https://x.org", venue: "V" }), SAT, SUN);
  t("gcal pins a run to the selected Saturday", later.indexOf("dates=20260905/20260906") !== -1);
}

// ---------------------------------------------------------------------------
// weekend picker
// ---------------------------------------------------------------------------
{
  const ws = ["2026-08-29", "2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26", "2026-10-03"];
  t("nearest is the current weekend", L.nearestWeekendIndex(ws, "2026-08-28") === 0);
  t("nearest still current on its Sunday", L.nearestWeekendIndex(ws, "2026-08-30") === 0);
  t("nearest rolls over on Monday", L.nearestWeekendIndex(ws, "2026-08-31") === 1);
  t("nearest clamps when data is stale", L.nearestWeekendIndex(ws, "2027-01-01") === ws.length - 1);
  t("nextSaturdays returns Saturdays", L.nextSaturdays("2026-08-28", 6).every((d) => new Date(d + "T12:00:00Z").getUTCDay() === 6));
  t("nextSaturdays includes today if Saturday", L.nextSaturdays("2026-08-29", 1)[0] === "2026-08-29");
}

// ---------------------------------------------------------------------------
// favourites fingerprint — a star must survive an id change
// ---------------------------------------------------------------------------
t("fingerprint ignores a subtitle", L.titleFingerprint("DC JazzFest at The Wharf – 22nd Annual Grand Finale Weekend") === L.titleFingerprint("DC JazzFest at The Wharf"));
t("fingerprint ignores filler words", L.titleFingerprint("The Fruits of Our Labor") === L.titleFingerprint("Fruits of Our Labor"));
t("fingerprint separates real differences", L.titleFingerprint("Venus") !== L.titleFingerprint("Measure for Measure"));
t("fingerprint includes the neighborhood", L.favFingerprint({ title: "Jazz Night", neighborhood: "U Street" }) !== L.favFingerprint({ title: "Jazz Night", neighborhood: "Capitol Hill" }));

// ---------------------------------------------------------------------------
// sample fixture rebasing
// ---------------------------------------------------------------------------
{
  const sample = JSON.parse(fs.readFileSync(path.join(root, "events-sample.json"), "utf8"));
  const out = L.rebaseSample(sample, "2026-08-28");
  t("rebased sample starts at the next Saturday", out.weekStartsCovered[0] === "2026-08-29");
  t("rebased weekends are all Saturdays", out.weekStartsCovered.every((d) => new Date(d + "T12:00:00Z").getUTCDay() === 6));
  t("rebased sample keeps its event count", out.events.length === sample.events.length);
  t("rebased dates keep their weekday", sample.events.filter((e) => e.date).every((e, i) =>
    new Date(e.date + "T12:00:00Z").getUTCDay() ===
    new Date(out.events.filter((x) => x.date)[i].date + "T12:00:00Z").getUTCDay()));
  t("rebase is a no-op when already current", L.rebaseSample(out, "2026-08-28").weekStartsCovered[0] === "2026-08-29");
  t("rebase tolerates an empty fixture", L.rebaseSample({ weekStartsCovered: [], events: [] }, "2026-08-28").events.length === 0);
}

// ---------------------------------------------------------------------------
// display grouping
// ---------------------------------------------------------------------------
{
  const g = L.orderForDisplay([
    single("2026-09-06", { title: "B" }), single(FRI, { title: "A" }),
    run("2026-08-01", "2026-12-01", { title: "Long" }), run("2026-08-01", "2026-09-10", { title: "Short" }),
    { eventType: "recurring", title: "Market" }
  ]);
  t("singles sorted by date", g.singles.map((e) => e.title).join("") === "AB");
  t("runs sorted by end date", g.runs.map((e) => e.title).join("") === "ShortLong");
  t("recurring kept separate", g.recurring.length === 1);
}

console.log(fails.length ? `FAIL (${fails.length}/${n}):\n - ` + fails.join("\n - ") : `All ${n} page tests passed.`);
process.exit(fails.length ? 1 : 0);
