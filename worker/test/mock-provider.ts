/**
 * Scripted LlmProvider for tests. Queue up responses (or errors) for
 * complete(); stream() emits `streamText` word by word.
 */

import type {
  CompleteRequest,
  LlmProvider,
  StreamRequest,
} from "../src/ai/provider";

type ScriptEntry = { response: string } | { error: Error };

export class MockProvider implements LlmProvider {
  readonly model = "mock-model";
  completeCalls: CompleteRequest[] = [];
  streamCalls: StreamRequest[] = [];
  streamText = "streamed mock answer";
  private script: ScriptEntry[] = [];
  /** Default JSON-mode response when the script is empty. */
  defaultSummaryJson = JSON.stringify({
    overview: "Mock overview.",
    action_items: [{ text: "Mock task", owner: "1", due: null }],
    decisions: ["Mock decision"],
    key_quotes: [{ speaker: "2", quote: "mock quote" }],
    risks_open_questions: [],
  });

  respondWith(...entries: (string | Error)[]): void {
    this.script.push(
      ...entries.map((e) =>
        e instanceof Error ? { error: e } : { response: e },
      ),
    );
  }

  async complete(req: CompleteRequest): Promise<string> {
    this.completeCalls.push(req);
    const next = this.script.shift();
    if (!next) return req.json ? this.defaultSummaryJson : "mock completion";
    if ("error" in next) throw next.error;
    return next.response;
  }

  async stream(req: StreamRequest): Promise<ReadableStream<string>> {
    this.streamCalls.push(req);
    const words = this.streamText.split(" ");
    let i = 0;
    return new ReadableStream<string>({
      pull(controller) {
        if (i >= words.length) return controller.close();
        controller.enqueue(i === 0 ? words[i++] : ` ${words[i++]}`);
      },
    });
  }
}

/** Parse an SSE body into its data payloads. */
export async function readSse(res: Response): Promise<object[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)) as object);
}
