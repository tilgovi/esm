// Based on Node"s `Module._initPaths` method.
// Copyright Node.js contributors. Released under MIT license:
// https://github.com/nodejs/node/blob/master/lib/module.js

import { delimiter, resolve } from "path"

function initPaths() {
  const isWin = process.platform === "win32"
  const homeDir = isWin
    ? process.env.USERPROFILE
    : process.env.HOME

  // The executable path, `$PREFIX\node.exe` on Windows or `$PREFIX/lib/node`
  // everywhere else, where `$PREFIX` is the root of the Node.js installation.
  const prefixDir = isWin
    ? resolve(process.execPath, "..")
    : resolve(process.execPath, "..", "..")

  const paths = [resolve(prefixDir, "lib", "node")]

  if (homeDir) {
    paths.unshift(resolve(homeDir, ".node_libraries"))
    paths.unshift(resolve(homeDir, ".node_modules"))
  }

  const nodePath = process.env.NODE_PATH

  return nodePath
    ? nodePath.split(delimiter).filter(Boolean).concat(paths)
    : paths
}

export default initPaths