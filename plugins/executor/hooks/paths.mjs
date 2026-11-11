import fs from 'node:fs'
import path from 'node:path'

export const inside = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** The real location of a path that may not exist yet: its nearest existing ancestor, resolved. */
export function resolveTarget(cwd, file) {
  const requested = path.resolve(cwd, file)
  let parent = requested

  while (true) {
    try {
      fs.lstatSync(parent)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error
      parent = path.dirname(parent)
    }
  }

  return path.resolve(fs.realpathSync(parent), path.relative(parent, requested))
}
