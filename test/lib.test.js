import { describe, it, expect } from "vitest";
import lib from "../lib.js";

const { escapeHtml, pick, detect, num, isoOf, parseDate, fmt, rebaseTo100, periodCutoff, validateDbUrl } = lib;

describe("escapeHtml", () => {
    it("escapes the five HTML-significant characters", () => {
        expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
        expect(escapeHtml("a & b")).toBe("a &amp; b");
        expect(escapeHtml("it's")).toBe("it&#39;s");
    });
    it("handles null/undefined as empty string", () => {
        expect(escapeHtml(null)).toBe("");
        expect(escapeHtml(undefined)).toBe("");
    });
    it("coerces numbers", () => {
        expect(escapeHtml(42)).toBe("42");
    });
});

describe("pick / detect", () => {
    const cols = [
        { name: "Date" },
        { name: "Open" },
        { name: "High" },
        { name: "Low" },
        { name: "Adj Close" },
        { name: "Volume" },
    ];
    it("pick returns the first matching column in regex order", () => {
        expect(pick(cols, [/^nope$/i, /^high$/i])).toBe("High");
        expect(pick(cols, [/^nope$/i])).toBe(null);
    });
    it("detect maps standard OHLCV columns", () => {
        const d = detect(cols);
        expect(d.date).toBe("Date");
        expect(d.open).toBe("Open");
        expect(d.high).toBe("High");
        expect(d.low).toBe("Low");
        expect(d.close).toBe("Adj Close"); // adj-close preferred over plain close
        expect(d.vol).toBe("Volume");
    });
    it("detect finds a symbol column when present", () => {
        const d = detect([{ name: "ticker" }, { name: "dt" }, { name: "price" }]);
        expect(d.sym).toBe("ticker");
        expect(d.date).toBe("dt");
        expect(d.close).toBe("price");
    });
});

describe("num", () => {
    it("coerces numeric strings", () => {
        expect(num("12.5")).toBe(12.5);
        expect(num(3)).toBe(3);
    });
    it("returns null for blanks and non-numbers", () => {
        expect(num("")).toBe(null);
        expect(num(null)).toBe(null);
        expect(num(undefined)).toBe(null);
        expect(num("abc")).toBe(null);
    });
});

describe("isoOf", () => {
    it("formats a date as local YYYY-MM-DD", () => {
        expect(isoOf(new Date(2023, 0, 5))).toBe("2023-01-05");
        expect(isoOf(new Date(2023, 11, 31))).toBe("2023-12-31");
    });
});

describe("parseDate", () => {
    it("parses ISO dates", () => {
        expect(isoOf(parseDate("2023-02-09"))).toBe("2023-02-09");
    });
    it("parses DD/MM/YYYY as Australian order", () => {
        // 01/02/2023 -> 1 Feb 2023, NOT 2 Jan.
        expect(isoOf(parseDate("01/02/2023"))).toBe("2023-02-01");
    });
    it("parses epoch seconds and milliseconds", () => {
        expect(parseDate(0)).toBeInstanceOf(Date);
        expect(parseDate("1700000000").getTime()).toBe(1700000000 * 1000);
        expect(parseDate("1700000000000").getTime()).toBe(1700000000000);
    });
    it("returns null for blanks and garbage", () => {
        expect(parseDate("")).toBe(null);
        expect(parseDate(null)).toBe(null);
        expect(parseDate("not-a-date")).toBe(null);
    });
});

describe("fmt", () => {
    it("trims trailing zeros below 1000", () => {
        expect(fmt(12)).toBe("12");
        expect(fmt(12.5)).toBe("12.5");
        expect(fmt(0.123456)).toBe("0.123");
    });
    it("uses thousands separators at/above 1000", () => {
        expect(fmt(1234.5)).toBe("1,234.5");
    });
});

describe("rebaseTo100", () => {
    it("rebases so the first value is 100", () => {
        expect(rebaseTo100([50, 75, 100])).toEqual([100, 150, 200]);
    });
    it("leaves the series untouched when empty or base is zero", () => {
        expect(rebaseTo100([])).toEqual([]);
        expect(rebaseTo100([0, 5, 10])).toEqual([0, 5, 10]);
    });
});

describe("periodCutoff", () => {
    const maxT = new Date(2023, 5, 15); // 15 Jun 2023
    it("returns null for MAX / CUSTOM", () => {
        expect(periodCutoff("MAX", maxT)).toBe(null);
        expect(periodCutoff("CUSTOM", maxT)).toBe(null);
    });
    it("computes YTD as Jan 1 of the latest year", () => {
        expect(isoOf(periodCutoff("YTD", maxT))).toBe("2023-01-01");
    });
    it("subtracts the right span for relative periods", () => {
        expect(isoOf(periodCutoff("1M", maxT))).toBe("2023-05-15");
        expect(isoOf(periodCutoff("3M", maxT))).toBe("2023-03-15");
        expect(isoOf(periodCutoff("1Y", maxT))).toBe("2022-06-15");
    });
});

describe("validateDbUrl", () => {
    it("accepts http(s) URLs", () => {
        expect(validateDbUrl("https://example.com/stocks.db").ok).toBe(true);
        expect(validateDbUrl("http://localhost:8000/a.db").ok).toBe(true);
    });
    it("rejects blanks, non-URLs and non-http schemes", () => {
        expect(validateDbUrl("").ok).toBe(false);
        expect(validateDbUrl("   ").ok).toBe(false);
        expect(validateDbUrl("not a url").ok).toBe(false);
        expect(validateDbUrl("ftp://example.com/a.db").ok).toBe(false);
        expect(validateDbUrl("file:///etc/passwd").ok).toBe(false);
    });
});
