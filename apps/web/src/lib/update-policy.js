function maintenanceReasons(releaseBody, files) {
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])])
  const reasons = []
  if (!/^VYNOPS_DATA_COMPATIBLE: true\r?$/m.test(releaseBody || '')) {
    reasons.push('The publisher has not confirmed compatibility with existing client data.')
  }
  if (paths.some(path => /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(path))) {
    reasons.push('Dependency or package changes require separate maintenance.')
  }
  if (paths.some(path => /(^|\/)(migrations?|migrate)(\/|[._-]|$)/i.test(path))) {
    reasons.push('Migration changes require separate maintenance.')
  }
  if (paths.some(path => {
    const parts = path.split('/')
    return path.startsWith('/') || path.includes('\\') || path.includes(':') ||
      parts.some(part => !part || part === '.' || part === '..') ||
      /(^|\/)(data|node_modules|\.git|\.next)(\/|$)/i.test(path) ||
      /(^|\/)(\.env(?:\..*)?|config\.runtime\.json|passwords\.json|users\.json|[^/]*\.(?:jsonl|key|pem|ppk))$/i.test(path)
  })) {
    reasons.push('Protected client data, configuration or unsafe paths require separate maintenance.')
  }
  return reasons
}

module.exports = { maintenanceReasons }
