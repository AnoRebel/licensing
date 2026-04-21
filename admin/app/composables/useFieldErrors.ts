/**
 * Extract a user-readable error string from a TanStack Form field's
 * `state.meta.errors` array.
 *
 * Valibot issues arrive as `{ message, path, ... }` objects — calling
 * `.join(', ')` yields `[object Object]`. This helper pulls `.message`
 * when present and falls back to string errors so forms can render a
 * flat string suitable for an `aria-describedby` error node.
 *
 * WHY SHARED: every field in every admin form needs the same behaviour,
 * and accessibility (B17 — role=alert + aria-describedby association)
 * depends on the error text being non-empty and human-readable. Keeping
 * this central prevents drift between forms.
 */
export function fieldErrors(errors: readonly unknown[]): string {
  return errors
    .map((err) => {
      if (!err) return '';
      if (typeof err === 'string') return err;
      if (typeof err === 'object' && 'message' in err) {
        const m = (err as { message?: unknown }).message;
        return typeof m === 'string' ? m : '';
      }
      return '';
    })
    .filter(Boolean)
    .join(' · ');
}
