import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configError, loadConfig, writeDefaultConfig, type Config } from "./config.js";
import { canonicalPath, findStateRoot, gitToplevel, pathsFor, type ProjectPaths } from "./paths.js";
import { Redactor } from "./redact.js";
import { EventStore, readJson, writeJson, type EmitInput } from "./store.js";
import { Git } from "./git.js";
import type { AgentEvent } from "./events.js";
import type { Db } from "./db.js";

export class ConfigBrokenError extends Error {
  constructor(problem: string) {
    super(`config.yaml has an error, so agent-state is not recording anything until it is fixed: ${problem}`);
  }
}

export class NotInitializedError extends Error {
  constructor(cwd: string) {
    super(`No agent-state project found at or above ${cwd}. Run \`agent-state init\` first.`);
  }
}

/** Pointer to what is currently being worked on. Rebuildable from events. */
export interface CurrentPointer {
  task_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  updated_at: string;
}

export class Project {
  readonly git: Git;
  readonly store: EventStore;
  readonly redactor: Redactor;
  private _config: Config;
  /** Set when config.yaml is malformed: nothing is recorded until it is fixed. */
  readonly configProblem: string | null;

  private constructor(readonly paths: ProjectPaths) {
    this._config = loadConfig(paths.config);
    this.configProblem = configError;
    this.redactor = new Redactor(this._config.redaction.patterns);
    this.store = new EventStore(paths, this.redactor);
    this.git = new Git(paths.root);
  }

  get root(): string {
    return this.paths.root;
  }

  get name(): string {
    return basename(this.paths.root);
  }

  get config(): Config {
    return this._config;
  }

  static open(cwd: string = process.cwd()): Project {
    const root = findStateRoot(cwd);
    if (!root) throw new NotInitializedError(cwd);
    return new Project(pathsFor(canonicalPath(root)));
  }

  static tryOpen(cwd: string = process.cwd()): Project | null {
    const root = findStateRoot(cwd);
    return root ? new Project(pathsFor(canonicalPath(root))) : null;
  }

  /** Creates `.agent-state/` at the git toplevel (or cwd). Idempotent. */
  static init(cwd: string = process.cwd(), opts: { gitignore?: boolean } = {}): { project: Project; created: boolean } {
    const existing = findStateRoot(cwd);
    const root = canonicalPath(gitToplevel(cwd) ?? existing ?? cwd);
    const paths = pathsFor(root);
    const created = !existsSync(paths.state);
    for (const dir of [
      paths.state,
      paths.events,
      paths.checkpoints,
      paths.sessions,
      paths.decisions,
      paths.index,
      paths.recovery,
      paths.reports,
      paths.tasks,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(paths.config)) writeDefaultConfig(paths.config);
    if (opts.gitignore !== false) ensureIgnored(root);
    const project = new Project(paths);
    project.store.sync();
    return { project, created };
  }

  emit(input: EmitInput): AgentEvent {
    // With an unreadable config we can't honor the user's privacy/redaction
    // settings, so we record nothing rather than record with the wrong rules.
    if (this.configProblem) throw new ConfigBrokenError(this.configProblem);
    return this.store.append(input);
  }

  db(): Db {
    return this.store.sync();
  }

  current(): CurrentPointer {
    return readJson<CurrentPointer>(this.paths.current, {
      task_id: null,
      session_id: null,
      agent_id: null,
      updated_at: new Date(0).toISOString(),
    });
  }

  setCurrent(patch: Partial<CurrentPointer>): CurrentPointer {
    const next = { ...this.current(), ...patch, updated_at: new Date().toISOString() };
    writeJson(this.paths.current, next);
    return next;
  }

  lockPath(name: string): string {
    return join(this.paths.state, `.${name}.lock`);
  }

  close(): void {
    this.store.close();
  }
}

function ensureIgnored(root: string): void {
  const gi = join(root, ".gitignore");
  const content = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (/^\/?\.agent-state\/?\s*$/m.test(content)) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  appendFileSync(gi, `${prefix}# agent-state local memory (may contain session history)\n.agent-state/\n`);
}
