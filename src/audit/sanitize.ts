// §10 — sanitizzazione dei valori che finiscono nell'audit log.
//
// Ogni valore controllato da un utente viene ripulito da CR/LF e dai
// caratteri delimitatori PRIMA dell'INSERT. Non e' cosmesi: la canonica
// dell'hash (audit.canonical) usa U+0001 come separatore, e un valore che lo
// contenesse potrebbe far collidere due righe diverse sulla stessa stringa
// canonica, cioe' sullo stesso hash.
//
// CR e LF vanno tolti perche' l'audit finisce anche nei log di riga, dove una
// newline iniettata crea una voce falsa (log injection).

/**
 * Sostituisce con uno spazio ogni carattere di controllo C0 (incluso U+0001,
 * separatore della canonica), DEL e C1.
 *
 * Scritto per codepoint e non con una regex: una classe di caratteri di
 * controllo scritta in modo letterale nel sorgente e' invisibile, e una
 * scritta con le escape sopravvive male al passaggio fra strumenti diversi.
 * Qui non c'e' nulla da interpretare.
 */
function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0 = code <= 0x1f;
    const isDelOrC1 = code >= 0x7f && code <= 0x9f;
    out += isC0 || isDelOrC1 ? ' ' : ch;
  }
  return out;
}

/** Lunghezze massime: un campo di audit non e' un posto dove versare un payload. */
export const LIMITS = {
  action: 96,
  moduleKey: 32,
  targetType: 48,
  targetId: 128,
  targetLabel: 200,
  email: 320,
  displayName: 120,
  userAgent: 512,
  reason: 500,
} as const;

/**
 * Ripulisce una stringa destinata a un campo di audit.
 * Restituisce `null` per input vuoto o assente, cosi' la colonna resta NULL
 * invece di contenere una stringa vuota indistinguibile da "non lo so".
 */
export function sanitizeText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'string' ? value : String(value);
  const cleaned = stripControlChars(raw).replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/**
 * Ripulisce ricorsivamente un payload jsonb. Le chiavi sono sanificate come i
 * valori: una chiave con un carattere di controllo e' altrettanto capace di
 * inquinare la canonica, visto che jsonb ci finisce dentro come testo.
 */
export function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[troppo profondo]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeText(value, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeJson(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= 60) break;
      const key = sanitizeText(k, 64);
      if (key === null) continue;
      out[key] = sanitizeJson(v, depth + 1);
      n += 1;
    }
    return out;
  }
  return String(value);
}

/**
 * Normalizza un IP per la colonna `inet`. Un valore non parsabile diventa
 * NULL: una colonna inet con un valore inventato farebbe fallire l'INSERT
 * dell'audit, cioe' farebbe fallire l'operazione che stava registrando.
 */
export function sanitizeIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 45) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) e' valido per inet; il resto lo valida
  // Postgres. Qui si escludono solo le forme palesemente non-IP.
  if (!/^[0-9a-fA-F:.]+$/.test(v)) return null;
  return v;
}

/**
 * SEC-44 — i campi interpolati nelle email (nome dell'invitante) sono
 * normalizzati a una allowlist di caratteri AL MOMENTO DELLA SCRITTURA IN DB,
 * non al momento dell'invio: cosi' il vincolo vale anche per chi legge quel
 * campo da un'altra parte.
 */
export function sanitizeDisplayName(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} '._-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIMITS.displayName) || 'utente'
  );
}
