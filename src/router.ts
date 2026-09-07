/**
 * ¿El texto deja preguntas abiertas? Un plan o comentario con preguntas abiertas
 * nunca habilita trabajo hasta que lleguen las respuestas (regla del core v2).
 * Único resto del router de v1; v2 solo usa esta función pura.
 */
export function hasOpenQuestions(text: string): boolean {
  return /\[(rápida|rapida|con contexto)\]/i.test(text) || /necesito que me respondas/i.test(text)
}
