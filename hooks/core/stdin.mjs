/**
 * Shared stdin reader for all hook scripts.
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Uses event-based flowing mode to avoid two platform bugs:
 * - `for await (process.stdin)` hangs on macOS when piped via spawnSync
 * - `readFileSync(0)` throws EOF/EISDIR on Windows, EAGAIN on Linux
 */

export function readStdin(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.removeAllListeners();
        process.stdin.destroy();
      } catch { /* ignore cleanup errors */ }
      reject(new Error(`readStdin timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    process.stdin.resume();
  });
}
