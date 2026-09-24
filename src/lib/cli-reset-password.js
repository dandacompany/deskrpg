"use strict";

const { cliMessage } = require("./cli-messages.js");

/**
 * The SQLite-side body of `deskrpg reset-password`. The CLI (bin/deskrpg.js) is one big JS
 * blob that tests can't reach, so only the part that actually touches the DB is split out here.
 *
 * A plaintext password never reaches this far — the caller hashes it before passing it in.
 */
function resetSqliteUserPassword(db, loginId, passwordHash) {
  const columns = db
    .prepare("PRAGMA table_info(users)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("must_change_password")) {
    throw new Error(cliMessage("resetPassword.schemaMissing"));
  }

  const user = db
    .prepare("SELECT id, login_id, nickname FROM users WHERE login_id = ?")
    .get(loginId);
  if (!user) return null;

  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?",
  ).run(passwordHash, new Date().toISOString(), user.id);

  return { id: user.id, loginId: user.login_id, nickname: user.nickname };
}

module.exports = { resetSqliteUserPassword };
