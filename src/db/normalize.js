// src/db/normalize.js
// JSON field normalization utilities for PG/SQLite compatibility.
// PostgreSQL jsonb fields return JS objects; SQLite text fields return strings.

"use strict";

/**
 * Parse a JSON field that may be an object (PG) or a string (SQLite).
 * Returns null for null/undefined input.
 */
function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Stringify a value for JSON storage.
 * For PG jsonb, Drizzle handles this automatically.
 * For SQLite text, the value needs to be a string.
 * Returns null for null/undefined input.
 */
function stringifyJson(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

module.exports = { parseJson, stringifyJson };
