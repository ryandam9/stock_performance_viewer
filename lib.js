/*
 * lib.js — pure, side-effect-free helpers shared by the browser app and the
 * Node test suite.
 *
 * Loadable two ways with NO build step:
 *   - Browser: <script src="lib.js"></script>  ->  window.ETFLib
 *   - Node/Vitest: const lib = require("./lib.js")
 *
 * Keep this file free of DOM / SQL / network access so it stays unit-testable.
 */
(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api; // Node / Vitest
    root.ETFLib = api; // Browser global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // ---- HTML escaping (XSS defence) ------------------------------------------
    const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    // Escapes the five HTML-significant characters. Safe for both element text
    // and double/single-quoted attribute values.
    function escapeHtml(value) {
        if (value === null || value === undefined) return "";
        return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    }

    // ---- column auto-detection ------------------------------------------------
    // Returns the name of the first column whose name matches any regex, in order.
    function pick(cols, regexes) {
        for (const re of regexes) {
            const m = cols.find((c) => re.test(c.name));
            if (m) return m.name;
        }
        return null;
    }
    // Maps a list of {name} columns to detected roles (date/open/high/.../symbol).
    function detect(cols) {
        return {
            date: pick(cols, [/^date$/i, /datetime/i, /timestamp/i, /date/i, /^dt$/i, /time/i, /day/i]),
            open: pick(cols, [/^open$/i, /\bopen\b/i, /^o$/i]),
            high: pick(cols, [/^high$/i, /\bhigh\b/i, /^h$/i]),
            low: pick(cols, [/^low$/i, /\blow\b/i, /^l$/i]),
            close: pick(cols, [/adj.?close/i, /^close$/i, /\bclose\b/i, /^price$/i, /\blast\b/i, /^c$/i]),
            vol: pick(cols, [/volume/i, /^vol$/i, /qty/i]),
            sym: pick(cols, [/symbol/i, /ticker/i, /^code$/i, /\basx\b/i, /security/i, /instrument/i]),
            name: pick(cols, [/^name$/i, /^desc$/i, /description/i, /company/i, /title/i, /fullname/i]),
        };
    }

    // ---- numeric / date coercion ----------------------------------------------
    // Coerces to a finite number, or null for blanks / non-numeric input.
    function num(x) {
        if (x === null || x === undefined || x === "") return null;
        return isNaN(+x) ? null : +x;
    }
    // Formats a Date as a local-time YYYY-MM-DD string.
    function isoOf(d) {
        return (
            d.getFullYear() +
            "-" +
            String(d.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(d.getDate()).padStart(2, "0")
        );
    }
    // Best-effort date parser. Accepts ISO, DD/MM/YYYY (Australian), and epoch
    // seconds / milliseconds. Returns a Date, or null if unrecognised.
    function parseDate(v) {
        if (v === null || v === undefined || v === "") return null;
        if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
        const s = String(v).trim();
        if (/^\d{10}$/.test(s)) return new Date(+s * 1000);
        if (/^\d{13}$/.test(s)) return new Date(+s);
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return new Date(+m[3], +m[2] - 1, +m[1]); // DD/MM/YYYY (AU)
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }

    // ---- display formatting ----------------------------------------------------
    // Human-friendly number: thousands separators above 1000, trimmed decimals below.
    function fmt(n) {
        return Math.abs(n) >= 1000
            ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : (+n).toFixed(3).replace(/\.?0+$/, "");
    }

    // ---- compare-tab maths -----------------------------------------------------
    // Rebases a series so its first value becomes 100 (relative performance).
    // Leaves the series untouched if empty or the base value is zero/falsy.
    function rebaseTo100(ys) {
        if (!ys || !ys.length || !ys[0]) return ys || [];
        const base = ys[0];
        return ys.map((y) => (y / base) * 100);
    }

    // ---- explore-tab period filtering -----------------------------------------
    // Returns the inclusive lower-bound Date for a named period relative to the
    // latest sample, or null for "MAX"/"CUSTOM" (no cutoff applied here).
    function periodCutoff(period, maxT) {
        if (!maxT || period === "MAX" || period === "CUSTOM") return null;
        if (period === "YTD") return new Date(maxT.getFullYear(), 0, 1);
        const cut = new Date(maxT);
        if (period === "1M") cut.setMonth(cut.getMonth() - 1);
        else if (period === "3M") cut.setMonth(cut.getMonth() - 3);
        else if (period === "6M") cut.setMonth(cut.getMonth() - 6);
        else if (period === "1Y") cut.setFullYear(cut.getFullYear() - 1);
        else return null;
        return cut;
    }

    // ---- input validation ------------------------------------------------------
    // Validates a user-supplied database URL. Returns { ok, reason }.
    function validateDbUrl(url) {
        if (!url || !String(url).trim()) return { ok: false, reason: "Enter a database URL." };
        let u;
        try {
            u = new URL(String(url).trim());
        } catch (e) {
            return { ok: false, reason: "That doesn't look like a valid URL." };
        }
        if (!/^https?:$/.test(u.protocol)) {
            return { ok: false, reason: "URL must start with http:// or https://" };
        }
        return { ok: true };
    }

    return {
        escapeHtml,
        pick,
        detect,
        num,
        isoOf,
        parseDate,
        fmt,
        rebaseTo100,
        periodCutoff,
        validateDbUrl,
    };
});
