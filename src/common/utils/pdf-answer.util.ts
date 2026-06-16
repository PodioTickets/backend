/**
 * Normaliza a resposta de uma pergunta do organizador para TEXTO PLANO do PDF.
 *
 * Respostas de múltipla escolha chegam como array (`["A", "B"]`) ou como JSON
 * serializado (`'["A","B"]'`) dependendo do fluxo — ambos viram lista separada
 * por vírgula, espelhando o mesmo tratamento do modal de visualização no front.
 * Sem essa normalização, o `<Text>` do react-pdf renderiza o array cru
 * (juntando sem separador) — o bug reportado.
 *
 * Fonte ÚNICA usada por todos os builders de PDF de ingresso (inscrição avulsa
 * + os 4 fluxos de pedido: orders / payments / webhook PIX e 3DS), garantindo
 * comportamento idêntico em qualquer caminho de geração do documento.
 */
export function formatPdfAnswer(answer: unknown): string {
  if (answer == null) return '';
  if (Array.isArray(answer)) return answer.join(', ');
  if (typeof answer === 'string') {
    try {
      const parsed = JSON.parse(answer);
      if (Array.isArray(parsed)) return parsed.join(', ');
    } catch {
      /* não é JSON — usa a string crua */
    }
    return answer;
  }
  return String(answer);
}
