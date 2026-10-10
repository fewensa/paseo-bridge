import { BridgeError } from '../errors.js';
import { RESPONSE_LIMIT } from './client-transport.js';
export interface SSEFrame { event: string; data: string; id?: string }
/** Incremental UTF-8/CRLF parser. Both a line and the entire frame are bounded. */
export class EventParser {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = ''; private bytes = 0; private cr = false;
  private data: string[] = []; private event = ''; private id: string | undefined;
  constructor(private emit: (frame: SSEFrame) => void, private limit = RESPONSE_LIMIT) {}
  push(chunk: Uint8Array): void {
    let text: string;
    try { text = this.decoder.decode(chunk, { stream: true }); }
    catch { throw new BridgeError('RESPONSE', 'Invalid event stream encoding', 502); }
    for (const char of text) {
      if (this.cr && char === '\n') { this.cr = false; continue; }
      this.cr = false;
      this.bytes += Buffer.byteLength(char);
      if (this.bytes > this.limit) throw new BridgeError('RESPONSE_LIMIT', 'Event stream frame too large', 502);
      if (char === '\r' || char === '\n') { this.consume(); this.cr = char === '\r'; }
      else this.line += char;
    }
  }
  end(): void {
    try { this.decoder.decode(); } catch { throw new BridgeError('RESPONSE', 'Invalid event stream encoding', 502); }
    // Incomplete frames at EOF are discarded per SSE; reconnect obtains a fresh snapshot.
  }
  private consume(): void {
    const line = this.line; this.line = '';
    if (!line) {
      if (this.data.length) this.emit({ event: this.event || 'message', data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}) });
      this.data = []; this.event = ''; this.id = undefined; this.bytes = 0; return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}
