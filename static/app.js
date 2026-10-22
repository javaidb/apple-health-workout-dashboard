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

  // The billboard's campfire is a neon sign: three nested flame tubes (a small blue core, a medium
  // yellow flame and a large orange one) over two crossed red log tubes. Like real neon, each tube
  // is an open run of glass, visible even when unlit, ending in two bulb-shaped electrodes whose
  // wires drop into the raceway (the transformer housing) along the bottom. Each flame has two
  // tubes, tip leaning one way and the other, lit alternately at its own pace like an animated
  // sign. Recent workouts light it from the inside out: orange stays lit for a day after training,
  // yellow for three days, blue for four; then the glass goes dark until the next workout.
  const FIRE_STAGES = ["Blazing: you trained today", "Burning well", "Burning low", "Flickering out",
    "Just the blue core left", "Gone out: a workout relights it"];
  // open flame runs, from the bottom-right electrode up over the tip and down to the bottom-left one
  const FLAME_A = "M23.2 31.8C26.4 31.2 29 28 29.5 23.5C30.5 15.5 25 11 20 3C19 13.6 17.6 12.6 15.6 8.5C14 14.5 9.9 18 10.5 23.5C11 28 13.6 31.2 16.8 31.8";
  const FLAME_B = "M23.2 31.8C26.4 31.2 29 28.4 29.6 24C30.6 16.4 26.6 11.6 21.8 4C19.8 12.6 17 13.4 14.2 9.8C13.4 14.4 9.8 18.6 10.5 24C11 28.4 13.6 31.2 16.8 31.8";
  // a glass tube: its glass body, the glowing gas inside and, when lit, a white-hot core
  const neonTube = (d, cls) => `<g class="nf-run ${cls}"><path class="nf-glass" d="${d}"/><path class="nf-gas" d="${d}"/><path class="nf-core" d="${d}"/></g>`;
  // a bulb-shaped electrode at a tube end, with its wire down to the raceway (in the layer's units)
  const electrode = (x, y, wireTo) => `<path class="nf-wire" d="M${x},${y + 1.4}V${wireTo}"/>
    <rect class="nf-cap" x="${x - .75}" y="${y + .6}" width="1.5" height="1.4" rx=".3"/><circle class="nf-bulb" cx="${x}" cy="${y}" r="1.15"/>`;
  function campfire(daysAgo) {
    const stage = FIRE_STAGES[Math.min(daysAgo, 5)];
    const layers = [
      // [colour, size, lit, flickering, mirrored]
      ["orange", 1, daysAgo <= 1, false, false],
      ["yellow", .64, daysAgo <= 3, daysAgo === 3, true],
      ["blue", .34, daysAgo <= 4, daysAgo === 4, false],
    ];
    const tubes = layers.map(([c, k, lit, flicker, mirror]) => {
      const t = `translate(20 32) scale(${mirror ? -k : k},${k}) translate(-20 -32)`;
      const state = lit ? `on${flicker ? " flicker" : ""}` : "off";
      const wireTo = 32 + 4.6 / k;   // the raceway's top, in this layer's units
      return `<g class="nf-layer ${c} ${state}" transform="${t}">${neonTube(FLAME_A, "a")}${neonTube(FLAME_B, "b")}
        ${electrode(16.8, 31.8, wireTo)}${electrode(23.2, 31.8, wireTo)}</g>`;
    }).join("");
    const anyLit = daysAgo <= 4;
    const sparks = daysAgo === 0 ? [[12.4, 8.6, 0], [28.4, 6.4, .6], [24.6, 1.4, 1.2]].map(([x, y, d]) =>
      `<circle class="nf-spark" cx="${x}" cy="${y}" r=".75" style="animation-delay:${d}s"/>`).join("") : "";
    const logs = `<g class="nf-layer log ${anyLit ? "on" : "off"}">${neonTube("M9.6 34.4L30.4 29.8", "solid")}${neonTube("M9.6 29.8L30.4 34.4", "solid")}
        ${electrode(8.6, 34.6, 36.6)}${electrode(31.4, 34.6, 36.6)}${electrode(8.6, 29.6, 36.6)}${electrode(31.4, 29.6, 36.6)}</g>`;
    return `<span class="campfire neon-fire" title="Neon campfire: ${stage}"><svg viewBox="0 0 40 40" role="img" aria-label="Neon campfire: ${stage}">
        ${tubes}${logs}${sparks}
        <rect class="nf-raceway" x="7" y="36.6" width="26" height="2.6" rx=".8"/><path class="nf-raceway-seam" d="M7.6 37.9H32.4"/>
        ${[[12, 37.9], [28, 37.9]].map(([x, y]) => `<circle class="nf-screw" cx="${x}" cy="${y}" r=".45"/>`).join("")}</svg></span>`;
  }

  // The Last workout card as a billboard: a riveted steel frame just outside the card with corner
  // brackets, a ledge underneath on brackets with a little railing, and three floodlights on the
  // ledge whose soft cones wash up the poster (stronger at night). Drawn on its own layer, so the
  // card and its content are untouched.
  let billboardKey = "";
  function drawBillboard(onlyIfMoved = false) {
    const layer = $("billboard"), card = $("last-card");
    const fixed = FIT_QUERY.matches, sx = fixed ? 0 : scrollX, sy = fixed ? 0 : scrollY;
    layer.style.position = fixed ? "fixed" : "absolute";
    const r = card.getBoundingClientRect(), night = skyPhase() === "night";
    const key = [r.left, r.top, r.right, r.bottom].map(Math.round).join(",") + night;
    if (onlyIfMoved && key === billboardKey) return;
    billboardKey = key;
    layer.setAttribute("width", 0); layer.setAttribute("height", 0); layer.innerHTML = "";
    if (!r.width || r.height < 80) return;
    const f = (n) => n.toFixed(1);
    const L = r.left + sx, T = r.top + sy, R = r.right + sx, B = r.bottom + sy, o = 2.5;
    // the frame, with rivets along it
    const rivets = [];
    for (let x = L + 14; x < R - 10; x += 26) rivets.push([x, T - o], [x, B + o]);
    for (let y = T + 14; y < B - 10; y += 26) rivets.push([L - o, y], [R + o, y]);
    const frame = `<rect class="bb-frame" x="${f(L - o)}" y="${f(T - o)}" width="${f(R - L + 2 * o)}" height="${f(B - T + 2 * o)}" rx="7"/>
      ${rivets.map(([x, y]) => `<circle class="bb-rivet" cx="${f(x)}" cy="${f(y)}" r="1.1"/>`).join("")}
      ${[[L - o, T - o, 1, 1], [R + o, T - o, -1, 1], [L - o, B + o, 1, -1], [R + o, B + o, -1, -1]].map(([x, y, dx, dy]) =>
        `<path class="bb-bracket" d="M${f(x)},${f(y + dy * 12)}V${f(y)}H${f(x + dx * 12)}"/><circle class="bb-rivet big" cx="${f(x + dx * 4)}" cy="${f(y + dy * 4)}" r="1.4"/>`).join("")}`;
    // a ledge under the billboard: a slab overhanging both sides on brackets, with a railing on it
    const next = $("streak-card")?.getBoundingClientRect(), gap = next ? next.top + sy - B : 16;
    const ly0 = B + 3, ly1 = B + 4.6, ly2 = B + Math.min(8, gap - 4), cl = L - 8, cr = R + 8;
    const posts = [];
    for (let x = L + 8; x <= R - 8 + .1; x += (R - L - 16) / Math.max(1, Math.round((R - L - 16) / 34))) posts.push(x);
    const corbels = [.12, .5, .88].map((t) => { const x = L + (R - L) * t; return `<path class="bb-corbel" d="M${f(x - 4)},${f(ly2)}H${f(x + 4)}L${f(x)},${f(Math.min(ly2 + 6, B + gap - 1.5))}Z"/>`; }).join("");
    const cy = ly0;
    const catwalk = `${corbels}<rect class="bb-ledge-front" x="${f(cl)}" y="${f(ly1)}" width="${f(cr - cl)}" height="${f(ly2 - ly1)}" rx=".6"/>
      <rect class="bb-ledge-top" x="${f(cl - 1)}" y="${f(ly0)}" width="${f(cr - cl + 2)}" height="${f(ly1 - ly0)}" rx=".5"/>
      <path class="bb-rail" d="M${f(L + 8)},${f(B - 5)}H${f(R - 8)}${posts.map((x) => `M${f(x)},${f(B - 5)}V${f(ly0)}`).join("")}"/>`;
    // three floodlights below the edge, washing light up the face
    const lamps = [.2, .5, .8].map((t) => {
      const x = L + (R - L) * t, h = (B - T) * .9, spread = (R - L) * .24, ly = B - 2.4;
      return `<path class="bb-cone" d="M${f(x - 3)},${f(ly)}L${f(x - spread)},${f(B - h)}H${f(x + spread)}L${f(x + 3)},${f(ly)}Z"/>
        <path class="bb-arm" d="M${f(x + 6)},${f(cy)}Q${f(x + 6)},${f(ly + 2)} ${f(x + 2)},${f(ly + 1.8)}"/>
        <g transform="translate(${f(x)},${f(ly + 1.6)}) rotate(-8)"><rect class="bb-lamp" x="-4" y="-1.6" width="8" height="3.4" rx="1.2"/><rect class="bb-lens" x="-3" y="-2.1" width="6" height="1.1" rx=".5"/></g>`;
    }).join("");
    const de = document.documentElement, W = fixed ? innerWidth : de.scrollWidth, H = fixed ? innerHeight : de.scrollHeight;
    layer.setAttribute("width", W); layer.setAttribute("height", H);
    layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    layer.innerHTML = `<g class="billboard${night ? " night" : ""}">
      <defs><linearGradient id="bb-light" x1="0" y1="1" x2="0" y2="0"><stop offset="0" class="bb-light-near"/><stop offset="1" class="bb-light-far"/></linearGradient></defs>
      ${lamps}${frame}${catwalk}</g>`;
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
      <div class="climb" role="button" tabindex="0" title="Open Carl's trail map" aria-label="Open Carl's trail map">${climbHtml()}</div>`;
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

  // The climb is drawn flat on the Weekly streak card itself, in the drawing's own pixels (W x H,
  // y = 0 at the card's top edge), like the rest of the page's cast. The card is the rock face:
  // small ledges stick out of it in a zig-zag, one a week, with a wider one halfway, up to a
  // clearing carved into the card just under its top edge, where the summit is. `capB` is how far
  // down the caption reaches on the left, so no ledge sits behind it. Each mountain dresses its
  // ledges and clearing its own way.
  // where the clearing goes in a W x H drawing: its floor, and its left and right walls
  const clearingBox = (W, H) => ({ fy: Math.round(Math.max(22, Math.min(36, H * .15))), x0: Math.round(W * .5), x1: Math.round(W - Math.max(14, W * .1)) });
  // How far in from the drawing's right edge the wall's side is at height y, and how far up from
  // the bottom its base is at x. Smooth swells unique to each mountain; near the top the side stays
  // out by the clearing, which is cut into the wall.
  function wallProfile(key, W, H) {
    const k = MOUNTAINS.findIndex((m) => m.key === key) + 1, { fy, x1 } = clearingBox(W, H);
    const topIn = Math.max(4, W - x1 - 4);
    const side = (y) => {
      const swell = 15 + 10 * Math.sin(y / H * 4.6 + k * 1.7) + 4 * Math.sin(y / H * 10.3 + k);
      const t = Math.min(1, Math.max(0, (y - fy - 8) / 30));   // ease out from the clearing's width
      return topIn + (Math.max(5, swell) - topIn) * t;
    };
    // the base rises off the card's bottom towards the right, and runs down into it at the seam
    const foot = (x) => (14 + 6 * Math.sin(x / W * 4.4 + k * 2.3) + 3 * Math.sin(x / W * 11 + k)) * Math.min(1, x / (W * .3));
    return { side, foot };
  }

  function ledgeScene(m, n, W, H, capB) {
    const { fy, x0: cx0, x1: cx1 } = clearingBox(W, H);
    const shelfW = Math.max(20, Math.min(30, W * .21)), sideW = Math.max(6, Math.min(10, W * .06));
    const prof = wallProfile(m.key, W, H), base = H - prof.foot(W * .22) - 16, h = n / 2, wander = routeWander(n);
    // the chimney ledge sits a fixed way below the clearing; ledges 0..n-2 are spaced evenly from
    // the base up to just below the caption (and the chimney ledge)
    const chimY = fy + (H - fy) * .2, top = Math.max(chimY + 16, capB + 18);
    const spots = Array.from({ length: n + 1 }, (_, k) => {
      if (k === n) return [cx1 - 11, fy];
      if (k === n - 1) return null;
      const y = base - (base - top) * k / (n - 2);
      const x = k === 0 ? W * .22 : k === h ? W * .42 : k % 2 ? W * .7 : W * .28;
      // right-hand ledges stick out of the wall's side, never past it
      return [Math.max(12, Math.min(W - prof.side(y) - shelfW / 2 - 6, x + wander[k] * W / 100)), y];
    });
    // the chimney ledge, out of the right-hand side under the clearing
    spots[n - 1] = [W - prof.side(chimY) - shelfW / 2 - 6, chimY];
    return { spots, n, W, H, shelfW, sideW, baseW: Math.max(24, Math.min(38, W * .28)), capB,
      clear: { x0: cx0, x1: cx1, fy }, G: base, base: spots[0], ledge: spots[h], summit: spots[n],
      tentAt: [cx0 + 18, fy], flagAt: [cx0 + 6, fy], bellAt: [cx0 + (cx1 - cx0) * .5, 2] };
  }

  // A ledge sticking out of the card: a flat top with a rough underside.
  function ledgeShelf(x, y, w, cls) {
    const f = (v) => v.toFixed(1);
    return `<g class="lg-shelf ${cls}"><path class="rock" d="M${f(x - w / 2)},${f(y)}L${f(x - w * .2)},${f(y - .5)}L${f(x + w * .25)},${f(y - .2)}L${f(x + w / 2)},${f(y + .3)}L${f(x + w / 2 - 1.4)},${f(y + 3)}L${f(x + w * .3)},${f(y + 4.4)}L${f(x + w * .08)},${f(y + 7)}L${f(x - w * .14)},${f(y + 5.2)}L${f(x - w * .34)},${f(y + 5.8)}L${f(x - w / 2 + 1)},${f(y + 2.6)}Z"/>
      <path class="crack" d="M${f(x + w * .1)},${f(y + 1.6)}l-1 2.4l.8 1.4M${f(x - w * .3)},${f(y + 1.8)}l.8 1.8"/>
      <path class="top" d="M${f(x - w / 2 + .5)},${f(y + .1)}L${f(x - w * .2)},${f(y - .4)}L${f(x + w * .25)},${f(y - .1)}L${f(x + w / 2 - .5)},${f(y + .4)}"/></g>`;
  }

  // The clearing carved under the card's top edge: a hollow with a rock floor, and a bell hanging
  // from its roof (Carl rings it when he gets there).
  function clearingArt(g, ring) {
    const { x0, x1, fy } = g.clear, f = (v) => v.toFixed(1), [bx] = g.bellAt;
    const wd = x1 - x0, at = (t) => f(x0 + wd * t);
    const hollow = `M${f(x0 + 3)},${fy}C${f(x0 - 1)},${f(fy * .7)} ${f(x0 + 1)},${f(fy * .25)} ${at(.12)},3.2L${at(.3)},2.4L${at(.5)},3L${at(.72)},2.2L${at(.9)},3C${f(x1 + 1)},${f(fy * .3)} ${f(x1 + 1)},${f(fy * .7)} ${f(x1 - 3)},${fy}Z`;
    const drips = [.22, .46, .64, .83].map((t, i) => `M${at(t - .02)},${f(2.8 + (i % 2) * .3)}l${f(wd * .02)} ${2 + (i % 3)}l${f(wd * .02)} -${2 + (i % 3)}`).join("");
    return `<path class="lg-clear" d="${hollow}"/><path class="lg-clear-rim" d="${hollow}"/><path class="lg-clear-drip" d="${drips}Z"/>
      <path class="lg-clear-floor" d="M${f(x0 - 2)},${fy}H${f(x1 + 2)}L${f(x1 - 2)},${f(fy + 3.2)}Q${f((x0 + x1) / 2)},${f(fy + 5)} ${f(x0 + 3)},${f(fy + 3)}Z"/>
      <g class="lg-bell${ring ? " ring" : ""}" transform="translate(${f(bx)},1.5)"><path class="chain" d="M0 0V5"/>
        <g class="swing"><path class="bell" d="M-3.2 10.4Q-3.2 5 0 5Q3.2 5 3.2 10.4H3.8V11.2H-3.8V10.4Z"/><circle class="clapper" cy="11.8" r=".8"/></g></g>`;
  }

  // The wall the ledges stick out of: the whole climb area is one solid wall in each mountain's own
  // material (ice, grassy turf, sandstone, basalt, jungle, crystal rock, wet slate, gold brick),
  // flat on the left where it meets the rest of the card and running out to the card's right edge,
  // base and top. The texture is drawn into it, holds sit between the ledges, and nothing on it moves.
  function wallArt(key, g) {
    const { W, H, spots } = g, n = spots.length - 1, f = (v) => v.toFixed(1);
    let seed = key.length * 97 + n * 13 + Math.round(W) * 7 + Math.round(H);
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed % 10000) / 10000; };
    const clipId = `lg-clip-${++climbId}`, B = H - wallProfile(key, W, H).foot(W / 2) + 2;
    // scatter over the whole wall, on a jittered grid so it reads as even texture
    const scatter = (step, fn) => {
      let out = "";
      for (let y = step / 2; y < H; y += step) {
        for (let x = step / 2 + ((y / step) % 2) * step / 2; x < W; x += step) out += fn(x + (rnd() - .5) * step * .8, y + (rnd() - .5) * step * .8, rnd());
      }
      return out;
    };
    const bands = (count, fn) => Array.from({ length: count }, (_, i) => fn((H * (i + .5 + (rnd() - .5) * .5)) / count, i)).join("");
    const wave = (y, amp) => { let d = `M-2,${f(y)}`; for (let x = 0; x <= W + 8; x += 8) d += `L${f(x)},${f(y + (rnd() - .5) * amp)}`; return d; };
    const tex = {
      frost: scatter(16, (x, y, r) => `<path class="t-shard${r < .5 ? " lite" : ""}" d="M${f(x)},${f(y - 6 - r * 4)}L${f(x + 5 + r * 3)},${f(y + 1)}L${f(x - 1)},${f(y + 6)}L${f(x - 5)},${f(y)}Z"/>`)
        + scatter(22, (x, y, r) => `<path class="t-crack" d="M${f(x)},${f(y)}l${f(3 + r * 3)} ${f(4 + r * 2)}l-2 4M${f(x + 3)},${f(y + 4)}l4 -1"/>`)
        + `<path class="t-base ice" d="${(() => { let d = `M0,${B}`; for (let x = 0; x <= W; x += 6) d += `L${f(x)},${f(B - (x / 6 % 2 ? 5 + rnd() * 9 : 1 + rnd() * 3))}`; return `${d}L${W},${B}Z`; })()}"/>`,
      pine: scatter(9, (x, y, r) => `<path class="t-grass${r < .3 ? " dark" : ""}" d="M${f(x - 2)},${f(y + 2)}l1.2 -3.4M${f(x)},${f(y + 2)}v-4M${f(x + 2)},${f(y + 2)}l-1.2 -3.4"/>`)
        + scatter(26, (x, y, r) => r < .4 ? `<ellipse class="t-dirt" cx="${f(x)}" cy="${f(y)}" rx="${f(3 + r * 4)}" ry="${f(2 + r * 2)}"/>` : r < .7 ? `<circle class="t-flower" cx="${f(x)}" cy="${f(y)}" r="1"/>` : `<path class="t-stone" d="M${f(x - 3)},${f(y + 1.5)}q0 -3 3 -3q3 0 3 3Z"/>`)
        + Array.from({ length: Math.round(W / 22) }, (_, i) => { const x = 8 + i * 22 + rnd() * 6, k = .7 + rnd() * .35;
          return `<path class="t-tree" d="M${f(x)},${f(B - 3 - 14 * k)}L${f(x + 4.4 * k)},${f(B - 3 - 6 * k)}H${f(x + 2.4 * k)}L${f(x + 5.6 * k)},${f(B - 3)}H${f(x - 5.6 * k)}L${f(x - 2.4 * k)},${f(B - 3 - 6 * k)}H${f(x - 4.4 * k)}Z"/>`; }).join(""),
      mesa: bands(Math.round(H / 14), (y, i) => `<path class="t-strata${i % 2 ? " lite" : ""}" d="${wave(y, 3)}L${W + 8},${f(y + 7)}L-2,${f(y + 7)}Z"/>`)
        + scatter(20, (x, y, r) => `<circle class="t-pebble" cx="${f(x)}" cy="${f(y)}" r="${f(.6 + r)}"/>`)
        + Array.from({ length: Math.round(W / 30) }, (_, i) => { const x = 10 + i * 30 + rnd() * 8, h2 = 10 + rnd() * 8;
          return `<path class="t-hoodoo" d="M${f(x - 3)},${B}V${f(B - h2)}h-1.6v-2.6h9.2v2.6h-1.6V${B}Z"/>`; }).join(""),
      ember: Array.from({ length: Math.ceil(W / 9) + 1 }, (_, i) => `<path class="t-column" d="M${f(i * 9)},0V${B}"/>`).join("")
        + bands(Math.round(H / 18), (y, i) => `<path class="t-joint" d="M${f(i % 2 ? 4.5 : 0)},${f(y)}${Array.from({ length: Math.ceil(W / 18) }, (_, j) => `M${f(j * 18 + (i % 2) * 9)},${f(y)}h9`).join("")}"/>`)
        + scatter(30, (x, y, r) => `<path class="t-lava" d="M${f(x)},${f(y)}l${f(2 + r * 3)} ${f(4 + r * 3)}l-1.6 ${f(3 + r * 2)}l3 ${f(2 + r)}"/>`)
        + `<path class="t-lava pool" d="M0,${B - 2}H${W}"/>`,
      canopy: scatter(10, (x, y, r) => `<path class="t-leaf${r < .35 ? " dark" : r > .8 ? " lite" : ""}" transform="rotate(${Math.round(r * 360)} ${f(x)} ${f(y)})" d="M${f(x - 4)},${f(y)}q4 -3.4 8 0q-4 3.4 -8 0Z"/>`)
        + Array.from({ length: Math.round(W / 26) }, (_, i) => { const x = 12 + i * 26 + rnd() * 6;
          return `<path class="t-vine" d="M${f(x)},0q-4 ${f(H * .2)} 1 ${f(H * .4)}q4 ${f(H * .2)} -1 ${f(H * .4)}"/>`; }).join("")
        + Array.from({ length: Math.round(W / 9) }, (_, i) => `<path class="t-fern" d="M${f(4 + i * 9)},${B}q${i % 2 ? -4 : 4} -6 ${i % 2 ? -1 : 1} -12"/>`).join(""),
      stars: scatter(18, (x, y, r) => r < .45 ? `<path class="t-star" d="M${f(x)},${f(y - 1.8)}l.5 1.3l1.3 .5l-1.3 .5l-.5 1.3l-.5 -1.3l-1.3 -.5l1.3 -.5Z"/>` : `<circle class="t-speck" cx="${f(x)}" cy="${f(y)}" r=".6"/>`)
        + scatter(34, (x, y, r) => `<path class="t-vein" d="M${f(x - 8)},${f(y + 4)}l5 -3l3 2l6 -5"/>`)
        + Array.from({ length: Math.round(W / 12) }, (_, i) => { const x = 6 + i * 12 + rnd() * 3, h2 = 8 + rnd() * 9;
          return `<path class="t-crystal" d="M${f(x - 3.4)},${B}L${f(x - 1.4)},${f(B - h2)}L${f(x + 1.6)},${f(B - h2 - 3)}L${f(x + 3.4)},${B}Z"/>`; }).join(""),
      storm: scatter(12, (x, y, r) => `<path class="t-streak" d="M${f(x)},${f(y - 4)}l${f(-.8 - r)} ${f(6 + r * 4)}"/>`)
        + scatter(28, (x, y, r) => `<path class="t-crack" d="M${f(x - 4)},${f(y - 3)}l3 3l-1.4 3l4 2"/>`)
        + Array.from({ length: Math.round(W / 14) }, (_, i) => { const x = 7 + i * 14 + rnd() * 4, h2 = 6 + rnd() * 5;
          return `<path class="t-boulder" d="M${f(x - 6)},${B}Q${f(x - 6)},${f(B - h2)} ${f(x)},${f(B - h2 - 1)}Q${f(x + 6)},${f(B - h2)} ${f(x + 6)},${B}Z"/>`; }).join(""),
      crown: Array.from({ length: Math.ceil(H / 7) }, (_, r) => `<path class="t-brick" d="M0,${f(r * 7)}H${W}${Array.from({ length: Math.ceil(W / 14) + 1 }, (_, j) => `M${f(j * 14 + (r % 2) * 7)},${f(r * 7)}v7`).join("")}"/>`).join("")
        + scatter(24, (x, y, r) => `<circle class="t-gleam" cx="${f(x)}" cy="${f(y)}" r="${f(.6 + r * .6)}"/>`)
        + Array.from({ length: Math.round(W / 10) }, (_, i) => `<circle class="t-coin" cx="${f(6 + i * 10 + rnd() * 3)}" cy="${f(B - 3 - rnd() * 4)}" r="2.2"/>`).join(""),
    }[key];
    // holds between ledges: two small knobs on each hop
    const holds = spots.slice(0, n).map(([ax, ay], k) => {
      const [bx, by] = spots[k + 1];
      return [.36, .7].map((t, i) => {
        const x = ax + (bx - ax) * t + (i ? -3 : 3), y = ay + (by - ay) * t;
        return `<path class="lg-hold" d="M${f(x - 2.4)},${f(y + .8)}L${f(x - 1.2)},${f(y - 1.2)}L${f(x + 1.6)},${f(y - 1)}L${f(x + 2.4)},${f(y + 1)}L${f(x)},${f(y + 2)}Z"/>`;
      }).join("");
    }).join("");
    const ol = wallOutline(key, W, H, rnd);
    g.outline = ol.path;   // for clipping the card itself to the wall (see drawClimb)
    return `<defs><clipPath id="${clipId}"><path d="${ol.svg}"/></clipPath></defs>
      <g class="lg-wall"><path class="face" d="${ol.svg}"/><g clip-path="url(#${clipId})">${tex}</g><path class="rim" d="M0,0${ol.path(0)}"/></g>${holds}`;
  }

  function wallOutline(key, W, H, rnd) {
    const f = (v) => v.toFixed(1), { side, foot } = wallProfile(key, W, H);
    const spiky = key === "frost" || key === "stars";
    const nick = { frost: 4, stars: 4, storm: 3, mesa: 2.4, ember: 2, crown: 1.6, pine: 2.2, canopy: 2.6 }[key];
    const right = [], bottom = [];
    const yEnd = H - foot(W - side(H)) - 8;
    for (let y = 0, i = 0; y < yEnd; y += (spiky ? 7 : 14) * (.8 + rnd() * .4), i++)
      right.push([W - side(y) - (spiky ? (i % 2 ? nick + rnd() * 2 : 0) : rnd() * nick), y]);
    const [cx, cy] = [W - side(yEnd) - 6, H - foot(W - side(yEnd))];
    right.push([cx + 3, (yEnd + cy) / 2 - 2]);
    for (let x = cx - 3, i = 0; x > 0; x -= (spiky ? 6 : 13) * (.8 + rnd() * .4), i++)
      bottom.push([x, H - foot(x) - (spiky ? (i % 2 ? nick + rnd() * 2 : 0) : rnd() * nick)]);
    bottom.push([0, H]);
    const pts = [[right[0][0], 0], ...right, ...bottom];
    // smooth (Catmull-Rom as cubic Béziers) for rock, turf and leaves; straight for ice and crystal
    const path = (ox) => {
      const P = (x, y) => `${f(x + ox)},${f(y)}`;
      let d = "";
      pts.forEach(([x, y], k) => {
        if (!k) { d += `L${P(x, y)}`; return; }
        if (spiky) { d += `L${P(x, y)}`; return; }
        const p0 = pts[Math.max(0, k - 2)], p1 = pts[k - 1], p3 = pts[Math.min(pts.length - 1, k + 1)];
        d += `C${P(p1[0] + (x - p0[0]) / 6, p1[1] + (y - p0[1]) / 6)} ${P(x - (p3[0] - p1[0]) / 6, y - (p3[1] - p1[1]) / 6)} ${P(x, y)}`;
      });
      return d;
    };
    return { svg: `M0,0${path(0)}Z`, path };
  }

  // Each mountain's own touches, on its ledges and around the clearing.
  function ledgeDeco(key, g) {
    const { spots, shelfW: w, clear: { x0, x1, fy } } = g, f = (v) => v.toFixed(1), n = spots.length - 1;
    const mids = spots.slice(1, n);   // the ledges between the base and the summit
    const pine = (x, y, k = 1) => `<path class="lg-pine" d="M${f(x)},${f(y - 11 * k)}L${f(x + 3.6 * k)},${f(y - 4.4 * k)}H${f(x + 2 * k)}L${f(x + 4.6 * k)},${f(y)}H${f(x - 4.6 * k)}L${f(x - 2 * k)},${f(y - 4.4 * k)}H${f(x - 3.6 * k)}Z"/>`;
    switch (key) {
      case "pine":
        return mids.filter((_, i) => i % 2 === 0).map(([x, y], i) => pine(x + (i % 2 ? -1 : 1) * w * .32, y, .8)).join("")
          + pine(x1 - 6, fy, .75) + pine(spots[0][0] + g.baseW * .3, spots[0][1], .9);
      case "mesa":
        return mids.map(([x, y]) => `<path class="lg-band" d="M${f(x - w / 2 + 2)},${f(y + 1.6)}H${f(x + w / 2 - 2)}"/>`).join("")
          + mids.filter((_, i) => i % 3 === 1).map(([x, y]) => `<path class="lg-cactus" d="M${f(x + w * .3)},${f(y)}V${f(y - 8)}M${f(x + w * .3)},${f(y - 4)}h-2.4v-2.6M${f(x + w * .3)},${f(y - 5.4)}h2.2v-2"/>`).join("")
          + `<path class="lg-cactus" d="M${f(x1 - 6)},${fy}V${fy - 9}M${f(x1 - 6)},${fy - 5}h-2.4v-2.6"/>`;
      case "ember":
        return mids.map(([x, y], i) => `<path class="lg-lava" style="animation-delay:${(i * .9).toFixed(1)}s" d="M${f(x + w * .06)},${f(y + 6)}q1.2 3.4 2.4 7q1.2 -3.6 0 -7Z"/>`).join("")
          + mids.map(([x, y]) => `<path class="lg-ember" d="M${f(x - w / 2 + 3)},${f(y + .5)}H${f(x - w / 2 + 6)}M${f(x + 2)},${f(y + .5)}H${f(x + 4)}"/>`).join("")
          + `<path class="lg-smoke" d="M${f(x0 + 6)},${fy - 4}q-2 -4 1 -8q2 -3 -1 -6"/><path class="lg-smoke b" d="M${f(x0 + 10)},${fy - 3}q-2 -4 1 -7"/>`;
      case "frost":
        return mids.concat([spots[0]]).map(([x, y]) => `<path class="lg-snow" d="M${f(x - w / 2)},${f(y + .2)}Q${f(x - w / 4)},${f(y - 1.8)} ${f(x)},${f(y - .6)}Q${f(x + w / 4)},${f(y - 2)} ${f(x + w / 2)},${f(y + .2)}Z"/>
            <path class="lg-icicle" d="M${f(x - w * .3)},${f(y + 2.6)}l.7 3.4l.7 -3.4M${f(x - w * .05)},${f(y + 3.8)}l.6 2.6l.6 -2.6M${f(x + w * .22)},${f(y + 2.8)}l.7 4l.7 -4"/>`).join("")
          + `<path class="lg-snow" d="M${f(x0 + 4)},${fy}Q${f((x0 + x1) / 2)},${fy - 2.4} ${f(x1 - 4)},${fy}Z"/>`;
      case "canopy":
        return mids.map(([x, y], i) => `<g class="lg-vine" style="animation-delay:${(-i * .7).toFixed(1)}s;transform-origin:${f(x - w * .3)}px ${f(y + 2)}px"><path d="M${f(x - w * .3)},${f(y + 2)}q-2 5 1 9q2 4 -1 8"/>
            <path class="leaf" d="M${f(x - w * .3 + .6)},${f(y + 8)}q2.6 -1 3.2 1.4q-2.6 .8 -3.2 -1.4ZM${f(x - w * .3 - .8)},${f(y + 14)}q-2.6 -1 -3.2 1.4q2.6 .8 3.2 -1.4Z"/></g>`).join("")
          + `<path class="lg-leaf-tuft" d="M${f(x1 - 4)},${fy}q-3 -6 -7 -6q3 2 3 6M${f(x1 - 4)},${fy}q1 -6 5 -8q-2 3 -2 8"/>`;
      case "stars":
        return [...mids, spots[0]].flatMap(([x, y], i) => [[x - w * .6, y - 8 - (i % 3) * 3], [x + w * .7, y - 4 - (i % 2) * 5]])
          .map(([x, y], i) => `<path class="lg-star" style="animation-delay:${(i * .37).toFixed(2)}s" d="M${f(x)},${f(y - 1.8)}l.5 1.3l1.3 .5l-1.3 .5l-.5 1.3l-.5 -1.3l-1.3 -.5l1.3 -.5Z"/>`).join("")
          + `<circle class="lg-star-glow" cx="${f(x1 - 6)}" cy="${fy - 8}" r="1.3"/>`;
      case "storm": {
        const [x, y] = spots[n - 1];
        const cx = x1 - 14, cy = fy + 15;
        return `<g class="lg-cloud"><path d="M${f(cx - 10)},${f(cy)}q0 -5 5 -5q2 -4 6 -2q4 -1 5 3q4 0 4 4Z"/></g>
          <path class="lg-rain" d="M${f(cx - 7)},${f(cy + 2)}l-1.2 4M${f(cx - 2)},${f(cy + 2)}l-1.2 4M${f(cx + 3)},${f(cy + 2)}l-1.2 4"/>
          <path class="lg-bolt" d="M${f(cx)},${f(cy + 1)}l-2.6 5h2.4l-2 5l5 -6.4h-2.6l1.8 -3.6Z"/>`
          + mids.map(([mx, my]) => `<path class="lg-wet" d="M${f(mx - w * .2)},${f(my + 3.4)}v3M${f(mx + w * .15)},${f(my + 3)}v2.2"/>`).join("")
          + `<path class="lg-wet" d="M${f(x + w * .1)},${f(y + 3)}v3"/>`;
      }
      case "crown":
        return mids.concat([spots[0]]).map(([x, y]) => `<path class="lg-gilt" d="M${f(x - w / 2 + .6)},${f(y + .4)}H${f(x + w / 2 - .6)}"/>`).join("")
          + `<g class="lg-crown" transform="translate(${f(x1 - 6)},${fy})"><path d="M-3.4 0V-5L-1.8 -3.2L0 -6.4L1.8 -3.2L3.4 -5V0Z"/><circle class="gem" cy="-1.8" r=".7"/></g>`
          + mids.filter((_, i) => i % 2).map(([x, y], i) => `<circle class="lg-sparkle" style="animation-delay:${i * .8}s" cx="${f(x + w * .4)}" cy="${f(y - 3)}" r=".8"/>`).join("");
    }
    return "";
  }

  function tent(x, y, label, sc = 1) {
    return `<g class="cl-tent" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${sc})">
        <path class="cl-tent-body" d="M-6 0L0 -7.5L6 0Z"/><path class="cl-tent-door" d="M0 -7.5L-2 0H2Z"/>
        <path class="cl-tent-line" d="M0 -7.5V-9M-6 0L-8.4 .1M6 0L8.4 .1"/></g>
      ${label ? `<text class="cl-label" x="${x.toFixed(1)}" y="${(y + 8).toFixed(1)}" text-anchor="middle">${label}</text>` : ""}`;
  }

  // The route through the ledges: a straight hop from each week's ledge to the next, sampled
  // ROUTE_SUB times per week so the done and ahead parts are pieces of the same line.
  function routeGeom(g) {
    const n = g.n, pt = (k) => g.spots[k];
    const curve = [pt(0)];
    for (let i = 0; i < n; i++) {
      const [a, b] = [pt(i), pt(i + 1)];
      for (let j = 1; j <= ROUTE_SUB; j++) curve.push([0, 1].map((c) => a[c] + (b[c] - a[c]) * j / ROUTE_SUB));
    }
    const line = (a, b) => curve.slice(a * ROUTE_SUB, b * ROUTE_SUB + 1).map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    return { G: g.G, base: g.base, ledge: g.ledge, summit: g.summit, pt, line };
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

  // Time of day, from the viewer's clock.
  function skyPhase(d = new Date()) {
    const h = d.getHours();
    return h >= 21 || h < 5 ? "night" : h < 7 ? "dawn" : h >= 18 ? "dusk" : "day";
  }
  // The caption goes in with the card; the drawing is made by drawClimb once the card has its size
  // (and again whenever that changes), since it's drawn to the card's own pixels.
  let climbRender = 0;
  function climbHtml() {
    climbRender += 1;
    const { sub } = climbScene(150, 300, 60);
    const { index, medals, step } = climbState(), info = mountainInfo(index), atSummit = step === weeksOf(index);
    const doneInYear = (index + (atSummit ? 1 : 0)) % MOUNTAINS.length;
    return climbCaption(info, sub, atSummit && doneInYear === 0 ? MOUNTAINS.length : doneInYear, medals, Math.floor(index / MOUNTAINS.length) * MOUNTAINS.length)
      + `<div class="climb-art"></div>`;
  }

  // Carl on this week's ledge (or hanging from it, resting, yawning, fallen, or celebrating in the
  // clearing), in a W x H drawing. Returns the caption's line, the aria label and the SVG's insides.
  function climbScene(W, H, capB, capT = 0) {
    const { index, step, fell, pending, golds, medals } = climbState();
    const info = mountainInfo(index), next = mountainInfo(index + 1);
    const N = weeksOf(index), LEDGE = N / 2;
    const g = ledgeScene(info, N, W, H, capB);
    const { pt, line, summit } = routeGeom(g);
    const night = skyPhase() === "night", atSummit = step === N;
    const reached = step, fellFrom = fell ? fell.from : 0, f = (v) => v.toFixed(1);

    const route = (reached > 0 ? `<path class="cl-route done" d="${line(0, reached)}"/>` : fellFrom ? `<path class="cl-route old" d="${line(0, fellFrom)}"/>` : "")
      + (reached < N ? `<path class="cl-route ahead" d="${line(reached, N)}"/>` : "")
      // weeks that hit the goal glow gold
      + golds.map((gd, k) => (gd ? `<path class="cl-route gold" d="${line(k, k + 1)}"/>` : "")).join("");
    const stateOf = (k) => (golds[k - 1] && k <= reached ? "gold" : k <= reached ? "done" : k <= fellFrom ? "old" : "ahead");
    const [bx, by] = g.base;
    const shelves = ledgeShelf(bx, by, g.baseW, reached > 0 ? "done" : "")
      + Array.from({ length: N - 1 }, (_, i) => i + 1).map((k) => {
        const [x, y] = pt(k);
        return k === LEDGE ? rockLedge(x, y, Math.max(reached, fellFrom) >= LEDGE, Math.min(1.1, W / 140))
          + `<text class="cl-label" x="${f(x)}" y="${f(y + 11)}" text-anchor="middle">${LEDGE === 4 ? "1 mo" : `${LEDGE} wks`}</text>`
          : ledgeShelf(x, y, g.shelfW, stateOf(k));
      }).join("");
    // the rope from the This week card ties on at the base ledge's left end
    const tie = [bx - g.baseW / 2 + 2, by + 1.4];
    const bolt = `<g class="cl-anchor"><circle cx="${f(tie[0])}" cy="${f(tie[1])}" r="1.5"/><circle class="eye" cx="${f(tie[0])}" cy="${f(tie[1])}" r=".6"/></g>`;
    const flag = `<g class="cl-summit${atSummit ? " won" : ""}" transform="translate(${f(g.flagAt[0])},${f(g.flagAt[1])})"><path d="M0 0V-12"/><path class="flag" d="M0 -12L7 -9.6L0 -7.2Z"/></g>`;
    const camp = campName(index);

    let figure = "", extra = "", sub;
    const cs = 1.2, HANG = 11.4 * cs;
    if (step > 0) {
      const [x, y] = pt(step), facingLeft = step < N && pt(step + 1)[0] < x;
      const [px, py] = pt(step - 1);
      const hang = pending && !atSummit;
      const hip = hang ? [x, y + HANG - 2.6] : step === LEDGE ? [x, y - .5] : [x + (facingLeft ? -.3 : .3), y - 5];
      const rope = atSummit ? "" : `<path class="cl-rope" d="M${f(hip[0])},${f(hip[1])} Q${f((hip[0] + px) / 2)},${f(Math.max(hip[1], py) + 6)} ${f(px)},${f(py)}"/>`;
      if (atSummit) {
        figure = tent(g.tentAt[0], g.tentAt[1], "", 1.2) + climber("cheer", summit[0], summit[1], false, cs)
          + `<g class="cl-confetti">${[[-12, -14, "a"], [-4, -19, "b"], [7, -16, "c"], [12, -9, "a"], [-15, -6, "c"], [2, -24, "b"]]
            .map(([dx, dy, c]) => `<rect class="cf ${c}" x="${f(summit[0] + dx)}" y="${f(Math.max(4, summit[1] + dy))}" width="1.6" height="1.6" rx=".3"/>`).join("")}</g>`;
        if (pending) extra = `<text class="cl-alert" x="${f(summit[0] - 9)}" y="${f(summit[1] - 4)}" text-anchor="middle">!</text>`;
        const medal = medalOf(medals[index] ?? 0, index);
        figure += medalBadge(medal, summit[0] + 7, summit[1] - 13, 1.2);
        sub = pending ? `${cap(medal)} medal · work out to start ${next.name}` : `Summit! ${cap(medal)} medal · Next: ${next.name}`;
      } else if (hang) {
        figure = rope + climber("hang", x, y + HANG, facingLeft, cs);
        extra = `<text class="cl-alert" x="${f(x + (facingLeft ? 9 : -9))}" y="${f(y + 9)}" text-anchor="middle">!</text>`;
        sub = `Hang on, ${plural(N - step, "wk")} to the summit`;  // this week counts as one of them
      } else if ((state.overview?.last_workout?.days_ago ?? 0) >= 5) {
        // this week already counts, but it's been a while: he sits down on his ledge and yawns
        figure = rope + climber("rest", x, y, facingLeft, cs)
          + `<text class="cl-yawn" x="${f(x + (facingLeft ? -9 : 9))}" y="${f(y - 10)}" text-anchor="middle">yawn</text>`;
        sub = `${plural(N - step, "wk")} to the summit · Carl's getting comfy`;
      } else {
        figure = rope + climber(step === LEDGE ? "rest" : "climb", x, y, facingLeft, cs);
        sub = `${plural(N - step, "wk")} to the summit`;
      }
    } else if (fell) {
      const [fx, fy] = pt(fell.from);
      extra = `<path class="cl-fall" d="M${f(fx)},${f(fy)} Q${f(fx + (fx > bx ? 14 : -14))},${f((fy + by) / 2)} ${f(bx + 4)},${f(by - 3)}"/>`;
      figure = climber("fallen", bx - 2, by, false, cs);
      sub = `${fell.down ? "Fell down" : "Fell on"} ${info.name} · back to ${camp}`;
    } else {
      // not started: Carl waits at camp, which lives in the This week card below
      sub = night ? `Carl's asleep at ${camp} · Help him reach the top!` : "Help Carl reach the top!";
    }
    // a headlamp glow while he climbs at night
    if (night && step > 0 && !atSummit) {
      const [x, y] = pt(step), hy = pending ? y + 5 : y - 11;
      figure = `<circle class="cl-lamp" cx="${f(x)}" cy="${f(hy)}" r="9"/>` + figure;
    }

    const label = step > 0
      ? `Carl on ${info.name}, ${atSummit ? "at the summit" : `${plural(step, "week")} up, ${plural(N - step, "week")} to the summit`}`
      : fell ? `Carl fell ${fell.down ? "down" : "on"} ${info.name} and is back at ${camp}` : `Carl at ${camp}, ready to climb ${info.name}`;
    const { x0: px0, fy: pfy } = g.clear, plaque = capB > capT
      ? `<path class="lg-plaque" d="M3,${f(capT)}H${f(px0 - 7)}V${f(Math.min(capB, pfy + 6))}H${f(g.spots[n0(g)][0] - g.shelfW / 2 - 7)}V${f(capB)}H3Z"/>` : "";
    const art = `${wallArt(info.key, g)}${plaque}${clearingArt(g, atSummit)}${route}${shelves}${ledgeDeco(info.key, g)}${bolt}${flag}${extra}${figure}`;
    return { sub, label, art, key: info.key, night, tie, outline: g.outline };
  }

  const n0 = (g) => g.spots.length - 2;   // the chimney ledge

  // Draws the climb to the size it has on the card. The drawing spans the climb column from the
  // card's top edge (so the clearing can be carved just under it) out to the card's right edge.
  let climbKey = "";
  function drawClimb(onlyIfMoved = false) {
    const box = document.querySelector("#streak-card .climb-art"), card = $("streak-card");
    if (!box) return;
    const col = box.parentElement.getBoundingClientRect(), c = card.getBoundingClientRect();
    const padT = col.top - c.top, padR = c.right - col.right;
    box.style.top = `${-padT}px`;
    box.style.right = `${-padR}px`;
    box.style.bottom = `${-(c.bottom - col.bottom)}px`;
    const W = Math.round(box.clientWidth), H = Math.round(box.clientHeight);
    // the caption wraps around the clearing (beside it at the top, then wider below its floor) and
    // the chimney the last pitch goes up by the card's right edge
    const cb = clearingBox(W, H), el = box.parentElement, capEl = el.querySelector(".climb-caption");
    el.style.setProperty("--clear-w", `${Math.max(0, W - cb.x0 + 4 - padR)}px`);
    el.style.setProperty("--clear-h", `${Math.max(0, cb.fy + 9 - padT)}px`);
    const chim = ledgeScene(MOUNTAINS[0], 4, W, H, 0), [cx, cy] = chim.spots[3];   // doesn't depend on the caption
    el.style.setProperty("--chim-w", `${Math.max(0, W - (cx - chim.shelfW / 2 - 6) - padR)}px`);
    el.style.setProperty("--chim-h", `${Math.max(0, cy + 10 - padT)}px`);
    // (the caption is a flex item, so its own box grows to hold its floats: measure its lines instead)
    const capB = capEl ? Math.round(Math.max(...[...capEl.children].map((e) => e.getBoundingClientRect().bottom)) - c.top) : 0, capT = Math.round(padT);
    const key = `${climbRender}|${W}x${H}|${capB}|${skyPhase()}`;
    if (onlyIfMoved && key === climbKey) return;
    climbKey = key;
    if (W < 40 || H < 80) { box.innerHTML = ""; card.style.clipPath = ""; return; }
    const { label, art, key: theme, night, tie, outline } = climbScene(W, H, capB, capT);
    box.innerHTML = `<svg class="th-${theme}${night ? " night" : ""}" data-anchor="${tie.map((v) => v.toFixed(1)).join(",")}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${art}</svg>`;
    const ox = col.left - c.left, r = 16, ch = c.height;
    card.style.clipPath = `path("M${r},0H${ox.toFixed(1)}${outline(ox)}H${r}Q0,${ch} 0,${ch - r}V${r}Q0,0 ${r},0Z")`;
  }

  // the card is clipped to the wall, so redraw the moment the card changes size (fonts settling,
  // the layout fitting itself), not just on the next timer
  if (window.ResizeObserver) new ResizeObserver(() => drawClimb(true)).observe($("streak-card"));

  // Carl's trail map: this tier's six mountains as one range, with the route climbed so far, a camp
  // on every summit reached, his best-ever point, and the souvenirs collected.
  function trailHtml() {
    const st = climbState();
    const tierStart = Math.floor(st.index / MOUNTAINS.length) * MOUNTAINS.length, tier = tierStart / MOUNTAINS.length + 1;
    const pos = startOf(st.index) + st.step;
    const bestAbove = st.best && startOf(st.best.index) + st.best.step > pos ? st.best : null;
    const panels = MOUNTAINS.map((m, i) => {
      const idx = tierStart + i, info = mountainInfo(idx), n = weeksOf(idx);
      const g = ledgeScene(info, n, 100, 186, 0), { summit, pt, line } = routeGeom(g), G = 196;
      const done = idx < st.index ? n : idx === st.index ? st.step : 0;
      const summited = done === n;
      const route = (done ? `<path class="cl-route done" d="${line(0, done)}"/>` : "") + (done < n ? `<path class="cl-route ahead" d="${line(done, n)}"/>` : "");
      const flag = `<g class="cl-summit${summited ? " won" : ""}" transform="translate(${g.flagAt[0]},${g.flagAt[1]})"><path d="M0 0V-10"/><path class="flag" d="M0 -10L6 -8L0 -6Z"/></g>`;
      const camp = summited ? tent(g.tentAt[0], g.tentAt[1], "", 1.2) + medalBadge(medalOf(st.medals[idx] ?? 0, idx), summit[0] + 6, summit[1] - 12, 1.4) : "";
      const shelves = ledgeShelf(g.base[0], g.base[1], g.baseW, done ? "done" : "")
        + Array.from({ length: n - 1 }, (_, k) => k + 1).map((k) => k === n / 2 ? rockLedge(...pt(k), done >= k, .9) : ledgeShelf(...pt(k), g.shelfW, k <= done ? "done" : "")).join("");
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
          ${wallArt(m.key, g)}${clearingArt(g, summited)}${shelves}${ledgeDeco(m.key, g)}
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
  // railing along the top edge, then a rope hung across the gap to the bolt on the climb's base
  // ledge in the Weekly streak card. Everything hugs the card's outline, so none of its
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
    // a rope hung free between the top of the railing's end post and the bolt on the climb's base
    // ledge, sagging under its own weight (but never below the card's top edge)
    const corner = b, post = [topX + 11, T - 9];
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

    // a pair of trainers flung over the cable where it bends over the calendar's corner, hanging by
    // their laces down the gap between the cards
    const hang = [gx - .4, T - 4];
    const trainer = (len, tilt) => `<g transform="translate(${f(hang[0])},${f(hang[1])}) rotate(${tilt})">
        <path class="shoe-lace" d="M0,0V${len}"/>
        <g transform="translate(0,${len}) rotate(90)"><path class="trail-shoe" d="M-1 0V-2.6Q-1 -4 .5 -4H2.5L3.9 -2.6L7.1 -1.8Q8.1 -1.4 8.1 0Z" transform="translate(-1,-.6) scale(.8)"/></g></g>`;
    const shoes = `<g class="cable-shoes" style="transform-origin:${f(hang[0])}px ${f(hang[1])}px">${trainer(7, 9)}${trainer(10.5, -7)}
        <path class="shoe-lace" d="M${f(hang[0] - 1.6)},${f(hang[1] - .4)}q1.6 -2.2 3.2 0"/><title>Someone's old trainers, flung over the power line</title></g>`;

    // a robin perched on one of the pins along the string
    const perch = pins[Math.min(pins.length - 1, Math.max(1, Math.floor(pins.length * .72)))];
    const bird = `<g class="robin" transform="translate(${f(perch)},${f(pinY - 1.4)})"><title>A robin, enjoying the lights</title>
        <path class="robin-leg" d="M-.6 0V-1.6M.8 0V-1.6"/>
        <g class="robin-tail"><path class="robin-back" d="M2.6 -3.4L6.4 -2.2L5.8 -1.2Z"/></g>
        <ellipse class="robin-back" cx="0" cy="-3.6" rx="3.2" ry="2.4"/><path class="robin-breast" d="M-2.9 -3.4Q-2.6 -1.4 -.4 -1.3Q-1.4 -2.6 -1.2 -4.6Z"/>
        <g class="robin-head"><circle class="robin-back" cx="-2.4" cy="-6.2" r="1.7"/><circle class="robin-eye" cx="-2.9" cy="-6.5" r=".35"/><path class="robin-beak" d="M-4 -6.2L-5.3 -5.9L-4 -5.6Z"/></g></g>`;

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
      <path class="light-wire" d="${d}"/>${bulbs.map(bulb).join("")}${tacks}${bird}</g>${shoes}${transformer}${elec}`;
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
  // box's top edge at y 0; the box's right edge is at x 7.
  function sitterHtml() {
    const g = state.overview?.week_streak;
    const mood = !g ? "look" : g.this_week_met ? "cheer" : g.this_week_workouts === 0 ? "doze" : "look";
    // The rail, styled like Carl's red cliff-edge railing: it runs along the box's top edge, follows
    // the rounded top-right corner and carries on a little way down the right side. Posts stand out
    // from the outline every ~13px, with bars 8 and 4 units off it. Box corner radius 12px = 7.4 units.
    const RC = 7.4, C = [7 - RC, RC], x0 = -26, L1 = C[0] - x0, L2 = RC * Math.PI / 2, total = L1 + L2 + 4;
    const along = (t) => {
      if (t <= L1) return [[x0 + t, 0], [0, -1]];
      if (t <= L1 + L2) { const a = -Math.PI / 2 + (t - L1) / RC; return [[C[0] + RC * Math.cos(a), C[1] + RC * Math.sin(a)], [Math.cos(a), Math.sin(a)]]; }
      return [[7, C[1] + t - L1 - L2], [1, 0]];
    };
    const off = (t, d) => { const [[x, y], [nx, ny]] = along(t); return [x + nx * d, y + ny * d]; };
    const line = (d) => Array.from({ length: Math.ceil(total / .5) + 1 }, (_, i) => off(Math.min(total, i * .5), d))
      .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
    const postAt = [...Array.from({ length: Math.floor(total / 8) + 1 }, (_, i) => i * 8), total];
    const rail = `<g class="s-rail"><path class="posts" d="${postAt.map((t) => { const [a, b] = [off(t, 0), off(t, 8)]; return `M${a[0].toFixed(2)},${a[1].toFixed(2)}L${b[0].toFixed(2)},${b[1].toFixed(2)}`; }).join("")}"/>
      <path class="bar" d="${line(8)}${line(4)}"/></g>`;
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
    // he stands just left of the corner, so his arms rest on the rail where it starts to curve
    return `<svg class="sitter ${mood}" viewBox="-28 -19 45 32" aria-hidden="true">${rail}<g transform="translate(-3 0)">${legs}${body}</g><title>Carl's climbing buddy, ${title}</title></svg>`;
  }

  // The rappeller: a climber in a blue helmet abseiling down the calendar's week column on a rope
  // hung from the end of the buddy's railing. He sits in his harness with his feet on the column's
  // edge and drops a little each day, following today's row. On every week so far with a workout
  // he has planted a flag, gold when that week hit the weekly goal. Viewing a past month he's at the
  // bottom; a future month, still at the top.
  let rappelKey = "";
  function drawRappel(onlyIfMoved = false) {
    const layer = $("rappel");
    const fixed = FIT_QUERY.matches, sx = fixed ? 0 : scrollX, sy = fixed ? 0 : scrollY;
    layer.style.position = fixed ? "fixed" : "absolute";
    const boxes = [...document.querySelectorAll("#calendar .week-total")];
    const rects = boxes.map((b) => b.getBoundingClientRect());
    const today = todayIso(), now = new Date();
    const key = rects.map((r) => [r.right, r.top, r.bottom].map(Math.round).join(",")).join("|")
      + `|${today}|${now.getHours()}|${state.goal}|` + boxes.map((b) => b.dataset.workouts).join(",");
    if (onlyIfMoved && key === rappelKey) return;
    rappelKey = key;
    layer.setAttribute("width", 0); layer.setAttribute("height", 0); layer.innerHTML = "";
    if (!boxes.length || !rects[0].width || !document.querySelector(".sitter")) return;

    const f = (n) => n.toFixed(1);
    // the buddy's railing ends 13px right of the first box, 18.5px below its top (8 and 11.4 units at 1.62px)
    const ropeX = rects[0].right + 13 + sx, ropeTop = rects[0].top + 18.5 + sy;
    const first = boxes[0].dataset.start, last = boxes[boxes.length - 1].dataset.end;
    let y;
    const row = boxes.findIndex((b) => b.dataset.start <= today && today <= b.dataset.end);
    if (row >= 0) {
      const r = rects[row], frac = (((now.getDay() + 6) % 7) + now.getHours() / 24) / 7;
      y = r.top + sy + frac * r.height;
    } else y = today < first ? ropeTop + 12 : rects[rects.length - 1].bottom + sy - 8;
    y = Math.max(ropeTop + 12, y);

    const flags = boxes.map((b, i) => {
      const n = Number(b.dataset.workouts);
      if (!n || b.dataset.start > today) return "";
      const r = rects[i], gold = n >= state.goal;
      return `<g class="rp-flag${gold ? " gold" : ""}" transform="translate(${f(r.right + sx)},${f(r.top + r.height / 2 + sy)}) scale(1.3)">
          <title>Week of ${b.dataset.start}: ${plural(n, "workout")}${gold ? " (goal hit)" : ""}</title>
          <path class="pole" d="M0,0L7.4,-4.4"/><path class="cloth" d="M2.4,-1.4L7.4,-4.4L7,1.2L4.6,-.6L2.6,2.2Z"/></g>`;
    }).join("");
    // on the last day of the month he has reached the bottom and gone down to the market
    const gone = atMonthEnd(now) && row >= 0;
    if (gone) y = rects[rects.length - 1].bottom + sy - 8;
    const climberAt = gone ? "" : `<g class="rappeller" transform="translate(${f(ropeX)},${f(y)}) scale(1.2)">
        <title>Abseiling down ${esc($("month-title").textContent)}: a flag for every week with a workout, gold for goal weeks</title>
        <g class="rp-bob">
          <path class="rp-limb" d="M0 0L-5 -1.8L-9.6 -1M0 0L-4.6 1.4L-9.4 2.8"/>
          <rect class="rp-pack" x="1.6" y="-6.6" width="2.6" height="4.4" rx=".9"/>
          <path class="rp-body" d="M0 0L1.2 -5.6"/>
          <path class="rp-limb" d="M1 -5L.2 -8.4M.8 -4.4L1.6 -1.4L.2 2.6"/>
          <circle class="rp-face" cx="1.6" cy="-7.8" r="1.9"/><path class="rp-helmet" d="M-.6 -8A2.3 2.3 0 0 1 3.8 -8Z"/>
          <path class="rp-harness" d="M-.8 -.4H1"/></g></g>`;
    const ropeEnd = gone ? y : y + 16;
    const rope = `<path class="rp-rope" d="M${f(ropeX)},${f(ropeTop)}V${f(ropeEnd)}q.2 3 -2 3.4q-2.4 .3 -2 -2.2"/>
      <circle class="rp-knot" cx="${f(ropeX)}" cy="${f(ropeTop)}" r="1.4"/>`;
    const de = document.documentElement, W = fixed ? innerWidth : de.scrollWidth, H = fixed ? innerHeight : de.scrollHeight;
    layer.setAttribute("width", W); layer.setAttribute("height", H);
    layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    layer.innerHTML = flags + rope + climberAt;
  }

  // The window washer: a little worker on the calendar who cleans the days you trained. He stands
  // on the bottom edge of a row of days and walks along it, climbs the gaps between columns to
  // change rows, and at each workout day sets down his bucket and wipes the glass with his rag;
  // the day sparkles when he's done, and he moves on to the next. The plan is redone whenever the
  // calendar or layout changes; with reduced motion he just stands cleaning the latest workout day.
  // An unhurried pace: a stroll (with steps matched to the speed so his feet don't slide), easing in
  // and out of each stretch, a short pause before and after each climb or turn, and a steady climb
  // up a ladder he props in the gap between columns, one rung per beat.
  const WASHER = { walk: 11, climb: 8, clean: 6, pause: .9, beat: .8 };   // px/s, px/s, s, s, s
  const washer = { x: null, y: null, mode: "walk", plan: [], target: null, until: 0, facing: 1, last: 0, sparkle: null, key: "",
    pauseUntil: 0, legFrom: null };
  // Two poses: on the ledge (walking, cleaning) with jointed legs that step one after the other, and
  // on the ladder, facing the wall, hands and feet moving rung by rung. Legs and arms animate their
  // shapes in CSS (d: path keyframes); the head and cap are shared.
  const washerFigure = `<g class="ww-body">
      <g class="ww-pose-ledge">
        <path class="ww-limb ww-leg l1" d="M0 -4.6L-.4 -2.3L-.9 0"/><path class="ww-limb ww-leg l2" d="M0 -4.6L.4 -2.3L.9 0"/>
        <path class="ww-torso" d="M0 -4.6V-9.4"/>
        <g class="ww-arm-back"><path class="ww-limb" d="M0 -8.6L-1.4 -6.4L-1.6 -4.6"/><g class="ww-bucket"><path class="ww-handle" d="M-3.2 -4.6Q-1.6 -6.2 0 -4.6"/><path class="ww-pail" d="M-3.4 -4.6H.2L-.3 -1.6H-2.9Z"/></g></g>
        <g class="ww-arm-front"><path class="ww-limb" d="M0 -8.6L2.4 -10.6L2.8 -13"/><rect class="ww-rag" x="1.6" y="-15.2" width="2.6" height="2.4" rx=".6"/></g>
      </g>
      <g class="ww-pose-ladder">
        <path class="ww-limb ww-cl c1" d="M0 -4.6L-1 -2.6L-1.2 -.2"/><path class="ww-limb ww-cl c2" d="M0 -4.6L-1 -2.6L-1.2 -.2"/>
        <path class="ww-torso" d="M0 -4.6V-9.4"/>
        <path class="ww-belt-pail" d="M1 -5H3.4L3 -2.8H1.4Z"/>
        <path class="ww-limb ww-ca a1" d="M0 -8.8L-1.8 -10.4L-2 -12.6"/><path class="ww-limb ww-ca a2" d="M0 -8.8L-1.8 -10.4L-2 -12.6"/>
      </g>
      <circle class="ww-head" cx="0" cy="-11.4" r="1.9"/><path class="ww-cap" d="M-2 -12.2A2.1 2.1 0 0 1 2 -12.2ZM1.8 -12.2H3.6"/></g>
    <g class="ww-pose-perch">
      <path class="ww-limb ww-dangle d1" d="M-.8 0L-1.1 2.4L-1 4.6"/><path class="ww-limb ww-dangle d2" d="M.8 0L1.1 2.4L1 4.6"/>
      <path class="ww-torso" d="M0 0V-4.8"/>
      <path class="ww-limb" d="M-.2 -4L-2.6 -2L-3.4 0"/><path class="ww-limb" d="M.2 -4L2 -3L1.6 -4.4"/>
      <rect class="ww-mug" x=".7" y="-6.2" width="1.9" height="1.9" rx=".4"/><path class="ww-steam" d="M1.3 -6.8q-.6 -.9 .2 -1.8M2.1 -6.8q-.6 -.9 .2 -1.8"/>
      <path class="ww-pail" d="M3.4 0H6.4L6 -2.6H3.8Z"/>
      <g class="ww-gaze"><circle class="ww-head" cx="0" cy="-6.9" r="1.9"/><path class="ww-cap" d="M-2 -7.7A2.1 2.1 0 0 1 2 -7.7ZM1.8 -7.7H3.6"/></g></g>`;

  function drawWasher() {
    const layer = $("washer");
    const fixed = FIT_QUERY.matches, sx = fixed ? 0 : scrollX, sy = fixed ? 0 : scrollY;
    layer.style.position = fixed ? "fixed" : "absolute";
    const days = [...document.querySelectorAll("#calendar .day")];
    if (!days.length || !days[0].getBoundingClientRect().width) { layer.innerHTML = ""; washer.key = ""; return; }
    const de = document.documentElement, W = fixed ? innerWidth : de.scrollWidth, H = fixed ? innerHeight : de.scrollHeight;
    layer.setAttribute("width", W); layer.setAttribute("height", H); layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
    if (!layer.querySelector(".washer")) {
      layer.innerHTML = `<g class="ww-ladder"></g><g class="ww-sparkle"></g><g class="washer walk"><title>The window washer, keeping your workout days sparkling</title><g class="ww-flip">${washerFigure}</g></g>`;
    }
    // the calendar's geometry: rows of days (their bottom edges are the ledges) and the gaps
    // between columns he climbs in
    const rects = days.map((d) => d.getBoundingClientRect());
    const ledges = [...new Set(rects.map((r) => Math.round(r.bottom + sy)))].sort((a, b) => a - b);
    const firstRow = rects.filter((r) => Math.round(r.bottom + sy) === ledges[0]).sort((a, b) => a.left - b.left);
    const gaps = firstRow.slice(1).map((r, i) => (firstRow[i].right + r.left) / 2 + sx);
    const targets = days.map((d, i) => ({ el: d, r: rects[i], date: d.dataset.date })).filter((t) => t.el.classList.contains("active"));
    const key = `${ledges.join(",")}|${gaps.map(Math.round).join(",")}|${targets.map((t) => t.date).join(",")}`;
    const spot = (t) => [t.r.left + t.r.width / 2 + sx, t.r.bottom + sy];
    if (key !== washer.key) {
      // the calendar changed: start (or restart) at the nearest ledge, and re-plan
      washer.key = key;
      if (washer.x == null || washer.x < firstRow[0].left + sx || washer.x > firstRow[firstRow.length - 1].right + sx) {
        const start = targets[targets.length - 1] || { r: rects[0] };
        [washer.x, washer.y] = spot(start);
      }
      washer.y = ledges.reduce((a, b) => (Math.abs(b - washer.y) < Math.abs(a - washer.y) ? b : a), ledges[0]);
      washer.plan = []; washer.target = null; washer.mode = "walk"; washer.legFrom = null; washer.rested = false; washer.ladder = null;
    }
    const g = layer.querySelector(".washer");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // At night, when the electrician has gone home, he knocks off too and sits on the billboard's
    // ledge with a hot drink; he fades out of one spot and into the other at the change of shift.
    const now0 = performance.now() / 1000, bb = $("last-card")?.getBoundingClientRect();
    const where = skyPhase() === "night" && bb && bb.width ? "perch" : "calendar";
    if (washer.where && where !== washer.where) {
      if (!washer.fadeUntil) washer.fadeUntil = now0 + .7;
      if (now0 < washer.fadeUntil) { g.classList.add("away"); return; }
      washer.fadeUntil = 0; washer.ladder = null;
    }
    washer.where = where;
    g.classList.remove("away");
    if (where === "perch") {
      g.setAttribute("class", "washer perch");
      g.setAttribute("transform", `translate(${(bb.right + sx - 30).toFixed(1)},${(bb.bottom + sy + 3).toFixed(1)}) scale(1.2)`);
      g.querySelector(".ww-flip").setAttribute("transform", "scale(1,1)");
      layer.querySelector(".ww-ladder").classList.remove("shown");
      washer.last = 0;
      return;
    }
    if (!targets.length) {
      washer.mode = "idle";
    } else if (reduce) {
      [washer.x, washer.y] = spot(targets[targets.length - 1]);
      washer.mode = "clean";
    } else {
      const now = performance.now() / 1000, dt = Math.min(.1, washer.last ? now - washer.last : 0);
      washer.last = now;
      if (!washer.target || !targets.some((t) => t.date === washer.target)) {
        // next workout day, in date order after the one just cleaned
        const next = targets.find((t) => t.date > (washer.done || "")) || targets[0];
        washer.target = next.date;
        const [tx, ty] = spot(next);
        if (Math.abs(ty - washer.y) < 1) washer.plan = [[tx, ty, "walk"]];
        else {
          const gx = gaps.reduce((a, b) => (Math.abs(b - washer.x) < Math.abs(a - washer.x) ? b : a), gaps[0]);
          washer.plan = [[gx, washer.y, "walk"], [gx, ty, "climb"], [tx, ty, "walk"]];
        }
        washer.mode = washer.plan[0][2];
      }
      if (washer.mode === "clean") {
        if (now >= washer.until) {
          const t = targets.find((t) => t.date === washer.target);
          if (t) washer.sparkle = { x: t.r.right + sx - 12, y: t.r.top + sy + 14, until: now + 2.4 };
          washer.done = washer.target; washer.target = null;
        }
      } else if (now < washer.pauseUntil) {
        washer.mode = "pause";
      } else if (washer.plan.length) {
        const [px, py, how] = washer.plan[0];
        const dx = px - washer.x, dy = py - washer.y, dist = Math.hypot(dx, dy);
        if (!washer.legFrom) {
          // starting a stretch: before a climb or a turn round, stop and take a breath first
          const turning = how === "walk" && Math.abs(dx) > .5 && (dx > 0 ? 1 : -1) !== washer.facing;
          if (how === "climb" && !washer.rested) washer.ladder = { x: px, y0: Math.min(washer.y, py), y1: Math.max(washer.y, py) };
          if ((how === "climb" || turning) && !washer.rested) {
            washer.rested = true; washer.pauseUntil = now + WASHER.pause; washer.mode = "pause";
          } else {
            if (how === "walk") washer.ladder = null;
            washer.rested = false; washer.legFrom = [washer.x, washer.y];
            if (how === "walk" && Math.abs(dx) > .5) washer.facing = dx > 0 ? 1 : -1;
          }
        }
        if (washer.legFrom) {
          washer.mode = how;
          let speed;
          if (how === "climb") {
            // a steady climb, with a slight rhythm as each rung is taken
            speed = WASHER.climb * (.8 + .2 * Math.sin(now * Math.PI * 2 / WASHER.beat));
          } else {
            // ease in over the first 10px and out over the last 12px
            const gone = Math.hypot(washer.x - washer.legFrom[0], washer.y - washer.legFrom[1]);
            speed = WASHER.walk * Math.max(.25, Math.min(1, (gone + 2) / 10, (dist + 2) / 12));
          }
          const step = speed * dt;
          if (dist <= Math.max(step, .05)) {
            washer.x = px; washer.y = py; washer.plan.shift(); washer.legFrom = null;
            if (how === "climb") washer.pauseUntil = now + WASHER.pause * .7;   // catch his breath at the top
            if (!washer.plan.length) { washer.mode = "clean"; washer.until = Math.max(now, washer.pauseUntil) + WASHER.clean; }
          } else { washer.x += (dx / dist) * step; washer.y += (dy / dist) * step; }
        }
      }
      // sparkles on the day he just finished
      const sp = layer.querySelector(".ww-sparkle");
      if (washer.sparkle && now < washer.sparkle.until) {
        if (!sp.innerHTML) sp.innerHTML = [[0, 0, 1], [-7, 5, .7], [5, 7, .8]].map(([dx, dy, k]) =>
          `<path transform="translate(${(washer.sparkle.x + dx).toFixed(1)},${(washer.sparkle.y + dy).toFixed(1)}) scale(${k})" d="M0 -3.2L.8 -.8L3.2 0L.8 .8L0 3.2L-.8 .8L-3.2 0L-.8 -.8Z"/>`).join("");
      } else if (sp.innerHTML) { sp.innerHTML = ""; washer.sparkle = null; }
    }
    g.setAttribute("class", `washer ${washer.mode === "pause" ? "idle" : washer.mode}`);
    // the ladder, while he's using it
    const lad = layer.querySelector(".ww-ladder"), L = washer.ladder;
    const ladKey = L ? `${L.x.toFixed(1)},${L.y0.toFixed(1)},${L.y1.toFixed(1)}` : "";
    // the ladder fades in as he props it up and out as he steps off (its drawing stays put while
    // it fades out, and a new one is only drawn once the old one has gone)
    if (L && lad.dataset.key !== ladKey && !lad.classList.contains("shown")) {
      lad.dataset.key = ladKey;
      const rungs = Array.from({ length: Math.floor((L.y1 - L.y0 + 6) / 4) }, (_, i) => `M${(L.x - 2.6).toFixed(1)},${(L.y1 - 2 - i * 4).toFixed(1)}H${(L.x + 2.6).toFixed(1)}`).join("");
      lad.innerHTML = `<path class="ww-rails" d="M${(L.x - 2.6).toFixed(1)},${(L.y0 - 6).toFixed(1)}V${L.y1.toFixed(1)}M${(L.x + 2.6).toFixed(1)},${(L.y0 - 6).toFixed(1)}V${L.y1.toFixed(1)}"/><path class="ww-rungs" d="${rungs}"/>`;
    } else if (L && lad.dataset.key === ladKey) lad.classList.add("shown");
    else if (!L || lad.dataset.key !== ladKey) lad.classList.remove("shown");
    g.setAttribute("transform", `translate(${washer.x.toFixed(1)},${washer.y.toFixed(1)}) scale(1.2)`);
    g.querySelector(".ww-flip").setAttribute("transform", `scale(${washer.mode === "clean" || washer.mode === "climb" ? 1 : washer.facing},1)`);
  }
  (function washerLoop() { if (!document.hidden) drawWasher(); requestAnimationFrame(washerLoop); })();

  // The bullet train. Every TRAIN.period seconds (on the wall clock, so it never restarts on a
  // redraw) a shinkansen comes in from the right along a rail at the bottom of the page, through the
  // underground market's right-hand tunnel, and stops at the market's platform. Its doors open, the
  // people waiting there step aboard, and it pulls away to the left, past the calendar and into a
  // tunnel in the side of the This week card. A while later the next passengers wander out to wait.
  // Each run is a different train: a livery, two to four cars, and either direction (going right,
  // it comes out of the This week card's tunnel and leaves through the market's).
  // Seen side-on and flat, like the market. Only on the one-screen layout, with the market showing.
  const TRAIN = { period: 90, arrive: 3, dwell: 7, depart: 2.6, waitersFrom: 44, car: 50, h: 13 };
  const LIVERIES = [
    { name: "white and blue", body: "#f8fafc", skirt: "#f8fafc", stripe: "#1d4ed8", edge: "#94a3b8" },
    { name: "green and white, with a pink stripe", body: "#0f766e", skirt: "#f1f5f9", stripe: "#f472b6", edge: "#115e59" },
    { name: "red and white", body: "#dc2626", skirt: "#f1f5f9", stripe: "#94a3b8", edge: "#991b1b" },
    { name: "yellow, with a blue stripe", body: "#facc15", skirt: "#facc15", stripe: "#1e40af", edge: "#a16207" },
    { name: "silver, with a blue stripe", body: "#cbd5e1", skirt: "#94a3b8", stripe: "#1e3a8a", edge: "#64748b" },
    { name: "purple and gold", body: "#6d28d9", skirt: "#ede9fe", stripe: "#f59e0b", edge: "#4c1d95" },
  ];
  // which train is running this time round: picked from the run's number, so it's the same on every redraw
  const trainRun = (run) => {
    const h = (k) => { const v = Math.sin((run + 1) * 78.233 + k * 12.9898) * 43758.5453; return v - Math.floor(v); };
    return { livery: LIVERIES[Math.floor(h(1) * LIVERIES.length)], cars: 2 + Math.floor(h(2) * 3), dir: h(3) < .5 ? -1 : 1 };
  };
  const trainFigure = (shirt, bag) => `<g class="tr-flip"><path class="tr-limb tr-leg l1" d="M0 -4.6L.2 -2.3L-.1 0"/><path class="tr-limb tr-leg l2" d="M0 -4.6L.2 -2.3L-.1 0"/>
      <path class="tr-torso" d="M0 -4.6V-9.4" style="stroke:${shirt}"/><path class="tr-limb" d="M0 -8.6L-1 -6.4L-.8 -4.4"/>
      ${bag ? `<path class="tr-limb" d="M0 -8.6L1.4 -6.6L2 -4.8"/><rect class="tr-case" x="1.6" y="-4.8" width="3" height="4.2" rx=".6"/>` : ""}
      <circle class="tr-head" cx="0" cy="-11.4" r="1.9"/></g>`;
  // A small footbridge over the rail: a deck with a railing just clear of the train's roof, and a
  // flight of open stairs (seen side-on, parallel to the street) coming down from its left end. The
  // stairs are on the far side of the line, so the train passes in front of them; the deck spans
  // over it and its post stands on the near side, in front of the train. Drawn in two parts: "back"
  // goes under the train, "front" over it. The trainspotter stands up on the deck.
  function footbridge(bx, bw, floor, f, part) {
    const deck = floor - 16, x0 = bx - bw / 2, x1 = bx + bw / 2, run = 16, steps = 6, sx = x0 - run;
    const treads = Array.from({ length: steps }, (_, i) => {
      const y = deck + (i + 1) * (floor - deck) / (steps + 1), x = x0 - (i + 1) * run / (steps + 1);
      return `M${f(x - run / (steps + 1))},${f(y)}H${f(x + .6)}`;
    }).join("");
    if (part === "back") return `<g class="tr-bridge">
      <path class="tr-stringer" d="M${f(x0)},${f(deck + 1.2)}L${f(sx)},${f(floor)}"/>
      <path class="tr-tread" d="${treads}"/>
      <path class="tr-handrail" d="M${f(x0)},${f(deck - 6)}L${f(sx)},${f(floor - 6)}M${f(x0 - run * .5)},${f(deck - 6 + (floor - deck) * .5)}v6M${f(sx)},${f(floor - 6)}V${f(floor)}"/></g>`;
    return `<g class="tr-bridge"><title>A footbridge over the line, and a trainspotter waiting for the shot</title>
      <path class="tr-stringer" d="M${f(x1 - 1)},${f(deck + 2)}V${f(floor)}"/>
      <rect class="tr-deck" x="${f(x0)}" y="${f(deck)}" width="${f(bw)}" height="2.2" rx=".4"/>
      <g class="tr-spotter" transform="translate(${f(x1 - 6)},${f(deck)}) scale(1.2)">${spotterFigure}</g>
      <path class="tr-bridge-rail" d="M${f(x0)},${f(deck - 6)}H${f(x1)}${Array.from({ length: Math.floor(bw / 4) + 1 }, (_, i) => `M${f(x0 + i * bw / Math.floor(bw / 4))},${f(deck - 6)}V${f(deck)}`).join("")}"/></g>`;
  }
  function trainBody(cars) {
    const cl = TRAIN.car, L = cl * cars, H = TRAIN.h;
    // a long, low duck-bill nose at each end, white with a blue stripe; the left end leads
    const body = `M3,-2 C-1,-2 -.5,-4.6 6,-7.4 C12,-10.6 17,${-H} 26,${-H} H${L - 26} C${L - 17},${-H} ${L - 12},-10.6 ${L - 6},-7.4 C${L + .5},-4.6 ${L + 1},-2 ${L - 3},-2 Z`;
    const doors = Array.from({ length: cars }, (_, i) => i * cl + cl * .5);
    const wins = [];
    for (let x = 24; x < L - 24; x += 4.2) if (doors.every((d) => Math.abs(x + 1 - d) > 3.6)) wins.push(`M${x.toFixed(1)},-9.6h2.4`);
    return `<clipPath id="tr-shape"><path d="${body}"/></clipPath><path class="tr-body" d="${body}"/>
      <rect class="tr-skirt" x="-2" y="-6.4" width="${L + 4}" height="4.4" clip-path="url(#tr-shape)"/>
      <path class="tr-stripe" d="M5,-4.4 C9,-5.6 14,-5.6 20,-5.4 H${L - 20} C${L - 14},-5.6 ${L - 9},-5.6 ${L - 5},-4.4"/>
      <path class="tr-cab" d="M9.5,-8.6 C12,-10.6 15,-11.4 19,-11.4M${L - 9.5},-8.6 C${L - 12},-10.6 ${L - 15},-11.4 ${L - 19},-11.4"/>
      <path class="tr-wins" d="${wins.join("")}"/>
      <path class="tr-joins" d="${Array.from({ length: cars - 1 }, (_, i) => `M${((i + 1) * cl).toFixed(1)},${-H + .6}V-2.4`).join("")}"/>
      ${doors.map((d) => `<rect class="tr-door" x="${(d - 1.7).toFixed(1)}" y="-11" width="3.4" height="8.4" rx=".5"/>`).join("")}
      <circle class="tr-head-lamp" cx="2.2" cy="-3.4" r=".8"/><circle class="tr-tail-lamp" cx="${L - 2.2}" cy="-3.4" r=".8"/>
      ${Array.from({ length: cars }, (_, i) => [i * cl + 8, (i + 1) * cl - 8]).flat().map((x) => `<rect class="tr-bogie" x="${(x - 4).toFixed(1)}" y="-2.2" width="8" height="1.4" rx=".5"/><circle class="tr-wheel" cx="${(x - 2.2).toFixed(1)}" cy="-.9" r=".9"/><circle class="tr-wheel" cx="${(x + 2.2).toFixed(1)}" cy="-.9" r=".9"/>`).join("")}`;
  }
  // The scene (rail, platform, sign, signal, portal) depends only on the page's geometry and is never
  // redrawn between trains; only the train itself is swapped for each run, while it's out of sight.
  // The platform, sign, signal and the spots where passengers wait are all fixed, sized for the
  // longest train, so nothing moves when a different train comes along.
  let trainKey = "", trainRunKey = "";
  // the trainspotter on the footbridge: where the train's nose was last frame, and when the flash went
  const spotter = { front: null, run: -1, flashAt: -9, shot: false };
  // standing on the deck, facing +x: leaning on the railing looking down at the track with the camera
  // at the chest, or with the camera up to the eye
  const spotterFigure = `<g class="tr-spot-flip">
      <path class="tr-limb" d="M-.6 0L-.4 -4.6M.8 0L.4 -4.6"/>
      <g class="tr-spot-wait"><path class="tr-torso" d="M0 -4.6L1.4 -9" style="stroke:#f97316"/><path class="tr-limb" d="M1.2 -8.4L3 -6.6L3.8 -7.2"/>
        <rect class="tr-cam" x="3" y="-8.4" width="2.6" height="1.8" rx=".4"/><circle class="tr-head" cx="2.4" cy="-10.6" r="1.9"/></g>
      <g class="tr-spot-shoot"><path class="tr-torso" d="M0 -4.6L.7 -9.2" style="stroke:#f97316"/><path class="tr-limb" d="M.6 -8.6L2.8 -9.4L3.6 -10.6"/>
        <circle class="tr-head" cx="1.4" cy="-11.2" r="1.9"/><rect class="tr-cam" x="2.6" y="-12.2" width="2.8" height="2" rx=".4"/><circle class="tr-lens" cx="5.6" cy="-11.2" r=".7"/>
        <g class="tr-flash"><circle class="tr-flash-glow" cx="5.8" cy="-11.6" r="4"/><path class="tr-flash-rays" d="M5.8 -14.4V-16.4M8.4 -11.6H10.4M7.8 -13.6L9.2 -15M7.8 -9.6L9.2 -8.2"/></g></g></g>`;
  function drawTrain() {
    const layer = $("train");
    const mk = $("market"), wk = $("week-card");
    const fixed = FIT_QUERY.matches;
    const m = mk && mk.getBoundingClientRect(), w = wk && wk.getBoundingClientRect();
    if (!fixed || !m || !m.height || !mk.firstElementChild || !w || !w.width || w.right > m.left || Math.abs(w.bottom - m.bottom) > 30) {
      if (trainKey) { layer.innerHTML = ""; layer.setAttribute("width", 0); layer.setAttribute("height", 0); trainKey = trainRunKey = ""; }
      return;
    }
    layer.style.position = "fixed";
    const W = innerWidth, H = innerHeight, floor = m.top + mk.clientHeight - 1, f = (n) => n.toFixed(1);
    const x0 = w.right, x1 = m.right, mid = (m.left + m.right) / 2, half = TRAIN.car * 2;   // the longest train is 4 cars
    // the footbridge, in the gap between the calendar and the market (if there's room for it)
    const cal = $("calendar")?.getBoundingClientRect(), gap = cal && cal.width ? m.left - cal.right : 0;
    const bx = gap >= 18 ? cal.right + gap / 2 : null, bw = Math.min(30, gap - 2);
    const key = `${W}x${H}|${x0.toFixed(0)}|${x1.toFixed(0)}|${floor.toFixed(1)}|${bx == null ? "" : bx.toFixed(0)}`;
    if (key !== trainKey) {
      trainKey = key; trainRunKey = "";
      layer.setAttribute("width", W); layer.setAttribute("height", H); layer.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const pt = floor - 21;
      layer.innerHTML = `<defs><clipPath id="tr-clip"><rect x="${f(x0)}" y="${f(floor - 40)}" width="${f(x1 - x0)}" height="44"/></clipPath></defs>
        <path class="tr-rail" d="M${f(x0)},${f(floor)}H${f(x1)}"/><path class="tr-ties" d="M${f(x0 + 2)},${f(floor + 1.4)}H${f(x1)}"/>
        <path class="tr-platform" d="M${f(mid - half - 4)},${f(floor - .6)}H${f(mid + half + 4)}"/>
        <g transform="translate(${f(mid - half - 9)},${f(floor)})"><path class="tr-post" d="M0 0V-21"/><rect class="tr-sign" x="-7" y="-25.5" width="14" height="5" rx=".8"/><text class="tr-sign-text" x="0" y="-21.9" text-anchor="middle">STATION</text></g>
        <g class="tr-signal" transform="translate(${f(x0 + 30)},${f(floor)})"><title>The crossing signal: red while a train is due or about, green once it has gone</title><path class="tr-sig-pole" d="M0 0V-20"/><rect class="tr-sig-box" x="-4" y="-38" width="8" height="19" rx="2"/>
          ${[["red", -33.4], ["amber", -28.5], ["green", -23.6]].map(([c, y]) => `<path class="tr-sig-visor" d="M-3,${y - 1.6}A3 3 0 0 1 3,${y - 1.6}"/><circle class="tr-sig ${c}" cy="${y}" r="2.1"/>`).join("")}</g>
        <path class="tr-portal-in" d="M${f(x0)},${f(floor)}V${f(pt)}H${f(x0 + 7)}V${f(floor)}Z"/>
        ${bx == null ? "" : footbridge(bx, bw, floor, f, "back")}
        <g clip-path="url(#tr-clip)"><g class="tr-waiters">${[0, 1].map(() => `<g class="tr-waiter"></g>`).join("")}</g><g class="tr-train"></g></g>
        ${bx == null ? "" : footbridge(bx, bw, floor, f, "front")}
        <g class="tr-gate" transform="translate(${f(bx == null ? x0 + 26 : bx - bw / 2 - 22)},${f(floor)}) scale(${bx == null ? 1 : -1},1)"><title>The level crossing barrier</title>
          <path class="tr-gate-post" d="M0 0V-10"/><rect class="tr-gate-box" x="-2.6" y="-14.6" width="5.2" height="4.4" rx="1"/>
          <circle class="tr-gate-lamp a" cx="-1.2" cy="-12.4" r=".9"/><circle class="tr-gate-lamp b" cx="1.2" cy="-12.4" r=".9"/>
          <g class="tr-gate-arm" transform="translate(0,-8) rotate(-90)"><rect class="tr-arm" x="0" y="-1" width="24" height="2" rx=".6"/>
            <path class="tr-arm-stripes" d="M5 -1v2M9 -1v2M13 -1v2M17 -1v2M21 -1v2"/><circle class="tr-arm-lamp" cx="22.6" cy="0" r=".7"/><circle class="tr-gate-hub" r="1.2"/></g></g>
        <path class="tr-portal" d="M${f(x0 - 1)},${f(pt)}H${f(x0 + 8.5)}V${f(pt + 2.6)}H${f(x0 + 7)}V${f(floor)}M${f(x0 - 1)},${f(pt - 1.6)}H${f(x0 + 8.5)}"/>`;
    }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const T = TRAIN, now = Date.now() / 1000, t = reduce ? T.arrive + 1 : now % T.period;
    const run = Math.floor(now / T.period), v = trainRun(run), L = T.car * v.cars, stopX = mid - L / 2;
    const tr = layer.querySelector(".tr-train");
    // this run's train, put together while the track is empty (before it appears)
    if (trainRunKey !== `${run}`) {
      trainRunKey = `${run}`;
      tr.setAttribute("style", `--tr-body:${v.livery.body};--tr-skirt:${v.livery.skirt};--tr-stripe:${v.livery.stripe};--tr-edge:${v.livery.edge}`);
      tr.innerHTML = `<title>A ${v.livery.name} bullet train, calling at the market</title>${trainBody(v.cars)}`;
    }
    // going left it comes in from the market's tunnel and leaves by the card's; going right, the reverse
    const startX = v.dir < 0 ? x1 + 4 : x0 - L - 6, endX = v.dir < 0 ? x0 - L - 6 : x1 + 4, tDep = T.arrive + T.dwell;
    let x, open = false;
    // it runs in fast and brakes hard into the platform, waits, then pulls away slowly and keeps
    // accelerating all the way into the tunnel
    if (t < T.arrive) { const p = t / T.arrive; x = startX + (stopX - startX) * (1 - (1 - p) ** 2); }
    else if (t < tDep) { x = stopX; open = t > T.arrive + 1 && t < tDep - 1.2; }
    else if (t < tDep + T.depart) { const p = (t - tDep) / T.depart; x = stopX + (endX - stopX) * p ** 2.2; }
    else x = null;
    tr.style.display = x == null ? "none" : "";
    // the nose with the headlight leads: mirrored when it's heading right
    if (x != null) tr.setAttribute("transform", v.dir < 0 ? `translate(${f(x)},${f(floor)})` : `translate(${f(x + L)},${f(floor)}) scale(-1,1)`);
    tr.classList.toggle("open", open);
    // the platform signal turns red 5 seconds before the train pulls in, and back to green as it leaves
    // The crossing by the left-hand tunnel: the signal turns red 5 seconds before the train pulls in
    // and the barrier comes down with it. Both go back up once the train has left the station and is
    // clear of the crossing (a train heading left still has to run through it into the tunnel).
    const redAt = T.period - (5 - T.arrive), clearAt = tDep + (v.dir < 0 ? T.depart : 0), swing = 1.6;
    const ease = (q) => q * q * (3 - 2 * q);
    const down = reduce ? 1 : t >= redAt ? ease(Math.min(1, (t - redAt) / swing)) : t < clearAt ? 1 : t < clearAt + swing ? 1 - ease((t - clearAt) / swing) : 0;
    layer.querySelector(".tr-signal").classList.toggle("stop", t >= redAt || t < clearAt);
    const gate = layer.querySelector(".tr-gate");
    gate.classList.toggle("down", down > 0);
    gate.querySelector(".tr-gate-arm").setAttribute("transform", `translate(0,-8) rotate(${f(-90 * (1 - down))})`);
    // the trainspotter faces the way this run's train will come from, raises the camera as it
    // gets close, and takes its picture (a flash) the moment the nose passes under the bridge
    const sp = layer.querySelector(".tr-spotter");
    if (sp) {
      const front = x == null ? null : v.dir < 0 ? x : x + L;
      if (spotter.run !== run) { spotter.run = run; spotter.shot = false; spotter.front = null; }
      if (front != null && spotter.front != null && !spotter.shot && (spotter.front - bx) * (front - bx) <= 0) { spotter.shot = true; spotter.flashAt = now; }
      spotter.front = front;
      const near = front != null && !spotter.shot && Math.abs(front - bx) < (v.dir < 0 ? 260 : 9999) && (v.dir > 0 || t >= tDep - 1.5);
      const since = now - spotter.flashAt;   // (never negative, even if the clock is set back)
      sp.classList.toggle("shoot", reduce ? false : near || (since >= 0 && since < 1.2));
      sp.classList.toggle("flash", since >= 0 && since < .18);
      sp.querySelector(".tr-spot-flip").setAttribute("transform", `scale(${v.dir < 0 ? 1 : -1},1)`);
    }
    // two passengers. They come out of the market's right-hand tunnel well after a train has gone and
    // wait at fixed spots on the platform; when the next train is in, each walks to its nearest door
    // and steps aboard (behind the train, so it hides them). Who they are is set by the train they
    // will catch, and changes only while they're out of sight.
    const waitAt = [mid - 30, mid + 34];
    const doors = Array.from({ length: v.cars }, (_, k) => stopX + T.car * (k + .5));
    [...layer.querySelectorAll(".tr-waiter")].forEach((g, i) => {
      const catching = t >= T.waitersFrom ? run + 1 : run;
      const who = `${catching}`;
      if (g.dataset.who !== who) {
        const h = (k) => { const q = Math.sin((catching + 1) * 39.17 + k * 7.31 + i * 3.7) * 43758.5453; return q - Math.floor(q); };
        g.dataset.who = who;
        g.innerHTML = trainFigure(["#f472b6", "#34d399", "#60a5fa", "#fbbf24", "#c084fc", "#f87171"][Math.floor(h(1) * 6)], h(2) < .45);
      }
      const door = doors.reduce((a, d) => Math.abs(d - waitAt[i]) < Math.abs(a - waitAt[i]) ? d : a, doors[0]);
      const walkIn = T.waitersFrom + i * 3, walkDur = 10, board = T.arrive + 1.4 + i * .8;
      let px = null, walking = false, dir = -1;
      if (reduce) px = waitAt[i];
      else if (t >= walkIn && t < walkIn + walkDur) { px = (x1 + 8) + (waitAt[i] - (x1 + 8)) * (t - walkIn) / walkDur; walking = true; }
      else if (t >= walkIn + walkDur || t < board) px = waitAt[i];
      else if (t < board + 2) { px = waitAt[i] + (door - waitAt[i]) * (t - board) / 2; walking = true; dir = door < waitAt[i] ? -1 : 1; }
      g.style.display = px == null ? "none" : "";
      if (px != null) {
        g.setAttribute("transform", `translate(${f(px)},${f(floor)}) scale(1.2)`);
        g.firstElementChild.setAttribute("transform", `scale(${dir},1)`);
        g.classList.toggle("walking", walking);
      }
    });
  }
  (function trainLoop() { if (!document.hidden) drawTrain(); requestAnimationFrame(trainLoop); })();

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
      html += `<div class="week-total${met ? " met" : ""}" data-start="${iso(weekStart)}" data-end="${iso(addDays(weekStart, 6))}" data-workouts="${weekWorkouts}">${week === 0 ? sitterHtml() : ""}
        <strong>${activeDays ? fmtDuration(weekTime) : "—"}</strong>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <span class="goal">${met ? `<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>Goal` : `${weekWorkouts}/${state.goal} workouts`}</span></div>`;
    }
    const cal = $("calendar");
    cal.style.setProperty("--rows", rows);
    cal.innerHTML = html;
    setTimeout(drawRappel, 0);
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
    drawMarket();
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

  // The last day of the month: the rappeller has reached the bottom of the calendar and gone down
  // to the underground market.
  const atMonthEnd = (d = new Date()) => d.getDate() === new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

  // The underground market: a flat, side-on street drawn straight onto the page below the Daily
  // activity card, whose bottom edge is its ceiling. Everything stands on one ground line:
  //   shops  a back row of shopfronts of different widths and heights, lamp posts in the gaps
  //   street carts, café tables, a fruit tent, a vending machine standing in front of them
  //   people strolling both ways (the further ones a touch smaller and dimmer), a bench with a
  //          reader, a cat, a plant, a bin, a puddle, and string lights tacked to the card's edge
  //   tunnels through the rock at either end (seen side-on, like everything else), where people
  //          walk in and out of the market
  // On the last day of the month the calendar's rappeller sits outside the bar with a beer.
  let marketKey = "";
  function drawMarket(onlyIfMoved = false) {
    const el = $("market");
    if (!el) return;
    const W = Math.round(el.clientWidth), H = Math.round(el.clientHeight), end = atMonthEnd();
    const card = $("activity-card");
    const ceil = card ? -Math.max(0, Math.round(el.getBoundingClientRect().top - card.getBoundingClientRect().bottom)) : 0;
    const key = `${W}x${H}|${end}|${ceil}`;
    if (onlyIfMoved && key === marketKey) return;
    marketKey = key;
    if (W < 200 || H < 44) { el.innerHTML = ""; return; }
    const f = (n) => n.toFixed(1);
    // A flat, side-on view on the page itself: the Daily activity card's bottom edge is the ceiling
    // (the lights hang from it), and everything stands on one ground line. Depth is only layering:
    // the shops at the back, things out in the street in front of them, people in front of those.
    const floor = H - 1.5, shopH = Math.max(30, floor - Math.max(6, ceil + 20)), TW = 20;

    // ---- shops: an organic back row. Buildings of different widths and heights, a lamp post in the
    // gaps between some, a closed shop with its shutter half down, hanging blade signs.
    const sil = (x, y, k = .9, arm = "") => `<g transform="translate(${f(x)},${f(y)}) scale(${k})"><path class="mk-silo" d="M0 0V-6"/><circle class="mk-silo-head" cy="-7.6" r="1.6"/>${arm}</g>`;
    const ROW = [
      { kind: "bar", w: 62, drop: 0 }, { kind: "alley", w: 7 }, { kind: "ramen", w: 50, drop: 7 },
      { kind: "eats", w: 66, drop: 3 }, { kind: "shutter", w: 38, drop: 9 }, { kind: "alley", w: 6 },
      { kind: "arcade", w: 54, drop: 0 }, { kind: "laundry", w: 46, drop: 5 }, { kind: "bakery", w: 50, drop: 8 },
    ];
    // keep as much of the row as fits, then stretch it to fill the street
    const avail = W - 2 * TW - 8;
    let rowItems = [], used = 0;
    for (const it of ROW) { if (used + it.w > avail * 1.08) break; rowItems.push(it); used += it.w; }
    if (rowItems[rowItems.length - 1].kind === "alley") { used -= rowItems.pop().w; }
    const stretch = avail / used;
    let cx = TW + 4, barDoor = null, eatsSpan = null, shutterSpan = null, arcadeSpan = null, bakerySpan = null, ramenSpan = null;
    const backRow = rowItems.map((it) => {
      const w = it.w * stretch, x = cx; cx += w;
      if (it.kind === "alley") {
        const lx = x + w / 2, ly = floor - 24;
        return `<path class="mk-lamppost" d="M${f(lx)},${f(floor)}V${f(ly)}q0 -2 2 -2"/><circle class="mk-doorlamp" cx="${f(lx + 2.2)}" cy="${f(ly - 1)}" r="1.1"/>`;
      }
      const shopBot = floor, top = floor - shopH + it.drop * .7, h = shopBot - top;
      const gs = Math.min(h - 9, 27), gTop = floor - gs, sgH = 6.4;   // ground storey, sign height
      const wx = x + 3.5, ww = w * .52, winTop = gTop + gs * .2, winH = gs * .52;
      const dx = x + w * .64, dw = Math.max(6, w * .22), doorTop = gTop + gs * .22;
      // flats over the shop, between its sign and the ground storey: some lit, some curtained
      const upper = [];
      for (let ry = top + sgH + 3.6, r = 0; ry + 4 <= gTop - 1.6; ry += 6.5, r++) {
        for (let wx2 = x + 4 + (r % 2) * 3, k = 0; wx2 + 5 <= x + w - 3; wx2 += 9, k++) {
          const seed = Math.round(x) * 7 + r * 13 + k * 5, lit = seed % 5 > 1, warm = seed % 3 > 0, flick = seed % 11 === 0;
          upper.push(`<rect class="mk-flat${lit ? (warm ? " warm" : " cool") : ""}${flick ? " flick" : ""}" x="${f(wx2)}" y="${f(ry)}" width="5" height="4" rx=".5" style="animation-delay:${(-seed % 23)}s"/>`
            + (lit && seed % 4 === 0 ? `<path class="mk-curtain" d="M${f(wx2)},${f(ry)}h5v1.4q-2.5 .9 -5 0Z"/>` : ""));
        }
      }
      const facade = (fill, extra = "") => `<path class="mk-facade" d="M${f(x + .6)},${f(shopBot)}V${f(top + 1.2)}H${f(x + w - .6)}V${f(shopBot)}Z" fill="${fill}"/>
        <path class="mk-cornice" d="M${f(x)},${f(top + .8)}H${f(x + w)}M${f(x)},${f(gTop - 1)}H${f(x + w)}"/>${upper.join("")}${extra}`;
      const sign = (text, cls, at = .5, sw = w - 8) => `<rect class="mk-signboard" x="${f(x + w * at - sw / 2)}" y="${f(top + 2.2)}" width="${f(sw)}" height="${sgH}" rx=".8"/>
        <text class="mk-sign ${cls}" x="${f(x + w * at)}" y="${f(top + 2.2 + sgH - 1.4)}" text-anchor="middle">${text}</text>`;
      const win = (glow, inside = "") => `<rect class="mk-window" x="${f(wx)}" y="${f(winTop)}" width="${f(ww)}" height="${f(winH)}" style="fill:${glow}"/>${inside}<rect class="mk-frame" x="${f(wx)}" y="${f(winTop)}" width="${f(ww)}" height="${f(winH)}"/>`;
      const door = (arched) => `<path class="mk-door" d="M${f(dx)},${f(shopBot)}V${f(doorTop + (arched ? dw / 2 : 0))}${arched ? `A${f(dw / 2)} ${f(dw / 2)} 0 0 1 ${f(dx + dw)},${f(doorTop + dw / 2)}` : `H${f(dx + dw)}`}V${f(shopBot)}Z"/>
        <circle class="mk-knob" cx="${f(dx + dw - 1.3)}" cy="${f(doorTop + (shopBot - doorTop) * .58)}" r=".5"/><circle class="mk-doorlamp" cx="${f(dx + dw / 2)}" cy="${f(doorTop - 1.6)}" r=".9"/>`;
      const blade = (text, cls, left = false) => { const bx = left ? x - 5.6 : x + w + 1;
        return `<path class="mk-bracket" d="M${f(left ? x + 1 : x + w - 1)},${f(top + 3)}h${left ? -3.4 : 3.4}"/><rect class="mk-blade" x="${f(bx)}" y="${f(top + 3.6)}" width="4.6" height="${f(text.length * 4.4 + 2)}" rx=".6"/>
        <text class="mk-sign mk-vert ${cls}" x="${f(bx + 2.3)}" y="${f(top + 5)}" text-anchor="middle">${text.split("").map((c, i) => `<tspan x="${f(bx + 2.3)}" dy="${i ? 4.4 : 3.6}">${c}</tspan>`).join("")}</text>`; };
      if (it.kind === "bar") {
        barDoor = dx + dw / 2;
        const bottles = Array.from({ length: Math.floor((ww - 4) / 4) }, (_, i) => `<rect x="${f(wx + 2.4 + i * 4)}" y="${f(winTop + 1)}" width="1.8" height="3" fill="${["#22c55e", "#f59e0b", "#60a5fa", "#e11d48"][i % 4]}"/>`).join("");
        return `<g class="mk-shop">${facade("#2a1820", `<path class="mk-bricks" d="${Array.from({ length: 4 }, (_, i) => `M${f(x + 2)},${f(top + h * (.3 + i * .17))}H${f(x + w - 2)}`).join("")}"/>`)}
          ${sign("BAR", "mk-neon pink", .44, w * .62)}
          ${win("#be185d", `<path class="mk-shelf" d="M${f(wx + 2)},${f(winTop + 4)}H${f(wx + ww - 2)}"/>${bottles}${sil(wx + ww * .6, winTop + winH, .9, `<g class="mk-shake"><path class="mk-silo-arm" d="M0 -5.4L2 -6.6L2.4 -8.8"/><rect class="mk-shaker" x="1.7" y="-11" width="1.5" height="2.6" rx=".5"/></g>`)}`)}
          ${door(true)}${blade("★", "mk-neon pink")}</g>`;
      }
      if (it.kind === "ramen") {
        ramenSpan = [x, x + w];
        return `<g class="mk-shop">${facade("#3a2618", `<path class="mk-planks" d="${Array.from({ length: Math.floor(w / 5) }, (_, i) => `M${f(x + 3 + i * 5)},${f(top + 2)}V${f(shopBot)}`).join("")}"/>`)}
          ${sign("RAMEN", "mk-neon cyan")}
          ${win("#0e7490", `<path class="mk-counter-in" d="M${f(wx + 1)},${f(winTop + winH - 3.6)}H${f(wx + ww - 1)}"/>${sil(wx + 5, winTop + winH - 3.6, .8)}${sil(wx + 13, winTop + winH - 3.6, .8)}<ellipse class="mk-bowl" cx="${f(wx + 7)}" cy="${f(winTop + winH - 4.2)}" rx="1.5" ry=".55"/>`)}
          ${door(false)}<path class="mk-noren" d="${Array.from({ length: 3 }, (_, i) => `M${f(dx + .6 + i * dw / 3)},${f(doorTop)}h${f(dw / 3 - 1)}v${f((shopBot - doorTop) * .3)}h${f(-(dw / 3 - 1))}Z`).join("")}"/>
          <path class="mk-pipe thin" d="M${f(x + w * .2)},${f(top)}V${f(top - 4)}"/><path class="mk-steam" d="M${f(x + w * .2)},${f(top - 5)}q-1 -2 .4 -4M${f(x + w * .2 + 1.2)},${f(top - 5)}q-1 -2 .4 -4"/></g>`;
      }
      if (it.kind === "eats") {
        eatsSpan = [x, x + w];
        return `<g class="mk-shop">${facade("#251d14")}${sign("EATS", "mk-neon amber", .5, w * .5)}
          ${win("#b45309", `<rect class="mk-tv" x="${f(wx + ww - 11)}" y="${f(winTop + 1.4)}" width="9" height="6" rx=".6"/>
            <g class="mk-tv-picture"><rect class="mk-tv-sky" x="${f(wx + ww - 10.4)}" y="${f(winTop + 2)}" width="7.8" height="4.8"/><path class="mk-tv-mtn" d="M${f(wx + ww - 10.4)},${f(winTop + 6.8)}l2.6 -3.2l1.6 1.4l1.6 -2l2 3.8Z"/></g>
            ${sil(wx + 6, winTop + winH, .85, `<g class="mk-fork"><path class="mk-silo-arm" d="M0 -5L2 -4.2L2.6 -5.4"/></g>`)}`)}
          <path class="mk-awn" d="M${f(x + 1)},${f(winTop + 3)}L${f(x + 3)},${f(winTop - .4)}H${f(x + w - 3)}L${f(x + w - 1)},${f(winTop + 3)}Z" fill="#dc2626"/>
          <path class="mk-awn-stripes" d="${Array.from({ length: Math.floor(w / 7) }, (_, i) => `M${f(x + 6 + i * 7)},${f(winTop - .4)}V${f(winTop + 3)}`).join("")}"/>
          ${door(false)}</g>`;
      }
      if (it.kind === "shutter") {
        shutterSpan = [x, x + w];
        return `<g class="mk-shop">${facade("#1f2023")}${sign("CLOSED", "painted dim", .5, w - 8)}
          <rect class="mk-shutter" x="${f(x + 3)}" y="${f(gTop + gs * .1)}" width="${f(w - 6)}" height="${f(gs * .6)}"/>
          <path class="mk-shutter-slats" d="${Array.from({ length: 6 }, (_, i) => `M${f(x + 3)},${f(gTop + gs * (.1 + i * .1))}H${f(x + w - 3)}`).join("")}"/>
          <rect class="mk-shutter-gap" x="${f(x + 3)}" y="${f(gTop + gs * .7)}" width="${f(w - 6)}" height="${f(gs * .3)}"/>
          <path class="mk-tag" d="M${f(x + 6)},${f(gTop + gs * .45)}q3 -3 6 0t6 0"/></g>`;
      }
      if (it.kind === "arcade") {
        arcadeSpan = [x, x + w];
        return `<g class="mk-shop">${facade("#1d1730")}${sign("ARCADE", "mk-neon violet")}
          ${win("#6d28d9", [0, 1, 2].map((i) => `<rect class="mk-cab" x="${f(wx + 2 + i * (ww - 4) / 3)}" y="${f(winTop + 2)}" width="${f((ww - 8) / 3)}" height="${f(winH - 2)}" rx=".6"/><rect class="mk-screen" x="${f(wx + 3 + i * (ww - 4) / 3)}" y="${f(winTop + 3.2)}" width="${f((ww - 8) / 3 - 2)}" height="3.2" style="animation-delay:${-i * .6}s"/>`).join(""))}
          ${door(false)}${blade("24", "mk-neon violet", true)}</g>`;
      }
      if (it.kind === "laundry") {
        return `<g class="mk-shop">${facade("#151c2b")}${sign("LAUNDRY", "painted", .5, w - 6)}
          ${win("#1d4ed8", [0, 1].map((i) => { const mx = wx + 2 + i * (ww - 4) / 2, cx2 = mx + (ww - 8) / 4, cy2 = winTop + winH - 4;
            return `<rect class="mk-washer-box" x="${f(mx)}" y="${f(winTop + winH - 8)}" width="${f((ww - 8) / 2)}" height="8" rx=".6"/><g class="mk-drum" style="transform-origin:${f(cx2)}px ${f(cy2)}px"><circle class="mk-porthole" cx="${f(cx2)}" cy="${f(cy2)}" r="2.4"/><path class="mk-suds" d="M${f(cx2 - 1.6)},${f(cy2)}h3.2"/></g>`; }).join(""))}
          ${door(false)}</g>`;
      }
      if (it.kind === "bakery") {
        bakerySpan = [x, x + w];
        return `<g class="mk-shop">${facade("#2a1c14")}${sign("BAKERY", "painted", .5, w - 6)}
          ${win("#c2410c", `<path class="mk-shelf" d="M${f(wx + 2)},${f(winTop + winH - 4)}H${f(wx + ww - 2)}"/>${Array.from({ length: 4 }, (_, i) => `<ellipse class="mk-loaf" cx="${f(wx + 4 + i * (ww - 8) / 3)}" cy="${f(winTop + winH - 5.4)}" rx="1.9" ry="1.1"/>`).join("")}`)}
          <path class="mk-awn" d="M${f(wx - 1)},${f(winTop + 2.6)}L${f(wx + 1)},${f(winTop - .2)}H${f(wx + ww - 1)}L${f(wx + ww + 1)},${f(winTop + 2.6)}Z" fill="#f59e0b"/>
          ${door(true)}</g>`;
      }
      return "";
    }).join("");
    const shops = backRow;

    // ---- the front row: things out in the street, standing on its front half
    const fy = floor;
    const frontRow = [];
    if (ramenSpan && eatsSpan) {   // a noodle cart under an umbrella, between the noodle bar and the diner
      const x = ramenSpan[0] + (ramenSpan[1] - ramenSpan[0]) * .3;
      frontRow.push(`<g class="mk-cart"><path class="mk-umbrella" d="M${f(x - 9)},${f(fy - 13)}Q${f(x)},${f(fy - 19)} ${f(x + 9)},${f(fy - 13)}Z"/><path class="mk-pole" d="M${f(x)},${f(fy - 16)}V${f(fy - 6)}"/>
        <rect class="mk-cartbox" x="${f(x - 8)}" y="${f(fy - 8)}" width="16" height="6" rx="1"/><circle class="mk-wheel" cx="${f(x - 5)}" cy="${f(fy - 1.2)}" r="1.6"/><circle class="mk-wheel" cx="${f(x + 5)}" cy="${f(fy - 1.2)}" r="1.6"/>
        <path class="mk-steam" d="M${f(x - 3)},${f(fy - 9)}q-1 -2 .4 -4M${f(x - 1.6)},${f(fy - 9)}q-1 -2 .4 -4"/>
        <g transform="translate(${f(x + 4)},${f(fy - 8)}) scale(1.2)"><path class="mk-body" d="M0 0V-4.8" style="stroke:#f87171"/><circle class="mk-face" cy="-6.6" r="1.8"/><path class="mk-limb" d="M0 -4L-2.6 -2.4"/></g></g>`);
    }
    if (eatsSpan) {   // two café tables outside the diner, one taken
      [eatsSpan[0] + (eatsSpan[1] - eatsSpan[0]) * .45, eatsSpan[0] + (eatsSpan[1] - eatsSpan[0]) * .82].forEach((x, i) => {
        frontRow.push(`<path class="mk-table" d="M${f(x - 4)},${f(fy - 7)}H${f(x + 4)}M${f(x)},${f(fy - 7)}V${f(fy)}M${f(x - 2)},${f(fy)}H${f(x + 2)}"/>
          <path class="mk-chair" d="M${f(x + 7)},${f(fy - 11)}V${f(fy)}M${f(x + 7)},${f(fy - 5.4)}H${f(x + 3.6)}V${f(fy)}"/>`
          + (i === 0 ? `<g transform="translate(${f(x + 5.6)},${f(fy - 5.8)}) scale(-1.2,1.2)"><path class="mk-limb" d="M0 0H-3.2L-3.4 4.4"/><path class="mk-body" d="M0 0L.2 -4.8" style="stroke:#38bdf8"/><circle class="mk-face" cx=".2" cy="-6.8" r="1.8"/><g class="mk-sip"><path class="mk-limb" d="M.1 -4L-2.6 -3.4L-3 -6"/><rect class="mk-glass" x="-4" y="-8.4" width="1.8" height="2.6" rx=".3"/></g></g>`
            : `<rect class="mk-glass" x="${f(x - 1)}" y="${f(fy - 9.4)}" width="1.6" height="2.4" rx=".3"/>`));
      });
    }
    if (shutterSpan) {   // a striped fruit tent pitched in front of the closed shop
      const x = (shutterSpan[0] + shutterSpan[1]) / 2;
      frontRow.push(`<g class="mk-tent"><path class="mk-awn" d="M${f(x - 13)},${f(fy - 11)}L${f(x - 10)},${f(fy - 15)}H${f(x + 10)}L${f(x + 13)},${f(fy - 11)}Z" fill="#14b8a6"/>
        <path class="mk-awn-stripes" d="${[-6, -2, 2, 6].map((d) => `M${f(x + d)},${f(fy - 15)}V${f(fy - 11)}`).join("")}"/><path class="mk-pole" d="M${f(x - 11)},${f(fy - 11)}V${f(fy)}M${f(x + 11)},${f(fy - 11)}V${f(fy)}"/>
        ${[-7, 0, 7].map((d) => `<rect class="mk-crate" x="${f(x + d - 3.2)}" y="${f(fy - 4.4)}" width="6.4" height="4.4" rx=".4"/>`).join("")}
        ${Array.from({ length: 8 }, (_, i) => `<circle cx="${f(x - 9 + i * 2.6)}" cy="${f(fy - 5.2)}" r="1.1" fill="${["#f97316", "#84cc16", "#ef4444", "#facc15"][i % 4]}"/>`).join("")}</g>`);
    }
    if (arcadeSpan) {   // a glowing vending machine by the arcade
      const x = arcadeSpan[1] - 6;
      frontRow.push(`<rect class="mk-vend" x="${f(x - 4)}" y="${f(fy - 15)}" width="8" height="15" rx=".8"/><rect class="mk-vend-glass" x="${f(x - 3)}" y="${f(fy - 13.6)}" width="6" height="7"/>
        ${[0, 1, 2].map((r) => `<path class="mk-vend-row" d="M${f(x - 3)},${f(fy - 11.6 + r * 2.2)}h6"/>`).join("")}`);
    }
    if (bakerySpan) {   // the bakery's chalkboard
      const x = bakerySpan[0] + 6;
      frontRow.push(`<path class="mk-board" d="M${f(x - 3.4)},${f(fy)}L${f(x - 2)},${f(fy - 9)}H${f(x + 2)}L${f(x + 3.4)},${f(fy)}"/><rect class="mk-board-face" x="${f(x - 2.4)}" y="${f(fy - 8.4)}" width="4.8" height="5.6"/><path class="mk-chalk" d="M${f(x - 1.6)},${f(fy - 7)}h3M${f(x - 1.6)},${f(fy - 5.4)}h2"/>`);
    }
    const front0 = frontRow.join("");

    // ---- the street: the ground line, a puddle, people strolling both ways between the tunnels
    const street = `<path class="mk-ground" d="M0,${f(floor + .5)}H${W}"/>
      <ellipse class="mk-puddle" cx="${f(W * .72)}" cy="${f(floor + .4)}" rx="9" ry=".9"/>`;
    const gait = (shirt) => `<path class="mk-limb mk-gait l1" d="M0 -4.6L.2 -2.3L-.1 0"/><path class="mk-limb mk-gait l2" d="M0 -4.6L.2 -2.3L-.1 0"/>
      <path class="mk-body" d="M0 -4.6V-9.4" style="stroke:${shirt}"/><g class="mk-swing"><path class="mk-limb" d="M0 -8.6L-1 -6.4L-.8 -4.4"/></g>
      <circle class="mk-face" cx="0" cy="-11.4" r="1.9"/>`;
    const walkers = [
      // [feet y, scale, direction, px/s, shirt, start offset 0-1, depth class]
      [floor, 1.2, 1, 9, "#60a5fa", .15, "far"],
      [floor, 1.2, -1, 8, "#f472b6", .6, "far"],
      [floor, 1.2, 1, 12, "#fbbf24", .45, "near"],
      [floor, 1.2, -1, 10.5, "#a3e635", .85, "near"],
    ].map(([y, k, dir, speed, shirt, off, depth]) => {
      const a = -12, b = W + 12, dur = (b - a) / speed;
      return [depth, `<g class="mk-walker ${depth}" style="--from:${dir > 0 ? a : b}px;--to:${dir > 0 ? b : a}px;animation-duration:${dur.toFixed(1)}s;animation-delay:${(-((Date.now() / 1000 + off * dur) % dur)).toFixed(2)}s">
          <g transform="translate(0,${f(y)}) scale(${dir * k},${k})">${gait(shirt)}</g></g>`];
    });
    const farWalkers = walkers.filter(([d]) => d === "far").map(([, g]) => g).join("");
    const nearWalkers = walkers.filter(([d]) => d === "near").map(([, g]) => g).join("");

    // ---- front: bench and reader, crates, a cat, a plant, a bin; the rappeller at month end
    const bx = W * .9;
    const front = `<path class="mk-bench" d="M${f(bx - 9)},${f(floor - 5)}H${f(bx + 9)}M${f(bx - 7)},${f(floor - 5)}V${f(floor)}M${f(bx + 7)},${f(floor - 5)}V${f(floor)}M${f(bx - 9)},${f(floor - 9.5)}H${f(bx + 9)}"/>
      <g transform="translate(${f(bx - 2)},${f(floor - 5.4)}) scale(1.2)"><path class="mk-limb" d="M0 0H2.6L2.8 4.4"/><path class="mk-body" d="M0 0L-.3 -4.8" style="stroke:#c084fc"/>
        <circle class="mk-face" cx="-.2" cy="-6.9" r="1.9"/><path class="mk-limb" d="M-.2 -4L2.2 -3.4M-.2 -3.6L2.4 -2.6"/><rect class="mk-paper" x="2" y="-5.8" width="2.6" height="3.4"/></g>

      <g class="mk-cat" transform="translate(${f(W * .3)},${f(floor)})"><path class="mk-cat-body" d="M-3 0V-2.4Q-3 -3.6 -1.4 -3.6H1.6L2.4 -5L2.8 -3.4Q3.4 -3 3.2 -1.8V0Z"/><g class="mk-cat-tail"><path d="M-2.8 -2.2Q-5.6 -2.6 -5.2 -5.4"/></g></g>
      <g transform="translate(${f(W * .975)},${f(floor)})"><path class="mk-pot" d="M-2.4 0L-3 -3.6H3L2.4 0Z"/><path class="mk-leaf" d="M0 -3.6Q-3.6 -7 -2 -9.6M0 -3.6Q.4 -8.4 1.8 -10M0 -3.6Q3.4 -6 3.8 -8"/></g>
      <g transform="translate(${f(W * .2)},${f(floor)})"><path class="mk-bin" d="M-2.4 0V-6H2.4V0Z"/><path class="mk-bin-lid" d="M-2.8 -6H2.8"/></g>
      ${end && barDoor != null ? `<g class="mk-who visitor" transform="translate(${f(barDoor + 4)},${f(floor - 5.6)}) scale(1.2)"><title>The calendar's rappeller made it to the bottom of the month: a beer outside the bar</title>
        <path class="mk-stool-front" d="M-1.6 0H1.6M0 0V4.6"/><path class="mk-limb" d="M0 0H-3.2L-3.4 4.4"/><rect class="mk-pack" x=".6" y="-5.2" width="2.4" height="4" rx=".8"/>
        <path class="mk-body" d="M0 0L.2 -4.8"/><path class="mk-limb" d="M.1 -4L-2.8 -2.8L-4.4 -3.6"/><rect class="mk-glass beer" x="-5.6" y="-5.6" width="2" height="2.8" rx=".3"/>
        <circle class="mk-face" cx=".2" cy="-6.9" r="1.9"/><path class="mk-helmet" d="M-1.9 -7.1A2.3 2.3 0 0 1 2.3 -7.1Z"/></g>` : ""}`;

    // ---- string lights tacked to the card's bottom edge in uneven arches, and the ladder down from it
    const pins = [];
    for (let x = 20, k = 0; x < W - 8; k++) { pins.push(x); x += 52 + ((k * 37) % 30); }
    pins.push(W - 6);
    const cy0 = ceil + 1.2;
    let wire = `M${pins[0]},${f(cy0)}`, bulbs = "", nb = 0;
    const warm = ["#fde68a", "#fdba74", "#fef3c7", "#fca5a5"];
    pins.slice(1).forEach((x1, k) => {
      const xa = pins[k], sag = 3 + ((k * 13) % 3) * 1.4, cy = cy0 + 2 * sag;
      wire += `Q${f((xa + x1) / 2)},${f(cy)} ${x1},${f(cy0)}`;
      const nbulb = Math.max(1, Math.round((x1 - xa) / 17));
      for (let b = 1; b <= nbulb; b++) {
        const t = b / (nbulb + 1), x = xa + (x1 - xa) * t, y = (1 - t) ** 2 * cy0 + 2 * (1 - t) * t * cy + t * t * cy0;
        bulbs += `<g class="bulb on" transform="translate(${f(x)},${f(y)}) rotate(${180 + ((nb * 7) % 13) - 6}) scale(.75)"><circle class="bulb-halo" cy="-5" r="5" fill="${warm[nb % 4]}" style="animation-delay:${((nb * .41) % 3).toFixed(2)}s"/><rect class="bulb-cap" x="-1" y="-2" width="2" height="2" rx=".4"/><path class="bulb-glass" d="M0,-1.9C-2,-2.9 -1.9,-6.4 0,-7.2C1.9,-6.4 2,-2.9 0,-1.9Z" fill="${warm[nb % 4]}"/></g>`;
        nb += 1;
      }
    });
    const lights = `<path class="light-wire" d="${wire}"/>${bulbs}${pins.map((x) => `<circle class="light-tack" cx="${x}" cy="${f(cy0)}" r="1.3"/>`).join("")}`;
    // ---- tunnels out of the market at either end, cut side-on through the rock under the card's
    // edge: rock down to the tunnel's roof, the dark passage beneath it running off the edge
    const roof = floor - 24;
    const tunnels = [0, 1].map((i) => {
      const o = (x) => f(i ? W - x : x);   // mirror for the right-hand end
      return `<path class="mk-rock" d="M${o(0)},${ceil}H${o(TW)}L${o(TW - 2)},${f(ceil + 8)}L${o(TW + 1)},${f(roof - 12)}L${o(TW - 1)},${f(roof - 4)}L${o(TW + 2)},${f(roof)}Q${o(TW * .5)},${f(roof + 2.5)} ${o(0)},${f(roof + 1)}Z"/>
        <path class="mk-tunnel" d="M${o(0)},${f(roof + 1)}Q${o(TW * .5)},${f(roof + 2.5)} ${o(TW + 2)},${f(roof)}V${f(floor)}H${o(0)}Z"/>
        <circle class="mk-doorlamp" cx="${o(TW - 3)}" cy="${f(roof + 4)}" r="1"/>`;
    }).join("");

    el.innerHTML = `<svg class="market" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="The underground market: a street of shops under string lights, people strolling by">
        <defs><clipPath id="mk-clip"><rect x="0" y="${ceil}" width="${W}" height="${f(H - ceil)}"/></clipPath></defs>
        ${tunnels}${shops}${street}<g clip-path="url(#mk-clip)">${farWalkers}</g>${front0}${front}<g clip-path="url(#mk-clip)">${nearWalkers}</g>${lights}</svg>`;
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
    fitTimer = setTimeout(() => { document.querySelectorAll(".card").forEach(fitCard); drawClimb(true); drawRopes(); drawLights(); drawRappel(); drawMarket(true); drawBillboard(); }, 40);
    // late layout shifts (fonts, the calendar redrawing) can move the rope's ends, so check again
    clearTimeout(ropeTimer);
    ropeTimer = setTimeout(() => { drawClimb(true); drawRopes(); drawLights(); drawRappel(); drawMarket(true); drawBillboard(); }, 600);
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
  setInterval(() => { if (!document.hidden) { drawClimb(true); drawRopes(true); drawLights(true); drawRappel(true); drawMarket(true); drawBillboard(true); } }, 1500);
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
