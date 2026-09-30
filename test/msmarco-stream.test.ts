import { describe, it, expect } from 'vitest';
import { passageBatches } from '../src/msmarco-stream.ts';
function stream(text: string, chunkSize = 3) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset += Math.min(chunkSize, bytes.length - offset)));
  } });
}
async function read(text: string, limit = Infinity) {
  const batches: { id: string; contents: string }[][] = [];
  for await (const batch of passageBatches(stream(text), limit, 2)) batches.push(batch);
  return batches;
}
describe('MS MARCO streaming import', () => {
  it('preserves UTF-8, embedded tabs, CRLF, and a final line without newline', async () => {
    expect(await read('1\tcafé\r\n2\ttext\tmore\n3\tlast')).toEqual([
      [{ id:'1', contents:'café' }, { id:'2', contents:'text\tmore' }],
      [{ id:'3', contents:'last' }],
    ]);
  });
  it('stops at the selected prefix without parsing later invalid records', async () => {
    expect((await read('1\tone\n2\ttwo\nbad', 1)).flat()).toEqual([{id:'1', contents:'one'}]);
  });
  it('rejects malformed or empty passages', async () => {
    await expect(read('bad')).rejects.toThrow('Malformed');
    await expect(read('1\t  ')).rejects.toThrow('Invalid');
  });
  it('accepts an empty input without inventing documents', async () => {
    expect(await read('')).toEqual([]);
  });
});
