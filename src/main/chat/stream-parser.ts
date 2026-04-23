import { StringDecoder } from 'string_decoder'

/**
 * Line-buffered NDJSON parser. Call `feed()` with each stdout chunk; it
 * returns an array of fully-received JSON objects (one per complete line).
 *
 * Handles:
 *   - multi-byte UTF-8 characters split across chunks (uses StringDecoder)
 *   - half-lines buffered until newline
 *   - blank lines skipped
 *   - malformed lines skipped (no throw — caller gets nothing returned for them)
 */
export class StreamJsonParser {
  private buf = ''
  private decoder = new StringDecoder('utf8')

  feed(chunk: Buffer | string): unknown[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    return this.drain()
  }

  /** Flush any incomplete multi-byte bytes left in the StringDecoder. Call once when the stream ends. */
  end(): unknown[] {
    this.buf += this.decoder.end()
    return this.drain()
  }

  private drain(): unknown[] {
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip malformed line — ChatManager can log at a higher layer if needed
      }
    }
    return out
  }
}
