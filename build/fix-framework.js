// afterPack hook: fix Electron Framework "bundle format is ambiguous" on Electron 41+
// The root-level binary and Resources/ confuse codesign. Remove them since
// Versions/Current/ symlinks provide the canonical structure.
const { existsSync, unlinkSync, rmSync, lstatSync } = require('fs')
const { join } = require('path')

exports.default = async function (context) {
  if (process.platform !== 'darwin') return

  const appPath = context.appOutDir
  const frameworksDir = join(appPath, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks')
  const efDir = join(frameworksDir, 'Electron Framework.framework')

  // Remove root-level binary if it's a real file (not symlink)
  const rootBin = join(efDir, 'Electron Framework')
  if (existsSync(rootBin) && !lstatSync(rootBin).isSymbolicLink()) {
    unlinkSync(rootBin)
    // Re-create as symlink to Versions/Current/Electron Framework
    require('fs').symlinkSync('Versions/Current/Electron Framework', rootBin)
  }

  // Remove root-level Resources if it's a real directory (not symlink)
  const rootRes = join(efDir, 'Resources')
  if (existsSync(rootRes) && !lstatSync(rootRes).isSymbolicLink()) {
    rmSync(rootRes, { recursive: true })
    require('fs').symlinkSync('Versions/Current/Resources', rootRes)
  }

  // Same for Helpers, Libraries
  for (const name of ['Helpers', 'Libraries']) {
    const p = join(efDir, name)
    if (existsSync(p) && !lstatSync(p).isSymbolicLink()) {
      rmSync(p, { recursive: true })
      require('fs').symlinkSync(`Versions/Current/${name}`, p)
    }
  }
}
