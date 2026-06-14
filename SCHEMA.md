# events.json — Data Contract

This file is the single source of truth. The scheduled GitHub Actions **write** it.
The static family page **reads** it. The future AI planner reads the same file.
Nothing else needs to coordinate — if both sides honor this schema, they stay in sync.

## Top-level shape

```json
{
  "generatedAt": "2026-05-28T10:02:00Z",
  "weekStartsCovered": ["2026-05-30", "2026-06-06", "2026-06-13",
                        "2026-06-20", "2026-06-27", "2026-07-04"],
  "lastTheaterRefresh": "2026-05-15T10:00:00Z",
  "events": [ /* array of Event objects, see below */ ]
}
```

- `generatedAt` — when the weekly run last wrote the file (ISO 8601, UTC).
- `weekStartsCovered` — the 6 upcoming Saturdays this file covers. The page uses
  this to build the weekend picker; never hardcode dates in the page.
- `lastTheaterRefresh` — when the twice-monthly run last updated theater/music/comedy
  entries. Lets the page show "shows as of <date>" and lets the Action decide whether
  a theater refresh is due.

## The Event object

Every event — a one-day festival, a 3-month theater run, a single concert — uses the
SAME object. The `eventType` field tells consumers how to interpret the dates. This is
the key design decision: one shape, three behaviors.

```json
{
  "id": "arena-crazysexycool-2026",
  "title": "CrazySexyCool – The TLC Musical",
  "eventType": "run",
  "date": null,
  "startDate": "2026-06-12",
  "endDate": "2026-08-09",
  "time": "Tue–Sun, see venue for showtimes",
  "venue": "Arena Stage (Kreeger Theater)",
  "neighborhood": "Southwest / The Wharf",
  "worthTheTrip": false,
  "category": "theater",
  "price": "$37+",
  "isFree": false,
  "isLowCost": false,
  "goodForTeens": true,
  "ageRestriction": null,
  "description": "World-premiere musical about the rise of TLC.",
  "url": "https://www.arenastage.org/tickets/calendar/",
  "source": "arenastage.org",
  "recurring": false,
  "confidence": "high"
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable slug, COMPUTED IN CODE by sweep.mjs (never by the model): slugify(venue + title + year), lowercased, hyphenated. Used for dedup + favorites. MUST be stable across runs so a favorited event keeps its star. |
| `title` | string | Event name. |
| `eventType` | enum | `"single"`, `"run"`, or `"recurring"`. Drives date logic (below). |
| `date` | string\|null | For `single` events only: the ISO date `YYYY-MM-DD`. Null otherwise. |
| `startDate` | string\|null | For `run` events: first day of the run. Null for single. |
| `endDate` | string\|null | For `run` events: last day of the run. Null for single. |
| `time` | string\|null | Free text, e.g. `"7:30 PM"`, `"Sat 8 AM–1 PM"`, `"showtimes vary"`. |
| `venue` | string | Display name. |
| `neighborhood` | string | One of the canonical values (see list below). |
| `worthTheTrip` | bool | `true` = outside DC core (Arlington/MD). Hidden unless the "Worth the trip" toggle is on. |
| `category` | enum | One of the canonical categories (see list below). |
| `price` | string\|null | Free text for display, e.g. `"Free"`, `"$15–40"`, `"PWYC"`. |
| `isFree` | bool | Powers the Free badge + "Free & Low-Cost" tab. |
| `isLowCost` | bool | `true` if cheapest entry ≤ ~$25, or has PWYC/rush/under-30 pricing. |
| `goodForTeens` | bool | Suitable/appealing for a teen or preteen. See guidance in PROMPTS. |
| `ageRestriction` | string\|null | e.g. `"18+"`, `"21+"`, `"All ages"`. Critical for music/comedy. If `18+` or `21+`, `goodForTeens` MUST be false. |
| `description` | string | 1–2 sentences, plain. No marketing fluff. |
| `url` | string | Link out to tickets/info. Prefer the official venue page. |
| `source` | string | Domain the entry came from, for trust/debugging. |
| `recurring` | bool | `true` for the hardcoded passive layer (markets, parks, trails). |
| `confidence` | enum | `"high"`, `"medium"`, `"low"`. Entries below `medium` are dropped before publish. |

## Date logic — how the page decides "is this on for the selected weekend?"

Given a selected weekend (a Saturday `satDate` and Sunday `sunDate`):

- **`eventType: "single"`** → show if `date === satDate || date === sunDate`.
- **`eventType: "run"`** → show if the run overlaps the weekend:
  `startDate <= sunDate && endDate >= satDate`. (A play running "now–July 26"
  appears on every weekend inside that window.)
- **`eventType: "recurring"`** → always show (these are weekly standing options like
  Eastern Market). Optionally annotate with the weekend date for calendar links.

## Canonical neighborhoods (use these exact strings)

- `"Capitol Hill"`
- `"Southwest / The Wharf"`
- `"Navy Yard / Ballpark"`
- `"Downtown / National Mall"`
- `"U Street"`            ← music venues live here; treat as DC-core
- `"H Street NE"`         ← Atlas; DC-core
- `"Other DC"`            ← anything else in the District
- `"Worth the Trip"`      ← set neighborhood AND worthTheTrip:true for Arlington/MD

> The 4 default toggles remain your original 4. U Street / H Street / Other DC show
> under "All DC". "Worth the Trip" is its own toggle, off by default.

## Canonical categories (map 1:1 to filter tabs)

- `"free-lowcost"`  → "Free & Low-Cost" (derived view; an event also keeps its real category)
- `"outdoor"`       → Outdoor
- `"music"`         → Music & Concerts
- `"theater"`       → Theater & Performances
- `"comedy"`        → Comedy & Standup
- `"museums-culture"`→ Museums & Culture
- `"arts"`          → Arts & Galleries
- `"sports-active"` → Sports & Active
- `"biking"`        → Biking & Trails
- `"food-markets"`  → Food & Markets
- `"family-teens"`  → Family & Teens

> "Free & Low-Cost" and "Family & Teens" are *cross-cutting* — an event has ONE real
> `category` but may also surface in these tabs via its `isFree`/`isLowCost`/`goodForTeens`
> flags. So the page's tab filter is: match real category OR (tab is free-lowcost AND
> isFree/isLowCost) OR (tab is family-teens AND goodForTeens).

## Dedup rule

Two entries are the same event if they share the same `id`, OR same normalized
`title` + same `venue`. On collision: keep the higher `confidence`; if tied, keep the
one with the more specific `url` (official venue domain over aggregator). The recurring
layer is merged LAST and never overwrites a fresher searched entry for the same thing.
