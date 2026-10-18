// Workout calendar: reads the local cache via /api/v1 and renders a month grid.
(() => {
  "use strict";

  const API = "/api/v1";
  const DISTANCE_CATEGORIES = new Set(["run", "walk", "hike", "cycle", "swim", "row"]);
  const CATEGORY_LABELS = {
    run: "Run", walk: "Walk", hike: "Hike", cycle: "Cycle", swim: "Swim", row: "Row",
    strength: "Strength", hiit: "HIIT", mobility: "Mobility", cardio: "Cardio", sport: "Sport", other: "Other",
  };
  const MAX_CHIPS = 3;

  const $ = (id) => document.getElementById(id);
  const state = { month: startOfMonth(new Date()), workouts: [], selectedId: null };

  // ---- date helpers (local calendar dates as YYYY-MM-DD strings) ----------
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function gridStart(month) { return addDays(month, -((month.getDay() + 6) % 7)); } // Monday-first

  // ---- formatting ---------------------------------------------------------
  function fmtDuration(s) {
    if (s == null) return "—";
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  }
  function fmtKm(m) { return m == null ? "—" : `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`; }
  function fmtPace(sPerKm) {
    if (sPerKm == null) return "—";
    const m = Math.floor(sPerKm / 60), s = Math.round(sPerKm % 60);
    return `${m}:${String(s).padStart(2, "0")} /km`;
  }
  function fmtTime(utc, offsetMin) {
    // Show the time in the workout's own timezone (as recorded on the phone).
    const d = new Date(new Date(utc).getTime() + offsetMin * 60000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  function fmtAgo(utc) {
    const mins = Math.round((Date.now() - new Date(utc).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  const catVar = (c) => `var(--c-${CATEGORY_LABELS[c] ? c : "other"})`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

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

  // ---- data ---------------------------------------------------------------
  async function loadMonth() {
    const start = gridStart(state.month);
    const end = addDays(start, 42);
    const items = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await api(`/workouts?from=${iso(start)}&to=${iso(end)}&sort=start&limit=1000&offset=${offset}`);
      items.push(...page.items);
      if (items.length >= page.total || page.items.length === 0) break;
    }
    state.workouts = items;
    render();
  }

  async function loadStatus() {
    try {
      const s = await api("/status");
      const el = $("sync-status");
      if (s.last_successful_sync) {
        el.textContent = `Last sync ${fmtAgo(s.last_successful_sync)} · ${s.workouts} workouts`;
        el.classList.toggle("stale", Date.now() - new Date(s.last_successful_sync).getTime() > 3 * 86400000);
      } else {
        el.textContent = "No syncs yet";
      }
      $("empty").hidden = s.workouts > 0;
      $("empty-url").textContent = `http://<this-PC-IP>:${location.port || 80}/api/v1/ingest/health-auto-export`;
    } catch (e) {
      $("sync-status").textContent = `Status unavailable: ${e.message}`;
    }
  }

  // ---- rendering ----------------------------------------------------------
  function render() {
    $("month-title").textContent = state.month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    renderSummary();
    renderCalendar();
    renderLegend();
  }

  function monthWorkouts() {
    const prefix = iso(state.month).slice(0, 7);
    return state.workouts.filter((w) => w.local_date.startsWith(prefix));
  }

  function renderSummary() {
    const ws = monthWorkouts();
    const days = new Set(ws.map((w) => w.local_date)).size;
    const time = ws.reduce((a, w) => a + (w.duration_s || 0), 0);
    const kcal = ws.reduce((a, w) => a + (w.active_energy_kcal || 0), 0);
    const byCat = {};
    for (const w of ws) {
      if (DISTANCE_CATEGORIES.has(w.activity.category) && w.distance_m) {
        byCat[w.activity.category] = (byCat[w.activity.category] || 0) + w.distance_m;
      }
    }
    const stats = [
      { label: "Workouts", value: ws.length, sub: `${days} active day${days === 1 ? "" : "s"}` },
      { label: "Time", value: fmtDuration(time), sub: ws.length ? `avg ${fmtDuration(time / ws.length)}` : "" },
      { label: "Active energy", value: `${Math.round(kcal).toLocaleString()} kcal`, sub: "" },
      ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, m]) => ({ label: `${CATEGORY_LABELS[c]} distance`, value: fmtKm(m), sub: "" })),
    ];
    $("summary").innerHTML = stats.map((s) =>
      `<div class="stat"><div class="label">${esc(s.label)}</div><div class="value">${esc(s.value)}</div><div class="sub">${esc(s.sub)}</div></div>`
    ).join("");
  }

  function renderCalendar() {
    const cal = $("calendar");
    const byDate = {};
    for (const w of state.workouts) (byDate[w.local_date] ||= []).push(w);
    const todayIso = iso(new Date());
    const start = gridStart(state.month);
    const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let html = dows.map((d) => `<div class="dow" role="columnheader">${d}</div>`).join("") + `<div class="dow week" role="columnheader">Week</div>`;

    for (let week = 0; week < 6; week++) {
      let weekTime = 0, weekCount = 0;
      for (let dow = 0; dow < 7; dow++) {
        const d = addDays(start, week * 7 + dow);
        const key = iso(d);
        const ws = byDate[key] || [];
        weekCount += ws.length;
        weekTime += ws.reduce((a, w) => a + (w.duration_s || 0), 0);
        const cls = ["day", d.getMonth() !== state.month.getMonth() && "outside", key === todayIso && "today"].filter(Boolean).join(" ");
        const chips = ws.slice(0, MAX_CHIPS).map(chipHtml).join("");
        const more = ws.length > MAX_CHIPS ? `<button class="chip" style="--cat:var(--c-other)" data-date="${key}"><span class="name">+${ws.length - MAX_CHIPS} more</span></button>` : "";
        html += `<div class="${cls}" role="gridcell" aria-label="${d.toDateString()}, ${ws.length} workouts"><span class="day-num">${d.getDate()}</span>${chips}${more}</div>`;
      }
      html += `<div class="week-total">${weekCount ? `<strong>${fmtDuration(weekTime)}</strong>${weekCount} workout${weekCount === 1 ? "" : "s"}` : "—"}</div>`;
    }
    cal.innerHTML = html;
  }

  function chipHtml(w) {
    const meta = DISTANCE_CATEGORIES.has(w.activity.category) && w.distance_m ? fmtKm(w.distance_m) : fmtDuration(w.duration_s);
    const sel = w.id === state.selectedId ? " selected" : "";
    return `<button class="chip${sel}" style="--cat:${catVar(w.activity.category)}" data-id="${w.id}" title="${esc(w.activity.label)} · ${fmtTime(w.start, w.utc_offset_minutes)}">` +
      `<span class="name">${esc(shortLabel(w.activity))}</span><span class="meta">${meta}</span></button>`;
  }

  function shortLabel(activity) {
    // "Outdoor Run" -> "Run"; unknown categories keep their (trimmed) original label.
    if (activity.category !== "other" && activity.category !== "sport") return CATEGORY_LABELS[activity.category];
    return activity.label.replace(/^(Outdoor|Indoor|Traditional|Functional)\s+/i, "");
  }

  function renderLegend() {
    const cats = [...new Set(monthWorkouts().map((w) => w.activity.category))];
    $("legend").innerHTML = cats.map((c) => `<span style="--cat:${catVar(c)}"><i></i>${CATEGORY_LABELS[c] || c}</span>`).join("");
  }

  // ---- detail panel -------------------------------------------------------
  async function showDetail(id) {
    state.selectedId = id;
    renderCalendar();
    const panel = $("detail");
    panel.hidden = false;
    $("detail-body").innerHTML = `<p class="note">Loading…</p>`;
    try {
      const w = await api(`/workouts/${id}`);
      const hasHr = w.metrics_available.heart_rate;
      const hr = hasHr ? await api(`/workouts/${id}/metrics?type=heart_rate`) : null;
      $("detail-body").innerHTML = detailHtml(w, hr?.series.heart_rate?.samples || []);
    } catch (e) {
      $("detail-body").innerHTML = `<p class="note">Could not load workout: ${esc(e.message)}</p>`;
    }
  }

  function detailHtml(w, hrSamples) {
    const d = new Date(`${w.local_date}T12:00:00`);
    const when = `${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${fmtTime(w.start, w.utc_offset_minutes)}–${fmtTime(w.end, w.utc_offset_minutes)}`;
    const cells = [["Duration", fmtDuration(w.duration_s)]];
    if (w.distance_m != null) cells.push(["Distance", fmtKm(w.distance_m)]);
    if (w.avg_pace_s_per_km != null) {
      cells.push(w.activity.category === "cycle" ? ["Avg speed", `${w.avg_speed_kmh.toFixed(1)} km/h`] : ["Avg pace", fmtPace(w.avg_pace_s_per_km)]);
    }
    if (w.active_energy_kcal != null) cells.push(["Active energy", `${Math.round(w.active_energy_kcal)} kcal`]);
    if (w.heart_rate_bpm?.avg != null) cells.push(["Avg HR", `${w.heart_rate_bpm.avg} bpm`]);
    if (w.heart_rate_bpm?.max != null) cells.push(["Max HR", `${w.heart_rate_bpm.max} bpm`]);
    if (w.elevation_up_m != null) cells.push(["Elevation gain", `${Math.round(w.elevation_up_m)} m`]);
    if (w.extra_metrics.intensity) cells.push(["Intensity", `${w.extra_metrics.intensity.value.toFixed(1)} MET`]);
    if (w.extra_metrics.temperature) cells.push(["Temperature", `${Math.round(w.extra_metrics.temperature.value)} °C`]);

    const flags = [];
    if (w.flags.heart_rate_data_was_recovery) flags.push("Heart-rate trace from the export was post-workout recovery data and was filed as recovery.");
    const extras = [];
    if (w.route_points) extras.push(`GPS route: ${w.route_points} points`);
    const series = Object.keys(w.metrics_available).filter((k) => k !== "heart_rate");
    if (series.length) extras.push(`Also recorded: ${series.map((s) => s.replace(/_/g, " ")).join(", ")}`);

    return `<h2 style="--cat:${catVar(w.activity.category)}"><i></i>${esc(w.activity.label)}</h2>
      <div class="when">${esc(when)}${w.location ? ` · ${esc(w.location)}` : ""}</div>
      <dl>${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${hrSamples.length > 1 ? `<h3>Heart rate</h3>${hrChart(hrSamples, w)}` : ""}
      ${extras.map((e) => `<p class="note">${esc(e)}</p>`).join("")}
      ${flags.map((f) => `<p class="flag">${esc(f)}</p>`).join("")}`;
  }

  function hrChart(samples, w) {
    const W = 300, H = 120, P = { l: 28, r: 6, t: 8, b: 18 };
    const t0 = new Date(w.start).getTime(), t1 = Math.max(new Date(w.end).getTime(), t0 + 1);
    const lo = Math.min(...samples.map((s) => s.min ?? s.v)), hi = Math.max(...samples.map((s) => s.max ?? s.v));
    const yMin = Math.floor((lo - 5) / 10) * 10, yMax = Math.ceil((hi + 5) / 10) * 10;
    const x = (t) => P.l + ((new Date(t).getTime() - t0) / (t1 - t0)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - yMin) / (yMax - yMin)) * (H - P.t - P.b);
    const line = samples.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`).join("");
    const hasBand = samples.some((s) => s.min != null && s.max != null);
    const band = hasBand
      ? samples.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s.max ?? s.v).toFixed(1)}`).join("") +
        samples.slice().reverse().map((s) => `L${x(s.t).toFixed(1)},${y(s.min ?? s.v).toFixed(1)}`).join("") + "Z"
      : "";
    const ticks = [yMin, Math.round((yMin + yMax) / 2), yMax];
    const mins = Math.round((t1 - t0) / 60000);
    return `<svg class="hr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Heart rate over the workout, ${lo} to ${hi} bpm">
      ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text x="0" y="${y(v) + 3}">${v}</text>`).join("")}
      ${band ? `<path class="band" d="${band}"/>` : ""}
      <path class="line" d="${line}"/>
      <text x="${P.l}" y="${H - 4}">0</text><text x="${W - P.r}" y="${H - 4}" text-anchor="end">${mins} min</text>
    </svg>`;
  }

  // ---- events -------------------------------------------------------------
  function shiftMonth(n) {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
    loadMonth().catch((e) => toast(e.message));
  }

  $("prev").addEventListener("click", () => shiftMonth(-1));
  $("next").addEventListener("click", () => shiftMonth(1));
  $("today").addEventListener("click", () => { state.month = startOfMonth(new Date()); loadMonth().catch((e) => toast(e.message)); });
  $("detail-close").addEventListener("click", () => { $("detail").hidden = true; state.selectedId = null; renderCalendar(); });

  $("calendar").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    if (chip.dataset.id) showDetail(Number(chip.dataset.id));
    else if (chip.dataset.date) {
      const ws = state.workouts.filter((w) => w.local_date === chip.dataset.date);
      toast(ws.map((w) => `${w.activity.label} ${fmtDuration(w.duration_s)}`).join(" · "));
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "ArrowLeft") shiftMonth(-1);
    else if (e.key === "ArrowRight") shiftMonth(1);
    else if (e.key === "Escape") $("detail-close").click();
  });

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const r = await api("/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const c = r.workouts;
      toast(`Imported ${c.received} workouts: ${c.inserted} new, ${c.updated} updated, ${c.unchanged} unchanged${c.failed ? `, ${c.failed} failed` : ""}`);
      await Promise.all([loadMonth(), loadStatus()]);
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });

  // Refresh while the page is open so new pushes from the phone show up.
  setInterval(() => { if (!document.hidden) { loadStatus(); loadMonth().catch(() => {}); } }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadStatus(); loadMonth().catch(() => {}); } });

  loadStatus();
  loadMonth().catch((e) => toast(e.message));
})();
