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
  const TREND_WINDOW = 12;   // weeks in the moving average
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
    $("streak-card").innerHTML = `<div class="eyebrow">Weekly streak · any workout</div>
      <div class="streak-row">
        <svg class="flame ${lit ? "lit" : "cold"}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-flame"/></svg>
        <div class="big streak-num">${w.current}<span class="unit">${w.current === 1 ? "week" : "weeks"}</span></div>
      </div>
      <div>
        <div class="best-track"><i style="width:${pct}%"></i></div>
        <div class="best-label"><span><svg viewBox="0 0 24 24"><use href="#i-trophy"/></svg>Best ${plural(w.longest, "week")}</span>
          <span>${w.longest && w.current < w.longest ? `${w.longest - w.current} to beat it` : w.current ? "On your best" : ""}</span></div>
      </div>
      <div class="nudge tone-${tone}">${esc(msg)}</div>`;
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
    $("week-card").innerHTML = `<div class="eyebrow">This week</div>
      <div class="week-top">
        <svg class="ring" viewBox="0 0 84 84" role="img" aria-label="${w.this_week_workouts} of ${w.goal} workouts this week">
          <circle class="track" cx="42" cy="42" r="${r}" fill="none" stroke-width="9"/>
          <circle class="prog" cx="42" cy="42" r="${r}" fill="none" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 42 42)"/>
          <text x="42" y="45" text-anchor="middle">${w.this_week_workouts}/${w.goal}</text>
          <text class="small" x="42" y="59" text-anchor="middle">workouts</text>
        </svg>
        <div>
          <div class="big" style="font-size:30px">${weekSecs ? fmtDuration(weekSecs) : "0m"}</div>
          <div class="sub" data-opt="1">trained this week · ${plural(w.this_week_days, "active day")}</div>
        </div>
      </div>
      <div class="week-dots">${dots}</div>
      <div class="week-foot">
        <span class="nudge tone-${w.this_week_met ? "good" : "ok"}" style="margin-top:0">${esc(msg)}</span>
        <span class="goal-stepper" title="Workouts per week that keep your weekly streak">
          <button data-goal="-1" aria-label="Lower weekly goal">−</button>${w.goal}/wk<button data-goal="1" aria-label="Raise weekly goal">+</button>
        </span>
      </div>`;
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

    const distUnit = state.metrics.walking_running_distance?.sourceUnit === "mi" ? "mi" : "km";
    const dist = metricOn("walking_running_distance", shown);
    const kcal = metricOn("active_energy", shown);
    const flights = metricOn("flights_climbed", shown);
    const tiles = [
      ["Distance", dist == null ? "—" : `${(dist / (distUnit === "mi" ? 1609.344 : 1000)).toFixed(1)} ${distUnit}`],
      ["Active kcal", kcal == null ? "—" : Math.round(kcal).toLocaleString()],
      ["Flights", flights == null ? "—" : Math.round(flights)],
    ].map(([k, v]) => `<div class="mini"><div class="stat-label">${k}</div><div class="mini-value">${esc(v)}</div></div>`).join("");

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
      <div class="mini-grid">${tiles}</div>
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
    if (Math.abs(diff) < 1e-9) return `<div class="delta">= same</div>`;
    return `<div class="delta ${diff > 0 ? "up" : "down"}">${diff > 0 ? "▲" : "▼"} ${fmt(Math.abs(diff))}</div>`;
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
    const ma = weeks.map((_, i) => {
      const slice = weeks.slice(Math.max(0, i - TREND_WINDOW + 1), i + 1);
      return slice.reduce((a, w) => a + w.workouts, 0) / slice.length;
    });
    const W = 300, H = 60, P = 4;
    const top = Math.max(...ma, 1) * 1.08;
    const x = (i) => (i / (ma.length - 1)) * W;
    const y = (v) => P + (1 - v / top) * (H - 2 * P);
    const d = smoothPath(ma.map((v, i) => [x(i), y(v)]));
    const peak = Math.max(...ma), now = ma[ma.length - 1];
    const first = parseIso(weeks[0].start).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    return `<div class="trend">
      <div class="bp-head"><span>Workouts / week</span>
        <span class="bp-note">${TREND_WINDOW}-wk avg · now <strong>${now.toFixed(1)}</strong> · peak ${peak.toFixed(1)}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
        aria-label="${TREND_WINDOW}-week moving average of workouts per week since ${first}: now ${now.toFixed(1)}, peak ${peak.toFixed(1)}">
        <path class="trend-glow" d="${d}"/>
        <path class="trend-line" d="${d}"/>
        <path class="trend-now" d="M${x(ma.length - 1).toFixed(1)},${y(now).toFixed(1)}h0"/>
      </svg>
      <div class="trend-axis"><span>${first}</span><span>now</span></div>
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
