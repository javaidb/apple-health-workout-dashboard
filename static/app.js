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
      <div class="big">${when}</div>
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
      <div class="climb">${climbHtml(w)}</div>`;
  }

  // ---- the climb: Carl's mountains -------------------------------------------------
  // The weekly streak is a series of themed mountains, one every 8 weeks (about 2 months), six
  // to a year. Each week is one step up; at 4 weeks Carl reaches a rock ledge, at 8 the summit,
  // where he celebrates and pitches a new camp before starting the next mountain. After the sixth
  // the cycle repeats as a higher tier. Not done this week yet: he hangs on. A missed week drops
  // him to the base of the mountain he is on; missing again while at a base drops him down the
  // previous mountain too. Summits are only lost that way, one mountain per missed week.
  const CLIMB_WEEKS = 8;     // weeks per mountain
  const CLIMB_LEDGE = 4;     // the ledge halfway up
  const ROUTE_WANDER = [0, 6, -4, 5, 0, -5, 4, -3, 0];   // sideways offset of each week's spot
  const ROUTE_SUB = 8;       // curve samples per week
  let climbId = 0;           // unique ids for each drawing's gradients
  const MOUNTAINS = [
    { key: "pine", name: "Pine Ridge", top: 70, width: 46, seed: 1 },
    { key: "mesa", name: "Red Rock Mesa", top: 78, width: 60, seed: 2 },
    { key: "ember", name: "Ember Peak", top: 70, width: 42, seed: 3, crater: true },
    { key: "frost", name: "Frost Spire", top: 60, width: 38, seed: 4, snow: true },
    { key: "canopy", name: "Canopy Crag", top: 68, width: 44, seed: 5 },
    { key: "stars", name: "Summit of Stars", top: 58, width: 40, seed: 6, snow: true },
  ];
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
    let index = 0, step = 0, fell = null;
    wk.forEach((week, i) => {
      if (week.workouts > 0) {
        if (step === CLIMB_WEEKS) { index += 1; step = 1; } else step += 1;
        fell = null;
      } else if (i < wk.length - 1) {
        if (step > 0) { fell = { from: step }; step = 0; }
        else if (index > 0) { index -= 1; fell = { from: CLIMB_WEEKS, down: true }; }
        else fell = null;
      }
    });
    return { index, step, fell, pending: !wk.length || wk[wk.length - 1].workouts === 0 };
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

    // Face detail, clipped to the mountain: shadowed right face behind a jagged ridge, ridgelines,
    // a lit rim along the plateau, and a snowcap with a wavy snowline.
    const ridge = [[64, 200], [R - 9, 160], [R - 4, 130], [R - 10, 104], [R - 6, py + 14], [R - 2, py]];
    const shade = `<path class="th-shade" d="${P([...ridge, [104, py], [104, 200]])}Z"/>`;
    const ridges = `<path class="th-ridge" d="${P([[L + 5, py + 2], [L + 1, py + 24], [L - 2, py + 50]])}${P([[L + 16, py + 3], [L + 13, py + 30], [L + 20, py + 60], [L + 14, py + 90]])}${P([[50, py + 4], [48, py + 38], [54, py + 72]])}"/>`;
    const rim = `<path class="th-rim" d="${P([...plateau, ...plateau.slice().reverse().map(([x, y]) => [x, y + 3])])}Z"/>`;
    let snow = "";
    if (m.snow) {
      const line = py + 30;
      const wave = Array.from({ length: 9 }, (_, i) => [104 - (108 * (i + 1)) / 10, line + (i % 2 ? 7 : -3) + (rnd(90 + i) - .5) * 5]);
      snow = `<path class="th-snowcap" d="${P([[-4, line], [-4, 0], [104, 0], [104, line], ...wave])}Z"/>`;
    }
    const face = {
      mesa: `<path class="th-strata" d="M0 ${py + 14}H100M0 ${py + 36}H100M0 ${py + 64}H100M0 ${py + 92}H100"/>`,
      ember: `<path class="th-lava" d="M50 ${py + 6}L47 ${py + 26}L51 ${py + 46}L45 ${py + 76}M54 ${py + 5}L57 ${py + 24}"/>`,
      frost: `<path class="th-ice" d="M30 136l4 6M80 130l-3 7M40 152l3 4"/>`,
    }[m.key] || "";
    const detail = `<defs><clipPath id="c-mtn-${id}"><path d="${path}"/></clipPath></defs>
      <g clip-path="url(#c-mtn-${id})">${face}${snow}${shade}${ridges}${rim}</g>`;

    const deco = {
      pine: [[10, 170], [18, 177], [86, 162], [93, 172], [30, 181], [72, 179], [6, 181]].map(([x, y]) =>
        `<path class="th-tree" d="M${x} ${y - 9}L${x - 3.4} ${y}H${x + 3.4}Z"/><path class="th-trunk" d="M${x} ${y}v2"/>`).join(""),
      mesa: `<path class="th-cactus" d="M88 182v-9m0 4h-2.4v-3m2.4 2h2.4v-3.6"/><path class="th-cactus" d="M12 184v-6m0 3h1.8v-2.4"/>`,
      ember: `<circle class="th-smoke" cx="52" cy="${py - 8}" r="5"/><circle class="th-smoke" cx="58" cy="${py - 18}" r="4"/><circle class="th-smoke" cx="54" cy="${py - 28}" r="3"/>`,
      frost: [[14, 30], [82, 40], [26, 52], [70, 22], [90, 70], [8, 86]].map(([x, y]) => `<circle class="th-flake" cx="${x}" cy="${y}" r=".9"/>`).join(""),
      canopy: `<path class="th-fall" d="M${L + 3} ${py + 2}Q${L - 2} ${py + 60} ${L - 12} 186"/><path class="th-fall th-fall2" d="M${L + 5} ${py + 2}Q${L} ${py + 60} ${L - 9} 186"/>
        <path class="th-vine" d="M${L + 10} ${py + 3}q2 10 -1 18M${L + 18} ${py + 2}q-2 8 1 14M${R - 6} ${py + 3}q2 10 -1 16"/>`,
      stars: `<circle class="th-moon" cx="84" cy="22" r="6"/><circle class="th-moon-cut" cx="87" cy="19.5" r="5.2"/>
        ${[[12, 18], [24, 34], [70, 12], [92, 44], [8, 50], [36, 10], [62, 30], [16, 74]].map(([x, y], i) => `<circle class="th-star" cx="${x}" cy="${y}" r="${i % 3 ? .6 : .9}"/>`).join("")}`,
    };
    const back = "M0 200L0 140L10 130L20 136L32 120L44 128L58 114L70 124L82 116L94 128L100 122L100 200Z";
    // Carl tops out on the left half of the plateau; his tent goes on the right half.
    const summit = [L + m.width * .3, py + (m.crater ? .5 : -.5)];
    const tentAt = [R - m.width * .24, py + (m.crater ? 1 : 0)];
    return { back, path, detail, deco: deco[m.key], ground, summit, tentAt };
  }

  function tent(x, y, label, sc = 1) {
    return `<g class="cl-tent" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${sc})">
        <path class="cl-tent-body" d="M-6 0L0 -7.5L6 0Z"/><path class="cl-tent-door" d="M0 -7.5L-2 0H2Z"/>
        <path class="cl-tent-line" d="M0 -7.5V-9M-6 0L-8.4 .1M6 0L8.4 .1"/></g>
      ${label ? `<text class="cl-label" x="${x.toFixed(1)}" y="${(y + 8).toFixed(1)}" text-anchor="middle">${label}</text>` : ""}`;
  }

  // Caption above the drawing: mountain name, progress and the year's six peaks.
  function climbCaption(info, sub, doneInYear) {
    const peaks = MOUNTAINS.map((m, i) => `<i class="cc-peak${i < doneInYear ? " done" : i === doneInYear ? " now" : ""}" title="${m.name}"></i>`).join("");
    return `<div class="climb-caption">
      <div class="cc-name">${esc(info.name)}${info.tier > 1 ? ` <span class="cc-tier">Tier ${ROMAN[info.tier - 1] || info.tier}</span>` : ""}</div>
      <div class="cc-sub">${esc(sub)}</div>
      <div class="cc-peaks" aria-hidden="true">${peaks}</div>
    </div>`;
  }

  function climbHtml(w) {
    const { index, step, fell, pending } = climbState();
    const info = mountainInfo(index), next = mountainInfo(index + 1);
    const id = ++climbId;
    const scene = mountainScene(info, id);
    const W = 100, H = 200, G = scene.ground;
    const base = [24, G - 2], ledge = [76, 118], summit = scene.summit;
    // Week k's spot on the route: evenly along base → ledge → summit, pushed sideways by a fixed
    // amount so the line wanders like a real route up the face (purely for looks).
    const pt = (k) => {
      const [a, b, t] = k <= CLIMB_LEDGE ? [base, ledge, k / CLIMB_LEDGE] : [ledge, summit, (k - CLIMB_LEDGE) / (CLIMB_WEEKS - CLIMB_LEDGE)];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), off = ROUTE_WANDER[k];
      return [a[0] + dx * t - (dy / len) * off, a[1] + dy * t + (dx / len) * off];
    };
    // The route is a smooth curve (Catmull-Rom) through the week spots, sampled ROUTE_SUB times per
    // week so the done and ahead parts are pieces of the same curve.
    const curve = [pt(0)];
    for (let i = 0; i < CLIMB_WEEKS; i++) {
      const p0 = pt(Math.max(0, i - 1)), p1 = pt(i), p2 = pt(i + 1), p3 = pt(Math.min(CLIMB_WEEKS, i + 2));
      for (let j = 1; j <= ROUTE_SUB; j++) {
        const s = j / ROUTE_SUB, s2 = s * s, s3 = s2 * s;
        curve.push([0, 1].map((c) => .5 * (2 * p1[c] + (p2[c] - p0[c]) * s + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * s2 + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * s3)));
      }
    }
    const line = (a, b) => curve.slice(a * ROUTE_SUB, b * ROUTE_SUB + 1).map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const mid = (k) => [curve[k * ROUTE_SUB + ROUTE_SUB / 2 - 1], curve[k * ROUTE_SUB + ROUTE_SUB / 2 + 1]];
    const atSummit = step === CLIMB_WEEKS;
    const reached = step, fellFrom = fell ? fell.from : 0;

    const route = (reached > 0 ? `<path class="cl-route done" d="${line(0, reached)}"/>` : fellFrom ? `<path class="cl-route old" d="${line(0, fellFrom)}"/>` : "")
      + (reached < CLIMB_WEEKS ? `<path class="cl-route ahead" d="${line(reached, CLIMB_WEEKS)}"/>` : "");
    const arrows = Array.from({ length: CLIMB_WEEKS }, (_, k) => k).filter((k) => k !== reached - 1 && k !== reached)
      .map((k) => routeArrow(...mid(k), k < reached ? "done" : k < fellFrom ? "old" : "ahead")).join("");
    const dots = Array.from({ length: CLIMB_WEEKS - 1 }, (_, i) => i + 1).filter((k) => k !== CLIMB_LEDGE)
      .map((k) => { const [x, y] = pt(k); return `<circle class="cl-step${k <= reached ? " done" : k <= fellFrom ? " old" : ""}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.3"/>`; }).join("");
    const ledgeRock = rockLedge(ledge[0], ledge[1] + 1.2, Math.max(reached, fellFrom) >= CLIMB_LEDGE)
      + `<text class="cl-label" x="${ledge[0] - 15}" y="${ledge[1] + 3}" text-anchor="end">1 mo</text>`;
    const flag = `<g class="cl-summit${atSummit ? " won" : ""}" transform="translate(${summit[0]},${summit[1]})"><path d="M0 0V-10"/><path class="flag" d="M0 -10L6 -8L0 -6Z"/></g>`;
    const camp = campName(index);
    const ground = `<path class="cl-ground" d="M2,${G}H98"/>`;

    let figure = "", extra = "", sub;
    const cs = 1.25;
    if (step > 0) {
      const [x, y] = pt(step), facingLeft = step > CLIMB_LEDGE;
      const [px, py] = pt(step - 1);
      const hang = pending && !atSummit;
      const hip = hang ? [x, y + 4.5] : step === CLIMB_LEDGE ? [x, y - .5] : [x + (facingLeft ? -.3 : .3), y - 5];
      const rope = atSummit ? "" : `<path class="cl-rope" d="M${hip[0].toFixed(1)},${hip[1].toFixed(1)} Q${((hip[0] + px) / 2).toFixed(1)},${(Math.max(hip[1], py) + 5).toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}"/>`;
      if (atSummit) {
        figure = `<g class="cl-newcamp">${tent(scene.tentAt[0], scene.tentAt[1], "", 1.1)}</g>` + climber("cheer", summit[0], summit[1], false, cs)
          + `<g class="cl-confetti">${[[-14, -16, "a"], [-4, -22, "b"], [8, -18, "c"], [14, -10, "a"], [-18, -6, "c"], [2, -28, "b"]]
            .map(([dx, dy, c]) => `<rect class="cf ${c}" x="${summit[0] + dx}" y="${summit[1] + dy}" width="1.6" height="1.6" rx=".3"/>`).join("")}</g>`;
        if (pending) extra = `<text class="cl-alert" x="${summit[0] - 16}" y="${summit[1] - 4}" text-anchor="middle">!</text>`;
        sub = pending ? `Summit reached · work out to start ${next.name}` : `Summit! Next: ${next.name}`;
      } else if (hang) {
        figure = rope + climber("hang", x, y + 9.5, facingLeft, cs);
        extra = `<text class="cl-alert" x="${(x + (facingLeft ? 10 : -10)).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">!</text>`;
        sub = `Hang on, ${plural(CLIMB_WEEKS - step + 1, "wk")} to the summit`;
      } else {
        figure = rope + climber(step === CLIMB_LEDGE ? "rest" : "climb", x, y, facingLeft, cs);
        sub = `${plural(CLIMB_WEEKS - step, "wk")} to the summit`;
      }
    } else if (fell) {
      const [fx, fy] = pt(fell.from);
      extra = `<path class="cl-fall" d="M${fx.toFixed(1)},${fy.toFixed(1)} Q${(fx + (fx > 50 ? 16 : -16)).toFixed(1)},${((fy + G) / 2).toFixed(1)} 52,${G - 3}"/>`;
      figure = climber("fallen", 52, G, false, cs);
      sub = `${fell.down ? "Fell down" : "Fell on"} ${info.name} · back to ${camp}`;
    } else {
      figure = climber("stand", 52, G, false, cs);
      sub = "Help Carl reach the top!";
    }

    const label = step > 0
      ? `Carl on ${info.name}, ${atSummit ? "at the summit" : `${plural(step, "week")} up, ${plural(CLIMB_WEEKS - step, "week")} to the summit`}`
      : fell ? `Carl fell ${fell.down ? "down" : "on"} ${info.name} and is back at ${camp}` : `Carl at ${camp}, ready to climb ${info.name}`;
    const doneInYear = (index + (atSummit ? 1 : 0)) % MOUNTAINS.length;
    return climbCaption(info, sub, atSummit && doneInYear === 0 ? MOUNTAINS.length : doneInYear) + `<div class="climb-art">
      <svg class="th-${info.key}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax meet" role="img" aria-label="${label}">
        <defs><linearGradient id="g-sky-${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--sky1)"/><stop offset="1" style="stop-color:var(--sky2)"/>
        </linearGradient></defs>
        <rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="url(#g-sky-${id})"/>
        <path class="th-back" d="${scene.back}"/>
        <path class="th-mtn" d="${scene.path}"/>${scene.detail}${scene.deco}
        ${ground}${tent(9, G, camp)}${route}${arrows}${dots}${ledgeRock}${flag}${extra}${figure}
      </svg></div>`;
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
      html += `<div class="week-total${met ? " met" : ""}">
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
  let fitTimer = 0;
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => document.querySelectorAll(".card").forEach(fitCard), 40);
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
    if (e.key === "Escape" && !$("detail").hidden) closeDetail();
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
