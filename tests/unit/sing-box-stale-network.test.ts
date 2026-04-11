import { describe, it, expect } from 'vitest'
import {
  parseStaleSingBoxInterfaces,
  parseStaleSingBoxRoutes,
  parseStaleSingBoxRouteCount,
} from '../../src/main/proxy/sing-box-stale-state'

describe('parseStaleSingBoxInterfaces', () => {
  it('detects a zombie utun with 198.18.x.x inet', () => {
    // Captured from a real macOS system with a stale sing-box TUN interface
    const ifconfig = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	options=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
	inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	ether a0:78:17:aa:bb:cc
	inet 192.168.10.61 netmask 0xffffff00 broadcast 192.168.10.255
utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
	inet6 fe80::abcd%utun0 prefixlen 64 scopeid 0x10
utun1024: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
	inet 198.18.0.1 --> 198.18.0.1 netmask 0xfffffffc
	nd6 options=201<PERFORMNUD,DAD>
`
    const result = parseStaleSingBoxInterfaces(ifconfig)
    expect(result).toEqual(['utun1024'])
  })

  it('detects multiple stale utun interfaces', () => {
    const ifconfig = `utun1024: flags=8051 mtu 1500
	inet 198.18.0.1 --> 198.18.0.1 netmask 0xfffffffc
utun2048: flags=8051 mtu 1500
	inet 198.19.250.5 --> 198.19.250.6 netmask 0xfffffffc
`
    expect(parseStaleSingBoxInterfaces(ifconfig)).toEqual(['utun1024', 'utun2048'])
  })

  it('ignores normal system utun interfaces', () => {
    const ifconfig = `utun0: flags=8051 mtu 1500
	inet6 fe80::abcd%utun0 prefixlen 64 scopeid 0x10
utun1: flags=8051 mtu 1380
	inet6 fe80::def0%utun1 prefixlen 64 scopeid 0x11
utun2: flags=8051 mtu 2000
`
    expect(parseStaleSingBoxInterfaces(ifconfig)).toEqual([])
  })

  it('returns empty for non-utun interfaces', () => {
    const ifconfig = `lo0: flags=8049 mtu 16384
	inet 127.0.0.1 netmask 0xff000000
en0: flags=8863 mtu 1500
	inet 192.168.1.100 netmask 0xffffff00
`
    expect(parseStaleSingBoxInterfaces(ifconfig)).toEqual([])
  })

  it('handles empty input', () => {
    expect(parseStaleSingBoxInterfaces('')).toEqual([])
  })

  it('does not false-positive on 198.20.x (outside 198.18.0.0/15)', () => {
    const ifconfig = `utun5: flags=8051 mtu 1500
	inet 198.20.0.1 --> 198.20.0.2 netmask 0xfffffffc
`
    expect(parseStaleSingBoxInterfaces(ifconfig)).toEqual([])
  })

  it('does not match "198.18" as a substring of a different address', () => {
    // "198.180.x.x" should NOT match — we want the full octet match
    const ifconfig = `utun3: flags=8051 mtu 1500
	inet 198.180.0.1 --> 198.180.0.2 netmask 0xfffffffc
`
    expect(parseStaleSingBoxInterfaces(ifconfig)).toEqual([])
  })
})

describe('parseStaleSingBoxRoutes', () => {
  // Captured from a real macOS system after sing-box was SIGKILL'd — the
  // sing-box "auto_route" table uses classful split-default shorthand.
  const realNetstat = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.10.1       UGScg                 en0
1                  198.18.0.1         UGSc             utun1024
2/7                198.18.0.1         UGSc             utun1024
4/6                198.18.0.1         UGSc             utun1024
8/5                198.18.0.1         UGSc             utun1024
16/4               198.18.0.1         UGSc             utun1024
32/3               198.18.0.1         UGSc             utun1024
64/2               198.18.0.1         UGSc             utun1024
128.0/1            198.18.0.1         UGSc             utun1024
198.18.0.1         198.18.0.1         UH               utun1024
127                127.0.0.1          UCS                   lo0
`

  it('extracts destinations of routes whose gateway is in the sing-box subnet', () => {
    const routes = parseStaleSingBoxRoutes(realNetstat)
    // All 9 routes with gateway 198.18.0.1, in file order
    expect(routes).toEqual([
      '1', '2/7', '4/6', '8/5', '16/4', '32/3', '64/2', '128.0/1', '198.18.0.1',
    ])
  })

  it('preserves netstat shorthand exactly (for round-trip with route delete)', () => {
    const routes = parseStaleSingBoxRoutes('16/4               198.18.0.1         UGSc             utun1024')
    expect(routes).toEqual(['16/4'])
  })

  it('handles 0.0.0.0/1 + 128.0.0.0/1 (alternative split pattern)', () => {
    const netstat = `0.0.0.0/1          198.18.0.1         UGSc             utun5
128.0.0.0/1        198.18.0.1         UGSc             utun5`
    expect(parseStaleSingBoxRoutes(netstat)).toEqual(['0.0.0.0/1', '128.0.0.0/1'])
  })

  it('does not match gateway column entries that start with 198.18 as text', () => {
    // A destination of 198.180.0.0/8 with an unrelated gateway — should NOT match
    const netstat = `198.180.0.0/8      192.168.1.1        UGSc             en0`
    expect(parseStaleSingBoxRoutes(netstat)).toEqual([])
  })

  it('does not false-positive on 198.20.x.x gateway (outside 198.18.0.0/15)', () => {
    const netstat = `1                  198.20.0.1         UGSc             utun5`
    expect(parseStaleSingBoxRoutes(netstat)).toEqual([])
  })

  it('matches 198.19.x.x gateway (upper half of 198.18.0.0/15)', () => {
    const netstat = `default            198.19.250.1       UGSc             utun2048`
    expect(parseStaleSingBoxRoutes(netstat)).toEqual(['default'])
  })

  it('handles empty input', () => {
    expect(parseStaleSingBoxRoutes('')).toEqual([])
  })

  it('skips header lines and blank lines', () => {
    const netstat = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire

1                  198.18.0.1         UGSc             utun1024
`
    expect(parseStaleSingBoxRoutes(netstat)).toEqual(['1'])
  })
})

describe('parseStaleSingBoxRouteCount', () => {
  it('delegates to parseStaleSingBoxRoutes', () => {
    const netstat = `1                  198.18.0.1         UGSc             utun1024
2/7                198.18.0.1         UGSc             utun1024`
    expect(parseStaleSingBoxRouteCount(netstat)).toBe(2)
  })

  it('returns 0 for empty input', () => {
    expect(parseStaleSingBoxRouteCount('')).toBe(0)
  })
})
