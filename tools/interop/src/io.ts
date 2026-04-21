/**
 * Shared stdin/stdout glue for the interop CLIs.
 *
 * The Go test harness drives these scripts by piping a single JSON object on
 * stdin and reading a single JSON object back on stdout. Any uncaught error
 * gets serialized as `{"ok": false, "error": "..."}` on stdout (not stderr)
 * and the process exits 1 — that way the Go side only needs to parse stdout
 * to tell success apart from failure, and stderr stays free for verbose
 * debug output.
 *
 * STDERR HYGIENE (security): the Go harness captures stderr and prints it
 * into test logs on failure. CI logs are retained and may be public on OSS
 * PRs. Never `console.error(key)` or otherwise echo private-key bytes, PEM
 * blocks, or HMAC secrets — the harness has a PEM-block redactor in
 * `sanitizeCLIStream` but that's belt-and-braces, not a license to log.
 * Stick to operational errors only.
 */

export async function readStdin(): Promise<string> {
  // Bun's Bun.stdin.stream() works, but node:process stdin is portable across
  // Bun + Node when the harness is run through Node for CI parity. Consume
  // chunks into a single string — payloads are kilobytes at most.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function writeOk(value: unknown): void {
  // No trailing newline — Go's exec.Command reads until EOF.
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

export function writeErr(err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: msg }));
  process.exitCode = 1;
}

export async function runCli(fn: (input: unknown) => Promise<unknown>): Promise<void> {
  try {
    const raw = await readStdin();
    const input = raw.trim() === '' ? {} : JSON.parse(raw);
    const value = await fn(input);
    writeOk(value);
  } catch (err) {
    writeErr(err);
  }
}
