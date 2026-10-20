import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { validateQuote } from "../contract.mjs";

const require = createRequire(import.meta.url);
const [quote] = require("../quotes.json");

test("accepts the complete contract and optional episode metadata", () => {
  assert.ok(validateQuote(quote));
  const minimal = structuredClone(quote);
  delete minimal.attribution.season;
  delete minimal.attribution.episode;
  assert.ok(validateQuote(minimal));
  assert.ok(validateQuote({ ...quote, text: "я".repeat(500) }));
});

test("rejects missing keys, extra keys, wrong versions and oversized text", () => {
  for (const key of Object.keys(quote)) {
    const missing = structuredClone(quote);
    delete missing[key];
    assert.equal(validateQuote(missing), false, key);
  }
  const invalid = [
    null,
    [],
    "quote",
    1,
    {},
    { ...quote, schemaVersion: "1" },
    { ...quote, schemaVersion: 2 },
    { ...quote, language: "en" },
    { ...quote, id: "" },
    { ...quote, id: "bad id" },
    { ...quote, id: "x".repeat(81) },
    { ...quote, text: "" },
    { ...quote, text: " " },
    { ...quote, text: " leading" },
    { ...quote, text: "line\nbreak" },
    { ...quote, text: "x".repeat(501) },
    { ...quote, extra: true },
    { ...quote, [Symbol("extra")]: true },
    Object.create(quote),
  ];
  for (const value of invalid) assert.equal(validateQuote(value), false);
});

test("rejects invalid attribution and non-HTTPS or credentialed source URLs", () => {
  for (const key of ["speaker", "work", "sourceUrl"]) {
    const missing = structuredClone(quote);
    delete missing.attribution[key];
    assert.equal(validateQuote(missing), false, key);
  }
  const invalid = [
    null,
    [],
    {},
    { ...quote.attribution, speaker: "" },
    { ...quote.attribution, work: 7 },
    { ...quote.attribution, speaker: "x".repeat(121) },
    { ...quote.attribution, extra: "unexpected" },
    { ...quote.attribution, season: 0 },
    { ...quote.attribution, episode: -1 },
    { ...quote.attribution, season: 1.5 },
    { ...quote.attribution, episode: "12" },
    { ...quote.attribution, episode: undefined },
  ];
  for (const sourceUrl of [
    "http://example.com",
    "javascript:alert(1)",
    "https://",
    "/relative",
    "https://user:password@example.com",
    " https://example.com",
    "https://example.com\n",
  ]) {
    invalid.push({ ...quote.attribution, sourceUrl });
  }
  for (const attribution of invalid) {
    assert.equal(validateQuote({ ...quote, attribution }), false);
  }
});
