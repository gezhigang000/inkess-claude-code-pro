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
 * Parse `netstat -rn -f inet` output and count routes whose gateway is in the
 * sing-box TUN subnet. Exported for tests.
 */
export function parseStaleSingBoxRouteCount(netstatOutput: string): number {
  let count = 0
  for (const line of netstatOutput.split('\n')) {
    // Gateway column contains a 198.18.x.x / 198.19.x.x address, typically
    // surrounded by whitespace. Match loosely to tolerate column alignment.
    if (/\s198\.(18|19)\.\d+\.\d+(\s|$)/.test(line)) count++
  }
  return count
}
