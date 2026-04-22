import { describe, it, expect } from 'vitest'
import { StreamJsonParser } from '../../src/main/chat/stream-parser'

function collect(p: StreamJsonParser, chunk: Buffer | string): unknown[] {
  return [...p.feed(chunk)]
}

describe('StreamJsonParser', () => {
  it('parses a single complete line', () => {
    const p = new StreamJsonParser()
    const out = collect(p, '{"type":"a"}\n')
    expect(out).toEqual([{ type: 'a' }])
  })

  it('buffers a half-line and completes on the next chunk', () => {
    const p = new StreamJsonParser()
    expect(collect(p, '{"type":')).toEqual([])
    expect(collect(p, '"a"}\n')).toEqual([{ type: 'a' }])
  })

  it('handles multiple lines in one chunk', () => {
    const p = new StreamJsonParser()
    const out = collect(p, '{"n":1}\n{"n":2}\n{"n":3}\n')
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('skips empty lines', () => {
    const p = new StreamJsonParser()
    const out = collect(p, '\n{"n":1}\n\n\n{"n":2}\n')
    expect(out).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('skips a malformed line and continues with subsequent good lines', () => {
    const p = new StreamJsonParser()
    const out = collect(p, 'not-json\n{"n":1}\n{bad\n{"n":2}\n')
    expect(out).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('handles UTF-8 multi-byte characters split across chunks', () => {
    const p = new StreamJsonParser()
    // "中" is 3 bytes in UTF-8: 0xE4 0xB8 0xAD
    const line = Buffer.from('{"s":"中"}\n', 'utf8')
    // split at the middle of the multi-byte char (byte 9 is inside "中")
    const a = line.slice(0, 9)
    const b = line.slice(9)
    expect(collect(p, a)).toEqual([])
    expect(collect(p, b)).toEqual([{ s: '中' }])
  })

  it('retains trailing partial line until newline arrives', () => {
    const p = new StreamJsonParser()
    expect(collect(p, '{"n":1}\n{"n":')).toEqual([{ n: 1 }])
    expect(collect(p, '2}\n')).toEqual([{ n: 2 }])
  })

  it('accepts string input (not just Buffer)', () => {
    const p = new StreamJsonParser()
    expect(collect(p, '{"n":1}\n')).toEqual([{ n: 1 }])
  })
})
