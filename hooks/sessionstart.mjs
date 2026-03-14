#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * SessionStart hook for context-mode
 *
 * Provides the agent with XML-structured "Rules of Engagement"
 * at the beginning of each session. Injects session knowledge on
 * both startup and compact to maintain continuity.
 *
 * Session Lifecycle Rules:
 * - "startup"  → Fresh session. Inject previous session knowledge. Cleanup old data.
 * - "compact"  → Auto-compact triggered. Inject resume snapshot + stats.
 * - "resume"   → User used --continue. Full history, no resume needed.
 * - "clear"    → User cleared context. No resume.
 *
 * Safety: This hook MUST always output valid JSON and exit cleanly.
 * A hanging or crashing SessionStart hook blocks Claude Code startup.
 */

import { ROUTING_BLOCK } from "./routing-block.mjs";
import { readStdin, getSessionId, getSessionDBPath, getSessionEventsPath, getCleanupFlagPath } from "./session-helpers.mjs";
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents, getLatestSessionEvents } from "./session-directive.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";

// Resolve absolute path for imports (fileURLToPath for Windows compat)
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);

const DEBUG_LOG = join(homedir(), ".claude", "context-mode", "sessionstart-debug.log");

/** Append to debug log — best-effort, never throws. */
function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

/** Emit the final JSON response and exit. Always called exactly once. */
function emitAndExit(additionalContext) {
  try {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }));
  } catch {
    // Absolute last resort — emit minimal valid JSON
    process.stdout.write('{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}\n');
  }
  process.exit(0);
}

// Process-level safety net — guarantee JSON output on any unhandled error
process.on("uncaughtException", (err) => {
  debugLog(`uncaughtException: ${err?.message || err}\n${err?.stack || ""}`);
  emitAndExit(ROUTING_BLOCK);
});
process.on("unhandledRejection", (err) => {
  debugLog(`unhandledRejection: ${err?.message || err}\n${err?.stack || ""}`);
  emitAndExit(ROUTING_BLOCK);
});

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  if (source === "compact") {
    // Session was compacted — write events to file for auto-indexing, inject directive only
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    try {
      const resume = db.getResume(sessionId);
      if (resume && !resume.consumed) {
        db.markResumeConsumed(sessionId);
      }

      const events = getSessionEvents(db, sessionId);
      if (events.length > 0) {
        const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
        additionalContext += buildSessionDirective("compact", eventMeta);
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } else if (source === "resume") {
    // User used --continue — clear cleanup flag so startup doesn't wipe data
    try { unlinkSync(getCleanupFlagPath()); } catch { /* no flag */ }

    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });

    try {
      const events = getLatestSessionEvents(db);
      if (events.length > 0) {
        const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
        additionalContext += buildSessionDirective("resume", eventMeta);
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } else if (source === "startup") {
    // Fresh session (no --continue) — clean slate, capture CLAUDE.md rules.
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });

    try {
      try { unlinkSync(getSessionEventsPath()); } catch { /* no stale file */ }

      // Detect true fresh start vs --continue (which fires startup→resume).
      // If cleanup flag exists from a PREVIOUS startup that was never followed by
      // resume, that was a true fresh start — aggressively wipe all data.
      const cleanupFlag = getCleanupFlagPath();
      let previousWasFresh = false;
      try { readFileSync(cleanupFlag); previousWasFresh = true; } catch { /* no flag */ }

      if (previousWasFresh) {
        db.cleanupOldSessions(0);
      } else {
        db.cleanupOldSessions(7);
      }
      db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

      writeFileSync(cleanupFlag, new Date().toISOString(), "utf-8");

      // Proactively capture CLAUDE.md files
      const sessionId = getSessionId(input);
      const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      db.ensureSession(sessionId, projectDir);
      const claudeMdPaths = [
        join(homedir(), ".claude", "CLAUDE.md"),
        join(projectDir, "CLAUDE.md"),
        join(projectDir, ".claude", "CLAUDE.md"),
      ];
      for (const p of claudeMdPaths) {
        try {
          const content = readFileSync(p, "utf-8");
          if (content.trim()) {
            db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
            db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
          }
        } catch { /* file doesn't exist — skip */ }
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  // "clear" — no action needed
} catch (err) {
  // Session continuity is best-effort — never block session start
  debugLog(`${err?.message || err}\n${err?.stack || ""}`);
}

emitAndExit(additionalContext);
