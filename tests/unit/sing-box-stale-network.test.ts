import { describe, it, expect } from 'vitest'
import {
  parseStaleSingBoxInterfaces,
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

describe('parseStaleSingBoxRouteCount', () => {
  it('counts split-default routes via 198.18.0.1', () => {
    const netstat = `Routing tables

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
`
    expect(parseStaleSingBoxRouteCount(netstat)).toBe(9)
  })

  it('returns 0 when no sing-box routes present', () => {
    const netstat = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.10.1       UGScg                 en0
127                127.0.0.1          UCS                   lo0
192.168.10         link#14            UCS                   en0
`
    expect(parseStaleSingBoxRouteCount(netstat)).toBe(0)
  })

  it('ignores gateways with non-matching subnet', () => {
    const netstat = `Routing tables

Internet:
default            198.180.0.1        UGScg                 en0
1                  198.20.0.1         UGSc             utun5
`
    expect(parseStaleSingBoxRouteCount(netstat)).toBe(0)
  })

  it('handles empty input', () => {
    expect(parseStaleSingBoxRouteCount('')).toBe(0)
  })

  it('counts routes with 198.19.x.x gateway (upper half of 198.18.0.0/15)', () => {
    const netstat = `default            198.19.250.1       UGSc             utun2048
`
    expect(parseStaleSingBoxRouteCount(netstat)).toBe(1)
  })
})
