"use strict";

const crypto = require("node:crypto");
const quotes = require("./quotes.json");

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

exports.handler = async (event) => {
  if (event?.httpMethod !== "GET") {
    return response(
      405,
      { error: { code: "METHOD_NOT_ALLOWED" } },
      { Allow: "GET" },
    );
  }
  const { validateQuote } = await import("./contract.mjs");
  const quote = quotes[crypto.randomInt(quotes.length)];
  if (!validateQuote(quote)) {
    return response(500, { error: { code: "INVALID_CATALOGUE" } });
  }
  return response(200, quote);
};
