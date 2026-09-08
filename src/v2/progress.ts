export function progressText(tool: string): string {
  if (['Read', 'Glob', 'Grep', 'Bash', 'Skill'].includes(tool)) return 'Sigo revisando el codigo y el contexto del proyecto.'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'Sigo aplicando los cambios en el proyecto.'
  return 'Sigo trabajando en tu solicitud.'
}
