// afterPack hook: fix ".framework" bundle structure for codesign on Electron 41+
// macOS frameworks require top-level entries to be symlinks into Versions/Current/.
// Electron sometimes copies real files/dirs instead, causing "bundle format is ambiguous".
const { existsSync, unlinkSync, rmSync, lstatSync, readdirSync, symlinkSync, readlinkSync } = require('fs')
const { join, basename } = require('path')

exports.default = async function (context) {
  if (process.platform !== 'darwin') return

  const appPath = context.appOutDir
  const frameworksDir = join(appPath, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks')

  if (!existsSync(frameworksDir)) return

  // Fix ALL .framework bundles, not just Electron Framework
  const frameworks = readdirSync(frameworksDir).filter(f => f.endsWith('.framework'))

  for (const fw of frameworks) {
    const fwDir = join(frameworksDir, fw)
    const versionsDir = join(fwDir, 'Versions')

    // Only fix frameworks that have a Versions/ directory
    if (!existsSync(versionsDir)) continue

    // Ensure Versions/Current is a symlink
    const currentDir = join(versionsDir, 'Current')
    if (existsSync(currentDir) && !lstatSync(currentDir).isSymbolicLink()) {
      // Find the version dir (typically 'A')
      const versionDirs = readdirSync(versionsDir).filter(d => d !== 'Current')
      if (versionDirs.length > 0) {
        rmSync(currentDir, { recursive: true })
        symlinkSync(versionDirs[0], currentDir)
      }
    }

    // Fix top-level entries: must be symlinks to Versions/Current/<name>
    const topEntries = readdirSync(fwDir).filter(e => e !== 'Versions')
    for (const entry of topEntries) {
      const entryPath = join(fwDir, entry)
      const stat = lstatSync(entryPath)

      if (!stat.isSymbolicLink()) {
        // Replace real file/dir with symlink
        if (stat.isDirectory()) {
          rmSync(entryPath, { recursive: true })
        } else {
          unlinkSync(entryPath)
        }
        symlinkSync(`Versions/Current/${entry}`, entryPath)
      }
    }
  }
}
