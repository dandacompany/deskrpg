import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { getDeskRpgHomeDir } from "../../runtime-paths";
import type { SetupJob } from "./types";

type StoredJob = {
  userId: string;
  /** Which target (local / ssh:<host>) the job belongs to. Resume is allowed only for the same target. Not exposed to the UI. */
  target?: string;
  pid: number;
  createdAt: number;
  cancelRequested: boolean;
  job: SetupJob;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sanitized progress only. No credentials, command lines, paths or upstream output. */
export class SetupJobStore {
  constructor(readonly directory = path.join(getDeskRpgHomeDir(), "gateway-setup")) {}
  private init() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private file(id: string) {
    if (!UUID.test(id)) throw new Error("setup_not_found");
    return path.join(this.directory, `${id}.json`);
  }
  private write(record: StoredJob) {
    this.init();
    const file = this.file(record.job.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  }
  private read(userId: string, id: string): StoredJob {
    let record: StoredJob;
    try {
      record = JSON.parse(readFileSync(this.file(id), "utf8"));
    } catch {
      throw new Error("setup_not_found");
    }
    if (record.userId !== userId) throw new Error("setup_not_found");
    if (record.job.status === "running" && !alive(record.pid)) {
      record.job.status = "failed";
      record.job.error = "setup_interrupted";
      this.write(record);
    }
    return record;
  }
  create(userId: string, target?: string, seed?: { completed?: string[] }): SetupJob {
    const job: SetupJob = {
      id: randomUUID(),
      status: "running",
      steps: [],
      // A resume job starts by inheriting the steps the previous job finished — neither reverting nor redoing them.
      ...(seed?.completed?.length ? { completed: [...new Set(seed.completed)] } : {}),
    };
    this.write({
      userId,
      ...(target === undefined ? {} : { target }),
      pid: process.pid,
      createdAt: Date.now(),
      cancelRequested: false,
      job,
    });
    return job;
  }
  /**
   * Returns only resumable jobs: same user, same target, status `failed`.
   * If anything differs it is `setup_not_found` — not even revealing whether someone else's job exists.
   */
  resumable(userId: string, id: string, target: string): SetupJob {
    const record = this.read(userId, id);
    if (record.target !== target || record.job.status !== "failed")
      throw new Error("setup_not_found");
    return record.job;
  }
  get(userId: string, id: string) {
    return this.read(userId, id).job;
  }
  update(userId: string, id: string, patch: Partial<Omit<SetupJob, "id">>) {
    const record = this.read(userId, id);
    record.job = { ...record.job, ...patch };
    this.write(record);
    return record.job;
  }
  cancel(userId: string, id: string) {
    const record = this.read(userId, id);
    if (record.job.status === "running") {
      record.cancelRequested = true;
      this.write(record);
    }
    return record.job;
  }
  cancelled(userId: string, id: string) {
    return this.read(userId, id).cancelRequested;
  }
  lock(target: string): () => void {
    this.init();
    const lock = path.join(
      this.directory,
      `${createHash("sha256").update(target).digest("hex")}.lock`,
    );
    if (existsSync(lock)) {
      let owner = 0;
      try {
        owner = Number(readFileSync(path.join(lock, "pid"), "utf8"));
      } catch {
        /* another process is acquiring */
      }
      if (!owner || alive(owner)) throw new Error("setup_busy");
      rmSync(lock, { recursive: true, force: true });
    }
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw new Error("setup_busy");
    }
    writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
    return () => {
      rmSync(lock, { recursive: true, force: true });
    };
  }
}
