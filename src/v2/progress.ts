export function progressText(tool: string): string {
  if (['Read', 'Glob', 'Grep', 'Bash', 'Skill'].includes(tool)) return 'Sigo revisando el codigo y el contexto del proyecto.'
  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) return 'Sigo aplicando los cambios en el worktree.'
  const names: Record<string, string> = {
    worktree: 'Estoy preparando el espacio de trabajo.',
    install: 'Estoy instalando las dependencias.',
    run_tests: 'Estoy ejecutando las verificaciones.',
    open_pr: 'Estoy preparando la publicacion del cambio.',
    create_task: 'Estoy registrando la tarea.',
    update_task: 'Estoy actualizando la tarea.',
    request_qa: 'Estoy preparando la revision humana.',
  }
  return names[tool.replace(/^mcp__regent__regent_/, '')] ?? 'Sigo trabajando en tu solicitud.'
}
