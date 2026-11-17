/* Forkcast by Ainex — OpenStreetMap edition (free, no API key) */
(() => {
  "use strict";

  const CFG = window.FORKCAST_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const state = {
    map: null, markerLayer: null, markerById: {}, userMarker: null,
    places: [], center: null, lastFetchPos: null, lastFetchAt: 0,
    watchId: null, live: false, token: 0, selectedId: null,
    sort: "best", cat: "all", openNow: false,
    radius: CFG.DEFAULT_RADIUS_M || 1500
  };

  /* ---------------- Helpers ---------------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const isMobile = () => matchMedia("(max-width: 820px)").matches;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const titleCase = (s) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const joinNice = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

  function distance(a, b) {
    const R = 6371000, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

  function setStatus(kind, text) {
    const el = $("#status");
    el.dataset.state = kind;
    el.textContent = text;
  }

  /* ---------------- Place types ---------------- */
  const TYPE_LABEL = { restaurant: "Restaurant", fast_food: "Fast food", cafe: "Café", food_court: "Food court", bar: "Bar", pub: "Pub" };
  const TYPE_ICON = { restaurant: "i-fork", fast_food: "i-burger", food_court: "i-burger", cafe: "i-cup", bar: "i-glass", pub: "i-glass" };
  const TYPE_WEIGHT = { restaurant: 1, cafe: 0.8, bar: 0.6, pub: 0.6, food_court: 0.6, fast_food: 0.5 };
  const BUDGET_WEIGHT = { fast_food: 1, food_court: 1, cafe: 0.6, restaurant: 0.4, pub: 0.3, bar: 0.3 };
  const FOOD = ["restaurant", "fast_food", "cafe", "food_court"];

  const CATEGORIES = {
    all: (p) => FOOD.includes(p.amenity),
    filipino: (p) => /filipino/.test(p.cuisine),
    cafe: (p) => p.amenity === "cafe",
    fast_food: (p) => p.amenity === "fast_food" || p.amenity === "food_court",
    japanese: (p) => /japanese|sushi|ramen/.test(p.cuisine),
    korean: (p) => /korean/.test(p.cuisine),
    chinese: (p) => /chinese|dim_sum/.test(p.cuisine),
    pizza: (p) => /pizza/.test(p.cuisine),
    seafood: (p) => /seafood|fish/.test(p.cuisine),
    bar: (p) => p.amenity === "bar" || p.amenity === "pub"
  };

  /* ---------------- Opening hours (common OSM formats) ---------------- */
  const DAY_CODES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  function parseDays(part) {
    const days = new Set();
    for (const token of part.split(",")) {
      if (token === "PH") continue;
      const [a, b] = token.split("-");
      const i = DAY_CODES.indexOf(a);
      if (i < 0) return null;
      if (!b) { days.add(i); continue; }
      const j = DAY_CODES.indexOf(b);
      if (j < 0) return null;
      for (let k = i; ; k = (k + 1) % 7) { days.add(k); if (k === j) break; }
    }
    return days;
  }

  function parseTimes(part) {
    const ranges = [];
    for (const token of part.split(",")) {
      const m = token.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/);
      if (!m) return null;
      ranges.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
    }
    return ranges;
  }

  // Returns true (open), false (closed) or undefined (unknown / too complex)
  function isOpenNow(oh, now = new Date()) {
    if (!oh) return undefined;
    oh = oh.trim();
    if (oh === "24/7") return true;
    const today = (now.getDay() + 6) % 7;      // Monday = 0
    const yesterday = (today + 6) % 7;
    const mins = now.getHours() * 60 + now.getMinutes();
    let todayState, carryOver = false;

    for (const raw of oh.split(";")) {
      const rule = raw.trim();
      if (!rule) continue;
      const m = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su|PH))*)?\s*(.*)$/);
      if (!m) return undefined;
      const days = m[1] ? parseDays(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
      if (!days) return undefined;
      const timePart = (m[2] || "").trim();

      if (/^(off|closed)$/i.test(timePart)) {
        if (days.has(today)) todayState = false;
        continue;
      }
      const ranges = parseTimes(timePart);
      if (!ranges) return undefined;

      if (days.has(today)) {
        todayState = ranges.some(([s, e]) => (e > s ? mins >= s && mins < e : mins >= s));
      }
      if (days.has(yesterday) && ranges.some(([s, e]) => e <= s && mins < e)) carryOver = true;
    }
    return Boolean(todayState) || carryOver;
  }

  /* ---------------- OpenStreetMap data ---------------- */
  function buildQuery(c, r) {
    return `[out:json][timeout:10];
nwr["amenity"~"^(restaurant|fast_food|cafe|food_court|bar|pub)$"]["name"](around:${Math.round(r)},${c.lat.toFixed(6)},${c.lng.toFixed(6)});
out center 250;`;
  }

  async function fetchOverpass(query) {
    const servers = CFG.OVERPASS_ENDPOINTS || [];
    let lastErr;
    for (let i = 0; i < servers.length; i++) {
      const url = servers[i];
      if (i > 0) setStatus("loading", `Server busy, trying backup ${i} of ${servers.length - 1}…`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 12000);
      try {
        const res = await fetch(`${url}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Server replied ${res.status}`);
        const json = await res.json();
        if (!Array.isArray(json.elements)) throw new Error("Unexpected response");
        return json;
      } catch (e) {
        lastErr = e;
        console.warn("Overpass server failed, trying next:", url, e);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error("No Overpass servers configured");
  }
  function toItem(el) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null || !t.name) return null;

    const cuisine = (t.cuisine || "").toLowerCase();
    const website = t.website || t["contact:website"] || "";
    const phone = t.phone || t["contact:phone"] || "";
    const addr = [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), t["addr:city"]]
      .filter(Boolean).join(", ");

    const features = [];
    if (t.outdoor_seating === "yes") features.push("Outdoor seating");
    if (t.air_conditioning === "yes") features.push("Air-conditioned");
    if (/^(yes|wlan|wifi)$/.test(t.internet_access || "")) features.push("Free Wi-Fi");
    if (/^(yes|only)$/.test(t["diet:vegetarian"] || "")) features.push("Vegetarian options");
    if (t.wheelchair === "yes") features.push("Wheelchair accessible");
    if (t.delivery === "yes") features.push("Delivery");

    let vibe = { restaurant: 0.55, cafe: 0.6, bar: 0.6, pub: 0.55, food_court: 0.3, fast_food: 0.25 }[t.amenity] ?? 0.4;
    if (t.outdoor_seating === "yes") vibe += 0.15;
    if (t.air_conditioning === "yes") vibe += 0.1;
    if (features.includes("Free Wi-Fi")) vibe += 0.05;
    if (t.smoking === "no") vibe += 0.05;
    if (website) vibe += 0.05;
    if (t.brand) vibe -= 0.05;

    return {
      id: `${el.type}/${el.id}`,
      osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      name: t.name,
      amenity: t.amenity,
      cuisine,
      cuisineLabel: cuisine ? cuisine.split(";").slice(0, 2).map((c) => titleCase(c.trim())).join(" · ") : "",
      loc: { lat, lng },
      open: isOpenNow(t.opening_hours),
      website, phone, addr, features,
      complete: [t.opening_hours, website, phone, t.cuisine, addr].filter(Boolean).length / 5,
      vibe: clamp(vibe, 0, 1)
    };
  }

  /* ---------------- Scoring & sorting ---------------- */
  function rescore() {
    const ref = state.center || state.lastFetchPos;
    state.places.forEach((p) => {
      p.dist = ref ? distance(ref, p.loc) : 0;
      const near = clamp(1 - p.dist / state.radius, 0, 1);
      const openAdj = p.open === true ? 0.1 : p.open === false ? -0.3 : 0;
      p.score = 0.3 * (TYPE_WEIGHT[p.amenity] ?? 0.5) + 0.3 * p.complete + 0.4 * near + openAdj;
      p.budget = 0.7 * (BUDGET_WEIGHT[p.amenity] ?? 0.4) + 0.3 * near;
      p.match = Math.round(clamp(p.score, 0, 1) * 100);
    });
  }

  const SORTS = {
    best: (a, b) => b.score - a.score,
    budget: (a, b) => b.budget - a.budget,
    vibe: (a, b) => b.vibe - a.vibe || a.dist - b.dist,
    near: (a, b) => a.dist - b.dist
  };

  const PICK_LABEL = { best: "Forkcast pick", budget: "Budget-friendly pick", vibe: "Best vibe", near: "Closest to you" };

  function explain(p) {
    const type = (TYPE_LABEL[p.amenity] || "Place").toLowerCase();
    const what = p.cuisineLabel ? `A ${type} serving ${p.cuisineLabel.replace(" · ", " and ")} food` : `A ${type}`;
    const bits = [`${fmtDist(p.dist)} away`];
    if (p.open === true) bits.push("open right now");
    if (p.features.length) bits.push(`with ${joinNice(p.features.slice(0, 2).map((f) => f.toLowerCase()))}`);
    if (state.sort === "budget" && (BUDGET_WEIGHT[p.amenity] ?? 0) >= 0.9) bits.push("usually easy on the wallet");
    return `${what}, ${joinNice(bits)}.`;
  }

  /* ---------------- Map ---------------- */
  function initMap() {
    if (!window.L) throw new Error("The map library didn't load. Check your internet connection.");
    const c = CFG.FALLBACK_CENTER;
    state.map = L.map("map", { zoomControl: false }).setView([c.lat, c.lng], 15);
    L.control.zoom({ position: "topright" }).addTo(state.map);
    L.tileLayer(CFG.TILE_URL, { maxZoom: 19, attribution: CFG.TILE_ATTRIBUTION }).addTo(state.map);
    state.map.attributionControl.setPrefix(false);
    state.markerLayer = L.layerGroup().addTo(state.map);
    state.map.on("dragend", () => { $("#searchArea").hidden = false; });
  }

  function placeUserMarker(pos) {
    if (!state.userMarker) {
      state.userMarker = L.marker([pos.lat, pos.lng], {
        icon: L.divIcon({ className: "fc-marker", html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false, zIndexOffset: 2000
      }).addTo(state.map);
    } else {
      state.userMarker.setLatLng([pos.lat, pos.lng]);
    }
  }

  function renderMarkers(items) {
    state.markerLayer.clearLayers();
    state.markerById = {};
    items.forEach((p, i) => {
      const cls = "pin" + (i === 0 ? " top" : "") + (p.id === state.selectedId ? " active" : "");
      const marker = L.marker([p.loc.lat, p.loc.lng], {
        icon: L.divIcon({ className: "fc-marker", html: `<div class="${cls}">${i + 1}</div>`, iconSize: [30, 37], iconAnchor: [15, 37] }),
        title: p.name, keyboard: false, zIndexOffset: 1000 - i
      });
      marker.on("click", () => select(p.id, true));
      marker.addTo(state.markerLayer);
      state.markerById[p.id] = marker;
    });
  }

  function fitToResults(items) {
    const top = items.slice(0, 8);
    if (!top.length) return;
    const pts = top.map((p) => [p.loc.lat, p.loc.lng]);
    if (state.center) pts.push([state.center.lat, state.center.lng]);
    state.map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [30, 40],
      paddingBottomRight: [30, isMobile() ? Math.round(window.innerHeight * 0.52) : 40],
      maxZoom: 17
    });
  }

  /* ---------------- Search ---------------- */
  function visibleItems() {
    const match = CATEGORIES[state.cat] || CATEGORIES.all;
    return state.places
      .filter((p) => match(p) && (!state.openNow || p.open === true))
      .sort(SORTS[state.sort])
      .slice(0, CFG.MAX_RESULTS || 40);
  }

  async function search(center, fit) {
    if (state.inflight) state.inflight.abort();   // cancel any older search first
    const inflight = new AbortController();
    state.inflight = inflight;
    state.lastFetchPos = center;
    state.lastFetchAt = Date.now();
    $("#searchArea").hidden = true;
    setStatus("loading", "Scanning food spots nearby…");
    showSkeleton();

    let data;
    try {
      data = await fetchOverpass(buildQuery(center, state.radius), inflight.signal);
    } catch (e) {
      if (inflight.signal.aborted) return;        // replaced by a newer search
      state.inflight = null;
      console.error("All Overpass servers failed:", e);
      setStatus("error", "Couldn't reach the free map data servers.");
      $("#searchArea").hidden = false;
      $("#list").innerHTML = emptyHTML("Couldn't load places", "Check your internet connection, wait a minute, then tap Search this area.");
      return;
    }
    if (inflight.signal.aborted) return;
    state.inflight = null;

    const seen = new Set();
    state.places = (data.elements || [])
      .map(toItem)
      .filter((p) => p && !seen.has(p.id) && seen.add(p.id));

    rescore();
    const items = render();
    if (fit) fitToResults(items);

    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setStatus(state.live ? "live" : "idle",
      `${state.live ? "Live · " : ""}${state.places.length} spots within ${fmtDist(state.radius)} · updated ${time}`);
  }

  /* ---------------- Live location ---------------- */
  function startLive() {
    if (!state.map) return;
    if (!("geolocation" in navigator)) { setStatus("error", "Location isn't supported in this browser."); return; }
    state.live = true;
    updateLiveButton();
    setStatus("loading", "Finding your location…");
    state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true, maximumAge: 10000, timeout: 20000
    });
  }

  function stopLive(showMessage = true) {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    state.live = false;
    updateLiveButton();
    if (showMessage) setStatus("idle", "Paused. Your last results are still shown.");
  }

  function updateLiveButton() {
    const b = $("#liveToggle");
    b.setAttribute("aria-pressed", String(state.live));
    b.querySelector(".live-label").textContent = state.live ? "Live" : "Go live";
  }

  function onPosition(pos) {
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const first = !state.center;
    state.center = here;
    placeUserMarker(here);

    // Laptops estimate location from Wi-Fi and it "jumps"; ignore jumps smaller than the accuracy
    const minMove = Math.max(CFG.REFRESH_DISTANCE_M, pos.coords.accuracy || 0);
    const moved = state.lastFetchPos ? distance(here, state.lastFetchPos) : Infinity;
    const waited = Date.now() - state.lastFetchAt;

    if (first) {
      state.map.setView([here.lat, here.lng], 16);
      search(here, true);
    } else if (moved >= minMove && waited >= CFG.MIN_REFRESH_MS && !state.inflight) {
      state.map.panTo([here.lat, here.lng]);
      search(here, false);
    } else if (state.places.length) {
      rescore();
      render();
    }
  }

  function onGeoError(err) {
    if (err.code === 1) {
      stopLive(false);
      setStatus("error", "Location access was blocked. Showing a default area. Allow location for live picks.");
    } else {
      setStatus("error", "Couldn't get your location yet. Still trying…");
    }
    if (err.code === 1 && !state.lastFetchPos) {
      const c = CFG.FALLBACK_CENTER;
      state.map.setView([c.lat, c.lng], 15);
      search(c, true);
    }
  }

  /* ---------------- Rendering ---------------- */
  function emptyHTML(title, text) {
    return `<li class="empty">${icon("i-fork", "i lg")}<h3>${esc(title)}</h3><p>${esc(text)}</p></li>`;
  }

  function showSkeleton() {
    $("#aiPick").hidden = true;
    $("#list").innerHTML = Array.from({ length: 5 }, () => `
      <li class="card skeleton"><div class="thumb"></div>
        <div><div class="line w80"></div><div class="line w60"></div><div class="line w40"></div></div>
      </li>`).join("");
  }

  function cardHTML(p, i) {
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${p.loc.lat},${p.loc.lng}`;
    const tags = [];
    if ((BUDGET_WEIGHT[p.amenity] ?? 0) >= 0.9) tags.push("Budget-friendly");
    tags.push(...p.features);
    const openTag = p.open === true ? `<span class="open">Open now</span>`
      : p.open === false ? `<span class="closed">Closed</span>`
      : `<span class="hint">Hours not listed</span>`;

    return `
      <li class="card${p.id === state.selectedId ? " active" : ""}" data-id="${esc(p.id)}" tabindex="0">
        <div class="thumb cat-${esc(p.amenity)}">${icon(TYPE_ICON[p.amenity] || "i-fork", "i lg")}<span class="rank">#${i + 1}</span></div>
        <div class="card-body">
          <div class="card-top">
            <h3 title="${esc(p.name)}">${esc(p.name)}</h3>
            <span class="match" title="Forkcast score">${p.match}</span>
          </div>
          <div class="meta">
            <span>${esc(TYPE_LABEL[p.amenity] || "Place")}</span>
            ${p.cuisineLabel ? `<span>· ${esc(p.cuisineLabel)}</span>` : ""}
          </div>
          <div class="meta">${openTag}<span>${icon("i-pin")}${fmtDist(p.dist)}</span></div>
          ${tags.length ? `<div class="tags">${tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
          <div class="actions">
            <a class="btn primary" href="${dir}" target="_blank" rel="noopener">${icon("i-nav")}Directions</a>
            ${p.phone ? `<a class="btn ghost" href="tel:${esc(p.phone.split(";")[0].replace(/\s+/g, ""))}">${icon("i-phone")}Call</a>` : ""}
            <a class="btn ghost" href="${esc(p.website || p.osmUrl)}" target="_blank" rel="noopener">${icon("i-external")}${p.website ? "Website" : "Details"}</a>
          </div>
        </div>
      </li>`;
  }

  function renderPick(p) {
    const box = $("#aiPick");
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `
      <span class="label">${icon("i-sparkle")}${PICK_LABEL[state.sort]}</span>
      <h2>${esc(p.name)}</h2>
      <p>${esc(explain(p))}</p>
      <button class="link" data-id="${esc(p.id)}">Show on map ${icon("i-chevron")}</button>`;
  }

  function render() {
    const items = visibleItems();
    renderPick(items[0]);
    if (!items.length) {
      $("#list").innerHTML = state.places.length
        ? emptyHTML("No matches", "Nothing fits these filters here. Try another category, turn off Open now, or widen the radius.")
        : emptyHTML("No food spots found", "OpenStreetMap has no places listed here yet. Try a bigger radius.");
      renderMarkers([]);
      return items;
    }
    $("#list").innerHTML = items.map(cardHTML).join("");
    renderMarkers(items);
    return items;
  }

  function select(id, fromMap) {
    state.selectedId = id;
    $$(".card").forEach((c) => c.classList.toggle("active", c.dataset.id === id));
    Object.entries(state.markerById).forEach(([mid, m]) => {
      m.getElement()?.querySelector(".pin")?.classList.toggle("active", mid === id);
    });
    const p = state.places.find((x) => x.id === id);
    if (!p) return;
    state.map.setView([p.loc.lat, p.loc.lng], Math.max(state.map.getZoom(), 16), { animate: true });
    if (fromMap) {
      document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  /* ---------------- UI wiring ---------------- */
  function bindUI() {
    $("#liveToggle").addEventListener("click", () => (state.live ? stopLive() : startLive()));

    $("#sortTabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-sort]");
      if (!b) return;
      state.sort = b.dataset.sort;
      $$("#sortTabs button").forEach((x) => x.classList.toggle("active", x === b));
      if (state.places.length) render();
    });

    $("#typeChips").addEventListener("click", (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      state.cat = b.dataset.cat;
      $$(".chip").forEach((x) => x.classList.toggle("active", x === b));
      if (state.places.length) render(); // filters locally, no new download
    });

    $("#openNow").addEventListener("change", (e) => {
      state.openNow = e.target.checked;
      if (state.places.length) render();
    });

    const r = $("#radius");
    r.value = state.radius;
    $("#radiusOut").textContent = fmtDist(state.radius);
    r.addEventListener("input", () => { $("#radiusOut").textContent = fmtDist(+r.value); });
    r.addEventListener("change", () => {
      state.radius = +r.value;
      const c = state.lastFetchPos || state.center;
      if (c) search(c, true);
    });

    $("#list").addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const c = e.target.closest(".card:not(.skeleton)");
      if (c) select(c.dataset.id);
    });
    $("#list").addEventListener("keydown", (e) => {
      const c = e.target.closest(".card");
      if (c && e.key === "Enter") select(c.dataset.id);
    });

    $("#aiPick").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (b) select(b.dataset.id, true);
    });

    $("#searchArea").addEventListener("click", () => {
      const c = state.map.getCenter();
      search({ lat: c.lat, lng: c.lng }, false);
    });

    $("#recenter").addEventListener("click", () => {
      if (!state.map) return;
      if (state.center) state.map.setView([state.center.lat, state.center.lng], 15);
      else startLive();
    });

    $("#sheetHandle").addEventListener("click", () => $("#panel").classList.toggle("expanded"));
  }

  function boot() {
    bindUI();
    try {
      initMap();
      setStatus("idle", "Ready. Tap Go live to find great food around you.");
    } catch (e) {
      setStatus("error", e.message);
    }
  }

  boot();
})();