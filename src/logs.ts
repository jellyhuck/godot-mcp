export function appendBoundedLines(buffer: string[], lines: string[], capacity = 2000): number {
  const dropped = Math.max(0, buffer.length + lines.length - capacity);
  const incoming = lines.slice(-capacity).map(line => line.slice(0, 4096));
  const retained = Math.max(0, capacity - incoming.length);
  if (buffer.length > retained) buffer.splice(0, buffer.length - retained);
  buffer.push(...incoming);
  return dropped;
}

export function readLogPage(buffer: string[], offset: number, cursor: number, limit = 200) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a nonnegative safe integer.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1 to 500.');
  const start = Math.min(buffer.length, Math.max(0, cursor - offset));
  const lines = buffer.slice(start, start + limit);
  return { lines, nextCursor: offset + start + lines.length, dropped: cursor < offset, hasMore: start + lines.length < buffer.length };
}
