import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { test } from "node:test";
import { validateQuote } from "../contract.mjs";

const require = createRequire(import.meta.url);
const { handler } = require("../index.js");
const quotes = require("../quotes.json");

test("catalogue contains distinct short quotations and preserves Kaneki", () => {
  assert.ok(quotes.length >= 3);
  assert.equal(new Set(quotes.map((quote) => quote.id)).size, quotes.length);
  for (const quote of quotes) {
    assert.ok(validateQuote(quote));
    assert.ok(quote.text.split(/\s+/u).length <= 15);
  }
  assert.equal(quotes[0].text, "Сколько будет тысяча минус семь?");
  assert.equal(quotes[0].attribution.speaker, "Кэн Канеки");
  assert.equal(quotes[0].attribution.season, 1);
  assert.equal(quotes[0].attribution.episode, 12);
});

test("GET selects on the server and returns the versioned JSON contract", async (t) => {
  let selectedIndex = 0;
  const random = t.mock.method(crypto, "randomInt", (upperBound) => {
    assert.equal(upperBound, quotes.length);
    return selectedIndex;
  });
  const result = await handler({ httpMethod: "GET", path: "/api/v1/quote" });
  assert.equal(random.mock.callCount(), 1);
  assert.equal(result.statusCode, 200);
  assert.equal(result.isBase64Encoded, false);
  assert.equal(
    result.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
  assert.deepEqual(JSON.parse(result.body), quotes[0]);
  for (selectedIndex = 1; selectedIndex < quotes.length; selectedIndex++) {
    const next = await handler({ httpMethod: "GET", path: "/api/v1/quote" });
    assert.deepEqual(JSON.parse(next.body), quotes[selectedIndex]);
  }
  assert.equal(random.mock.callCount(), quotes.length);
});

test("request contents and invocation context are never read or echoed", async () => {
  const event = { httpMethod: "GET" };
  for (const key of [
    "body",
    "headers",
    "queryStringParameters",
    "requestContext",
  ]) {
    Object.defineProperty(event, key, {
      get() {
        throw new Error(`Read ${key}`);
      },
    });
  }
  const context = new Proxy(
    {},
    {
      get() {
        throw new Error("Read context");
      },
    },
  );
  const result = await handler(event, context);
  assert.equal(result.statusCode, 200);
  const selected = JSON.parse(result.body);
  assert.deepEqual(selected, quotes.find((quote) => quote.id === selected.id));
});

test("only GET is accepted, with no quote data or CORS headers in errors", async () => {
  for (const httpMethod of [
    "POST",
    "HEAD",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "get",
    "",
    undefined,
  ]) {
    const result = await handler({ httpMethod });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.Allow, "GET");
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
    assert.deepEqual(JSON.parse(result.body), {
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  }
  assert.equal((await handler(null)).statusCode, 405);
  assert.equal((await handler()).statusCode, 405);
});
