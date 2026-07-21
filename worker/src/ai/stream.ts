/**
 * SSE helpers: turn `LlmProvider.stream()` text deltas into a
 * `text/event-stream` Response with the canonical section-20 framing:
 *   data: {"delta":"..."}        (repeated)
 *   data: {"done":true, ...}     (final; extra fields e.g. "sources")
 *   data: {"error":{"code","message"}}   (mid-stream failure, then close)
 */

export function sseEvent(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface SseStreamOptions {
  /** Extra fields merged into the final {"done":true} event (e.g. sources). */
  doneExtra?: object;
}

/**
 * Build the SSE Response from a promise of a delta stream. Errors BEFORE the
 * first delta already happened inside provider retry logic (the promise
 * rejecting is handled by the route and mapped to a JSON error response);
 * errors AFTER streaming starts emit a data:{"error"} event and close.
 */
export function sseResponse(
  deltas: ReadableStream<string>,
  opts: SseStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const reader = deltas.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(
            encoder.encode(sseEvent({ done: true, ...(opts.doneExtra ?? {}) })),
          );
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseEvent({ delta: value })));
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            sseEvent({
              error: {
                code: "ai_unavailable",
                message: err instanceof Error ? err.message : "Stream failed",
              },
            }),
          ),
        );
        controller.close();
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
