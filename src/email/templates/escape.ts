// Escaping HTML per i template email.
//
// I client di posta non hanno una CSP e non hanno il divieto di innerHTML che
// vale nel frontend (SEC-35): li' l'unica difesa e' che il valore non
// contenga mai HTML. I campi interpolati sono gia' normalizzati a una
// allowlist in scrittura (SEC-44); questo e' il secondo strato.

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Per un valore che finisce dentro un attributo `href`. */
export function escapeUrl(value: string): string {
  // Solo http/https: un `javascript:` in un href di un'email e' inerte nella
  // maggior parte dei client, ma "la maggior parte" non e' un controllo.
  if (!/^https?:\/\//i.test(value)) return '#';
  return escapeHtml(value);
}
