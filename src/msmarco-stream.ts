// Incremental TSV parser: never holds the complete corpus in JS memory.
export async function* passageBatches(stream: ReadableStream<Uint8Array>, limit = Infinity, batchSize = 2000): AsyncGenerator<{ id: string; contents: string }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '', batch = [], count = 0;
  function parse(line: string) {
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error(`Malformed passage at line ${count + 1}`);
    const id = line.slice(0, tab);
    const contents = line.slice(tab + 1).replace(/\r$/, '');
    if (!/^\d+$/.test(id) || !contents.trim()) throw new Error(`Invalid passage at line ${count + 1}`);
    count++;
    return { id, contents };
  }
  try {
    while (count < limit) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end;
      while (count < limit && (end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        batch.push(parse(line));
        if (batch.length >= batchSize) { yield batch; batch = []; }
      }
      if (done) {
        if (count < limit && pending.length) batch.push(parse(pending));
        break;
      }
    }
    if (batch.length) yield batch;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
