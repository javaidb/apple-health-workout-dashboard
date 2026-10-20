// Health & Fitness Tracker dashboard: streaks, last workout, weekly goal, year heatmap and a
// month calendar, all read from the local cache via /api/v1.
(() => {
  "use strict";

  const API = "/api/v1";
  const DISTANCE_CATEGORIES = new Set(["run", "walk", "hike", "cycle", "swim", "row"]);
  const CATEGORY_LABELS = {
    run: "Run", walk: "Walk", hike: "Hike", cycle: "Cycle", swim: "Swim", row: "Row",
    strength: "Workout", hiit: "HIIT", mobility: "Mobility", cardio: "Cardio", sport: "Sport", other: "Other",
  };
  const FIT_QUERY = matchMedia("(min-width: 1100px) and (min-height: 560px)");
  const APP_ICONS = { fitbod: "img/fitbod.png" };  // source app (lower-case) -> small icon
  const FORM_WEEKS = 12;
  const FORM_SESSIONS = 6;
  const TREND_WINDOW = 12;   // smoothing width of the trend line, in weeks
  const STEP_GOAL = 10000;
  const ACTIVITY_METRICS = ["step_count", "walking_running_distance", "active_energy", "flights_climbed", "weight_body_mass"];
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const $ = (id) => document.getElementById(id);
  const state = {
    month: startOfMonth(new Date()),
    goal: readGoal(),
    overview: null,
    yearDays: new Map(),     // local date -> {workouts, duration_s, categories}
    workouts: [],            // workouts in the visible calendar grid
    metrics: {},             // metric -> {byDate: Map(date -> value), sourceUnit} for the last 30 days
    gridSteps: new Map(),    // local date -> steps for the visible calendar grid
    recent: [],              // most recent workouts (newest first) for the "Recent form" card
    weekly: [],              // workouts per week since the first workout, oldest first
    selectedId: null,
  };

  // ---- storage (per-viewer convenience only) ------------------------------
  function readGoal() {
    try { const g = Number(localStorage.getItem("weeklyGoal")); return g >= 1 && g <= 7 ? g : 3; } catch { return 3; }
  }
  function saveGoal(g) { try { localStorage.setItem("weeklyGoal", String(g)); } catch { /* ignore */ } }

  // ---- dates --------------------------------------------------------------
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function monday(d) { return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7)); }
  const todayIso = () => iso(new Date());

  // ---- formatting ---------------------------------------------------------
  function fmtDuration(s) {
    if (s == null) return "—";
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }
  function fmtHours(s) { return s >= 36000 ? `${Math.round(s / 3600)}h` : fmtDuration(s); }
  function fmtKm(m) { return m == null ? "—" : `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`; }
  function fmtPace(sPerKm) {
    if (sPerKm == null) return "—";
    return `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, "0")} /km`;
  }
  function fmtClock(utc, offsetMin) {
    const d = new Date(new Date(utc).getTime() + offsetMin * 60000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  function fmtAgo(utc) {
    const mins = Math.round((Date.now() - new Date(utc).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }
  function fmtSteps(n) { return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`; }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const catOf = (c) => (CATEGORY_LABELS[c] ? c : "other");
  const catVar = (c) => `var(--c-${catOf(c)})`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  function shortLabel(activity) {
    if (activity.category !== "other" && activity.category !== "sport") return CATEGORY_LABELS[activity.category];
    return activity.label.replace(/^(Outdoor|Indoor|Traditional|Functional)\s+/i, "");
  }
  const badge = (c) => `<span class="cat-badge" style="--cat:${catVar(c)}">${CATEGORY_LABELS[catOf(c)][0]}</span>`;

  async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const body = r.status === 204 ? null : await r.json();
    if (!r.ok && !(body && body.workouts)) throw new Error(body?.error?.message || `HTTP ${r.status}`);
    return body;
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // ---- loading ------------------------------------------------------------
  function heatmapRange() {
    const end = addDays(new Date(), 1);
    const start = monday(addDays(new Date(), -364));
    return { start, end };
  }

  async function loadOverview() {
    const today = todayIso();
    const { start, end } = heatmapRange();
    const [overview, days, recent, weekly] = await Promise.all([
      api(`/analytics/overview?today=${today}&weekly_goal=${state.goal}`),
      api(`/analytics/days?from=${iso(start)}&to=${iso(end)}`),
      api(`/workouts?sort=-start&limit=${FORM_SESSIONS}&to=${iso(end)}`),
      api(`/analytics/weekly?today=${today}`),
    ]);
    state.overview = overview;
    state.recent = recent.items;
    state.weekly = weekly.weeks;
    state.yearDays = new Map(days.days.map((d) => [d.date, d]));
    renderHero();
    renderHeatmap();
    renderSide();  // month-over-month deltas use yearDays
    renderForm();
    checkNewWorkout();
    // the calendar buddy reacts to this week, so refresh him once the overview is in
    const buddy = document.querySelector(".sitter");
    if (buddy) buddy.outerHTML = sitterHtml();
    loadActivity().catch(() => renderActivity());
    $("empty").hidden = overview.totals.workouts > 0;
  }

  async function loadMonth() {
    const start = monday(state.month);
    const end = addDays(start, 42);
    const items = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await api(`/workouts?from=${iso(start)}&to=${iso(end)}&sort=start&limit=1000&offset=${offset}`);
      items.push(...page.items);
      if (items.length >= page.total || page.items.length === 0) break;
    }
    state.workouts = items;
    try {
      const steps = await api(`/metrics/daily?names=step_count&from=${iso(start)}&to=${iso(end)}`);
      state.gridSteps = new Map(steps.metrics.step_count.days.map((d) => [d.date, d.value]));
    } catch { state.gridSteps = new Map(); }
    renderCalendar();
    renderSide();
  }

  async function loadActivity() {
    const today = new Date();
    const res = await api(`/metrics/daily?names=${ACTIVITY_METRICS.join(",")}&from=${iso(addDays(today, -30))}&to=${iso(addDays(today, 1))}`);
    state.metrics = {};
    for (const [name, m] of Object.entries(res.metrics)) {
      state.metrics[name] = { byDate: new Map(m.days.map((d) => [d.date, d.value])), sourceUnit: m.source_unit };
    }
    renderActivity();
  }

  async function loadStatus() {
    const pill = $("sync-status");
    try {
      const s = await api("/status");
      const label = pill.querySelector("span");
      pill.classList.remove("fresh", "stale");
      if (s.last_successful_sync) {
        const age = Date.now() - new Date(s.last_successful_sync).getTime();
        label.textContent = `Synced ${fmtAgo(s.last_successful_sync)}`;
        pill.classList.add(age < 6 * 3600000 ? "fresh" : age > 3 * 86400000 ? "stale" : "x");
        pill.title = `${s.workouts} workouts in cache`;
      } else {
        label.textContent = "No syncs yet";
      }
      $("empty-url").textContent = `http://<this-PC-IP>:${location.port || 80}/api/v1/ingest/health-auto-export`;
    } catch (e) {
      pill.querySelector("span").textContent = "Offline";
    }
  }

  const refreshAll = () => Promise.all([loadOverview(), loadMonth(), loadStatus()]).catch((e) => toast(e.message));

  // ---- celebrating a new workout ------------------------------------------
  // This browser remembers the latest workout it has celebrated. When a newer one shows up (a sync
  // or an import), it celebrates once: confetti from the last-workout card, the campfire flares and
  // Carl hops. First visits just remember where things are, and old workouts (backfills, imports of
  // history) don't count.
  const SEEN_KEY = "celebratedWorkout";
  function checkNewWorkout() {
    const last = state.overview?.last_workout;
    if (!last) return;
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(SEEN_KEY)); } catch { /* storage unavailable */ }
    const remember = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ id: last.id, start: last.start })); } catch { /* ignore */ } };
    if (!seen) { remember(); return; }
    if (seen.id === last.id || last.start <= seen.start) return;
    remember();
    if (last.days_ago > 2) return;
    celebrate(state.recent.filter((w) => w.start > seen.start).length || 1);
  }

  function celebrate(n) {
    toast(n > 1 ? `${n} new workouts logged. Carl climbs on!` : "New workout logged. Carl climbs on!");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = $("last-card").getBoundingClientRect();
    const burst = document.createElement("div");
    burst.className = "confetti-burst";
    burst.style.left = `${(r.left + r.width * .72).toFixed(0)}px`;
    burst.style.top = `${(r.top + r.height * .32).toFixed(0)}px`;
    const colors = ["#f97316", "#fbbf24", "#34d399", "#22d3ee", "#f472b6", "#a78bfa"];
    burst.innerHTML = Array.from({ length: 46 }, (_, i) => {
      const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 110;
      return `<i style="--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d * .7 - 50).toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;background:${colors[i % colors.length]};animation-delay:${(Math.random() * .15).toFixed(2)}s"></i>`;
    }).join("");
    document.body.appendChild(burst);
    const fire = document.querySelector("#last-card .campfire"), carl = document.querySelector(".climb-art svg .climber");
    fire?.classList.add("flare");
    carl?.classList.add("cl-hop");
    setTimeout(() => { burst.remove(); fire?.classList.remove("flare"); carl?.classList.remove("cl-hop"); }, 2800);
  }

  // ---- hero ---------------------------------------------------------------
  function renderHero() {
    const o = state.overview;
    renderLastCard(o.last_workout);
    renderStreakCard(o.active_week_streak);
    renderWeekCard(o.week_streak);
    const t = o.totals;
    renderLifetime(t, o.active_week_streak);
    scheduleFit();
  }

  // Nudge for the last-workout card. Rules are checked in order; the first match wins.
  //   n     days since the last workout (0 = today)
  //   goal  week_streak:        weekly target (default 3 workouts), remaining, days_left (incl. today)
  //   any   active_week_streak: consecutive weeks with any workout
  // A rest day is offered only after a workout yesterday, and only if skipping today still
  // leaves enough days to reach the weekly goal at one workout per day.
  function lastWorkoutNudge(n, goal, any) {
    const R = goal.remaining, D = goal.days_left, more = plural(R, "more workout");
    if (n === 0) {
      return goal.this_week_met
        ? ["good", goal.this_week_workouts === goal.goal ? "That's your weekly goal done. Great work." : "Done for today. Weekly goal already hit."]
        : ["good", `Done for today. ${more} this week.`];
    }
    if (any.at_risk && D <= 2) {
      return ["bad", `Last chance: train ${D === 1 ? "today" : "by tomorrow"} to keep your ${any.current}-week streak.`];
    }
    if (R > D) {
      return ["warn", `${goal.goal} a week is out of reach this week, but a session today still counts.`];
    }
    if (R > 0 && R === D) {
      return ["warn", D === 1 ? "Last day of the week: one more workout hits your goal."
                              : `No rest today: ${plural(R, "workout")} left and ${plural(D, "day")} to do them.`];
    }
    if (n === 1) {
      return ["good", `Well done yesterday. You've earned a rest day today.${R ? ` ${R} more to go this week.` : ""}`];
    }
    if (R === 0) return ["good", "Weekly goal done. A bonus session is up to you."];
    if (n === 2) return ["ok", "Rest day done. Time to train."];
    if (n < 7) return ["bad", `It's been ${n} days. Time to get moving.`];
    return ["bad", "Over a week off. One workout today gets you back on track."];
  }

  // Lifetime stats in the top bar: one glassy pill of icon + value + label items.
  function renderLifetime(t, streak) {
    const el = $("lifetime");
    if (!t.workouts) { el.innerHTML = `<span class="lt-empty">Waiting for your first workout</span>`; return; }
    const since = parseIso(t.first_workout_date);
    const items = [
      ["i-dumbbell", "var(--good)", t.workouts.toLocaleString(), "workouts"],
      ["i-clock", "var(--ok)", fmtHours(t.duration_s), "trained"],
      ["i-calendar", "var(--warn)", t.this_year_workouts.toLocaleString(), `in ${new Date().getFullYear()}`],
      ["i-trophy", "var(--accent)", `${streak.longest} wk`, "best streak"],
      ["i-flag", "var(--c-mobility)", `since ${since.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`, ""],
    ];
    el.innerHTML = items.map(([icon, color, value, label]) => `<div class="lt" style="--lt:${color}">
        <span class="lt-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${icon}"/></svg></span>
        <span class="lt-text"><span class="lt-value">${esc(value)}</span>${label ? `<span class="lt-label">${esc(label)}</span>` : ""}</span>
      </div>`).join("");
  }

  // Campfire on the last-workout card: blazing on a training day, then dying down a step each day
  // after, to embers and finally a wisp of smoke. The next workout relights it.
  const FIRE_STAGES = ["Blazing: you trained today", "Burning well", "Burning low", "Flickering out",
    "Just embers left", "Gone out: a workout relights it"];
  const FLAME = "M20 3C25 11 30.5 15.5 29.5 23.5C28.8 29.2 24.8 32 20 32C15.2 32 11.2 29.2 10.5 23.5C9.9 18 14 14.5 15.6 8.5C17.6 12.6 19 13.6 20 3Z";
  function campfire(daysAgo) {
    const heat = Math.max(0, 5 - daysAgo), f = .3 + .14 * heat, stage = FIRE_STAGES[Math.min(daysAgo, 5)];
    const at = (k) => `translate(20 32) scale(${k}) translate(-20 -32)`;
    const flames = heat >= 2 ? `<g transform="${at(f)}">
        <g class="cf-flick a"><path class="cf-outer" d="${FLAME}"/></g>
        <g class="cf-flick b" transform="${at(.68)}"><path class="cf-mid" d="${FLAME}"/></g>
        <g class="cf-flick c" transform="${at(.4)}"><path class="cf-core" d="${FLAME}"/></g></g>` : "";
    const sparks = heat >= 4 ? [[15, 12, 0], [25, 9, .7], [19, 6, 1.4]].map(([x, y, d]) =>
      `<circle class="cf-spark" cx="${x}" cy="${y}" r=".9" style="animation-delay:${d}s"/>`).join("") : "";
    const embers = heat <= 2 ? [[14, 32.4], [19, 33.6], [24, 32.2], [27.5, 33.4], [17, 31.2]].slice(0, heat === 0 ? 0 : 5).map(([x, y], i) =>
      `<circle class="cf-ember" cx="${x}" cy="${y}" r="${i % 2 ? .9 : 1.2}" style="animation-delay:${i * .4}s"/>`).join("") : "";
    const smoke = heat <= 1 ? `<path class="cf-smoke" d="M20 30C17 25 23 21 20 16C17.5 12 22 9 20.5 4"/>` : "";
    return `<span class="campfire heat-${heat}" title="Campfire: ${stage}"><svg viewBox="0 0 40 40" role="img" aria-label="Campfire: ${stage}">
        <ellipse class="cf-glow" cx="20" cy="34" rx="17" ry="4.5" style="opacity:${(.08 * heat).toFixed(2)}"/>
        <g class="cf-logs${heat === 0 ? " cold" : ""}"><rect x="7" y="31" width="26" height="4.4" rx="2.2" transform="rotate(13 20 33)"/>
          <rect x="7" y="31" width="26" height="4.4" rx="2.2" transform="rotate(-13 20 33)"/></g>
        ${embers}${flames}${sparks}${smoke}</svg></span>`;
  }

  function renderLastCard(w) {
    const el = $("last-card");
    if (!w) {
      el.className = "card hero-card last-card";
      el.innerHTML = `<div class="eyebrow">Last workout</div><div class="big">—</div>
        <div class="last-meta">Your workouts will appear here after the first sync.</div>
        <div class="nudge tone-ok">Log your first workout to get started.</div>`;
      return;
    }
    const n = w.days_ago;
    const when = n === 0 ? "Today" : n === 1 ? "Yesterday" : `${n} days ago`;
    const [tone, msg] = lastWorkoutNudge(n, state.overview.week_streak, state.overview.active_week_streak);
    el.className = `card hero-card last-card tone-${tone}`;
    el.dataset.id = w.id;
    const date = parseIso(w.local_date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const detail = [w.distance_m != null ? fmtKm(w.distance_m) : null, fmtDuration(w.duration_s),
      w.active_energy_kcal != null ? `${Math.round(w.active_energy_kcal)} kcal` : null].filter(Boolean).join(" · ");
    el.innerHTML = `<div class="eyebrow">Last workout</div>
      <div class="big"><span>${when}</span>${campfire(n)}</div>
      <div class="last-activity">${badge(w.activity.category)}<span>${esc(w.activity.label)}</span></div>
      <div class="last-meta">${esc(detail)} · ${esc(date)}, ${fmtClock(w.start, w.utc_offset_minutes)}</div>
      <div class="nudge">${esc(msg)}</div>`;
  }

  // Headline streak: consecutive weeks with at least one workout.
  function renderStreakCard(w) {
    const lit = w.current > 0;
    const left = w.days_left === 1 ? "today" : `in the next ${plural(w.days_left, "day")}`;
    let tone, msg;
    if (w.this_week_met) {
      tone = w.current >= w.longest && w.current > 1 ? "flame" : "good";
      msg = tone === "flame" ? "Personal best streak!" : "This week counts. See you next week.";
    } else if (w.at_risk) {
      tone = w.days_left <= 2 ? "bad" : "warn";
      msg = `Work out ${left} to make it ${plural(w.current + 1, "week")}`;
    } else {
      tone = "ok";
      msg = `Work out ${left} to start a streak`;
    }
    const pct = w.longest ? Math.min(100, (w.current / w.longest) * 100) : 0;
    $("streak-card").innerHTML = `<div class="streak-main"><div class="eyebrow">Weekly streak · any workout</div>
      <div class="streak-row">
        <svg class="flame ${lit ? "lit" : "cold"}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-flame"/></svg>
        <div class="big streak-num">${w.current}<span class="unit">${w.current === 1 ? "week" : "weeks"}</span></div>
      </div>
      <div data-opt="1">
        <div class="best-track"><i style="width:${pct}%"></i></div>
        <div class="best-label"><span><svg viewBox="0 0 24 24"><use href="#i-trophy"/></svg>Best ${plural(w.longest, "week")}</span>
          <span>${w.longest && w.current < w.longest ? `${w.longest - w.current} to beat it` : w.current ? "On your best" : ""}</span></div>
      </div>
      <div class="nudge tone-${tone}">${esc(msg)}</div></div>
      <div class="climb" role="button" tabindex="0" title="Open Carl's trail map" aria-label="Open Carl's trail map">${climbHtml(w)}</div>`;
  }

  // ---- the climb: Carl's mountains -------------------------------------------------
  // The weekly streak is a range of eight themed mountains that grow longer as the year goes on:
  // three of a month, two of six weeks and three of two months, 48 weeks in all. Each week is one
  // step up; halfway Carl reaches a rock ledge, at the top the summit, where he celebrates and
  // pitches a new camp before starting the next mountain. After the eighth the range repeats as a
  // higher tier. Not done this week yet: he hangs on. A missed week drops him to the base of the
  // mountain he is on; missing again while at a base drops him down the previous mountain too.
  // Summits are only lost that way, one mountain per missed week.
  const ROUTE_SUB = 8;       // curve samples per week
  let climbId = 0;           // unique ids for each drawing's gradients
  const MOUNTAINS = [
    { key: "pine", name: "Pine Ridge", top: 70, width: 46, seed: 1 },
    { key: "mesa", name: "Red Rock Mesa", top: 78, width: 60, seed: 2 },
    { key: "ember", name: "Ember Peak", top: 70, width: 42, seed: 3, crater: true },
    { key: "frost", name: "Frost Spire", top: 56, width: 34, seed: 4, snow: 42 },
    { key: "canopy", name: "Canopy Crag", top: 68, width: 44, seed: 5 },
    { key: "stars", name: "Summit of Stars", top: 60, width: 44, seed: 6 },
    { key: "storm", name: "Thunderhead", top: 62, width: 36, seed: 7 },
    { key: "crown", name: "Gilded Crown", top: 54, width: 32, seed: 8 },
  ];
  const MOUNTAIN_WEEKS = { pine: 4, mesa: 4, ember: 4, frost: 6, canopy: 6, stars: 8, storm: 8, crown: 8 };
  const RANGE_WEEKS = MOUNTAINS.reduce((n, m) => n + MOUNTAIN_WEEKS[m.key], 0);
  const weeksOf = (index) => MOUNTAIN_WEEKS[MOUNTAINS[index % MOUNTAINS.length].key];
  const ledgeOf = (index) => weeksOf(index) / 2;
  // weeks from the very start of the first range to the base of mountain `index`
  const startOf = (index) => Math.floor(index / MOUNTAINS.length) * RANGE_WEEKS
    + MOUNTAINS.slice(0, index % MOUNTAINS.length).reduce((n, m) => n + MOUNTAIN_WEEKS[m.key], 0);
  // sideways offset of each week's spot on a route of n weeks (0 at the base, ledge and summit)
  function routeWander(n) {
    const h = n / 2;
    return [0, ...[6, -4, 5, -3].slice(0, h - 1), 0, ...[-5, 4, -3, 5].slice(0, n - h - 1), 0];
  }
  const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

  const mountainInfo = (index) => ({ ...MOUNTAINS[index % MOUNTAINS.length], tier: Math.floor(index / MOUNTAINS.length) + 1 });
  const campName = (index) => (index === 0 ? "base camp" : `Camp ${index + 1}`);

  // Replays the weekly history (oldest first, the last entry is the current week). A week with a
  // workout is one step up; step 8 is the summit, and the next workout starts the next mountain.
  // A missed week drops Carl to the base of his mountain (the summit counts as on it); if he is
  // already at a base, he falls down the previous mountain to its base. The current week only
  // counts once it has a workout, so until then it is `pending`.
  function climbState() {
    const wk = state.weekly;
    let index = 0, step = 0, fell = null, summits = 0, falls = 0, best = null;
    // Weeks that hit the weekly goal: each step remembers whether it was a goal week (gold), a
    // summit banks a medal from those, and lifetime goal weeks grow base camp.
    let golds = [], goalWeeks = 0;
    const medals = {};
    wk.forEach((week, i) => {
      if (week.workouts > 0) {
        const hit = week.workouts >= state.goal;
        if (hit) goalWeeks += 1;
        if (step === weeksOf(index)) { index += 1; step = 1; golds = [hit]; } else { step += 1; golds.push(hit); }
        if (step === weeksOf(index)) { summits += 1; medals[index] = golds.filter(Boolean).length; }
        fell = null;
        if (!best || startOf(index) + step > startOf(best.index) + best.step) best = { index, step };
      } else if (i < wk.length - 1) {
        if (step > 0) { fell = { from: step }; delete medals[index]; step = 0; falls += 1; }
        else if (index > 0) { index -= 1; delete medals[index]; fell = { from: weeksOf(index), down: true }; falls += 1; }
        else fell = null;
        golds = [];
      }
    });
    return { index, step, fell, summits, falls, best, golds, medals, goalWeeks,
      pending: !wk.length || wk[wk.length - 1].workouts === 0 };
  }

  // Minimalist alpine climber. Local coordinates: feet at (0,0), facing right, up is negative y.
  function climber(pose, x, y, facingLeft, scale = 1.25) {
    const flip = facingLeft ? -scale : scale;
    const helmet = (cx, cy, r = 2.05) =>
      `<circle class="cl-face" cx="${cx}" cy="${cy}" r="${r}"/>` +
      `<path class="cl-helmet" d="M${cx - r - .35} ${cy - .15} A${r + .35} ${r + .35} 0 0 1 ${cx + r + .35} ${cy - .15} Z"/>` +
      `<path class="cl-brim" d="M${cx - r - .6} ${cy - .1}H${cx + r + .9}"/>`;
    const parts = {
      // leaning into the face, right hand reaching up for the next hold, left foot stepping up
      climb: `<rect class="cl-pack" x="-3.7" y="-9.6" width="2.9" height="4.8" rx="1" transform="rotate(-18 -2.2 -7.2)"/>
        <path class="cl-body" d="M.2 -4.2L1.9 -8.7"/>
        <path class="cl-limb" d="M1.7 -8.1L3.9 -10.2L5.3 -13M1.6 -7.6L3.6 -6.4L5.1 -6.9M.2 -4.2L2.9 -2.6L2.6 .1M.2 -4.2L-.9 -1.7L-2.4 .2"/>
        <path class="cl-harness" d="M-.5 -4.5L1.1 -3.9"/>${helmet(2.9, -11.2)}`,
      // standing at base camp, looking up, one hand shading the eyes
      stand: `<rect class="cl-pack" x="-3.4" y="-9.4" width="2.8" height="4.9" rx="1"/>
        <path class="cl-body" d="M0 -3.8V-8.6"/>
        <path class="cl-limb" d="M0 -8.1L2.4 -9.6L2.2 -11.2M0 -7.8L-1.4 -5.5L-1 -3.8M0 -3.8L-1.5 -1.8L-1.6 .1M0 -3.8L1.4 -1.8L1.7 .1"/>
        <path class="cl-harness" d="M-.8 -4.2H.9"/>${helmet(.3, -10.9)}`,
      // resting on the ledge: sitting, legs over the edge, pack beside him
      rest: `<rect class="cl-pack" x="-6.4" y="-4.6" width="3" height="4.6" rx="1"/>
        <path class="cl-body" d="M-.4 -.4L.2 -5.2"/>
        <path class="cl-limb" d="M-.4 -.4L3 -.6L3.6 2.6M-.4 -.4L2.3 .2L2.4 3.2M.1 -4.6L2.3 -3L3.4 -1.4M.1 -4.6L-1.6 -2.6L-1.8 -.6"/>
        ${helmet(.5, -7.4)}`,
      // hanging from the ledge by both hands, feet scrabbling
      hang: `<rect class="cl-pack" x="-3.6" y="-6.6" width="2.8" height="4.7" rx="1"/>
        <path class="cl-body" d="M0 -6.8V-1.8"/>
        <path class="cl-limb" d="M0 -6.4L-1.4 -9L-1.2 -11.4M0 -6.4L1.5 -9L1.4 -11.4M0 -1.8L-1.6 .6L-.6 2.8M0 -1.8L1.2 .4L2.6 1.6"/>
        <path class="cl-harness" d="M-.8 -2.2H.9"/>${helmet(0, -8.9)}`,
      // on the summit: arms up in a V, feet apart
      cheer: `<rect class="cl-pack" x="-3.4" y="-9.4" width="2.8" height="4.9" rx="1"/>
        <path class="cl-body" d="M0 -3.8V-8.6"/>
        <path class="cl-limb" d="M0 -8.2L-2.6 -10.6L-3.6 -13.4M0 -8.2L2.6 -10.6L3.6 -13.4M0 -3.8L-2 -1.8L-2.4 .1M0 -3.8L2 -1.8L2.4 .1"/>
        <path class="cl-harness" d="M-.8 -4.2H.9"/>${helmet(0, -10.9)}`,
      // fallen at base camp, lying on his back, helmet knocked aside
      fallen: `<rect class="cl-pack" x="-1.8" y="-1.6" width="4.6" height="1.8" rx=".8"/>
        <path class="cl-body" d="M3.6 -1.6L-1.8 -1.4"/>
        <path class="cl-limb" d="M-1.8 -1.4L-4.2 -3.4L-6 -2.6M-1.8 -1.4L-4.6 -.2L-6.4 .2M2.4 -1.6L3.4 -4.2L5.2 -4.8M2.6 -1.6L4.6 -.4"/>
        <circle class="cl-face" cx="5.8" cy="-1.9" r="1.9"/>
        <path class="cl-helmet" d="M8.6 -4.6A2.4 2.4 0 0 1 12.8 -4.8Z" transform="rotate(24 10.7 -4.7)"/>
        <path class="cl-stars" d="M5 -6.6l.5 1 .9-.6-.3 1 1 .3-1 .3.3 1-.9-.6-.5 1-.5-1-.9.6.3-1-1-.3 1-.3-.3-1 .9.6z"/>`,
    };
    return `<g class="climber ${pose}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${flip},${scale})">${parts[pose]}</g>`;
  }

  // Irregular rock slab for a month ledge, centred on (x, y) with its flat top at y.
  function rockLedge(x, y, done, sc = 1) {
    const p = (dx, dy) => `${(x + dx * sc).toFixed(1)},${(y + dy * sc).toFixed(1)}`;
    return `<g class="cl-rock${done ? " done" : ""}">
      <path d="M${p(-12, .4)} L${p(-9, -.6)} L${p(-3, -.2)} L${p(4, -.7)} L${p(10, -.3)} L${p(12.5, .9)} L${p(10.5, 3)} L${p(6, 3.6)}
        L${p(3.5, 5.6)} L${p(-.5, 4.2)} L${p(-4, 6.2)} L${p(-7.5, 4)} L${p(-11, 3.4)} Z"/>
      <path class="cl-rock-top" d="M${p(-11.4, .2)} L${p(-9, -.6)} L${p(-3, -.2)} L${p(4, -.7)} L${p(10, -.3)} L${p(12, .7)}"/>
      <path class="cl-rock-crack" d="M${p(-2, 1.6)} l1.4 1.8 M${p(6, 1)} l-1 1.6"/>
    </g>`;
  }

  // Small chevron at the midpoint of a route segment, pointing in the climbing direction.
  function routeArrow([x1, y1], [x2, y2], cls) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    return `<path class="cl-arrow ${cls}" d="M-1.7,-1.9 L.9,0 L-1.7,1.9" transform="translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${deg.toFixed(1)})"/>`;
  }

  // Theme scenery. Every mountain is built from the same recipe so it reads as a real massif:
  // a flat summit plateau (room for a tent) with steep shoulders that ease into foothills, the
  // right face in shadow, a few ridgelines, a fainter range behind, and optional snow up top.
  function mountainScene(m, id) {
    const ground = 186, py = m.top, L = 50 - m.width / 2, R = 50 + m.width / 2;
    const rnd = (i) => { const v = Math.sin(i * 12.9898 + m.seed * 78.233) * 43758.5453; return v - Math.floor(v); };
    const P = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    // a slope from the plateau edge to the foot: drops fast at the top, flattens near the base
    const slope = (x0, y0, x1, y1, n, k) => Array.from({ length: n }, (_, i) => {
      const t = (i + 1) / (n + 1), drop = 1 - (1 - t) ** 1.35;
      return [x0 + (x1 - x0) * t + (rnd(k + i) - .5) * 4, y0 + (y1 - y0) * drop + (rnd(k + i + 40) - .5) * 5];
    });
    const left = slope(L, py, -4, 174, 8, 10).reverse();
    const right = slope(R, py, 104, 168, 8, 30);
    const plateau = m.crater
      ? [[L, py], [L + 7, py - 1], [L + 12, py + 4], [50, py + 6], [R - 12, py + 4], [R - 7, py - 1], [R, py]]
      : [[L, py + .8], [L + 3, py - .4], [L + m.width * .3, py - 1], [L + m.width * .55, py], [L + m.width * .8, py - .8], [R - 3, py - .2], [R, py + 1]];
    const outline = [[-4, 178], ...left, ...plateau, ...right, [104, 172]];
    const path = `${P([[-4, 200], ...outline, [104, 200]])}Z`;

    // Distance from the climbing route's straight legs, so busy scenery leaves Carl's line clear.
    const routeLegs = [[[36, ground - 2], [76, 118]], [[76, 118], [L + m.width * .3, py]]];
    const offRoute = (x, y, gap) => routeLegs.every(([[ax, ay], [bx, by]]) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) > gap;
    });

    // Face detail, clipped to the mountain: shadowed right face behind a jagged ridge, ridgelines,
    // a lit rim along the plateau, and a snowcap with a wavy snowline.
    const ridge = [[64, 200], [R - 9, 160], [R - 4, 130], [R - 10, 104], [R - 6, py + 14], [R - 2, py]];
    const shade = `<path class="th-shade" d="${P([...ridge, [104, py], [104, 200]])}Z"/>`;
    const ridges = `<path class="th-ridge" d="${P([[L + 5, py + 2], [L + 1, py + 24], [L - 2, py + 50]])}${P([[L + 16, py + 3], [L + 13, py + 30], [L + 20, py + 60], [L + 14, py + 90]])}${P([[50, py + 4], [48, py + 38], [54, py + 72]])}"/>`;
    const rim = `<path class="th-rim" d="${P([...plateau, ...plateau.slice().reverse().map(([x, y]) => [x, y + 3])])}Z"/>`;
    let snow = "";
    if (m.snow) {
      const line = py + m.snow;
      const wave = Array.from({ length: 9 }, (_, i) => [104 - (108 * (i + 1)) / 10, line + (i % 2 ? 7 : -3) + (rnd(90 + i) - .5) * 5]);
      snow = `<path class="th-snowcap" d="${P([[-4, line], [-4, 0], [104, 0], [104, line], ...wave])}Z"/>`;
    }
    const face = {
      // sandstone layers in alternating bands, erosion grooves and wind-cut hollows
      mesa: [[py + 8, 7, "a"], [py + 22, 10, "b"], [py + 40, 6, "c"], [py + 56, 12, "a"], [py + 78, 8, "b"], [py + 96, 11, "c"]]
        .map(([y, hgt, k]) => `<path class="th-band ${k}" d="M-4 ${y}Q30 ${y - 1.6} 60 ${y + .8}T104 ${y}V${y + hgt}Q70 ${y + hgt + 1.4} 40 ${y + hgt - .6}T-4 ${y + hgt}Z"/>`).join("")
        + `<path class="th-strata" d="M0 ${py + 18}H100M0 ${py + 50}H100M0 ${py + 90}H100"/>`
        + `<path class="th-groove" d="${[L + 4, L + 11, R - 9, R - 3, 14, 88].map((x, i) => `M${x} ${py + (i < 4 ? 3 : 60)}l${i % 2 ? 1.4 : -1.2} ${10 + rnd(140 + i) * 14}`).join("")}"/>`
        + [[16, py + 70, 3.2], [84, py + 36, 2.6], [70, py + 100, 2.2]].map(([x, y, r]) => `<ellipse class="th-hollow" cx="${x}" cy="${y}" rx="${r}" ry="${r * .6}"/>`).join(""),
      ember: `<path class="th-lava" d="M50 ${py + 6}L47 ${py + 26}L51 ${py + 46}L45 ${py + 76}M54 ${py + 5}L57 ${py + 24}"/>
        <ellipse class="th-crater-glow" cx="50" cy="${py + 4}" rx="${m.width * .28}" ry="4"/><path class="th-basalt" d="${[12, 20, 30, 68, 78, 88].map((x, i) => `M${x} ${py + 50 + i * 4}v${30 + rnd(700 + i) * 40}`).join("")}"/>
        <path class="th-crack" d="M${L + 6} ${py + 12}l-4 10l3 8l-5 12M${R - 4} ${py + 20}l5 12l-2 9l4 10M20 ${py + 74}l6 6l-2 8M84 ${py + 60}l-5 8l3 7M60 ${py + 104}l4 6l-3 8"/>`,
      // glacier: crevasses across the ice below the snowline
      frost: `<path class="th-ice" d="M14 ${py + 66}l7 3l5 -2M60 ${py + 58}l8 4l6 -1M28 ${py + 88}l6 2l7 -3M70 ${py + 84}l5 3M40 ${py + 108}l8 2M78 ${py + 110}l6 -2"/>`,
      // small pines scattered up the slopes, thinning with height, plus a few boulders
      pine: Array.from({ length: 34 }, (_, i) => [rnd(500 + i) * 100, py + 24 + rnd(600 + i) ** .6 * (ground - py - 30), i])
        .filter(([x, y]) => offRoute(x, y, 6))
        .map(([x, y, i]) => {
          const h = 3 + (y - py) / 30;
          return i % 6 === 0 ? `<ellipse class="th-boulder" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(h * .5).toFixed(1)}" ry="${(h * .32).toFixed(1)}"/>`
            : `<path class="th-pine${i % 3 ? "" : " far"}" d="M${x.toFixed(1)} ${(y - h).toFixed(1)}l${(-h * .38).toFixed(1)} ${h.toFixed(1)}h${(h * .76).toFixed(1)}z"/>`;
        }).join(""),
      // rainforest: leaf clumps all over the slopes (kept off the route), with flowers here and there
      canopy: Array.from({ length: 70 }, (_, i) => [rnd(200 + i) * 104 - 2, py + 6 + rnd(300 + i) * (ground - py), 2.2 + rnd(400 + i) * 2.8, i])
        .filter(([x, y]) => offRoute(x, y, 7))
        .map(([x, y, r, i]) => `<circle class="th-leaf l${i % 3}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"/>`
          + (i % 7 === 0 ? `<circle class="th-bloom${i % 2 ? " b" : ""}" cx="${(x + r * .4).toFixed(1)}" cy="${(y - r * .3).toFixed(1)}" r=".8"/>` : "")).join(""),
      // storm: rain-dark streaks down the rock and a few wet glints
      storm: `<path class="th-wet" d="${[14, 26, 40, 58, 72, 86].map((x, i) => `M${x} ${py + 20 + i * 6}l-2 ${24 + rnd(800 + i) * 30}`).join("")}"/>`,
      // gilded: veins of gold through the rock that glint
      crown: `<path class="th-gold" d="M${L + 4} ${py + 10}l6 14l-4 12l8 18M${R - 6} ${py + 16}l-5 16l6 14M20 ${py + 70}l10 8l-3 12M78 ${py + 64}l-6 10l4 14"/>`
        + [[L + 10, py + 24], [R - 9, py + 32], [26, py + 80], [74, py + 76], [50, py + 50]].map(([x, y], i) => `<path class="th-glint" style="animation-delay:${(i * .6).toFixed(1)}s" d="M${x} ${y - 2}v4M${x - 2} ${y}h4"/>`).join(""),
      // a constellation traced in light across the rock
      stars: (() => {
        const c = [[L + 4, py + 22], [L + 16, py + 40], [46, py + 30], [R - 6, py + 52], [R + 2, py + 82], [54, py + 98], [36, py + 74]];
        return `<path class="th-const" d="${P(c)}M${c[2][0]},${c[2][1]}L${c[6][0]},${c[6][1]}"/>`
          + c.map(([x, y], i) => `<circle class="th-cstar" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i % 3 ? .9 : 1.3}" style="animation-delay:${(i * .45).toFixed(2)}s"/>`).join("");
      })(),
    }[m.key] || "";
    const detail = `<defs><clipPath id="c-mtn-${id}"><path d="${path}"/></clipPath></defs>
      <g clip-path="url(#c-mtn-${id})">${face}${snow}${shade}${ridges}${rim}</g>`;

    const deco = {
      pine: [[86, 162], [93, 172], [72, 179], [80, 184], [64, 184]].map(([x, y]) =>
        `<path class="th-tree" d="M${x} ${y - 9}L${x - 3.4} ${y}H${x + 3.4}Z"/><path class="th-tree" d="M${x} ${y - 12}L${x - 2.4} ${y - 6}H${x + 2.4}Z"/><path class="th-trunk" d="M${x} ${y}v2"/>`).join("")
        // trailhead signpost, a stump and two mushrooms
        + `<g class="th-sign"><path d="M45 186V177"/><path class="board" d="M42 177.6h8.4l1.6 1.6l-1.6 1.6H42Z"/></g>
          <path class="th-stump" d="M61 186v-2.6h3.4V186Z"/><ellipse class="th-stump-top" cx="62.7" cy="183.4" rx="1.7" ry=".6"/>
          ${[[57, 186, 1], [59.2, 186, .75]].map(([x, y, k]) => `<g transform="translate(${x} ${y}) scale(${k})"><path class="th-shroom-stem" d="M-.5 0V-2.2H.5V0Z"/><path class="th-shroom" d="M-2 -2.1Q0 -4.6 2 -2.1Z"/></g>`).join("")}`,
      // a sandstone arch, saguaros, desert scrub and a tumbleweed
      mesa: `<path class="th-arch" d="M60 186V176Q60 166 68 165Q76 166 76 176V186H72V177Q72 171 68 171Q64 171 64 177V186Z"/>
        ${[[90, 186, 1.25], [45, 187, .7], [97, 187, .75]].map(([x, y, k]) => `<g transform="translate(${x} ${y}) scale(${k})"><path class="th-saguaro" d="M-1.3 0V-13Q-1.3 -14.6 0 -14.6Q1.3 -14.6 1.3 -13V0Z"/>
          <path class="th-saguaro" d="M-1.3 -6H-3.4Q-4.6 -6 -4.6 -7.2V-10.4Q-4.6 -11.4 -3.6 -11.4Q-2.6 -11.4 -2.6 -10.4V-8.1H-1.3ZM1.3 -8.4H3.2Q4.4 -8.4 4.4 -9.6V-12Q4.4 -13 3.5 -13Q2.5 -13 2.5 -12V-10.4H1.3Z"/></g>`).join("")}
        ${[[50, 186], [80, 187], [57, 187]].map(([x, y]) => `<path class="th-scrub" d="M${x - 3} ${y}q1 -3 3 -3.4q2 .4 3 3.4z"/>`).join("")}
        <g transform="translate(40 183.6)"><g class="th-tumble"><circle r="2.4"/><path d="M-1.8 -1Q0 1.6 1.8 -1M-1.2 1.6Q0 -1.8 1.6 1.2M-2 .4L2 -.4"/></g></g>`,
      ember: `<circle class="th-smoke" cx="52" cy="${py - 8}" r="5"/><circle class="th-smoke" cx="58" cy="${py - 18}" r="4"/><circle class="th-smoke" cx="54" cy="${py - 28}" r="3"/>
        ${[[47, -4], [53, -6], [50, -3], [56, -5], [44, -6]].map(([x, dy], i) => `<circle class="th-spark" cx="${x}" cy="${py + dy}" r=".7" style="animation-delay:${(i * .55).toFixed(2)}s"/>`).join("")}
        <ellipse class="th-lavapool" cx="80" cy="186.2" rx="10" ry="2"/>
        ${[[64, 186, 1], [92, 186, .8]].map(([x, y, k]) => `<path class="th-deadtree" transform="translate(${x} ${y}) scale(${k})" d="M0 0V-12M0 -6l-3 -3M0 -8.4l2.6 -2.6M0 -4l2 -1.6"/>`).join("")}`,
      // icicles under the summit rim, and snow falling
      frost: Array.from({ length: Math.floor((R - L - 4) / 3.4) }, (_, i) => {
        const x = L + 2.5 + i * 3.4, len = 2.6 + rnd(120 + i) * 4;
        return `<path class="th-icicle" d="M${x.toFixed(1)} ${py + .6}h2l-1 ${len.toFixed(1)}Z"/>`;
      }).join("") + [[14, 30], [82, 40], [26, 52], [70, 22], [90, 70], [8, 86], [44, 16], [58, 44], [36, 36], [94, 30]]
        .map(([x, y], i) => `<circle class="th-flake" cx="${x}" cy="${y}" r="${i % 2 ? .7 : 1}" style="animation-delay:${(-i * .7).toFixed(1)}s"/>`).join(""),
      // waterfall into a misty pool, hanging vines, palms and ferns at the foot, low cloud drifting
      canopy: `<path class="th-fall" d="M${L + 3} ${py + 2}Q${L - 10} ${py + 50} 4 186"/><path class="th-fall th-fall2" d="M${L + 5} ${py + 2}Q${L - 8} ${py + 50} 7 186"/>
        <ellipse class="th-pool" cx="6" cy="186.4" rx="6" ry="1.6"/>${[[2, 183], [6, 182], [10, 184]].map(([x, y], i) => `<circle class="th-spray" cx="${x}" cy="${y}" r="1.4" style="animation-delay:${i * .5}s"/>`).join("")}
        <path class="th-vine" d="M${L + 10} ${py + 3}q2 10 -1 18q-2 6 0 10M${L + 18} ${py + 2}q-2 8 1 14M${R - 6} ${py + 3}q2 10 -1 16q-2 6 1 9M${R - 14} ${py + 2}q1.6 7 -.6 12"/>
        ${[[L + 9, py + 31], [L + 17, py + 16], [R - 7, py + 28], [R - 6, py + 19], [R - 14, py + 14]].map(([x, y]) => `<path class="th-vleaf" d="M${x} ${y}q2 -1.6 3 .2q-2 1.2 -3 -.2z"/>`).join("")}
        ${[[93, 186, 1], [84, 187, -.8]].map(([x, y, f]) => `<g transform="translate(${x} ${y}) scale(${f} 1)"><path class="th-palm-trunk" d="M0 0Q-1 -8 2 -15"/>
          <path class="th-palm" d="M2 -15Q-3 -18 -7 -14Q-3 -16 2 -15ZM2 -15Q7 -19 11 -15Q6 -16.4 2 -15ZM2 -15Q0 -20.5 -4 -21Q0 -19 2 -15ZM2 -15Q5 -21 9 -20.6Q5 -18.6 2 -15ZM2 -15Q-1.4 -11.6 -4.2 -9Q-1 -12.6 2 -15Z"/></g>`).join("")}
        ${[[44, 186], [70, 186], [62, 186], [58, 186]].map(([x, y]) => `<path class="th-fern" d="M${x} ${y}q-4 -2 -5 -6M${x} ${y}q-1 -4 0 -8M${x} ${y}q3 -3 5 -6M${x} ${y}q-2 -4 -3.4 -7"/>`).join("")}
        <g class="th-mist"><ellipse cx="30" cy="${py + 58}" rx="26" ry="3.6"/><ellipse cx="74" cy="${py + 92}" rx="24" ry="3.2"/></g>`,
      // storm: rain sweeping across the scene and a puddle at the foot
      storm: `<g class="th-rain">${Array.from({ length: 22 }, (_, i) => [rnd(900 + i) * 104 - 2, rnd(950 + i) * 180]).map(([x, y]) => `<path d="M${x.toFixed(1)} ${y.toFixed(1)}l-2 6"/>`).join("")}</g>
        <ellipse class="th-puddle" cx="74" cy="186.4" rx="9" ry="1.6"/>`,
      // gilded: a sea of cloud around the mountain's waist
      crown: `<g class="th-cloudsea"><ellipse cx="18" cy="${py + 92}" rx="22" ry="5"/><ellipse cx="50" cy="${py + 96}" rx="26" ry="5.6"/><ellipse cx="84" cy="${py + 90}" rx="22" ry="5"/></g>`,
      stars: `<circle class="th-moon" cx="84" cy="22" r="6"/><circle class="th-moon-cut" cx="87" cy="19.5" r="5.2"/>
        ${[[12, 18], [24, 34], [70, 12], [92, 44], [8, 50], [36, 10], [62, 30], [16, 74], [48, 22], [94, 84], [4, 30]].map(([x, y], i) => `<circle class="th-star" cx="${x}" cy="${y}" r="${i % 3 ? .6 : .9}"/>`).join("")}`,
    };
    const back = m.key === "storm" ? "M0 200V128L12 114L20 122L30 104L40 116L52 98L62 112L74 100L84 114L94 106L100 112V200Z"
      : m.key === "crown" ? "M0 200V142L14 132L26 138L40 126L54 134L68 124L82 134L100 128V200Z"
      : m.key === "pine"
      ? `M0 200V${Array.from({ length: 26 }, (_, i) => { const x = i * 4, b = 134 + 5 * Math.sin(x / 13); return `${i ? "L" : ""}${x} ${b.toFixed(1)}L${x + 2} ${(b - 5).toFixed(1)}`; }).join("").slice(0)}L100 134V200Z`
      : m.key === "ember" ? "M0 200V136L8 126L14 132L24 116L30 124L40 112L48 122L60 108L68 120L78 110L88 124L96 116L100 120V200Z"
      : m.key === "mesa" ? "M0 200V146H5L7 134H19L21 146H34V152H64L66 140H77L79 128H92L94 140H100V200Z"
      : m.key === "canopy" ? "M0 200V134Q8 124 16 132Q24 120 34 130Q44 118 54 128Q64 116 74 126Q84 118 92 128Q97 124 100 126V200Z"
      : "M0 200L0 140L10 130L20 136L32 120L44 128L58 114L70 124L82 116L94 128L100 122L100 200Z";
    const sky = m.key === "storm" ? `<g class="th-stormcloud"><path d="M-6 ${py - 34}q10 -12 24 -6q8 -10 22 -4q12 -8 24 2q14 -4 20 8q12 0 16 8H-6Z"/><path class="c2" d="M-6 ${py - 50}q14 -10 28 -3q10 -9 24 -2q14 -6 26 4q12 -2 28 6V${py - 44}H-6Z"/></g>
        <path class="th-bolt" d="M70 ${py - 30}l-6 12h5l-7 14l13 -17h-6l5 -9Z"/>`
      : m.key === "crown" ? `<circle class="th-crown-sun-glow" cx="50" cy="${py - 6}" r="30"/><circle class="th-crown-sun" cx="50" cy="${py - 6}" r="14"/>
        <path class="th-crown-rays" d="${Array.from({ length: 9 }, (_, i) => { const a = (-160 + i * 17.5) * Math.PI / 180; return `M${(50 + 18 * Math.cos(a)).toFixed(1)} ${(py - 6 + 18 * Math.sin(a)).toFixed(1)}L${(50 + 44 * Math.cos(a)).toFixed(1)} ${(py - 6 + 44 * Math.sin(a)).toFixed(1)}`; }).join("")}"/>`
      : m.key === "pine" ? `<g class="th-cloud"><path d="M10 ${py - 26}a4 4 0 0 1 7 -2a5 5 0 0 1 9 1a3.4 3.4 0 0 1 1 6.4H11a3 3 0 0 1 -1 -5.4Z"/></g>
        <g class="th-cloud c2"><path d="M68 ${py - 44}a3.4 3.4 0 0 1 6 -1.6a4.4 4.4 0 0 1 8 1a3 3 0 0 1 .6 5.6H69a2.6 2.6 0 0 1 -1 -5Z"/></g>`
      : m.key === "ember" ? `<ellipse class="th-ashglow" cx="50" cy="150" rx="70" ry="44"/>${[[14, 40], [30, 62], [70, 34], [86, 56], [22, 90], [80, 88]].map(([x, y], i) => `<circle class="th-ash" cx="${x}" cy="${y}" r=".6" style="animation-delay:${(-i * 1.1).toFixed(1)}s"/>`).join("")}`
      : m.key === "mesa" ? `<circle class="th-sun-glow" cx="20" cy="${py - 20}" r="16"/><circle class="th-sun" cx="20" cy="${py - 20}" r="8"/>
        <path class="th-haze" d="M4 ${py - 2}H30M60 ${py - 30}H92M50 ${py - 46}H74"/>`
      : m.key === "canopy" ? `<path class="th-rays" d="M86 0L60 ${py + 40}H72ZM98 0L82 ${py + 30}H90Z"/>${[[20, 40], [34, 30], [76, 48]].map(([x, y]) => `<path class="th-bird" d="M${x - 2.4} ${y}q1.2 -1.2 2.4 0q1.2 -1.2 2.4 0"/>`).join("")}`
      : m.key === "stars" ? `<defs><clipPath id="c-sky-${id}"><rect width="100" height="200" rx="8"/></clipPath></defs><g class="th-aurora" clip-path="url(#c-sky-${id})"><path class="a1" d="M-6 ${py - 6}C14 ${py - 30} 30 ${py - 4} 52 ${py - 24}S86 ${py - 42} 106 ${py - 22}"/>
        <path class="a2" d="M-6 ${py - 20}C18 ${py - 40} 38 ${py - 18} 60 ${py - 36}S90 ${py - 50} 106 ${py - 36}"/></g>` : "";
    // Carl tops out on the left half of the plateau; his tent goes on the right half.
    const summit = [L + m.width * .3, py + (m.crater ? .5 : -.5)];
    const tentAt = [R - m.width * .24, py + (m.crater ? 1 : 0)];
    const skyLayer = sky && `<defs><clipPath id="c-skyl-${id}"><rect width="100" height="200" rx="8"/></clipPath></defs><g clip-path="url(#c-skyl-${id})">${sky}</g>`;
    return { sky: skyLayer, back, path, detail, deco: deco[m.key], ground, summit, tentAt };
  }

  function tent(x, y, label, sc = 1) {
    return `<g class="cl-tent" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${sc})">
        <path class="cl-tent-body" d="M-6 0L0 -7.5L6 0Z"/><path class="cl-tent-door" d="M0 -7.5L-2 0H2Z"/>
        <path class="cl-tent-line" d="M0 -7.5V-9M-6 0L-8.4 .1M6 0L8.4 .1"/></g>
      ${label ? `<text class="cl-label" x="${x.toFixed(1)}" y="${(y + 8).toFixed(1)}" text-anchor="middle">${label}</text>` : ""}`;
  }

  // Route geometry on one mountain drawing (100x200). Week k's spot is evenly along base → ledge →
  // summit, pushed sideways by a fixed amount so the line wanders like a real route (purely for
  // looks). The route is a smooth curve (Catmull-Rom) through those spots, sampled ROUTE_SUB times
  // per week so the done and ahead parts are pieces of the same curve.
  function routeGeom(scene, n) {
    const G = scene.ground, base = [36, G - 2], ledge = [76, 118], summit = scene.summit;
    const h = n / 2, wander = routeWander(n);
    const pt = (k) => {
      const [a, b, t] = k <= h ? [base, ledge, k / h] : [ledge, summit, (k - h) / (n - h)];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), off = wander[k];
      return [a[0] + dx * t - (dy / len) * off, a[1] + dy * t + (dx / len) * off];
    };
    const curve = [pt(0)];
    for (let i = 0; i < n; i++) {
      const p0 = pt(Math.max(0, i - 1)), p1 = pt(i), p2 = pt(i + 1), p3 = pt(Math.min(n, i + 2));
      for (let j = 1; j <= ROUTE_SUB; j++) {
        const u = j / ROUTE_SUB, u2 = u * u, u3 = u2 * u;
        curve.push([0, 1].map((c) => .5 * (2 * p1[c] + (p2[c] - p0[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * u3)));
      }
    }
    const line = (a, b) => curve.slice(a * ROUTE_SUB, b * ROUTE_SUB + 1).map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const mid = (k) => [curve[k * ROUTE_SUB + ROUTE_SUB / 2 - 1], curve[k * ROUTE_SUB + ROUTE_SUB / 2 + 1]];
    return { G, base, ledge, summit, pt, line, mid };
  }

  // Souvenirs: Carl brings one keepsake home from each summit. Drawn in a 12x12 box.
  const SOUVENIRS = {
    pine: ["Pinecone", `<ellipse cx="6" cy="6.6" rx="3.3" ry="4.6" fill="#b9814b"/><path d="M3.1 5h5.8M2.9 7.4h6.2M3.5 9.7h5M6 2.2v9" stroke="#6b4423" stroke-width=".7" fill="none"/><path d="M6 2V.6" stroke="#4ade80" stroke-width="1" stroke-linecap="round"/>`],
    mesa: ["Desert bloom", `${[0, 72, 144, 216, 288].map((a) => `<circle cx="${(6 + 2.7 * Math.sin(a * Math.PI / 180)).toFixed(2)}" cy="${(6 - 2.7 * Math.cos(a * Math.PI / 180)).toFixed(2)}" r="2" fill="#f472b6"/>`).join("")}<circle cx="6" cy="6" r="1.4" fill="#fde047"/>`],
    ember: ["Obsidian shard", `<path d="M6 .8L10.4 4.4L8.8 11H3.2L1.6 4.4Z" fill="#7c3aed"/><path d="M6 .8L6.9 6.1L8.8 11M1.6 4.4L6.9 6.1L10.4 4.4" stroke="#ddd6fe" stroke-width=".55" fill="none" stroke-linejoin="round"/>`],
    frost: ["Ice crystal", `<path d="M6 .8v10.4M1.5 3.4l9 5.2M1.5 8.6l9-5.2M4.6 1.8L6 3.2l1.4-1.4M4.6 10.2L6 8.8l1.4 1.4" stroke="#bae6fd" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`],
    canopy: ["Jungle leaf", `<path d="M1.8 10.2C1.6 4.6 5.6 1.4 10.6 1.6C10.8 6.8 7.4 10.6 1.8 10.2Z" fill="#4ade80"/><path d="M1.8 10.2L8.4 3.6M4.4 7.6l-.4-2.2M6.2 5.8l1.9.3" stroke="#166534" stroke-width=".6" fill="none" stroke-linecap="round"/>`],
    stars: ["Fallen star", `<path d="M6 .8L7.5 4.3L11.2 4.6L8.4 7.1L9.3 10.8L6 8.8L2.7 10.8L3.6 7.1L.8 4.6L4.5 4.3Z" fill="#fde047" stroke="#fef9c3" stroke-width=".4" stroke-linejoin="round"/>`],
    storm: ["Fulgurite", `<path d="M7.4 .6L3 6.6H6L4.2 11.4L9.4 4.8H6.4Z" fill="#a5f3fc" stroke="#ecfeff" stroke-width=".45" stroke-linejoin="round"/>`],
    crown: ["Golden crown", `<path d="M1.4 9.6V4L4 6.4L6 2.4L8 6.4L10.6 4V9.6Z" fill="#fbbf24" stroke="#fef3c7" stroke-width=".45" stroke-linejoin="round"/><circle cx="6" cy="7.6" r=".9" fill="#ef4444"/><rect x="1.4" y="9.6" width="9.2" height="1.3" rx=".4" fill="#f59e0b"/>`],
  };
  const souvenir = (key, cls = "", size = "") => `<svg class="souv ${cls}" viewBox="0 0 12 12"${size}><title>${SOUVENIRS[key][0]} from ${MOUNTAINS.find((m) => m.key === key).name}</title>${SOUVENIRS[key][1]}</svg>`;

  // A summit's medal from how many of its 8 weeks hit the weekly goal.
  // gold: every goal week but one; silver: at least half; bronze: the rest
  const medalOf = (goalWeeks, index) => (goalWeeks >= weeksOf(index) - 1 ? "gold" : goalWeeks >= weeksOf(index) / 2 ? "silver" : "bronze");
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  function medalBadge(kind, x, y, sc = 1) {
    return `<g class="cl-medal ${kind}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${sc})"><title>${cap(kind)} medal</title>
        <path class="ribbon" d="M-1.8 -5.4L-1 -1.6M1.8 -5.4L1 -1.6"/><circle r="2.4"/><circle class="shine" r="1.1"/></g>`;
  }

  // Base camp grows with lifetime goal weeks; nothing is ever taken away.
  const CAMP_UPGRADES = [[1, "Campfire"], [3, "Flag"], [6, "Lantern"], [10, "String lights"], [15, "Woodpile"], [21, "Second tent"]];
  function campUpgrades(goalWeeks, G) {
    const has = (i) => goalWeeks >= CAMP_UPGRADES[i][0];
    let out = "";
    if (has(5)) out += `<g class="cl-tent2">${tent(28.5, G, "", .85)}</g>`;
    if (has(1)) out += `<g class="cl-camp-flag"><path class="pole" d="M2.6 ${G}V${G - 17}"/><path class="pennant" d="M2.6 ${G - 17}l6 1.8l-6 1.8Z"/></g>`;
    if (has(2)) out += `<g class="cl-lantern"><path class="arm" d="M2.6 ${G - 12}h2.8v1"/><circle class="halo" cx="5.4" cy="${G - 9.6}" r="3.4"/><rect class="body" x="4.5" y="${G - 10.8}" width="1.8" height="2.4" rx=".4"/></g>`;
    if (has(3)) out += `<g class="cl-lights"><path class="wire" d="M2.6 ${G - 15.6}Q7 ${G - 10} 11 ${G - 10.6}"/>${[[4.6, G - 13.4, "a"], [6.8, G - 11.9, "b"], [9, G - 11, "c"]].map(([x, y, c]) => `<circle class="bulb ${c}" cx="${x}" cy="${y}" r=".6"/>`).join("")}</g>`;
    if (has(4)) out += `<g class="cl-woodpile">${[[16.2, G - 1.4], [19, G - 1.4], [17.6, G - 3.8]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4"/>`).join("")}</g>`;
    if (has(0)) out += `<g class="cl-campfire" transform="translate(22.6 ${G}) scale(1.3)"><path class="logs" d="M-2.6 0L2.6 -1.2M-2.6 -1.2L2.6 0"/><g class="flame"><path d="M0 -6Q2.2 -3.4 1.6 -1.6Q1 -.4 0 -.4Q-1 -.4 -1.6 -1.6Q-2.2 -3.4 0 -6Z"/><path class="core" d="M0 -3.8Q1 -2.4 .7 -1.4Q.4 -.8 0 -.8Q-.4 -.8 -.7 -1.4Q-1 -2.4 0 -3.8Z"/></g></g>`;
    return out;
  }
  const nextUpgrade = (goalWeeks) => CAMP_UPGRADES.find(([n]) => goalWeeks < n);

  // Caption above the drawing: mountain name, progress and the year's six souvenirs.
  function climbCaption(info, sub, doneInYear, medals, tierStart) {
    const peaks = MOUNTAINS.map((m, i) => souvenir(m.key, i < doneInYear ? `done m-${medalOf(medals[tierStart + i] ?? 0, tierStart + i)}` : i === doneInYear ? "now" : "todo")).join("");
    return `<div class="climb-caption">
      <div class="cc-name">${esc(info.name)}${info.tier > 1 ? ` <span class="cc-tier">Tier ${ROMAN[info.tier - 1] || info.tier}</span>` : ""}</div>
      <div class="cc-sub">${esc(sub)}</div>
      <div class="cc-peaks">${peaks}</div>
    </div>`;
  }

  // Wildlife cameos: each mountain has its own visitor, who turns up on about 3 weeks in 5. The
  // week number decides, so a given week always shows the same scene.
  const CAMEOS = {
    pine: ["An eagle circles Pine Ridge", `<g transform="translate(66 34) scale(1.3)"><g class="cm-glide"><path class="cm-eagle" d="M-8 0Q-4 -4.4 0 -.4Q4 -4.4 8 0Q4 -2 0 1Q-4 -2 -8 0Z"/><circle class="cm-eagle-head" cx="0" cy="-.6" r="1"/></g></g>`],
    mesa: ["A lizard suns itself on the mesa", `<g transform="translate(80 183) scale(1.2)"><path class="cm-lizard" d="M-6 -1.2Q-8.4 -.8 -9.6 -2.6M-6 -1.2Q-2 -2.8 2.4 -1.6Q4.6 -1.6 5.6 -2.6Q4.4 -.2 2 -.2Q-2 .4 -6 -1.2Z"/><path class="cm-lizard-leg" d="M-3.4 -1.4L-4.6 .4M-3.2 -1.4L-2 -3.4M1 -1L2.2 .6M1.2 -1.4L2.2 -3.4"/><circle cx="4.4" cy="-2" r=".35" fill="#111"/></g>`],
    ember: ["Bats flutter out of Ember Peak", `${[[26, 46, 1.7], [38, 34, 1.4], [16, 30, 1.15]].map(([x, y, k], i) => `<g transform="translate(${x} ${y}) scale(${k})"><g class="cm-flap" style="animation-delay:${i * .25}s"><path class="cm-bat" d="M-4.4 0Q-3 -2.2 -1.6 -.6Q-.8 -1.8 0 -1.2Q.8 -1.8 1.6 -.6Q3 -2.2 4.4 0Q3 -.2 2.2 1Q1 0 0 1.2Q-1 0 -2.2 1Q-3 -.2 -4.4 0Z"/></g></g>`).join("")}`],
    frost: ["A yeti peeks over Frost Spire", `<g transform="translate(88 168)"><path class="cm-yeti" d="M-5 6V-1.6Q-5 -6.4 0 -6.4Q5 -6.4 5 -1.6V6Z"/><path class="cm-yeti-face" d="M-3 -3.2Q0 -4.6 3 -3.2V.4Q0 2 -3 .4Z"/><circle cx="-1.2" cy="-2" r=".55" fill="#0f172a"/><circle cx="1.2" cy="-2" r=".55" fill="#0f172a"/><path d="M-1 .1Q0 .7 1 .1" stroke="#0f172a" stroke-width=".4" fill="none"/><path class="cm-yeti" d="M-5 1.4Q-8.4 -.4 -8 -4.2" stroke-width="2.2"/></g>`],
    canopy: ["A toucan watches from the vines", `<g transform="translate(83 146) scale(1.6)"><path class="cm-perch" d="M-5 4.2H6"/><ellipse class="cm-toucan" cx="0" cy="0" rx="2.6" ry="4"/><path class="cm-toucan-chest" d="M.4 -3.4Q2.6 -2 2 .6Q1 -1 .4 -3.4Z"/><path class="cm-beak" d="M1.4 -3.2Q5.6 -3.6 6.8 -1.6Q4.6 -2 1.6 -1.8Z"/><circle cx="1" cy="-2.8" r=".45" fill="#e2e8f0"/><path class="cm-toucan" d="M-1.6 3.2L-3.4 6.4" stroke-width="1.4"/></g>`],
    stars: ["A shooting star crosses the sky", `<g class="cm-shoot"><path class="cm-trail" d="M8 16L30 27"/><circle class="cm-star" cx="30" cy="27" r="1.3"/></g>`],
    storm: ["A mountain goat braves the storm", `<g transform="translate(84 150) scale(1.3)"><path class="cm-goat" d="M-4 0Q-4.4 -3 -1.6 -3.4H2.4Q3.6 -3.4 4 -4.6L4.8 -5.6Q5.6 -5 5.4 -3.8Q5 -2.6 4 -2.4V0M-3.4 0V2.4M-1.8 0V2.4M2 0V2.4M3.4 -.2V2.4"/><path class="cm-horn" d="M4.6 -5.6Q4 -7.4 2.8 -7.6"/></g>`],
    crown: ["A little dragon circles the Gilded Crown", `<g transform="translate(24 42) scale(1.4)"><g class="cm-glide"><path class="cm-dragon" d="M-7 1Q-4 -1 -1 0Q2 -1 4 -2.6L6 -2Q5 -.6 3 .4Q0 1.6 -3 1.4Q-5.4 1.6 -7 1ZM-2 -.2L-4.4 -4.8L-.4 -1M.6 -.6L1.2 -5.4L2.4 -1.2"/><circle cx="5" cy="-2.2" r=".35" fill="#1c1917"/></g></g>`],
  };
  function cameo(key, week) {
    if ((Math.imul(week + 7, 2654435761) >>> 0) % 5 >= 3) return "";
    const [title, art] = CAMEOS[key];
    return `<g class="cameo"><title>${title}</title>${art}</g>`;
  }

  // Time of day for the climb's sky, from the viewer's clock.
  function skyPhase(d = new Date()) {
    const h = d.getHours();
    return h >= 21 || h < 5 ? "night" : h < 7 ? "dawn" : h >= 18 ? "dusk" : "day";
  }
  const NIGHT_STARS = [[10, 14], [22, 40], [34, 12], [48, 30], [60, 10], [72, 46], [90, 20], [16, 70], [94, 64], [40, 52], [6, 98]]
    .map(([x, y], i) => `<circle class="th-star" cx="${x}" cy="${y}" r="${i % 3 ? .55 : .85}" style="animation-delay:${(i * .37).toFixed(2)}s"/>`).join("");
  function skyLayers(phase, key, id) {
    if (phase === "day") return { back: "", front: "" };
    if (phase === "night") {
      const moon = key === "stars" ? "" : `<circle class="th-moon" cx="80" cy="26" r="5.4"/><circle class="th-moon-cut" cx="82.8" cy="23.6" r="4.6"/>`;
      return { back: `<rect class="sky-night" width="100" height="200" rx="8"/>${key === "stars" ? "" : NIGHT_STARS}${moon}`,
               front: `<rect class="scene-night" width="100" height="200" rx="8"/>` };
    }
    return { back: `<defs><linearGradient id="g-${phase}-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="${phase}-top"/><stop offset=".75" class="${phase}-low"/></linearGradient></defs>
        <rect width="100" height="200" rx="8" fill="url(#g-${phase}-${id})"/>`, front: "" };
  }

  function climbHtml(w) {
    const { index, step, fell, pending, golds, medals, goalWeeks } = climbState();
    const info = mountainInfo(index), next = mountainInfo(index + 1);
    const id = ++climbId;
    const scene = mountainScene(info, id);
    const W = 100, H = 200;
    const N = weeksOf(index), LEDGE = N / 2;
    const { G, ledge, summit, pt, line, mid } = routeGeom(scene, N);
    const phase = skyPhase(), night = phase === "night", sky = skyLayers(phase, info.key, id);
    const atSummit = step === N;
    const reached = step, fellFrom = fell ? fell.from : 0;

    const route = (reached > 0 ? `<path class="cl-route done" d="${line(0, reached)}"/>` : fellFrom ? `<path class="cl-route old" d="${line(0, fellFrom)}"/>` : "")
      + (reached < N ? `<path class="cl-route ahead" d="${line(reached, N)}"/>` : "")
      // weeks that hit the goal glow gold
      + golds.map((g, k) => (g ? `<path class="cl-route gold" d="${line(k, k + 1)}"/>` : "")).join("");
    const arrows = Array.from({ length: N }, (_, k) => k).filter((k) => k !== reached - 1 && k !== reached)
      .map((k) => routeArrow(...mid(k), k < reached ? "done" : k < fellFrom ? "old" : "ahead")).join("");
    const dots = Array.from({ length: N - 1 }, (_, i) => i + 1).filter((k) => k !== LEDGE)
      .map((k) => { const [x, y] = pt(k); return `<circle class="cl-step${golds[k - 1] ? " gold" : k <= reached ? " done" : k <= fellFrom ? " old" : ""}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.3"/>`; }).join("");
    // a winding dirt road from the drawing's bottom edge back to the foot of the route: wide and
    // swinging up close, narrowing into the scene (the rope from the This week card meets its near end)
    const roadFoot = [pt(0)[0] + 4, 199.2];
    const road = (() => {
      const [ax, ay] = pt(0), [x0, y0] = roadFoot, steps = 48;
      const c = Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps, d = 1 - (1 - t) ** 1.25, ease = Math.sin(Math.min(1, t * 3.5) * Math.PI / 2) ** 2;
        // switchbacks: several wide swings that shrink as the road recedes (eased in so the first
        // bend isn't tighter than the road is wide)
        const swing = 12 * (1 - t) ** .9 * Math.sin(t * Math.PI * 3.2) * ease;
        return [x0 + (ax - x0) * d + swing, y0 + (ay - y0) * d, 5.2 * (1 - t) + 1.3 * t];
      });
      const side = (k) => c.map(([x, y, w], i) => {
        const [px, py] = c[Math.max(0, i - 1)], [nx, ny] = c[Math.min(steps, i + 1)], len = Math.hypot(nx - px, ny - py) || 1;
        return [x + (k * (ny - py) / len) * w / 2, y - (k * (nx - px) / len) * w / 2];
      });
      const P = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
      const l = side(1), r = side(-1);
      // a footpath along the bottom of the drawing, from the rope's corner bolt to the road
      const path = `<path class="cl-footpath" d="M2.4,197.6C${(x0 * .4).toFixed(1)},198.6 ${(x0 * .7).toFixed(1)},197 ${(x0 - 2).toFixed(1)},${y0.toFixed(1)}"/>`;
      return `${path}<g class="cl-road"><path class="surface" d="${P(l)}${P(r.slice().reverse()).replace("M", "L")}Z"/>
        <path class="edge" d="${P(l)}${P(r)}"/><path class="centre" d="${P(c.slice(0, -3))}"/></g>`;
    })();
    const ledgeRock = rockLedge(ledge[0], ledge[1] + 1.2, Math.max(reached, fellFrom) >= LEDGE)
      + `<text class="cl-label" x="${ledge[0] - 15}" y="${ledge[1] + 3}" text-anchor="end">${LEDGE === 4 ? "1 mo" : `${LEDGE} wks`}</text>`;
    const flag = `<g class="cl-summit${atSummit ? " won" : ""}" transform="translate(${summit[0]},${summit[1]})"><path d="M0 0V-10"/><path class="flag" d="M0 -10L6 -8L0 -6Z"/></g>`;
    const camp = campName(index);
    const ground = `<path class="cl-ground" d="M2,${G}H98"/>`;

    let figure = "", extra = "", sub;
    const cs = 1.25;
    if (step > 0) {
      const [x, y] = pt(step), facingLeft = step > LEDGE;
      const [px, py] = pt(step - 1);
      const hang = pending && !atSummit;
      // hanging: hands on the ledge's lip, or on a small rock hold between ledges
      const HANG = 15.2;
      const hip = hang ? [x, y + HANG - 2.6] : step === LEDGE ? [x, y - .5] : [x + (facingLeft ? -.3 : .3), y - 5];
      const rope = atSummit ? "" : `<path class="cl-rope" d="M${hip[0].toFixed(1)},${hip[1].toFixed(1)} Q${((hip[0] + px) / 2).toFixed(1)},${(Math.max(hip[1], py) + 5).toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}"/>`;
      if (atSummit) {
        figure = tent(scene.tentAt[0], scene.tentAt[1], "", 1.2) + climber("cheer", summit[0], summit[1], false, cs)
          + `<g class="cl-confetti">${[[-14, -16, "a"], [-4, -22, "b"], [8, -18, "c"], [14, -10, "a"], [-18, -6, "c"], [2, -28, "b"]]
            .map(([dx, dy, c]) => `<rect class="cf ${c}" x="${summit[0] + dx}" y="${summit[1] + dy}" width="1.6" height="1.6" rx=".3"/>`).join("")}</g>`;
        if (pending) extra = `<text class="cl-alert" x="${summit[0] - 16}" y="${summit[1] - 4}" text-anchor="middle">!</text>`;
        const medal = medalOf(medals[index] ?? 0, index);
        figure += medalBadge(medal, summit[0] - 10, summit[1] - 12, 1.3);
        sub = pending ? `${cap(medal)} medal · work out to start ${next.name}` : `Summit! ${cap(medal)} medal · Next: ${next.name}`;
      } else if (hang) {
        const hold = step === LEDGE ? "" : `<path class="cl-hold" d="M${(x - 3.4).toFixed(1)},${(y + 1.8).toFixed(1)}L${(x - 2.2).toFixed(1)},${(y - .2).toFixed(1)}L${(x + 1.4).toFixed(1)},${(y - .7).toFixed(1)}L${(x + 3.4).toFixed(1)},${(y + 1).toFixed(1)}L${(x + 1.2).toFixed(1)},${(y + 2.6).toFixed(1)}Z"/>`;
        figure = rope + hold + climber("hang", x, y + HANG, facingLeft, cs);
        extra = `<text class="cl-alert" x="${(x + (facingLeft ? 10 : -10)).toFixed(1)}" y="${(y + 9).toFixed(1)}" text-anchor="middle">!</text>`;
        sub = `Hang on, ${plural(N - step, "wk")} to the summit`;  // this week counts as one of them
      } else if ((state.overview?.last_workout?.days_ago ?? 0) >= 5) {
        // this week already counts, but it's been a while: he sits down on his hold and yawns
        const seat = step === LEDGE ? "" : `<path class="cl-hold" d="M${(x - 3.6).toFixed(1)},${(y + 2).toFixed(1)}L${(x - 2.4).toFixed(1)},${(y - .2).toFixed(1)}L${(x + 2).toFixed(1)},${(y - .6).toFixed(1)}L${(x + 3.6).toFixed(1)},${(y + 1.2).toFixed(1)}L${(x + 1.2).toFixed(1)},${(y + 2.8).toFixed(1)}Z"/>`;
        figure = rope + seat + climber("rest", x, y, facingLeft, cs)
          + `<text class="cl-yawn" x="${(x + (facingLeft ? -9 : 9)).toFixed(1)}" y="${(y - 9).toFixed(1)}" text-anchor="middle">yawn</text>`;
        sub = `${plural(N - step, "wk")} to the summit · Carl's getting comfy`;
      } else {
        figure = rope + climber(step === LEDGE ? "rest" : "climb", x, y, facingLeft, cs);
        sub = `${plural(N - step, "wk")} to the summit`;
      }
    } else if (fell) {
      const [fx, fy] = pt(fell.from);
      extra = `<path class="cl-fall" d="M${fx.toFixed(1)},${fy.toFixed(1)} Q${(fx + (fx > 50 ? 16 : -16)).toFixed(1)},${((fy + G) / 2).toFixed(1)} 52,${G - 3}"/>`;
      figure = climber("fallen", 52, G, false, cs);
      sub = `${fell.down ? "Fell down" : "Fell on"} ${info.name} · back to ${camp}`;
    } else {
      // not started: Carl waits at camp, which lives in the This week card below
      sub = night ? `Carl's asleep at ${camp} · Help him reach the top!` : "Help Carl reach the top!";
    }
    // a headlamp glow while he climbs at night
    if (night && step > 0 && !atSummit) {
      const [x, y] = pt(step), hy = pending ? y + 4.2 : y - 9;
      figure = `<circle class="cl-lamp" cx="${x.toFixed(1)}" cy="${hy.toFixed(1)}" r="9"/>` + figure;
    }

    const label = step > 0
      ? `Carl on ${info.name}, ${atSummit ? "at the summit" : `${plural(step, "week")} up, ${plural(N - step, "week")} to the summit`}`
      : fell ? `Carl fell ${fell.down ? "down" : "on"} ${info.name} and is back at ${camp}` : `Carl at ${camp}, ready to climb ${info.name}`;
    const doneInYear = (index + (atSummit ? 1 : 0)) % MOUNTAINS.length;
    return climbCaption(info, sub, atSummit && doneInYear === 0 ? MOUNTAINS.length : doneInYear, medals, Math.floor(index / MOUNTAINS.length) * MOUNTAINS.length) + `<div class="climb-art">
      <svg class="th-${info.key}${night ? " night" : ""}" data-anchor="${pt(0)[0].toFixed(1)},${pt(0)[1].toFixed(1)}" data-foot="${roadFoot.join(",")}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax meet" role="img" aria-label="${label}">
        <defs><linearGradient id="g-sky-${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--sky1)"/><stop offset="1" style="stop-color:var(--sky2)"/>
        </linearGradient></defs>
        <rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="url(#g-sky-${id})"/>${sky.back}
        ${scene.sky}<path class="th-back" d="${scene.back}"/>
        <path class="th-mtn" d="${scene.path}"/>${scene.detail}${scene.deco}${cameo(info.key, state.weekly.length)}
        ${ground}${sky.front}${road}<g class="cl-anchor"><circle cx="${pt(0)[0].toFixed(1)}" cy="${pt(0)[1].toFixed(1)}" r="1.5"/><circle class="eye" cx="${pt(0)[0].toFixed(1)}" cy="${pt(0)[1].toFixed(1)}" r=".6"/></g>${route}${arrows}${dots}${ledgeRock}${flag}${extra}${figure}
      </svg></div>`;
  }

  // Carl's trail map: this tier's six mountains as one range, with the route climbed so far, a camp
  // on every summit reached, his best-ever point, and the souvenirs collected.
  function trailHtml() {
    const st = climbState();
    const tierStart = Math.floor(st.index / MOUNTAINS.length) * MOUNTAINS.length, tier = tierStart / MOUNTAINS.length + 1;
    const pos = startOf(st.index) + st.step;
    const bestAbove = st.best && startOf(st.best.index) + st.best.step > pos ? st.best : null;
    const panels = MOUNTAINS.map((m, i) => {
      const idx = tierStart + i, info = mountainInfo(idx), id = ++climbId, scene = mountainScene(info, id);
      const n = weeksOf(idx), { G, summit, pt, line } = routeGeom(scene, n);
      const done = idx < st.index ? n : idx === st.index ? st.step : 0;
      const summited = done === n;
      const route = (done ? `<path class="cl-route done" d="${line(0, done)}"/>` : "") + (done < n ? `<path class="cl-route ahead" d="${line(done, n)}"/>` : "");
      const flag = `<g class="cl-summit${summited ? " won" : ""}" transform="translate(${summit[0]},${summit[1]})"><path d="M0 0V-10"/><path class="flag" d="M0 -10L6 -8L0 -6Z"/></g>`;
      const camp = summited ? tent(scene.tentAt[0], scene.tentAt[1], "", 1.2) + medalBadge(medalOf(st.medals[idx] ?? 0, idx), summit[0] - 9, summit[1] - 12, 1.6) : "";
      const goldSteps = idx === st.index ? st.golds.map((g, k) => (g ? `<path class="cl-route gold" d="${line(k, k + 1)}"/>` : "")).join("") : "";
      let carl = "";
      if (idx === st.index) {
        const [x, y] = st.step ? pt(st.step) : [52, G];
        carl = `<circle class="trail-you" cx="${x.toFixed(1)}" cy="${(y - 6).toFixed(1)}" r="11"/>`
          + climber(st.step === n ? "cheer" : st.step ? "climb" : "stand", x, y, st.step > n / 2, 1.5);
      }
      const best = bestAbove && bestAbove.index === idx
        ? (() => { const [x, y] = pt(bestAbove.step); return `<g class="trail-best" transform="translate(${x.toFixed(1)},${y.toFixed(1)})"><path d="M0 0V-9"/><path class="flag" d="M0 -9L5.5 -7.2L0 -5.4Z"/></g>`; })()
        : "";
      return `<svg class="th-${m.key}" x="${i * 100}" y="0" width="100" height="200" viewBox="0 0 100 200">
          <defs><linearGradient id="g-sky-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--sky1)"/><stop offset="1" style="stop-color:var(--sky2)"/></linearGradient></defs>
          <rect width="100" height="200" fill="url(#g-sky-${id})"/>${scene.sky}<path class="th-mtn" d="${scene.path}"/>${scene.detail}${scene.deco}
          <path class="cl-ground" d="M0,${G}H100"/>${i === 0 ? tent(11, G, "", 1.4) + campUpgrades(st.goalWeeks, G) : ""}${route}${goldSteps}${flag}${camp}${best}${carl}
        </svg>
        <text class="trail-name${idx === st.index ? " now" : ""}" x="${i * 100 + 50}" y="214" text-anchor="middle">${esc(m.name)}</text>
        <text class="trail-weeks" x="${i * 100 + 50}" y="221" text-anchor="middle">${n === 4 ? "1 month" : n === 8 ? "2 months" : `${n} weeks`}</text>`;
    }).join("");
    const doneInTier = st.index - tierStart + (st.step === weeksOf(st.index) ? 1 : 0);
    const shelf = MOUNTAINS.map((m, i) => {
      const n = st.medals[tierStart + i] ?? 0, got = i < doneInTier, medal = medalOf(n, tierStart + i);
      return `<div class="shelf-item${got ? ` got m-${medal}` : ""}">
        ${souvenir(m.key, got ? `done m-${medal}` : "todo")}
        <div><b>${SOUVENIRS[m.key][0]}</b><span>${got ? `${cap(medal)} · ${n} of ${weeksOf(tierStart + i)} goal weeks` : "not found yet"}</span></div></div>`;
    }).join("");
    const nu = nextUpgrade(st.goalWeeks), owned = CAMP_UPGRADES.filter(([n]) => st.goalWeeks >= n);
    const campLine = `${owned.length ? owned.map(([, name]) => name).join(", ") : "Just the tent so far"}${nu ? ` · next: ${nu[1].toLowerCase()} at ${plural(nu[0], "goal week")}` : " · camp complete"}`;
    const bestText = st.best ? `${mountainInfo(st.best.index).name}${st.best.index >= MOUNTAINS.length ? ` (Tier ${ROMAN[Math.floor(st.best.index / MOUNTAINS.length)]})` : ""}, ${st.best.step === weeksOf(st.best.index) ? "summit" : `week ${st.best.step}`}` : "not started";
    const stats = [["Summits reached", st.summits], ["Falls", st.falls], ["Highest point", bestText], [`Goal weeks (${state.goal}+)`, st.goalWeeks]];
    return `<div class="trail-head"><h3 id="trail-title">Carl's trail</h3>
        <span class="trail-sub">Tier ${ROMAN[tier - 1] || tier} · ${doneInTier} of ${MOUNTAINS.length} summits this range${bestAbove ? " · the small flag marks your best" : ""}</span></div>
      <div class="trail-map"><svg viewBox="0 0 ${MOUNTAINS.length * 100} 226" role="img" aria-label="Carl's trail across the ${MOUNTAINS.length} mountains">${panels}</svg></div>
      <div class="trail-stats">${stats.map(([k, v]) => `<div><span>${k}</span><b>${esc(String(v))}</b></div>`).join("")}</div>
      <div class="eyebrow trail-shelf-title">Souvenirs · medal by goal weeks on the climb: gold for all but one, silver for half or more, bronze below</div>
      <div class="trail-shelf">${shelf}</div>
      <div class="eyebrow trail-shelf-title">Base camp</div>
      <div class="trail-camp">${esc(campLine)}</div>`;
  }

  function openTrail() {
    $("trail-body").innerHTML = trailHtml();
    $("trail").hidden = false;
    $("trail").querySelector(".trail-close").focus();
  }
  function closeTrail() { $("trail").hidden = true; }

  // Carl's camp at the foot of the current mountain, drawn in the This week card. A rope runs from
  // its stake up across the cards to the start of the route (see drawRopes).
  function campHtml() {
    const { index, step, fell, goalWeeks } = climbState();
    const G = 186, night = skyPhase() === "night", waiting = step === 0 && !fell;
    const name = campName(index);
    let carl = "";
    if (waiting && night) {
      carl = `<g class="cl-zzz">${[[19, G - 13, 3.2], [22.5, G - 17.5, 4], [26.5, G - 23, 4.8]]
        .map(([x, y, f], i) => `<text x="${x}" y="${y}" style="font-size:${f}px;animation-delay:${i * .6}s">z</text>`).join("")}</g>`;
    } else if (waiting) {
      carl = climber("stand", 45.5, G, false, 1.35);
    }
    const label = waiting ? `${name}: Carl is waiting to start the climb` : `${name}: Carl's camp in a cave at the foot of the mountain`;
    // the camp sits in a cave: rock arching over it (fading into the card on the left), a dark
    // interior lit by the campfire, stalactites, and a mouth opening right towards the card's edge
    const id = ++climbId;
    const cave = `<defs>
        <linearGradient id="cave-rock-${id}" x1="-2" x2="50" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" class="cave-rock-stop" stop-opacity="0"/><stop offset=".24" class="cave-rock-stop"/></linearGradient>
        <radialGradient id="cave-glow-${id}" cx="22" cy="184" r="24" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f59e0b" stop-opacity="${night ? .3 : .18}"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient></defs>
      <path class="cave-inside" d="M1 ${G}V171Q2 163.4 11 163H33Q42 162.6 45.4 168.8L47 ${G}Z"/>
      <path fill="url(#cave-glow-${id})" d="M1 ${G}V171Q2 163.4 11 163H33Q42 162.6 45.4 168.8L47 ${G}Z"/>
      <path fill="url(#cave-rock-${id})" d="M-2 155H42L46.4 156.6L49.4 161.2L47.4 164.8L49 169.4H45.4Q42 162.6 33 163H11Q2 163.4 1 171V${G}H-2Z"/>
      <path class="cave-crack" d="M14 157.4l2 2.2l-.6 1.8M30 156.8l-1.4 2.4l1.2 1.4M41 158.6l1.6 2"/>
      <path class="cave-drip" d="M15.6 163l.9 3.4l.9-3.4ZM24 163l.7 2.4l.7-2.4ZM29.4 163l1 3.8l1-3.8ZM37.6 163.4l.6 2.2l.6-2.2Z"/>`;
    return `<svg class="camp-scene${night ? " night" : ""}" viewBox="-2 154 54 38" data-anchor="39,183.4" role="img" aria-label="${esc(label)}">
        ${cave}<path class="cl-ground" d="M-2 ${G}H52"/>
        ${tent(11, G, "", 1.4)}${campUpgrades(goalWeeks, G)}
        <g class="cl-stake"><path d="M39 ${G + .4}V182.6"/><path class="coil" d="M36.2 ${G}a2.8 1.3 0 1 0 5.6 0a2.8 1.3 0 1 0 -5.6 0M36.8 ${G - .8}a2.2 1 0 1 0 4.4 0"/></g>
        ${carl}
        <text class="camp-name" x="11" y="191.2" text-anchor="middle">${esc(name)}</text>
      </svg>`;
  }

  // Carl's way up, drawn on a layer above the cards: a railing from the camp to the This week card's
  // right edge, a grappling hook lodged on the top edge with its rope hanging down that edge, a
  // railing along the top edge, then a rope hung across the gap to the mountain drawing's
  // bottom-left corner. Inside the drawing a winding road leads to the start of the route. Everything hugs the card's outline, so none of its
  // content is covered. Things Carl left behind sit on the way: his trainers (he changed into
  // climbing shoes), a flashlight still on and a water bottle. Only drawn
  // when the mountain is above the camp (the stacked layout).
  let ropeKey = "";
  function drawRopes(onlyIfMoved = false) {
    const layer = $("ropes");
    // One-screen layout: nothing scrolls, so the layer is fixed and uses viewport coordinates (body
    // is its own clipping box there, and an absolute layer would drift if it were ever scrolled).
    // Scrolling layout: an absolute layer in document coordinates.
    const fixed = FIT_QUERY.matches, sx = fixed ? 0 : scrollX, sy = fixed ? 0 : scrollY;
    layer.style.position = fixed ? "fixed" : "absolute";
    const from = document.querySelector(".week-camp:not([hidden]) svg"), to = document.querySelector(".climb-art svg");
    const map = (svg, x, y) => {
      const m = svg.getScreenCTM();
      return m ? [x * m.a + y * m.c + m.e + sx, x * m.b + y * m.d + m.f + sy] : null;
    };
    const at = (svg) => map(svg, ...svg.dataset.anchor.split(",").map(Number));
    const a = from && at(from), b = to && at(to);
    const box = $("week-card").getBoundingClientRect();
    const key = [a, b, [box.left, box.top, box.right]].map((p) => (p ? p.map(Math.round).join(",") : "-")).join("|");
    if (onlyIfMoved && key === ropeKey) return;
    ropeKey = key;
    // collapse first so the layer's own old size never props the page open
    layer.setAttribute("width", 0); layer.setAttribute("height", 0); layer.innerHTML = "";
    if (!a || !b || b[1] > a[1] - 24) return;

    const L = box.left + sx, R = box.right + sx, T = box.top + sy;
    const floor = map(from, 39, 186)[1];                 // the camp's ground line
    const lx = R - 6;                                    // where the way up meets the right edge
    const topX = Math.min(R - 34, Math.max(L + 24, b[0]));
    const f = (n) => n.toFixed(1);
    const posts = (x0, x1, y, h, step) => {
      const n = Math.max(1, Math.round(Math.abs(x1 - x0) / step));
      return Array.from({ length: n + 1 }, (_, i) => x0 + ((x1 - x0) * i) / n).map((x) => `M${f(x)},${f(y)}V${f(y - h)}`).join("");
    };
    const railing = (x0, x1, y, h) => `<g class="trail-rail"><path class="posts" d="${posts(x0, x1, y, h, 13)}"/>
        <path class="bar" d="M${f(x0)},${f(y - h)}H${f(x1)}M${f(x0)},${f(y - h / 2)}H${f(x1)}"/></g>`;
    // grappling hook lodged on the top edge by the corner; its brown rope runs over the corner and
    // hangs free down the outside of the right edge
    const hx = R - 2.4, hy = T - 2.6;                    // the hook's eye, pulled up by the rope
    const hook = `<g class="trail-hook" transform="translate(${f(hx)},${f(hy)}) rotate(-17)">
        <path class="shank" d="M0,0L-11.5,.4"/>
        <path class="prong" d="M-11.5,.4C-15.6,.6 -16.6,4.8 -12.4,6.4M-11.5,.4C-15.2,-.2 -16.4,-3.8 -13,-5.4M-11.5,.4C-14.2,-.4 -15.6,-.6 -16.2,-2.6"/>
        <circle class="eye" r="1.7"/></g>
      <path class="trail-scuff" d="M${f(hx - 16)},${f(T + .6)}l-2.4 1.4M${f(hx - 13.4)},${f(T + .8)}l-1.8 1.6"/>`;
    const hangTop = [R + 2.6, T + 6], hangEnd = [R + 3.4, floor - 5];
    const hang = `<path class="trail-hookrope" d="M${f(hx)},${f(hy)}Q${f(R + 2.6)},${f(T - 1)} ${f(hangTop[0])},${f(hangTop[1])}"/>
      <g class="trail-sway" style="transform-origin:${f(hangTop[0])}px ${f(hangTop[1])}px">
        <path class="trail-hookrope" d="M${f(hangTop[0])},${f(hangTop[1])}C${f(R + 5)},${f(T + (floor - T) * .4)} ${f(R + 1)},${f(T + (floor - T) * .7)} ${f(hangEnd[0])},${f(hangEnd[1])}q1.6 3.4 -1.4 4.6"/>
        <path class="trail-hookrope-tex" d="M${f(hangTop[0])},${f(hangTop[1])}C${f(R + 5)},${f(T + (floor - T) * .4)} ${f(R + 1)},${f(T + (floor - T) * .7)} ${f(hangEnd[0])},${f(hangEnd[1])}"/></g>`;
    // a rope hung free between the top of the railing's end post and the bottom-left corner of the
    // mountain drawing, sagging under its own weight (but never below the card's top edge)
    const corner = map(to, 2.4, 197.6), post = [topX + 11, T - 9];
    const sagY = Math.min((post[1] + corner[1]) / 2 + 22, (4 * (T - 3) - post[1] - corner[1]) / 2);
    const ropePath = `M${f(post[0])},${f(post[1])}Q${f((post[0] + corner[0]) / 2)},${f(sagY)} ${f(corner[0])},${f(corner[1])}`;
    const rope = `<path class="trail-hookrope" d="${ropePath}"/><path class="trail-hookrope-tex" d="${ropePath}"/>
      <circle class="trail-knot" cx="${f(post[0])}" cy="${f(post[1])}" r="1.6"/><circle class="trail-bolt" cx="${f(corner[0])}" cy="${f(corner[1])}" r="1.8"/>`;

    // left-behind things
    const shoe = (x, y, flip) => `<path class="trail-shoe" transform="translate(${f(x)},${f(y)}) scale(${flip ? -1 : 1},1)" d="M-4.5 0V-2.6Q-4.5 -4 -3 -4H-1L.4 -2.6L3.6 -1.8Q4.6 -1.4 4.6 0Z"/>
      <path class="trail-lace" transform="translate(${f(x)},${f(y)}) scale(${flip ? -1 : 1},1)" d="M-2.4 -3.4L-.6 -2.2M-1.6 -3.8L.2 -2.6"/>`;
    const shoes = shoe(R - 10, floor, false) + shoe(R - 19, floor + .4, true);
    const fx = (hx - 18 + topX + 30) / 2;
    const flashlight = `<g class="trail-torch" transform="translate(${f(fx)},${f(T)})"><path class="beam" d="M-5 -2.6L-26 -9V3.4Z"/>
        <rect class="body" x="-5" y="-4.2" width="10" height="3.6" rx="1"/><rect class="head" x="-6.4" y="-4.8" width="2.6" height="4.8" rx=".6"/><circle class="lens" cx="-6.4" cy="-2.4" r="1.1"/></g>`;
    const bottle = `<g class="trail-bottle" transform="translate(${f(topX + 24)},${f(T)})"><rect class="body" x="-2" y="-9" width="4" height="9" rx="1.2"/><rect class="cap" x="-1.3" y="-10.8" width="2.6" height="2" rx=".5"/><rect class="label" x="-2" y="-6" width="4" height="2.4"/></g>`;

    const de = document.documentElement, W = fixed ? innerWidth : de.scrollWidth, H = fixed ? innerHeight : de.scrollHeight;
    layer.setAttribute("width", W); layer.setAttribute("height", H);
    layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    layer.innerHTML = railing(a[0] + 2, R - 3, floor, 8) + shoes + railing(hx - 18, topX + 11, T, 9) + hang + hook
      + rope + flashlight + bottle;
  }

  // String lights powered by the Recent form batteries: a wire runs along the tops of the 12
  // batteries (touching each terminal), out of the card, across the gap and along the calendar's
  // top edge, through a transformer that shows the power, then on to a string hanging in uneven
  // arches between pins. The bulbs are in series: the fuller the batteries, the more of them light.
  let lightsKey = "";
  function drawLights(onlyIfMoved = false) {
    const layer = $("lights");
    const fixed = FIT_QUERY.matches, sx = fixed ? 0 : scrollX, sy = fixed ? 0 : scrollY;
    layer.style.position = fixed ? "fixed" : "absolute";
    const batts = [...document.querySelectorAll("#form-card .goal-weeks .batt")].map((b) => b.getBoundingClientRect());
    const cal = document.querySelector(".calendar-card")?.getBoundingClientRect(), form = $("form-card").getBoundingClientRect();
    const cells = document.querySelectorAll("#form-card .goal-weeks .batt i");
    const charge = cells.length ? document.querySelectorAll("#form-card .goal-weeks .batt i.on").length / cells.length : 0;
    const key = [cal, form, batts[0], batts[batts.length - 1]].map((r) => (r ? [r.left, r.top, r.right].map(Math.round).join(",") : "-")).join("|") + `|${charge}`;
    if (onlyIfMoved && key === lightsKey) return;
    lightsKey = key;
    layer.setAttribute("width", 0); layer.setAttribute("height", 0); layer.innerHTML = "";
    // only in the column layout, with the calendar to the left of Recent form at about the same height
    if (!batts.length || !cal || form.left < cal.right || Math.abs(batts[0].top - cal.top) > 160) return;

    const f = (n) => n.toFixed(1);
    const wy = batts[0].top - 3 + sy;                    // wire height over the terminals
    const gx = (cal.right + form.left) / 2 + sx;         // middle of the gap between the cards
    const T = cal.top + sy, R = cal.right + sx, Lx = cal.left + sx;
    const terminals = batts.map((b) => [(b.left + b.right) / 2 + sx, b.top - .5 + sy]);
    const last = terminals[terminals.length - 1];
    // along the battery tops from the newest to the oldest, a little drop to each terminal
    let d = `M${f(last[0] + 6)},${f(wy)}`;
    for (const [x, y] of terminals.slice().reverse()) d += `H${f(x + 2)}Q${f(x)},${f(wy)} ${f(x)},${f(y)}Q${f(x)},${f(wy)} ${f(x - 2)},${f(wy)}`;
    // out of the card, down the gap, over the calendar's corner and along its top edge
    const rad = 16;
    d += `H${f(gx + 3)}Q${f(gx)},${f(wy)} ${f(gx)},${f(wy + 3)}V${f(T - 4)}Q${f(gx)},${f(T - .6)} ${f(R - 2)},${f(T - .6)}H${f(R - rad)}`;
    // pins along the top edge at uneven spacing; the string droops between them in arches of
    // different widths and depths, with the bulbs hanging down from it
    const startX = R - rad - 48, endX = Lx + rad + 6, rnd = (k) => { const v = Math.sin(k * 91.7 + 3.1) * 4373.13; return v - Math.floor(v); };
    const pins = [startX];
    for (let k = 0; pins[pins.length - 1] - endX > 40; k++) pins.push(Math.max(endX, pins[pins.length - 1] - (70 + rnd(k) * 80)));
    if (pins[pins.length - 1] - endX > 0) pins.push(endX);
    const pinY = T - 3.5, bulbs = [], colors = ["#fde68a", "#fca5a5", "#86efac", "#93c5fd", "#f9a8d4"];
    let edge = "", nb = 0;
    pins.slice(1).forEach((x1, k) => {
      const x0 = pins[k], span = x0 - x1, sag = 3 + rnd(k + 20) * 4.5;           // arch depth 3-7.5px
      const cy = pinY + 2 * sag, at = (t) => [x0 + (x1 - x0) * t, (1 - t) ** 2 * pinY + 2 * (1 - t) * t * cy + t * t * pinY];
      edge += `Q${f((x0 + x1) / 2)},${f(cy)} ${f(x1)},${f(pinY)}`;
      const count = Math.max(1, Math.round(span / 24));
      for (let b = 1; b <= count; b++) {
        const [x, y] = at(b / (count + 1));
        bulbs.push([x, y, 180 + (rnd(nb + 40) - .5) * 24, colors[nb % colors.length]]);
        nb += 1;
      }
    });
    d += `L${f(startX)},${f(pinY)}` + edge;
    const tacks = pins.map((x) => `<circle class="light-tack" cx="${f(x)}" cy="${f(pinY)}" r="1.5"/>`).join("");

    // The electrician: a window-washer cradle hung from a trolley on a rail along the calendar's top
    // edge, sliding back and forth through the empty middle of the header (between the month nav
    // and the Today button) while he works on the lights.
    let elec = "";
    const nav = $("next")?.getBoundingClientRect(), today = $("today")?.getBoundingClientRect();
    if (nav && today) {
      const CW = 44, from = nav.right + 28 + sx, to = today.left - 28 - CW + sx;
      if (to > from) {
        const travel = to - from;
        // The lights layer is rebuilt now and then (data refreshes, layout changes). Tie the ride and
        // the spark to the wall clock, so a rebuilt cradle carries on from where he was instead of
        // starting over: the 240 s alternating ride repeats every 480 s, the spark every 9 s.
        const now = Date.now() / 1000, ride = (now % 480).toFixed(2), spark = (now % 9).toFixed(2);
        // fully charged: he parks mid-rail for a coffee; at night he's gone home and left a work lamp
        const shift = skyPhase() === "night" ? "night" : charge >= .999 ? "coffee" : "work";
        const park = shift === "night" ? `animation:none;translate:0 0;` : shift === "coffee" ? `animation:none;translate:${f(travel / 2)}px 0;` : `animation-delay:-${ride}s;`;
        const arm = shift === "coffee"
          ? `<path class="e-limb" d="M.2 -10.4L2.8 -9.2L2.4 -12.2"/><rect class="e-mug" x="1.4" y="-13.8" width="2.4" height="2.4" rx=".5"/>
             <path class="e-steam" d="M2.2 -14.6q-.7 -1 .2 -2.2M3.2 -14.6q-.7 -1 .2 -2.2"/>`
          : `<g class="elec-arm"><path class="e-limb" d="M.2 -10.4L2.6 -14.4L3.6 -18"/><path class="e-bulb" d="M3.6 -18.2c-1.4 -.8 -1.2 -3.4 0 -3.8c1.2 .4 1.4 3 0 3.8Z"/>
                <circle class="e-flash" cx="4" cy="-20.2" r="2.6"/>
                <path class="e-spark" d="M5.4 -21l2 -1.4M5.8 -19l2.4 .3M4.6 -22.6l.7 -2.2M2.4 -22.2l-1.2 -1.8M6 -20l2.6 -.6"/></g>`;
        const man = shift === "night"
          ? `<path class="elec-lampwire" d="M24 0V10"/><circle class="elec-lamp-glow" cx="24" cy="12" r="8"/><path class="elec-lamp" d="M22.3 10h3.4l-.7 3.4h-2Z"/>`
          : `<g class="elec-man" transform="translate(27,25) scale(1.2)">
              <path class="e-body" d="M0 -3.6V-11.4"/>
              <rect class="e-vest" x="-1.9" y="-11" width="3.8" height="5.6" rx="1"/>
              <path class="e-limb" d="M-.2 -10.4L-3 -7.4L-4.6 -6"/>
              ${arm}
              <circle class="e-face" cx=".3" cy="-13.6" r="1.9"/>
              <path class="e-hat" d="M-2.3 -14.1A2.4 2.4 0 0 1 2.9 -14.1Z"/><path class="e-brim" d="M-2.6 -14H3.6"/></g>`;
        const note = { work: "The electrician keeps the lights running. Charge them with workouts.",
          coffee: "Lights fully charged: the electrician is on a coffee break.", night: "The electrician has gone home for the night." }[shift];
        elec = `<path class="elec-rail" d="M${f(from - 8)},${f(T + .4)}H${f(to + CW + 8)}"/>
          <g class="elec-ride" style="--travel:${f(travel)}px;${park}--spark-delay:-${spark}s" transform="translate(${f(from)},${f(T)})">
            <circle class="elec-wheel" cx="6" cy="-1.6" r="1.9"/><circle class="elec-wheel" cx="38" cy="-1.6" r="1.9"/>
            <path class="elec-trolley" d="M3 -1.6H41"/>
            <path class="elec-cable" d="M6 0L3 17M38 0L41 17"/>
            ${man}
            <rect class="elec-panel" x="0" y="19.5" width="${CW}" height="6.5" rx="1"/>
            <path class="elec-railing" d="M0 17H${CW}M0 17V26M11 17V19.5M22 17V19.5M33 17V19.5M${CW} 17V26"/>
            <rect class="elec-toolbox" x="5" y="15.4" width="7" height="4.1" rx=".6"/><path class="elec-toolbox-lid" d="M7 15.4v-1.2h3v1.2"/>
            <title>${note}</title>
          </g>`;
      }
    }
    // The bulbs are in series: the power lights that share of them, counting from the transformer
    // end, at full brightness; the rest stay dark.
    const lit = charge > 0 ? Math.max(1, Math.round(charge * bulbs.length)) : 0;
    const bulb = ([x, y, tilt, color], i) => `<g class="bulb${i < lit ? " on" : ""}" transform="translate(${f(x)},${f(y)}) rotate(${tilt}) scale(1.3)">
        ${i < lit ? `<circle class="bulb-halo" cy="-5" r="7" fill="${color}" style="animation-delay:${(i * .37 % 3).toFixed(2)}s"/>` : ""}
        <rect class="bulb-cap" x="-1.1" y="-2.4" width="2.2" height="2.4" rx=".4"/>
        <path class="bulb-glass" d="M0,-2.2C-2.4,-3.4 -2.2,-7.6 0,-8.6C2.2,-7.6 2.4,-3.4 0,-2.2Z" fill="${color}"/></g>`;
    // The transformer on the calendar's corner, between the incoming wire and the string: its
    // display shows how much power the batteries are sending to the lights.
    const pct = Math.round(charge * 100), level = pct >= 66 ? "hi" : pct >= 33 ? "mid" : "lo";
    const bx = R - rad - 44, by = T - 15.5;
    const transformer = `<g class="xfmr ${level}" transform="translate(${f(bx)},${f(by)})">
        <title>Transformer: ${pct}% power from the batteries, ${lit} of ${bulbs.length} bulbs lit</title>
        <rect class="xf-body" width="38" height="15" rx="2"/>
        <path class="xf-fins" d="M30.5 2.5V12.5M33 2.5V12.5M35.5 2.5V12.5"/>
        <rect class="xf-screen" x="2.5" y="2.2" width="25.5" height="10.6" rx="1.2"/>
        <path class="xf-bolt" d="M6.6 3.6L4.6 7.6H6.4L5.6 11.4L8.6 6.6H6.8L7.8 3.6Z"/>
        <text class="xf-pct" x="25.6" y="8.6" text-anchor="end">${pct}%</text>
        ${Array.from({ length: 5 }, (_, k) => `<rect class="xf-seg${k < Math.ceil(pct / 20) ? " on" : ""}" x="${10.4 + k * 3.3}" y="10" width="2.6" height="1.5" rx=".3"/>`).join("")}
      </g>`;
    const de = document.documentElement, W = fixed ? innerWidth : de.scrollWidth, H = fixed ? innerHeight : de.scrollHeight;
    layer.setAttribute("width", W); layer.setAttribute("height", H);
    layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    layer.innerHTML = `<g class="lights"><title>String lights: ${lit} of ${bulbs.length} lit at ${pct}% power from the last 12 weeks</title>
      <path class="light-wire" d="${d}"/>${bulbs.map(bulb).join("")}${tacks}</g>${transformer}${elec}`;
  }

  function renderWeekCard(w) {
    const r = 34, c = 2 * Math.PI * r;
    const pct = Math.min(1, w.this_week_workouts / w.goal);
    const today = todayIso();
    const weekSecs = w.this_week.reduce((a, d) => a + (state.yearDays.get(d.date)?.duration_s || 0), 0);
    const dots = w.this_week.map((d, i) => {
      const missed = !d.active && d.date < today;  // day already passed without a workout
      const cls = ["wd", d.active && "on", missed && "missed", d.date === today && "today", d.date > today && "future"].filter(Boolean).join(" ");
      const mark = d.workouts > 1 ? `<b>${d.workouts}</b>`
        : d.active ? `<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>`
        : missed ? `<svg viewBox="0 0 24 24"><use href="#i-x"/></svg>` : "";
      return `<div class="${cls}" title="${missed ? "No workout" : plural(d.workouts, "workout")}"><i>${mark}</i>${DOW[i][0]}</div>`;
    }).join("");
    const msg = w.this_week_met ? "Weekly goal hit"
      : `${plural(w.remaining, "more workout")} · ${plural(w.days_left, "day")} left`;
    $("week-card").innerHTML = `<div class="week-head">
        <div class="eyebrow">This week</div>
        <div class="week-head-right">
          <span class="nudge tone-${w.this_week_met ? "good" : "ok"}" data-opt="2">${esc(msg)}</span>
          <span class="goal-stepper" title="Workouts per week that keep your weekly streak">
            <button data-goal="-1" aria-label="Lower weekly goal">−</button>${w.goal}/wk<button data-goal="1" aria-label="Raise weekly goal">+</button>
          </span>
        </div>
      </div>
      <div class="week-top">
        <svg class="ring" viewBox="0 0 84 84" role="img" aria-label="${w.this_week_workouts} of ${w.goal} workouts this week">
          <circle class="track" cx="42" cy="42" r="${r}" fill="none" stroke-width="9"/>
          <circle class="prog" cx="42" cy="42" r="${r}" fill="none" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 42 42)"/>
          <text x="42" y="45" text-anchor="middle">${w.this_week_workouts}/${w.goal}</text>
          <text class="small" x="42" y="59" text-anchor="middle">workouts</text>
        </svg>
        <div>
          <div class="big week-time">${weekSecs ? fmtDuration(weekSecs) : "0m"}</div>
          <div class="sub" data-opt="1">trained this week · ${plural(w.this_week_days, "active day")}</div>
        </div>
        <div class="week-camp" data-opt="3">${campHtml()}</div>
      </div>
      <div class="week-dots">${dots}</div>`;
  }

  // ---- heatmap ------------------------------------------------------------
  function level(day) {
    if (!day) return 0;
    const m = day.duration_s / 60;
    return m < 30 ? 1 : m < 60 ? 2 : m < 90 ? 3 : 4;
  }

  function renderHeatmap() {
    const { start } = heatmapRange();
    const today = new Date();
    const tIso = iso(today);
    const left = 30, top = 18;
    const weeks = Math.ceil(((today - start) / 86400000 + 1) / 7);
    // Size cells to fill the card; below the minimum the card scrolls horizontally.
    const avail = $("heatmap-scroll").clientWidth || 900;
    const maxStep = FIT_QUERY.matches ? Math.max(12, Math.min(24, Math.floor(window.innerHeight * 0.021))) : 24;
    const step = Math.max(12, Math.min(maxStep, Math.floor((avail - left) / weeks)));
    const cell = step - 3;
    const width = left + weeks * step, height = top + 7 * step;
    let rects = "", labels = "", lastMonth = -1;
    let workouts = 0, active = 0;
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const date = addDays(start, w * 7 + d);
        if (date > today) continue;
        const key = iso(date);
        const day = state.yearDays.get(key);
        if (day) { workouts += day.workouts; active++; }
        const tip = day ? `${date.toDateString()}: ${plural(day.workouts, "workout")} · ${fmtDuration(day.duration_s)}` : `${date.toDateString()}: rest`;
        rects += `<rect class="cell l${level(day)}${key === tIso ? " today-cell" : ""}" data-date="${key}" x="${left + w * step}" y="${top + d * step}" width="${cell}" height="${cell}"><title>${tip}</title></rect>`;
        if (d === 0 && date.getMonth() !== lastMonth && date.getDate() <= 7) {
          lastMonth = date.getMonth();
          labels += `<text x="${left + w * step}" y="11">${date.toLocaleDateString(undefined, { month: "short" })}</text>`;
        }
      }
    }
    ["Mon", "Wed", "Fri"].forEach((l, i) => { labels += `<text x="0" y="${top + (i * 2) * step + 10}">${l}</text>`; });
    const svg = $("heatmap");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("aria-label", `Workout heatmap: ${workouts} workouts on ${active} days in the last year`);
    svg.innerHTML = labels + rects;
    $("heatmap-sub").textContent = `${plural(workouts, "workout")} on ${plural(active, "day")}`;
    const scroller = $("heatmap-scroll");
    scroller.scrollLeft = scroller.scrollWidth;
  }

  // ---- calendar -----------------------------------------------------------
  // Carl's climbing buddy, in a headband instead of a helmet, standing on top of the first week
  // summary and leaning on a little rail at the box's top-right corner while the wind streams his
  // long headband tails. His mood follows this week: looking out past the rail, waving a flag once
  // the weekly goal is hit, or dozing on the rail while the week has no workouts yet. Feet on the
  // box's top edge at y 0; the rail post is at x 3.6.
  function sitterHtml() {
    const g = state.overview?.week_streak;
    const mood = !g ? "look" : g.this_week_met ? "cheer" : g.this_week_workouts === 0 ? "doze" : "look";
    const rail = `<path class="s-rail" d="M3.6 .2V-8M3.6 -8H6.6M3.6 -4H6.6M6.6 .2V-8"/>`;
    const legs = `<path class="s-limb s-far" d="M-.4 -4.6L.2 -2.2L.6 0"/><path class="s-limb" d="M-.4 -4.6L-1.2 -2.2L-1.4 0"/>`;
    const tails = `<path class="s-tail t1" d="M.4 -11.1C-2 -12.4 -4 -10 -7.6 -11.8"/><path class="s-tail t2" d="M.4 -10.9C-1.8 -9.6 -4.2 -11.4 -7.2 -9.6"/>`;
    let body;
    if (mood === "doze") {
      // slumped on the rail, head on his folded arms
      body = `<path class="s-body" d="M-.4 -4.6L1.8 -7.6"/>
        <path class="s-limb s-far" d="M1.6 -7.4L3.4 -8.4L5.4 -8.4"/><path class="s-limb" d="M1.8 -7.6L3.8 -8.6L5.8 -8.6"/>
        <circle class="s-face" cx="3.6" cy="-10.1" r="1.9"/><path class="s-band" d="M1.8 -10.8L5.4 -11.6"/>
        <path class="s-tail t1" d="M1.8 -10.8C0 -11 -1.6 -9.6 -3.4 -10.2"/>
        <g class="s-zzz"><text x="5.4" y="-13.6">z</text><text x="7.2" y="-16">z</text></g>`;
    } else if (mood === "cheer") {
      // goal hit: one arm on the rail, the other waving a little flag
      body = `<path class="s-body" d="M-.4 -4.6L1 -8.8"/>
        <path class="s-limb s-far" d="M1 -8.4L2.6 -7.4L4.6 -8.2"/>
        <path class="s-limb" d="M1 -8.6L.4 -11.2L1.2 -13.6"/>
        <g class="s-flag"><path class="s-stick" d="M1.2 -13L1.6 -18.4"/><path class="s-pennant" d="M1.6 -18.4L5.4 -17.2L1.5 -16.2Z"/></g>
        <circle class="s-face" cx="1.8" cy="-10.8" r="1.9"/><path class="s-band" d="M-.1 -11.4L3.6 -11.9"/>${tails}`;
    } else {
      body = `<path class="s-body" d="M-.4 -4.6L1.4 -8.6"/>
        <path class="s-limb s-far" d="M1.2 -8.2L2.6 -7.2L4.6 -8.2"/><path class="s-limb" d="M1.4 -8.4L3 -7.4L5.2 -8.4"/>
        <circle class="s-face" cx="2.3" cy="-10.6" r="1.9"/><path class="s-band" d="M.4 -11.1L4.1 -11.7"/>${tails}`;
    }
    const title = { look: "taking in the view", cheer: "cheering: weekly goal hit!", doze: "dozing until this week's first workout" }[mood];
    return `<svg class="sitter ${mood}" viewBox="-8 -19 15 20" aria-hidden="true">${rail}${legs}${body}<title>Carl's climbing buddy, ${title}</title></svg>`;
  }

  function renderCalendar() {
    $("month-title").textContent = state.month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const byDate = {};
    for (const w of state.workouts) (byDate[w.local_date] ||= []).push(w);
    const tIso = todayIso();
    const start = monday(state.month);
    let html = DOW.map((d) => `<div class="dow" role="columnheader">${d}</div>`).join("") + `<div class="dow wk" role="columnheader">Week</div>`;
    let rows = 0;
    while (rows < 6 && !(rows >= 4 && addDays(start, rows * 7) > state.month && addDays(start, rows * 7).getMonth() !== state.month.getMonth())) rows++;
    const maxChips = chipsPerDay(rows);

    for (let week = 0; week < rows; week++) {
      const weekStart = addDays(start, week * 7);
      let weekTime = 0, activeDays = 0, weekWorkouts = 0;
      for (let dow = 0; dow < 7; dow++) {
        const d = addDays(weekStart, dow);
        const key = iso(d);
        const ws = byDate[key] || [];
        const isActive = ws.length > 0;
        if (isActive) activeDays++;
        weekWorkouts += ws.length;
        weekTime += ws.reduce((a, w) => a + (w.duration_s || 0), 0);
        const prevActive = dow > 0 && (byDate[iso(addDays(d, -1))] || []).length > 0;
        const nextActive = dow < 6 && (byDate[iso(addDays(d, 1))] || []).length > 0;
        const cls = ["day",
          d.getMonth() !== state.month.getMonth() && "outside",
          key === tIso && "today",
          key > tIso && "future",
          isActive && "active",
          isActive && prevActive && "join-l",
          isActive && nextActive && "join-r"].filter(Boolean).join(" ");
        const steps = state.gridSteps.get(key);
        const stepsTag = steps != null && key <= tIso
          ? `<span class="day-steps${steps >= STEP_GOAL ? " hit" : ""}" title="${Math.round(steps).toLocaleString()} steps">${fmtSteps(steps)}</span>` : "";
        const shown = Math.min(ws.length, maxChips);
        const chips = ws.slice(0, shown).map(chipHtml).join("");
        const more = ws.length > shown
          ? `<button class="more-badge" data-date="${key}" title="${plural(ws.length, "workout")}">+${ws.length - shown}</button>` : "";
        html += `<div class="${cls}" data-date="${key}" role="gridcell" aria-label="${d.toDateString()}, ${plural(ws.length, "workout")}">
          ${isActive ? `<span class="band"></span><svg class="day-tick" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-dumbbell"/></svg>` : ""}
          <div class="day-top"><span class="num">${d.getDate()}</span>${stepsTag}${more}${key === tIso ? `<span class="today-tag">Today</span>` : ""}</div>
          <div class="chips">${chips}</div></div>`;
      }
      const met = weekWorkouts >= state.goal;
      const pct = Math.min(100, (weekWorkouts / state.goal) * 100);
      html += `<div class="week-total${met ? " met" : ""}">${week === 0 ? sitterHtml() : ""}
        <strong>${activeDays ? fmtDuration(weekTime) : "—"}</strong>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <span class="goal">${met ? `<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>Goal` : `${weekWorkouts}/${state.goal} workouts`}</span></div>`;
    }
    const cal = $("calendar");
    cal.style.setProperty("--rows", rows);
    cal.innerHTML = html;
  }

  // How many workout chips fit in a day cell at the current calendar height.
  function chipsPerDay(rows) {
    const cal = $("calendar");
    if (!FIT_QUERY.matches) { cal.classList.remove("dots"); return 3; }
    const h = cal.clientHeight;
    if (!h) return 3;
    const rowH = (h - 22 - rows * 5) / rows;
    const fit = Math.floor((rowH - 28) / 25);
    cal.classList.toggle("dots", fit < 1);  // too short for labels: compact dots (up to 4)
    return fit < 1 ? 4 : Math.min(4, fit);
  }

  function appIcon(w) {
    const src = w.source_app && APP_ICONS[w.source_app.toLowerCase()];
    return src ? `<img class="app-icon" src="${src}" alt="${esc(w.source_app)}" width="14" height="14">` : "";
  }

  function chipHtml(w) {
    const meta = DISTANCE_CATEGORIES.has(w.activity.category) && w.distance_m ? fmtKm(w.distance_m) : fmtDuration(w.duration_s);
    const sel = w.id === state.selectedId ? " selected" : "";
    return `<button class="chip${sel}" style="--cat:${catVar(w.activity.category)}" data-id="${w.id}" title="${esc(w.activity.label)} · ${fmtClock(w.start, w.utc_offset_minutes)} · ${fmtDuration(w.duration_s)}">` +
      `${appIcon(w) || `<span class="dot"></span>`}<span class="name">${esc(shortLabel(w.activity))}</span><span class="meta">${meta}</span></button>`;
  }

  // ---- daily activity (health metrics) --------------------------------------
  function metricOn(name, date) { return state.metrics[name]?.byDate.get(date); }

  function renderActivity() {
    const el = $("activity-card");
    const hasAny = Object.values(state.metrics).some((m) => m.byDate.size);
    if (!hasAny) {
      el.innerHTML = `<div class="card-head"><h2>Daily activity</h2></div>
        <div class="none">No health metrics yet. Add a Health Auto Export automation with data type <strong>Health Metrics</strong> pointing at this PC.</div>`;
      return;
    }
    const today = new Date();
    const tIso = iso(today);
    // Show today when it has synced; otherwise the most recent day that has activity data.
    const dayMetrics = ["step_count", "walking_running_distance", "active_energy", "flights_climbed"];
    const latest = dayMetrics.flatMap((n) => [...(state.metrics[n]?.byDate.keys() ?? [])]).filter((d) => d <= tIso).sort().pop();
    const shown = metricOn("step_count", tIso) != null || !latest ? tIso : latest;
    const shownLabel = shown === tIso ? "today"
      : shown === iso(addDays(today, -1)) ? "yesterday"
      : parseIso(shown).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const shownSteps = metricOn("step_count", shown);
    const steps = shownSteps ?? 0;
    const stepsSub = `steps ${shown === tIso || shownLabel === "yesterday" ? shownLabel : `on ${shownLabel}`} · ` +
      (steps >= STEP_GOAL ? "goal hit" : `${Math.round(STEP_GOAL - steps).toLocaleString()} to ${STEP_GOAL / 1000}k`);
    const r = 26, c = 2 * Math.PI * r, pct = Math.min(1, steps / STEP_GOAL);

    // Last 7 days of steps, oldest first.
    const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
    const vals = week.map((d) => metricOn("step_count", iso(d)) ?? 0);
    const max = Math.max(STEP_GOAL, ...vals);
    const goalPct = (STEP_GOAL / max) * 100;
    const bars = week.map((d, i) => {
      const v = vals[i], h = Math.max(3, (v / max) * 100);
      const cls = [v >= STEP_GOAL && "hit", iso(d) === shown && "today"].filter(Boolean).join(" ");
      return `<div class="sbar ${cls}" title="${d.toDateString()}: ${Math.round(v).toLocaleString()} steps"><i style="height:${h}%"></i><span>${DOW[(d.getDay() + 6) % 7][0]}</span></div>`;
    }).join("");
    const synced = week.map((d) => metricOn("step_count", iso(d))).filter((v) => v != null);
    const avg7 = synced.length ? synced.reduce((a, b) => a + b, 0) / synced.length : 0;


    el.innerHTML = `<div class="card-head"><h2>Daily activity</h2><span class="card-sub">7-day avg ${Math.round(avg7).toLocaleString()} steps</span></div>
      <div class="act-top">
        <svg class="ring steps-ring" viewBox="0 0 64 64" aria-hidden="true">
          <circle class="track" cx="32" cy="32" r="${r}" fill="none" stroke-width="7"/>
          <circle class="prog" cx="32" cy="32" r="${r}" fill="none" stroke-width="7" stroke-linecap="round"
            stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 32 32)"/>
        </svg>
        <div>
          <div class="act-steps">${shownSteps == null ? "—" : Math.round(steps).toLocaleString()}</div>
          <div class="sub">${esc(stepsSub)}</div>
        </div>
        <div class="step-bars" style="--goal:${goalPct}%">${bars}</div>
      </div>
      ${weightRow()}`;
    scheduleFit();
  }

  function weightRow() {
    const m = state.metrics.weight_body_mass;
    if (!m || !m.byDate.size) return "";
    const lb = m.sourceUnit === "lb" || m.sourceUnit === "lbs";
    const conv = (kg) => (lb ? kg / 0.45359237 : kg);
    const unit = lb ? "lb" : "kg";
    const entries = [...m.byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const [lastDate, last] = entries[entries.length - 1];
    const first = entries[0][1];
    const diff = conv(last) - conv(first);
    const trend = entries.length > 1 && Math.abs(diff) >= 0.05
      ? `<span class="delta ${diff < 0 ? "down-neutral" : "up-neutral"}">${diff < 0 ? "▼" : "▲"} ${Math.abs(diff).toFixed(1)} ${unit} · 30d</span>` : "";
    const lo = Math.min(...entries.map((e) => e[1])), hi = Math.max(...entries.map((e) => e[1]));
    const W = 90, H = 26;
    const pts = entries.map(([d, v], i) => `${entries.length === 1 ? W / 2 : (i / (entries.length - 1)) * W},${hi === lo ? H / 2 : H - 2 - ((v - lo) / (hi - lo)) * (H - 4)}`).join(" ");
    const when = lastDate === todayIso() ? "today" : parseIso(lastDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<div class="weight-row">
      <div><div class="stat-label">Weight</div><div class="mini-value">${conv(last).toFixed(1)} ${unit} <span class="weight-when">${when}</span></div>${trend}</div>
      <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>
    </div>`;
  }

  // ---- side panels --------------------------------------------------------
  function monthAgg(monthDate) {
    const prefix = iso(monthDate).slice(0, 7);
    let workouts = 0, days = 0, secs = 0;
    for (const [k, d] of state.yearDays) if (k.startsWith(prefix)) { workouts += d.workouts; days++; secs += d.duration_s; }
    return { workouts, days, secs };
  }

  function delta(cur, prev, fmt) {
    if (prev == null) return "";
    const diff = cur - prev;
    if (Math.abs(diff) < 1e-9) return `<div class="delta" data-opt="1">= same</div>`;
    return `<div class="delta ${diff > 0 ? "up" : "down"}" data-opt="1">${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff))}</div>`;
  }

  function renderSide() {
    const prefix = iso(state.month).slice(0, 7);
    const ws = state.workouts.filter((w) => w.local_date.startsWith(prefix));
    const days = new Set(ws.map((w) => w.local_date)).size;
    const secs = ws.reduce((a, w) => a + (w.duration_s || 0), 0);
    const kcal = ws.reduce((a, w) => a + (w.active_energy_kcal || 0), 0);

    // Month-over-month deltas only when the previous month is inside the heatmap window.
    const prevMonth = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
    const inWindow = prevMonth >= startOfMonth(heatmapRange().start) && state.overview;
    const prev = inWindow ? monthAgg(prevMonth) : null;
    const pn = prevMonth.toLocaleDateString(undefined, { month: "short" });

    const dist = {};
    for (const w of ws) if (DISTANCE_CATEGORIES.has(w.activity.category) && w.distance_m) dist[w.activity.category] = (dist[w.activity.category] || 0) + w.distance_m;
    const distStats = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([c, m]) => `<div class="stat dist"><div class="stat-label">${CATEGORY_LABELS[c]} km</div><div class="stat-value">${(m / 1000).toFixed(1)}</div></div>`).join("");

    $("month-stats").innerHTML = `<div class="card-head"><h2>${state.month.toLocaleDateString(undefined, { month: "long" })} at a glance</h2>${prev ? `<span class="card-sub">▲▼ vs ${pn}</span>` : ""}</div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Workouts</div><div class="stat-value">${ws.length}</div>${delta(ws.length, prev?.workouts, (v) => v)}</div>
        <div class="stat"><div class="stat-label">Active days</div><div class="stat-value">${days}</div>${delta(days, prev?.days, (v) => v)}</div>
        <div class="stat"><div class="stat-label">Time</div><div class="stat-value">${fmtDuration(secs)}</div>${delta(secs, prev?.secs, fmtDuration)}</div>
        <div class="stat"><div class="stat-label">Kcal</div><div class="stat-value">${Math.round(kcal).toLocaleString()}</div></div>
        ${distStats}
      </div>`;
  }

  // ---- recent form: goal history + last sessions ----------------------------
  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function renderForm() {
    const el = $("form-card");
    const goal = state.goal;
    const thisMonday = monday(new Date());

    // Goal history: workouts per Monday-start week for the last FORM_WEEKS weeks (oldest first).
    const weeks = Array.from({ length: FORM_WEEKS }, (_, i) => {
      const start = addDays(thisMonday, (i - (FORM_WEEKS - 1)) * 7);
      let n = 0;
      for (let d = 0; d < 7; d++) n += state.yearDays.get(iso(addDays(start, d)))?.workouts || 0;
      return { start, n, current: i === FORM_WEEKS - 1 };
    });
    const done = weeks.filter((w) => !w.current || w.n >= goal);
    const hits = done.filter((w) => w.n >= goal).length;
    // Each week is a battery with one cell per workout of the weekly goal, filled from the bottom.
    const bars = weeks.map((w) => {
      const cls = w.n >= goal ? "hit" : w.n > 0 ? "part" : "zero";
      const cells = Array.from({ length: goal }, (_, i) => `<i class="${i < w.n ? "on" : ""}"></i>`).join("");
      const label = w.start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `<div class="gw ${cls}${w.current ? " current" : ""}" title="Week of ${label}: ${w.n} of ${goal} workouts${w.current ? " (this week)" : ""}">
        <div class="batt">${cells}</div><span>${w.n || ""}</span></div>`;
    }).join("");

    const sessions = state.recent;
    el.innerHTML = `<div class="card-head"><h2>Recent form</h2>
        <span class="card-sub">Goal hit <strong>${hits}</strong> of the last ${plural(done.length, "week")}</span></div>
      <div class="goal-weeks">${bars}</div>
      <div class="gw-axis" data-opt="3"><span>${FORM_WEEKS} weeks ago</span><span>${goal}/wk goal</span><span>this week</span></div>
      <div data-opt="2"><div class="form-sub">Last ${plural(sessions.length, "session")}</div>
      ${sessions.length ? boxPlot("Duration", sessions.map((w) => ({ v: w.duration_s / 60, est: !!w.flags.duration_estimated, w })), (v) => fmtDuration(v * 60))
                        + `<div data-opt="1">${boxPlot("Calories", sessions.filter((w) => w.active_energy_kcal != null).map((w) => ({ v: w.active_energy_kcal, w })), (v) => `${Math.round(v)} kcal`)}</div>`
                        : `<div class="none">No workouts yet.</div>`}
      </div>
      <div data-opt="4">${trendLine()}</div>`;
    scheduleFit();
  }

  // No scrolling: when a card's content is taller than its box, hide its optional sections
  // (marked data-opt="N") one at a time, lowest N first, until it fits.
  function fitCard(el) {
    const opts = [...el.querySelectorAll("[data-opt]")].sort((a, b) => a.dataset.opt - b.dataset.opt);
    opts.forEach((o) => { o.hidden = false; });
    if (!FIT_QUERY.matches) return;
    for (const o of opts) {
      if (el.scrollHeight <= el.clientHeight + 1) break;
      o.hidden = true;
    }
  }

  // Fit every card after the layout has settled (renders and size changes can come in any order).
  // (setTimeout rather than requestAnimationFrame so it also runs in background tabs.)
  let fitTimer = 0, ropeTimer = 0;
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { document.querySelectorAll(".card").forEach(fitCard); drawRopes(); drawLights(); }, 40);
    // late layout shifts (fonts, the calendar redrawing) can move the rope's ends, so check again
    clearTimeout(ropeTimer);
    ropeTimer = setTimeout(() => { drawRopes(); drawLights(); }, 600);
  }

  // Slim line: trailing moving average of workouts per week since the first workout.
  function trendLine() {
    const weeks = state.weekly;
    if (weeks.length < 2) return "";
    // Rough trend, not exact: Gaussian-smooth the weekly counts, then keep ~40 points.
    const counts = weeks.map((w) => w.workouts);
    const sigma = TREND_WINDOW / 2, reach = Math.ceil(sigma * 3);
    const smooth = counts.map((_, i) => {
      let sum = 0, wsum = 0;
      for (let k = -reach; k <= reach; k++) {
        const j = i + k;
        if (j < 0 || j >= counts.length) continue;
        const wt = Math.exp(-(k * k) / (2 * sigma * sigma));
        sum += counts[j] * wt; wsum += wt;
      }
      return sum / wsum;
    });
    const step = Math.max(1, Math.round(smooth.length / 40));
    const idx = smooth.map((_, i) => i).filter((i) => i % step === 0 || i === smooth.length - 1);
    const ma = idx.map((i) => smooth[i]);
    const W = 300, H = 60, P = 4;
    const top = Math.max(...ma, 2) * 1.12;  // always leave room for the 1 and 2 per week guides
    const x = (i) => (i / (ma.length - 1)) * W;
    const y = (v) => P + (1 - v / top) * (H - 2 * P);
    const d = smoothPath(ma.map((v, i) => [x(i), y(v)]));
    const peak = Math.max(...ma), now = ma[ma.length - 1];
    const first = parseIso(weeks[0].start).toLocaleDateString(undefined, { month: "short", year: "numeric" });

    // Year ticks: this calendar day in each earlier year, positioned on the same week scale as the line.
    const t0 = parseIso(weeks[0].start).getTime(), span = parseIso(weeks[weeks.length - 1].start).getTime() - t0;
    const today = new Date();
    const ticks = [];
    for (let yr = today.getFullYear() - 1; yr >= parseIso(weeks[0].start).getFullYear(); yr--) {
      const f = (new Date(yr, today.getMonth(), today.getDate()).getTime() - t0) / span;
      if (f > 0 && f < 1) ticks.push({ f, label: `'${String(yr).slice(2)}` });
    }
    const tickLines = ticks.map((k) => `<line class="trend-tick" x1="${(k.f * W).toFixed(1)}" x2="${(k.f * W).toFixed(1)}" y1="${H - 5}" y2="${H + 3}"/>`).join("");
    const tickLabels = ticks.filter((k) => k.f > 0.1 && k.f < 0.92)
      .map((k) => `<span class="trend-year" style="left:${(k.f * 100).toFixed(2)}%">${k.label}</span>`).join("");
    return `<div class="trend">
      <div class="bp-head"><span>Workouts / week</span>
        <span class="bp-note">trend · now <strong>~${now.toFixed(1)}</strong> · peak ~${peak.toFixed(1)}</span></div>
      <div class="trend-plot">
      ${[1, 2].map((v) => `<span class="trend-guide-label" style="top:${((y(v) / H) * 100).toFixed(1)}%">${v}/wk</span>`).join("")}
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
        aria-label="Smoothed trend of workouts per week since ${first}: now about ${now.toFixed(1)}, peak about ${peak.toFixed(1)}">
        ${tickLines}
        ${[1, 2].map((v) => `<line class="trend-guide" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join("")}
        <path class="trend-glow" d="${d}"/>
        <path class="trend-line" d="${d}"/>
        <path class="trend-now" d="M${x(ma.length - 1).toFixed(1)},${y(now).toFixed(1)}h0"/>
      </svg>
      </div>
      <div class="trend-axis"><span>${first}</span>${tickLabels}<span>now</span></div>
    </div>`;
  }

  // Smooth curve through points (Catmull-Rom converted to cubic Bezier segments).
  function smoothPath(pts) {
    const t = 1 / 6;
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
      const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
      d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  // Horizontal box-and-whisker plot: whiskers = min..max, box = Q1..Q3, line = median,
  // dots = sessions (hollow when estimated), latest session highlighted.
  function boxPlot(label, points, fmt) {
    if (!points.length) return `<div class="bp"><div class="bp-head"><span>${label}</span><span class="bp-note">no data in these sessions</span></div></div>`;
    const vals = points.map((p) => p.v).sort((a, b) => a - b);
    const min = vals[0], max = vals[vals.length - 1];
    const q1 = quantile(vals, 0.25), med = quantile(vals, 0.5), q3 = quantile(vals, 0.75);
    const span = max - min || Math.max(1, max * 0.2);
    const lo = min - span * 0.08, hi = max + span * 0.08;
    const W = 300, H = 34, P = 6, cy = 15;
    const x = (v) => P + ((v - lo) / (hi - lo)) * (W - 2 * P);
    const latest = points.find((p) => p.w === state.recent[0]);
    const showBox = vals.length >= 3;
    const dots = points.map((p) => {
      const isLatest = p === latest;
      return `<circle class="bp-dot${p.est ? " est" : ""}${isLatest ? " latest" : ""}" cx="${x(p.v).toFixed(1)}" cy="${cy}" r="${isLatest ? 5.5 : 3.6}">
        <title>${p.w.local_date}: ${fmt(p.v)}${p.est ? " (estimated)" : ""}</title></circle>`;
    }).join("");
    const box = showBox ? `<line class="bp-whisker" x1="${x(min)}" x2="${x(max)}" y1="${cy}" y2="${cy}"/>
        <line class="bp-whisker" x1="${x(min)}" x2="${x(min)}" y1="${cy - 6}" y2="${cy + 6}"/>
        <line class="bp-whisker" x1="${x(max)}" x2="${x(max)}" y1="${cy - 6}" y2="${cy + 6}"/>
        <rect class="bp-box" x="${x(q1)}" y="${cy - 9}" width="${Math.max(2, x(q3) - x(q1))}" height="18" rx="4"/>
        <line class="bp-median" x1="${x(med)}" x2="${x(med)}" y1="${cy - 9}" y2="${cy + 9}"/>` : "";
    let cmp = "";
    if (latest && vals.length > 1) {
      const diff = latest.v - med;
      const same = Math.abs(diff) < (label === "Duration" ? 0.5 : 1);
      cmp = same ? "latest ≈ median" : `latest ${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff))} vs median`;
    }
    return `<div class="bp">
      <div class="bp-head"><span>${label}</span><span class="bp-note">${showBox ? `median <strong>${fmt(med)}</strong> · ` : ""}${esc(cmp)}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label} of the last ${points.length} sessions: ${fmt(min)} to ${fmt(max)}">
        ${box}${dots}
        <text x="${P}" y="${H - 1}">${fmt(min)}</text><text x="${W - P}" y="${H - 1}" text-anchor="end">${fmt(max)}</text>
      </svg></div>`;
  }

  // ---- detail drawer ------------------------------------------------------
  async function showDetail(id) {
    state.selectedId = id;
    renderCalendar();
    $("detail").hidden = false;
    $("drawer-backdrop").hidden = false;
    $("detail-body").innerHTML = `<p class="note">Loading…</p>`;
    try {
      const w = await api(`/workouts/${id}`);
      const hr = w.metrics_available.heart_rate ? await api(`/workouts/${id}/metrics?type=heart_rate`) : null;
      $("detail-body").innerHTML = detailHtml(w, hr?.series.heart_rate?.samples || []);
    } catch (e) {
      $("detail-body").innerHTML = `<p class="note">Could not load workout: ${esc(e.message)}</p>`;
    }
  }

  function closeDetail() {
    $("detail").hidden = true;
    $("drawer-backdrop").hidden = true;
    state.selectedId = null;
    renderCalendar();
  }

  function detailHtml(w, hrSamples) {
    const date = parseIso(w.local_date).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const when = `${date} · ${fmtClock(w.start, w.utc_offset_minutes)}–${fmtClock(w.end, w.utc_offset_minutes)}`;
    const cells = [["Duration", `${w.flags.duration_estimated ? "≈ " : ""}${fmtDuration(w.duration_s)}`]];
    if (w.distance_m != null) cells.push(["Distance", fmtKm(w.distance_m)]);
    if (w.avg_pace_s_per_km != null) {
      cells.push(w.activity.category === "cycle" ? ["Avg speed", `${w.avg_speed_kmh.toFixed(1)} km/h`] : ["Avg pace", fmtPace(w.avg_pace_s_per_km)]);
    }
    if (w.active_energy_kcal != null) cells.push(["Active energy", `${Math.round(w.active_energy_kcal)} kcal`]);
    if (w.heart_rate_bpm?.avg != null) cells.push(["Avg heart rate", `${w.heart_rate_bpm.avg} bpm`]);
    if (w.heart_rate_bpm?.max != null) cells.push(["Max heart rate", `${w.heart_rate_bpm.max} bpm`]);
    if (w.elevation_up_m != null) cells.push(["Elevation gain", `${Math.round(w.elevation_up_m)} m`]);
    if (w.extra_metrics.intensity) cells.push(["Intensity", `${w.extra_metrics.intensity.value.toFixed(1)} MET`]);
    if (w.extra_metrics.temperature) cells.push(["Temperature", `${Math.round(w.extra_metrics.temperature.value)} °C`]);

    const notes = [];
    if (w.route_points) notes.push(`GPS route recorded (${w.route_points} points)`);
    if (w.source_app) notes.push(`Recorded with ${w.source_app}`);
    const series = Object.keys(w.metrics_available).filter((k) => k !== "heart_rate");
    if (series.length) notes.push(`Also recorded: ${series.map((s) => s.replace(/_/g, " ")).join(", ")}`);
    const flags = w.flags.heart_rate_data_was_recovery ? [`The exported heart-rate trace was post-workout recovery data, so it is shown as recovery.`] : [];
    if (w.flags.imported_from === "fitbod_csv") notes.push("Imported from your Fitbod history. Duration is estimated from the number of sets.");

    return `<div class="detail-head">${badge(w.activity.category)}<div><h3>${esc(w.activity.label)}</h3>
        <div class="detail-when">${esc(when)}${w.location ? ` · ${esc(w.location)}` : ""}</div></div></div>
      <div class="detail-grid">${cells.map(([k, v]) => `<div class="stat"><div class="stat-label">${k}</div><div class="stat-value">${esc(v)}</div></div>`).join("")}</div>
      ${hrSamples.length > 1 ? `<h4>Heart rate</h4>${hrChart(hrSamples, w)}` : ""}
      ${notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
      ${flags.map((f) => `<p class="flag">${esc(f)}</p>`).join("")}`;
  }

  function hrChart(samples, w) {
    const W = 360, H = 150, P = { l: 30, r: 8, t: 10, b: 20 };
    const t0 = new Date(w.start).getTime(), t1 = Math.max(new Date(w.end).getTime(), t0 + 1);
    const lo = Math.min(...samples.map((s) => s.v)), hi = Math.max(...samples.map((s) => s.v));
    const yMin = Math.floor((lo - 5) / 10) * 10, yMax = Math.ceil((hi + 5) / 10) * 10;
    const x = (t) => P.l + ((new Date(t).getTime() - t0) / (t1 - t0)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - yMin) / (yMax - yMin)) * (H - P.t - P.b);
    const pts = samples.map((s) => [x(s.t), y(s.v)]);
    const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${H - P.b}L${pts[0][0].toFixed(1)},${H - P.b}Z`;
    const ticks = [yMin, Math.round((yMin + yMax) / 2), yMax];
    const mins = Math.round((t1 - t0) / 60000);
    return `<svg class="hr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Heart rate from ${lo} to ${hi} bpm">
      <defs><linearGradient id="g-hr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb7185" stop-opacity=".35"/><stop offset="1" stop-color="#fb7185" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="0" y="${y(v) + 3}">${v}</text>`).join("")}
      <path class="area" d="${area}"/><path class="line" d="${line}"/>
      <text x="${P.l}" y="${H - 4}">0 min</text><text x="${W - P.r}" y="${H - 4}" text-anchor="end">${mins} min</text>
    </svg>`;
  }

  // ---- events -------------------------------------------------------------
  function goToMonth(d, flashDate) {
    state.month = startOfMonth(d);
    loadMonth().then(() => {
      if (!flashDate) return;
      const cell = document.querySelector(`.day[data-date="${flashDate}"]`);
      if (cell) { cell.scrollIntoView({ behavior: "smooth", block: "center" }); cell.classList.add("flash"); }
    }).catch((e) => toast(e.message));
  }

  $("prev").addEventListener("click", () => goToMonth(new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1)));
  $("next").addEventListener("click", () => goToMonth(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1)));
  $("today").addEventListener("click", () => goToMonth(new Date(), todayIso()));
  $("detail-close").addEventListener("click", closeDetail);
  $("drawer-backdrop").addEventListener("click", closeDetail);

  $("last-card").addEventListener("click", () => { const id = Number($("last-card").dataset.id); if (id) showDetail(id); });
  $("last-card").addEventListener("keydown", (e) => { if (e.key === "Enter") $("last-card").click(); });

  $("streak-card").addEventListener("click", (e) => { if (e.target.closest(".climb")) openTrail(); });
  $("streak-card").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.closest(".climb")) { e.preventDefault(); openTrail(); } });
  $("trail").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeTrail(); });

  $("week-card").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-goal]");
    if (!btn) return;
    const g = Math.min(7, Math.max(1, state.goal + Number(btn.dataset.goal)));
    if (g === state.goal) return;
    state.goal = g;
    saveGoal(g);
    loadOverview().catch((err) => toast(err.message));
    renderCalendar();
  });

  $("heatmap").addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (cell) goToMonth(parseIso(cell.dataset.date), cell.dataset.date);
  });

  $("calendar").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip, .more-badge");
    if (!chip) return;
    if (chip.dataset.id) showDetail(Number(chip.dataset.id));
    else if (chip.dataset.date) {
      const ws = state.workouts.filter((w) => w.local_date === chip.dataset.date);
      toast(ws.map((w) => `${w.activity.label} ${fmtDuration(w.duration_s)}`).join(" · "));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "Escape" && !$("trail").hidden) closeTrail();
    else if (e.key === "Escape" && !$("detail").hidden) closeDetail();
    else if (e.key === "ArrowLeft" && $("detail").hidden) $("prev").click();
    else if (e.key === "ArrowRight" && $("detail").hidden) $("next").click();
  });

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const r = await api("/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const c = r.workouts;
      toast(`Imported ${c.received} workouts: ${c.inserted} new, ${c.updated} updated, ${c.unchanged} unchanged${c.failed ? `, ${c.failed} failed` : ""}`);
      await refreshAll();
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });

  // Redraw the calendar when its box settles or changes size (first layout, window resize,
  // fonts loading), since chips-per-day and the dot mode depend on the cell height.
  let calHeight = 0, calTimer;
  new ResizeObserver(([entry]) => {
    const h = Math.round(entry.contentRect.height);
    if (Math.abs(h - calHeight) < 3) return;
    calHeight = h;
    clearTimeout(calTimer);
    calTimer = setTimeout(renderCalendar, 60);
  }).observe($("calendar"));

  new ResizeObserver(scheduleFit).observe(document.querySelector(".page"));
  document.fonts?.ready.then(scheduleFit);
  // catch any late layout shift that moves the rope's ends without resizing the page
  setInterval(() => { if (!document.hidden) { drawRopes(true); drawLights(true); } }, 1500);
  window.addEventListener("load", scheduleFit);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.overview) renderHeatmap(); renderCalendar(); }, 150);
  });

  // Keep fresh while open so pushes from the phone appear without a reload.
  setInterval(() => { if (!document.hidden && $("detail").hidden) refreshAll(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });

  refreshAll();
})();
