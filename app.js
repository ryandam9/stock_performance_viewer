/*
 * app.js — ASX ETF EOD Explorer UI.
 *
 * Browser-only: depends on the DOM, Plotly, sql.js, and the pure helpers in
 * lib.js (exposed as window.ETFLib). Loaded as a classic script so the page
 * still works when opened directly from disk (file://), with no build step.
 */
(function () {
    "use strict";

    const { escapeHtml, detect, num, isoOf, parseDate, fmt, rebaseTo100, periodCutoff, validateDbUrl } = window.ETFLib;

    const $ = (s) => document.querySelector(s);
    const statusEl = $("#status"),
        app = $("#app");
    let SQL = null,
        db = null,
        TABLES = [],
        SCHEMA = {};

    // Sets the status banner. `msg` may contain trusted HTML (e.g. <code>, <b>);
    // callers MUST escapeHtml() any user/DB-derived values before interpolating.
    function setStatus(msg, kind) {
        statusEl.className = "status" + (kind ? " " + kind : "");
        statusEl.innerHTML = (kind ? "" : '<span class="spin"></span>') + "<span>" + msg + "</span>";
    }

    // Small debounce so per-keystroke handlers don't thrash the DOM.
    function debounce(fn, ms) {
        let h;
        return function (...args) {
            clearTimeout(h);
            h = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    const q = (id) => '"' + String(id).replace(/"/g, '""') + '"'; // quote identifier
    const lit = (v) => "'" + String(v).replace(/'/g, "''") + "'"; // quote literal

    function run(sql) {
        const r = db.exec(sql);
        if (!r.length) return { cols: [], rows: [] };
        return { cols: r[0].columns, rows: r[0].values };
    }

    // ---- schema sidebar --------------------------------------------------------
    function buildSchema() {
        TABLES = run(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).rows.map((r) => r[0]);
        SCHEMA = {};
        const host = $("#schema");
        host.innerHTML = "";

        TABLES.forEach((t) => {
            const info = run("PRAGMA table_info(" + q(t) + ")").rows.map((r) => ({
                cid: r[0],
                name: r[1],
                type: r[2],
            }));
            let cnt = 0;
            try {
                cnt = run("SELECT COUNT(*) FROM " + q(t)).rows[0][0];
            } catch (e) {
                /* uncountable view/virtual table — leave at 0 */
            }
            SCHEMA[t] = { cols: info, count: cnt, detect: detect(info) };

            // Build with textContent so table names can never inject markup.
            const item = document.createElement("div");
            item.className = "tbl-item";
            item.dataset.name = String(t).toLowerCase();
            const nameSpan = document.createElement("span");
            nameSpan.className = "name";
            nameSpan.textContent = t;
            const countSpan = document.createElement("span");
            countSpan.className = "count";
            countSpan.textContent = cnt.toLocaleString();
            item.append(nameSpan, countSpan);

            item.onclick = () => {
                const idx = TICKERS.findIndex((tk) => tk.table === t);
                if (idx >= 0) {
                    selectTicker(idx);
                    switchTab("explore");
                }
            };
            host.appendChild(item);
        });

        $("#schemaSearch").oninput = debounce((e) => {
            const val = e.target.value.toLowerCase();
            document.querySelectorAll(".tbl-item").forEach((el) => {
                el.style.display = el.dataset.name.includes(val) ? "flex" : "none";
            });
        }, 120);
    }

    // ---- EXPLORE (ticker-centric, live updating) -------------------------------
    let TICKERS = [],
        curIdx = 0,
        curSeries = null,
        exType = "line",
        period = "MAX";

    // Populates a <select> safely (option text via textContent).
    function fillSel(sel, items, selected) {
        sel.innerHTML = "";
        items.forEach((i) => {
            const opt = document.createElement("option");
            opt.textContent = i;
            if (i === selected) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    // One flat ticker list spanning the whole DB — works for "table per ETF"
    // OR "one table with a symbol column".
    function buildTickerUniverse() {
        TICKERS = [];
        const seen = new Set();

        function add(tk) {
            if (seen.has(tk.label)) return;
            seen.add(tk.label);
            TICKERS.push(tk);
        }

        TABLES.forEach((t) => {
            const d = SCHEMA[t].detect;
            if (!d.date) return; // not a time series

            // Case A: table has multiple symbols in a column.
            if (d.sym) {
                let rows = [];
                const selectCols = d.name ? q(d.sym) + ", MAX(" + q(d.name) + ")" : q(d.sym);
                try {
                    rows = run(
                        "SELECT " +
                            selectCols +
                            " FROM " +
                            q(t) +
                            " WHERE " +
                            q(d.sym) +
                            " IS NOT NULL GROUP BY " +
                            q(d.sym) +
                            " ORDER BY 1",
                    ).rows;
                } catch (e) {
                    /* fall through to single-table handling */
                }
                if (rows.length > 1) {
                    rows.forEach((r) => {
                        const val = String(r[0]);
                        const nameVal = d.name && r[1] ? String(r[1]) : "";
                        add({ label: val, name: nameVal, table: t, symCol: d.sym, symVal: val, det: d });
                    });
                    return;
                }
            }

            // Case B: table is the ticker (e.g. "VAS" table).
            let nameVal = "";
            if (d.name) {
                try {
                    const nameRows = run(
                        "SELECT " + q(d.name) + " FROM " + q(t) + " WHERE " + q(d.name) + " IS NOT NULL LIMIT 1",
                    ).rows;
                    if (nameRows.length && nameRows[0][0]) nameVal = String(nameRows[0][0]);
                } catch (e) {
                    /* no usable name column */
                }
            }
            add({ label: t, name: nameVal, table: t, symCol: null, symVal: null, det: d });
        });

        // Final fallback: nothing looked like a time series — list every table.
        if (!TICKERS.length) {
            TABLES.forEach((t) => {
                add({ label: t, name: "", table: t, symCol: null, symVal: null, det: SCHEMA[t].detect });
            });
        }

        TICKERS.sort((a, b) =>
            String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" }),
        );
    }

    function selectTicker(i) {
        curIdx = i;
        $("#ex_ticker").value = String(i);
        const tk = TICKERS[i],
            names = SCHEMA[tk.table].cols.map((c) => c.name),
            d = tk.det;
        const dateCol = d.date || names[0];
        const valCol = d.close || names[1] || names[0];

        fillSel($("#ex_date"), names, dateCol);
        fillSel($("#ex_val"), names, valCol);

        const cb = $('#ex_type button[data-t="candle"]'),
            can = !!(d.open && d.high && d.low && d.close);
        cb.disabled = !can;
        cb.title = can ? "" : "No OHLC columns detected";
        if (!can && exType === "candle") {
            exType = "line";
            syncType();
        }
        $("#ex_name").textContent = tk.name || "";
        loadSeries(dateCol, valCol);
        renderExplore();
    }

    function loadSeries(dateOverride, valOverride) {
        const tk = TICKERS[curIdx],
            d = tk.det;
        const dateCol = dateOverride || $("#ex_date").value || d.date;
        const valCol = valOverride || $("#ex_val").value || d.close;
        const cols = [
            q(dateCol) + " AS _dt",
            (valCol ? q(valCol) : "NULL") + " AS _val",
            (d.open ? q(d.open) : "NULL") + " AS _o",
            (d.high ? q(d.high) : "NULL") + " AS _h",
            (d.low ? q(d.low) : "NULL") + " AS _l",
            (d.close ? q(d.close) : "NULL") + " AS _c",
            (d.vol ? q(d.vol) : "NULL") + " AS _v",
        ];
        const where = tk.symCol ? " WHERE " + q(tk.symCol) + "=" + lit(tk.symVal) : "";
        let rows = [],
            total = 0,
            skipped = 0;
        try {
            const raw = run(
                "SELECT " + cols.join(",") + " FROM " + q(tk.table) + where + " ORDER BY " + q(dateCol),
            ).rows;
            total = raw.length;
            rows = raw
                .map((v) => {
                    const t = parseDate(v[0]);
                    if (!t) {
                        skipped++;
                        return null;
                    }
                    return {
                        t,
                        iso: isoOf(t),
                        val: num(v[1]),
                        o: num(v[2]),
                        h: num(v[3]),
                        l: num(v[4]),
                        c: num(v[5]),
                        v: num(v[6]),
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.t - b.t);
        } catch (e) {
            console.error("loadSeries error:", e);
            rows = [];
        }
        curSeries = { tk, rows, total, skipped, hasOHLC: !!(d.open && d.high && d.low && d.close) };
    }

    function visibleRows() {
        if (!curSeries || !curSeries.rows || !curSeries.rows.length) return [];
        const rows = curSeries.rows;
        if (period === "CUSTOM") {
            const f = parseDate($("#ex_from").value),
                t = parseDate($("#ex_to").value);
            return rows.filter((r) => (!f || r.t >= f) && (!t || r.t <= t));
        }
        if (period === "MAX") return rows;
        const cut = periodCutoff(period, rows[rows.length - 1].t);
        return cut ? rows.filter((r) => r.t >= cut) : rows;
    }

    function renderExplore() {
        if (!curSeries) return;
        const vis = visibleRows();
        updateHead(vis);
        const statEl = $("#ex_stats");
        const chartEl = $("#chart");

        if (!vis.length) {
            Plotly.purge(chartEl);
            statEl.innerHTML = '<span style="color:var(--down);font-size:12px">No data in this range.</span>';
            return;
        }

        const x = vis.map((r) => r.iso);
        const lay = baseLayout(curSeries.tk.label, exType === "candle");
        let traces;
        if (exType === "candle" && curSeries.hasOHLC) {
            traces = [
                {
                    type: "candlestick",
                    x,
                    open: vis.map((r) => r.o),
                    high: vis.map((r) => r.h),
                    low: vis.map((r) => r.l),
                    close: vis.map((r) => r.c),
                    increasing: { line: { color: getCss("--up", "#3ddc97") }, fillcolor: "rgba(61,220,151,.5)" },
                    decreasing: { line: { color: getCss("--down", "#ff6b6b") }, fillcolor: "rgba(255,107,107,.5)" },
                },
            ];
        } else {
            const ys = vis.map((r) => (r.val != null ? r.val : r.c));
            const clean = ys.filter((n) => n != null);
            if (clean.length) {
                const lo = Math.min(...clean),
                    hi = Math.max(...clean),
                    pad = (hi - lo) * 0.08 || hi * 0.02 || 1;
                lay.yaxis.range = [lo - pad, hi + pad];
            }
            traces = [
                {
                    type: "scatter",
                    mode: "lines",
                    x,
                    y: ys,
                    name: curSeries.tk.label,
                    line: { color: getCss("--accent", "#c6f432"), width: 1.9 },
                    fill: exType === "area" ? "tozeroy" : "none",
                    fillcolor: "rgba(198,244,50,.10)",
                    hovertemplate: "%{x}  ·  %{y}<extra></extra>",
                },
            ];
        }

        try {
            Plotly.react(chartEl, traces, lay, {
                responsive: true,
                displaylogo: false,
                modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
            });
        } catch (e) {
            console.error("Plotly.react error:", e);
            Plotly.newPlot(chartEl, traces, lay, { responsive: true, displaylogo: false });
        }
        setStats(vis);
    }

    function updateHead(vis) {
        const lastEl = $("#ex_last"),
            chgEl = $("#ex_chg");
        const closes = (vis || []).map((r) => (r.c != null ? r.c : r.val)).filter((n) => n != null);
        if (!closes.length) {
            lastEl.textContent = "—";
            chgEl.textContent = "";
            return;
        }
        const first = closes[0],
            last = closes[closes.length - 1];
        lastEl.textContent = fmt(last);
        const abs = last - first,
            pct = first ? (abs / first) * 100 : 0,
            up = abs >= 0;
        chgEl.className = "chg " + (up ? "up" : "down");
        chgEl.textContent = (up ? "▲ +" : "▼ ") + fmt(abs) + "  (" + (up ? "+" : "") + pct.toFixed(2) + "%)";
    }

    // Builds one stat card. `extraClass` is an internal literal, never user input.
    function statCard(k, v, extraClass) {
        const card = document.createElement("div");
        card.className = "st" + (extraClass ? " " + extraClass : "");
        const kEl = document.createElement("span");
        kEl.className = "k";
        kEl.textContent = k;
        const vEl = document.createElement("span");
        vEl.className = "v";
        vEl.textContent = v;
        card.append(kEl, vEl);
        return card;
    }

    function setStats(vis) {
        const highs = vis.map((r) => (r.h != null ? r.h : r.c != null ? r.c : r.val)).filter((n) => n != null);
        const lows = vis.map((r) => (r.l != null ? r.l : r.c != null ? r.c : r.val)).filter((n) => n != null);
        const vols = vis.map((r) => r.v).filter((n) => n != null);
        const host = $("#ex_stats");
        host.innerHTML = "";
        host.appendChild(statCard("Range", vis[0].iso + " → " + vis[vis.length - 1].iso));
        host.appendChild(statCard("Sessions", vis.length));
        if (highs.length) host.appendChild(statCard("High", fmt(Math.max(...highs))));
        if (lows.length) host.appendChild(statCard("Low", fmt(Math.min(...lows))));
        if (vols.length) {
            host.appendChild(
                statCard("Avg volume", Math.round(vols.reduce((a, b) => a + b, 0) / vols.length).toLocaleString()),
            );
        }
        // Surface rows whose dates couldn't be parsed so silent data loss is visible.
        if (curSeries && curSeries.skipped > 0) {
            host.appendChild(
                statCard("Unparsed dates", curSeries.skipped + " of " + curSeries.total + " rows", "st-warn"),
            );
        }
    }

    function syncType() {
        document.querySelectorAll("#ex_type button").forEach((b) => b.classList.toggle("on", b.dataset.t === exType));
    }

    function wireExplore() {
        $("#ex_ticker").onchange = () => selectTicker(+$("#ex_ticker").value);
        $("#ex_date").onchange = () => {
            loadSeries();
            renderExplore();
        };
        $("#ex_val").onchange = () => {
            loadSeries();
            renderExplore();
        };
        document.querySelectorAll("#ex_period button").forEach(
            (b) =>
                (b.onclick = () => {
                    period = b.dataset.p;
                    document.querySelectorAll("#ex_period button").forEach((x) => x.classList.toggle("on", x === b));
                    $("#ex_custom").classList.add("hidden");
                    $("#ex_customToggle").classList.remove("on");
                    renderExplore();
                }),
        );
        $("#ex_customToggle").onclick = () => {
            const c = $("#ex_custom"),
                show = c.classList.contains("hidden");
            c.classList.toggle("hidden", !show);
            $("#ex_customToggle").classList.toggle("on", show);
            if (show) {
                period = "CUSTOM";
                document.querySelectorAll("#ex_period button").forEach((x) => x.classList.remove("on"));
                if (curSeries && curSeries.rows.length) {
                    $("#ex_from").value = curSeries.rows[0].iso;
                    $("#ex_to").value = curSeries.rows[curSeries.rows.length - 1].iso;
                }
                renderExplore();
            }
        };
        $("#ex_from").onchange = () => {
            period = "CUSTOM";
            renderExplore();
        };
        $("#ex_to").onchange = () => {
            period = "CUSTOM";
            renderExplore();
        };
        document.querySelectorAll("#ex_type button").forEach(
            (b) =>
                (b.onclick = () => {
                    if (b.disabled) return;
                    exType = b.dataset.t;
                    syncType();
                    renderExplore();
                }),
        );
    }

    // ---- COMPARE ---------------------------------------------------------------
    // ── custom dropdown (shadcn-style) factory, with keyboard + ARIA support ──
    let _openCDD = null;
    // Close whichever dropdown is open (used by the single document listener).
    document.addEventListener(
        "click",
        (e) => {
            if (_openCDD && !_openCDD.wrap.contains(e.target)) _openCDD.close();
        },
        true,
    );

    function createCDD(wrapId) {
        const wrap = document.getElementById(wrapId);
        const trigger = wrap.querySelector(".cdd-trigger");
        const valEl = wrap.querySelector(".cdd-value");
        const menu = wrap.querySelector(".cdd-menu");
        const multiple = wrap.classList.contains("cdd-multi");
        let items = [],
            sel = multiple ? [] : null,
            onChange = null;

        trigger.setAttribute("aria-expanded", "false");
        if (!menu.id) menu.id = wrapId + "_menu";
        trigger.setAttribute("aria-controls", menu.id);

        function render() {
            menu.innerHTML = "";
            items.forEach((o) => {
                const isSel = multiple ? sel.includes(o.value) : sel === o.value;
                let el;
                if (multiple) {
                    el = document.createElement("label");
                    const cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = isSel;
                    cb.tabIndex = -1;
                    el.appendChild(cb);
                    el.appendChild(document.createTextNode(o.label));
                } else {
                    el = document.createElement("div");
                    el.textContent = o.label;
                }
                el.className = "cdd-option" + (isSel ? " selected" : "");
                el.dataset.value = o.value; // dataset assignment is injection-safe
                el.setAttribute("role", "option");
                el.setAttribute("aria-selected", isSel ? "true" : "false");
                el.tabIndex = -1;
                menu.appendChild(el);
            });
            syncLabel();
        }

        function syncLabel() {
            if (multiple) {
                const n = sel.length;
                valEl.textContent = n ? n + " selected" : "None selected";
                valEl.classList.toggle("placeholder", !n);
            } else {
                const found = items.find((x) => x.value === sel);
                valEl.textContent = found ? found.label : "Select source…";
                valEl.classList.toggle("placeholder", !found);
            }
        }

        function close() {
            wrap.classList.remove("cdd-open");
            trigger.setAttribute("aria-expanded", "false");
            if (_openCDD === api) _openCDD = null;
        }

        function open() {
            if (_openCDD && _openCDD !== api) _openCDD.close();
            wrap.classList.add("cdd-open");
            trigger.setAttribute("aria-expanded", "true");
            _openCDD = api;
        }

        function toggle() {
            if (wrap.classList.contains("cdd-open")) close();
            else open();
        }

        function choose(val) {
            if (multiple) {
                const idx = sel.indexOf(val);
                if (idx >= 0) sel.splice(idx, 1);
                else sel.push(val);
                render();
                if (onChange) onChange(sel);
            } else {
                sel = val;
                render();
                close();
                trigger.focus();
                if (onChange) onChange(val);
            }
        }

        // Roving focus across the visible options.
        function focusOption(dir) {
            const opts = Array.from(menu.querySelectorAll(".cdd-option"));
            if (!opts.length) return;
            const cur = opts.indexOf(document.activeElement);
            let next = cur + dir;
            if (next < 0) next = opts.length - 1;
            if (next >= opts.length) next = 0;
            opts.forEach((o) => o.classList.remove("active"));
            opts[next].classList.add("active");
            opts[next].focus();
        }

        trigger.onclick = (e) => {
            e.stopPropagation();
            toggle();
        };
        trigger.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                open();
                focusOption(1);
            } else if (e.key === "Escape") {
                close();
            }
        });

        menu.onclick = (e) => {
            const opt = e.target.closest(".cdd-option");
            if (opt) choose(opt.dataset.value);
        };
        menu.addEventListener("keydown", (e) => {
            const opt = e.target.closest(".cdd-option");
            if (e.key === "ArrowDown") {
                e.preventDefault();
                focusOption(1);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                focusOption(-1);
            } else if ((e.key === "Enter" || e.key === " ") && opt) {
                e.preventDefault();
                choose(opt.dataset.value);
            } else if (e.key === "Escape") {
                close();
                trigger.focus();
            }
        });

        const api = {
            wrap,
            close,
            setItems: function (opts) {
                items = opts || [];
                if (multiple) sel = [];
                else sel = items.length ? items[0].value : null;
                render();
            },
            getVal: function () {
                return sel;
            },
            setVal: function (v) {
                sel = multiple ? v || [] : v;
                render();
                if (onChange) onChange(sel);
            },
            onChange: function (cb) {
                onChange = cb;
            },
        };
        return api;
    }

    let cmpSrc, cmpSeries;

    function buildCompareSources() {
        const opts = [];
        TABLES.forEach((t) => {
            if (SCHEMA[t].detect.sym) opts.push({ value: "symbols in " + t, label: "symbols in " + t });
        });
        if (TABLES.length > 1) opts.push({ value: "tables", label: "tables (each table = one series)" });

        cmpSrc = createCDD("cmp_src_wrap");
        cmpSrc.setItems(opts);
        cmpSeries = createCDD("cmp_series_wrap");
        cmpSrc.onChange(function (v) {
            fillCompareSeries(v);
        });
        if (opts.length) fillCompareSeries(opts[0].value);
    }

    function fillCompareSeries(srcVal) {
        if (!srcVal) {
            cmpSeries.setItems([]);
            return;
        }
        let vals;
        if (srcVal.startsWith("symbols in ")) {
            const t = srcVal.slice("symbols in ".length),
                col = SCHEMA[t].detect.sym;
            vals = run("SELECT DISTINCT " + q(col) + " FROM " + q(t) + " ORDER BY 1").rows.map((r) => ({
                value: String(r[0]),
                label: String(r[0]),
            }));
        } else {
            vals = TABLES.map((t) => ({ value: t, label: t }));
        }
        cmpSeries.setItems(vals);
        $("#cmp_status").style.display = "none";
    }

    function plotCompare() {
        const v = cmpSrc.getVal();
        if (!v) {
            showCmpStatus("Select a source first.");
            return;
        }
        const norm = $("#cmp_norm").checked;
        const chosen = cmpSeries.getVal();
        if (!chosen || !chosen.length) {
            showCmpStatus("Select at least one series to plot.");
            return;
        }
        $("#cmp_status").style.display = "none";
        const traces = [];
        chosen.forEach(function (name) {
            let rows = [],
                label = name;
            if (v.startsWith("symbols in ")) {
                const t = v.slice("symbols in ".length),
                    d = SCHEMA[t].detect;
                rows = run(
                    "SELECT " +
                        q(d.date) +
                        "," +
                        q(d.close) +
                        " FROM " +
                        q(t) +
                        " WHERE " +
                        q(d.sym) +
                        "=" +
                        lit(name) +
                        " ORDER BY " +
                        q(d.date),
                ).rows;
            } else {
                const d = SCHEMA[name].detect;
                if (!d.date || !d.close) return;
                rows = run(
                    "SELECT " + q(d.date) + "," + q(d.close) + " FROM " + q(name) + " ORDER BY " + q(d.date),
                ).rows;
            }
            let ys = rows.map((r) => +r[1]);
            if (norm) ys = rebaseTo100(ys);
            traces.push({
                type: "scatter",
                mode: "lines",
                name: label,
                x: rows.map((r) => r[0]),
                y: ys,
                line: { width: 1.5 },
            });
        });
        const lay = baseLayout(norm ? "Relative performance (rebased to 100)" : "Closing price overlay", false);
        lay.showlegend = true;
        lay.colorway = ["#c6f432", "#3ddc97", "#ff6b6b", "#ffce5c", "#7aa2ff", "#ff9ad5", "#5ad1d1", "#c89bff"];
        Plotly.newPlot("chartCompare", traces, lay, { responsive: true, displaylogo: false });
    }

    function showCmpStatus(msg) {
        const el = $("#cmp_status");
        el.style.display = "block";
        el.textContent = msg;
    }

    // ---- SQL console -----------------------------------------------------------
    let lastResult = null;
    function runSql() {
        const sql = $("#sql").value.trim();
        if (!sql) return;
        const out = $("#sql_out"),
            meta = $("#sql_meta");
        try {
            const t0 = performance.now();
            const r = run(sql);
            lastResult = r;
            const ms = (performance.now() - t0).toFixed(1);
            if (!r.cols.length) {
                out.innerHTML = '<div style="padding:14px;color:var(--mute)">Query OK · no rows returned.</div>';
                meta.textContent = ms + " ms";
                return;
            }
            const cap = 1000,
                shown = r.rows.slice(0, cap);
            // Column names and cell values come from the DB — escape every one.
            const head = r.cols.map((c) => "<th>" + escapeHtml(c) + "</th>").join("");
            const body = shown
                .map(
                    (row) =>
                        "<tr>" +
                        row
                            .map(
                                (c) =>
                                    "<td>" +
                                    (c === null ? '<span style="color:var(--faint)">NULL</span>' : escapeHtml(c)) +
                                    "</td>",
                            )
                            .join("") +
                        "</tr>",
                )
                .join("");
            out.innerHTML =
                '<table class="res"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table>";
            meta.textContent =
                r.rows.length + " rows · " + ms + " ms" + (r.rows.length > cap ? " (showing first " + cap + ")" : "");
        } catch (e) {
            out.innerHTML = '<div style="padding:14px;color:var(--down)">' + escapeHtml(e.message) + "</div>";
            meta.textContent = "";
        }
    }
    function plotSql() {
        if (!lastResult || lastResult.cols.length < 2) {
            alert("Run a query that returns at least 2 columns (x, y).");
            return;
        }
        const r = lastResult;
        Plotly.newPlot(
            "chartSql",
            [
                {
                    type: "scatter",
                    mode: "lines+markers",
                    x: r.rows.map((v) => v[0]),
                    y: r.rows.map((v) => +v[1]),
                    line: { color: getCss("--accent"), width: 1.6 },
                    marker: { size: 3 },
                },
            ],
            baseLayout(r.cols[1] + " vs " + r.cols[0], false),
            { responsive: true, displaylogo: false },
        );
    }

    // ---- chart styling ---------------------------------------------------------
    function getCss(v, fallback) {
        const val = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        return val || fallback;
    }
    function baseLayout(title, isCandle) {
        return {
            title: {
                text: title,
                font: { family: "Bricolage Grotesque, sans-serif", size: 17, color: getCss("--ink", "#e7efe9") },
                x: 0,
                xanchor: "left",
            },
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
            font: { family: "IBM Plex Mono, monospace", size: 11, color: getCss("--mute", "#7d8f87") },
            margin: { l: 58, r: 18, t: 46, b: 40 },
            xaxis: {
                type: "date",
                gridcolor: "#18211d",
                zeroline: false,
                rangeslider: { visible: isCandle, bgcolor: "#0e1311", thickness: 0.06 },
            },
            yaxis: { gridcolor: "#18211d", zeroline: false },
            legend: { bgcolor: "rgba(0,0,0,0)", font: { size: 11 } },
            hovermode: "x unified",
            hoverlabel: { bgcolor: "#11161a", bordercolor: "#1f2a26" },
        };
    }

    // ---- tabs ------------------------------------------------------------------
    function switchTab(name) {
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
        document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
        if (name === "explore" && $("#chart").children.length) Plotly.Plots.resize($("#chart"));
        if (name === "compare" && $("#chartCompare").children.length) Plotly.Plots.resize($("#chartCompare"));
    }

    // ---- database fetch (with progress + offline cache) ------------------------
    const DB_CACHE = "etf-db-v1";

    async function dbCache() {
        try {
            return typeof caches !== "undefined" ? await caches.open(DB_CACHE) : null;
        } catch (e) {
            return null; // unavailable on file:// or insecure origins
        }
    }

    // Streams the response so we can report download progress for large DBs.
    async function fetchWithProgress(url, onProgress) {
        const resp = await fetch(url, { mode: "cors" });
        if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.statusText);
        const total = +resp.headers.get("content-length") || 0;
        if (!resp.body || !resp.body.getReader) return new Uint8Array(await resp.arrayBuffer());
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress(received, total);
        }
        const out = new Uint8Array(received);
        let pos = 0;
        for (const c of chunks) {
            out.set(c, pos);
            pos += c.length;
        }
        return out;
    }

    async function loadDb() {
        const url = $("#url").value.trim();
        const urlEl = $("#url");
        const valid = validateDbUrl(url);
        if (!valid.ok) {
            urlEl.classList.add("invalid");
            setStatus(escapeHtml(valid.reason), "err");
            return;
        }
        urlEl.classList.remove("invalid");

        app.style.display = "none";
        const fileName = escapeHtml(url.split("/").pop() || url);
        setStatus("Fetching <code>" + fileName + "</code> from S3…");

        let bytes,
            fromCache = false;
        try {
            bytes = await fetchWithProgress(url, (received, total) => {
                const got = (received / 1024).toFixed(0);
                const msg = total
                    ? "Downloading <code>" +
                      fileName +
                      "</code> — " +
                      ((received / total) * 100).toFixed(0) +
                      "% (" +
                      got +
                      " KB)"
                    : "Downloading <code>" + fileName + "</code> — " + got + " KB";
                setStatus(msg);
            });
            const cache = await dbCache();
            if (cache) {
                try {
                    await cache.put(url, new Response(bytes));
                } catch (e) {
                    /* cache write is best-effort */
                }
            }
        } catch (e) {
            // Network failed — fall back to a previously cached copy if we have one.
            const cache = await dbCache();
            const hit = cache && (await cache.match(url));
            if (hit) {
                bytes = new Uint8Array(await hit.arrayBuffer());
                fromCache = true;
            } else {
                const msg = e.message || String(e);
                const cors = /Failed to fetch|NetworkError|CORS|Load failed/i.test(msg);
                setStatus(
                    cors
                        ? "Couldn't read the file — almost certainly <b>CORS</b> (the bucket isn't allowing this page to fetch it). Open the “CORS / fetch error” section at the bottom for the exact fix."
                        : "Failed to load: " + escapeHtml(msg),
                    "err",
                );
                return;
            }
        }

        try {
            if (db) db.close();
            db = new SQL.Database(new Uint8Array(bytes));
            buildSchema();
            if (!TABLES.length) {
                setStatus("Loaded, but found no tables in this database.", "err");
                return;
            }
            buildTickerUniverse();

            // Build the ticker <select> safely via DOM APIs (labels are DB-derived).
            const sel = $("#ex_ticker");
            sel.innerHTML = "";
            TICKERS.forEach((t, i) => {
                const opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = t.label;
                if (t.name) opt.title = t.name;
                sel.appendChild(opt);
            });

            app.style.display = "grid";
            selectTicker(0);
            buildCompareSources();
            const kb = (bytes.byteLength / 1024).toFixed(0);
            const note =
                "Loaded <b>" +
                TABLES.length +
                "</b> table" +
                (TABLES.length > 1 ? "s" : "") +
                " · <b>" +
                TICKERS.length +
                "</b> ticker" +
                (TICKERS.length > 1 ? "s" : "") +
                " · " +
                kb +
                " KB" +
                (fromCache ? " · <b>offline copy</b> (network unavailable)" : "") +
                ".";
            setStatus(note, fromCache ? "warn" : "ok");
        } catch (e) {
            setStatus("Failed to open the database: " + escapeHtml(e.message || String(e)), "err");
        }
    }

    // ---- boot ------------------------------------------------------------------
    document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
    wireExplore();
    $("#load").onclick = loadDb;
    $("#url").addEventListener("keydown", (e) => {
        if (e.key === "Enter") loadDb();
    });
    $("#cmp_plot").onclick = plotCompare;
    $("#sql_run").onclick = runSql;
    $("#sql_plot").onclick = plotSql;
    $("#hideSchema").onclick = () => {
        $("#schemaCard").classList.add("hidden");
        $("#app").classList.add("hide-sidebar");
        $("#showSchema").classList.remove("hidden");
    };
    $("#showSchema").onclick = () => {
        $("#schemaCard").classList.remove("hidden");
        $("#app").classList.remove("hide-sidebar");
        $("#showSchema").classList.add("hidden");
    };

    // ---- dynamic CDN loader: try sources in order until one actually loads -----
    function loadScript(urls) {
        return new Promise((resolve, reject) => {
            let i = 0;
            (function next() {
                if (i >= urls.length) {
                    reject(new Error("all sources failed"));
                    return;
                }
                const url = urls[i++];
                const s = document.createElement("script");
                s.src = url;
                s.async = false;
                s.onload = () => resolve(url);
                s.onerror = () => {
                    s.remove();
                    next();
                };
                document.head.appendChild(s);
            })();
        });
    }

    async function boot() {
        setStatus("Loading chart + SQLite engines…");
        let sqlBase;
        try {
            await loadScript([
                "https://cdn.plot.ly/plotly-2.35.2.min.js",
                "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js",
                "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.2/plotly.min.js",
            ]);
            const sqlUrl = await loadScript([
                "https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/sql-wasm.js",
                "https://unpkg.com/sql.js@1.12.0/dist/sql-wasm.js",
                "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.js",
            ]);
            sqlBase = sqlUrl.replace(/sql-wasm\.js.*$/, ""); // the .wasm lives in this same dir
        } catch (e) {
            setStatus(
                "Couldn't load the chart / SQLite engines from any CDN. If you're seeing this <b>inside the chat preview pane</b>, that sandbox blocks external scripts — download this file and open it in a browser, or host it on S3/CloudFront, where it works normally.",
                "err",
            );
            return;
        }
        if (typeof initSqlJs === "undefined" || typeof Plotly === "undefined") {
            setStatus(
                "The CDN scripts loaded but didn't initialise. Try a hard refresh, or open the file outside the chat preview.",
                "err",
            );
            return;
        }
        try {
            SQL = await initSqlJs({ locateFile: (f) => sqlBase + f });
            loadDb();
        } catch (e) {
            setStatus(
                "Failed to initialise the SQLite WebAssembly module: " + escapeHtml(e.message || String(e)),
                "err",
            );
        }
    }

    boot();
})();
