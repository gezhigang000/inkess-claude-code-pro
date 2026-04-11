/**
 * Pure helpers for detecting stale sing-box network state on macOS.
 *
 * Kept in a separate module (no Electron / logger imports) so unit tests can
 * import them without pulling in the rest of the main-process stack.
 */

/**
 * Parse `ifconfig` output and return utun interface names whose inet address
 * falls in sing-box's TUN subnet (198.18.0.0/15). Exported for tests.
 */
export function parseStaleSingBoxInterfaces(ifconfigOutput: string): string[] {
  const interfaces: string[] = []
  // Split into per-interface blocks. Each block starts at column 0.
  const blocks = ifconfigOutput.split(/\n(?=\S)/)
  for (const block of blocks) {
    const headerMatch = block.match(/^(utun\d+):/)
    if (!headerMatch) continue
    // 198.18.0.0/15 covers 198.18.x.x and 198.19.x.x
    if (/\binet 198\.(18|19)\./.test(block)) {
      interfaces.push(headerMatch[1])
    }
  }
  return interfaces
}

/**
 * Parse `netstat -rn -f inet` output and return the *destination* of every
 * route whose gateway is in the sing-box TUN subnet (198.18.0.0/15).
 *
 * Destinations are returned exactly as netstat printed them — e.g. "1",
 * "2/7", "128.0/1" — so they can be fed back into `route delete` which
 * accepts the same netstat shorthand (important because some of these
 * split-default routes don't round-trip through explicit CIDR on macOS).
 *
 * Exported for tests.
 */
export function parseStaleSingBoxRoutes(netstatOutput: string): string[] {
  const destinations: string[] = []
  for (const line of netstatOutput.split('\n')) {
    // Route table columns: Destination  Gateway  Flags  Netif  Expire
    // We want rows where Gateway is 198.(18|19).x.x. Use a loose match
    // tolerant of column alignment: first two whitespace-separated tokens.
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 2) continue
    const [dest, gateway] = tokens
    if (!/^198\.(18|19)\.\d+\.\d+$/.test(gateway)) continue
    destinations.push(dest)
  }
  return destinations
}

/**
 * Convenience count wrapper — kept for log messages, delegates to the
 * destination parser.
 */
export function parseStaleSingBoxRouteCount(netstatOutput: string): number {
  return parseStaleSingBoxRoutes(netstatOutput).length
}
