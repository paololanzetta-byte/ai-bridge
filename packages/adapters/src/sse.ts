export interface StreamEvent {
  type?: string;
  delta?: unknown;
  response?: { error?: { code?: string } };
  [key: string]: unknown;
}

/** Legge un flusso "server-sent events" e restituisce un oggetto per ogni riga "data:" JSON. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = function* (block: string): Generator<StreamEvent> {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data) as StreamEvent;
      } catch {
        // riga non JSON: ignorata
      }
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        yield* parse(block);
      }
    }
    if (buffer.trim()) yield* parse(buffer);
  } finally {
    reader.releaseLock();
  }
}
