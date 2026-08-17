// Impalcatura comune delle email, sulle misure di frontend/email-*.html.
//
// Perche' tabelle e stili in linea invece del CSS che usiamo nel pannello: i
// client di posta non sono browser. Outlook rende con il motore di Word,
// Gmail rimuove i <style> nel corpo, molti ignorano flex e grid. Il minimo
// comune denominatore e' HTML del 1998, ed e' quello che il disegno usa.
//
// SEC-44 — ogni valore interpolato passa da `escapeHtml`, senza eccezioni.
// Nel pannello la difesa contro l'HTML iniettato e' la CSP piu' il divieto di
// innerHTML; in un'email non esiste ne' l'una ne' l'altro, e l'unica difesa e'
// che il valore non contenga mai markup. I nomi sono gia' normalizzati a una
// allowlist in scrittura: questo e' il secondo strato, non il primo.

import { escapeHtml, escapeUrl } from './escape.ts';

/** I colori del disegno, in esadecimale pieno: i client non hanno le variabili CSS. */
const C = {
  page: '#0c1a22',
  card: '#122530',
  inset: '#0f2129',
  border: '#1e3946',
  borderSoft: '#17313c',
  borderLogo: '#2f5566',
  accent: '#db6e19',
  accentText: '#e78030',
  accentStrong: '#f0913f',
  onAccent: '#160a02',
  text: '#e9f1f5',
  textBody: '#c2d3db',
  textMuted: '#9db1bc',
  textFaint: '#7c95a2',
  textFooter: '#5f7783',
  link: '#8cc4e0',
  warn: '#e0a32e',
} as const;

const FONT = 'Arial,Helvetica,sans-serif';
const MONO = "'Courier New',Courier,monospace";

export type EmailSection = string;

/**
 * Testo nascosto che i client mostrano nell'anteprima accanto all'oggetto.
 * Senza, l'anteprima diventa il primo testo visibile — cioe' «METAMC CONSOLE».
 */
export function preheader(text: string): EmailSection {
  return `<span style="display:none;font-size:1px;color:${C.page};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(text)}</span>`;
}

/** Occhiello sopra il titolo: maiuscolo, spaziato, colore accento. */
export function eyebrow(text: string): EmailSection {
  return `<p style="margin:0 0 10px 0;font-family:${FONT};font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${C.accentText};">${escapeHtml(text)}</p>`;
}

export function heading(text: string): EmailSection {
  return `<h1 class="mm-h1" style="margin:0 0 16px 0;font-family:${FONT};font-size:26px;line-height:34px;font-weight:bold;color:${C.text};">${escapeHtml(text)}</h1>`;
}

/**
 * Paragrafo del corpo. `html` accetta markup GIA' composto da questo modulo —
 * mai testo che arrivi da fuori: per quello c'e' `strong()` e `mono()`, che
 * escapano.
 */
export function paragraph(html: string, marginBottom = 24): EmailSection {
  return `<p style="margin:0 0 ${marginBottom}px 0;font-family:${FONT};font-size:15px;line-height:24px;mso-line-height-rule:exactly;color:${C.textBody};">${html}</p>`;
}

export function strong(text: string): string {
  return `<strong style="color:${C.text};">${escapeHtml(text)}</strong>`;
}

export function mono(text: string): string {
  return `<span style="font-family:${MONO};color:${C.text};">${escapeHtml(text)}</span>`;
}

/** Il pulsante arancione. Una tabella, non un <a> con padding: Outlook. */
export function button(link: string, label: string): EmailSection {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" bgcolor="${C.accent}" style="border-radius:6px;">
      <a href="${escapeUrl(link)}" style="display:block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:bold;color:${C.onAccent};text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/**
 * Il riquadro con l'indirizzo per esteso.
 *
 * Non e' cortesia: i client aziendali riscrivono gli href per passarli dal
 * loro filtro, e quando quel filtro sbaglia il pulsante porta altrove. Con
 * l'indirizzo visibile la persona vede dove sta andando.
 */
export function linkFallback(link: string): EmailSection {
  return box(
    `<span style="font-family:${FONT};font-size:13px;line-height:21px;mso-line-height-rule:exactly;color:${C.textMuted};">Se il pulsante non funziona, copia questo indirizzo nel browser:<br>
    <a href="${escapeUrl(link)}" style="font-family:${MONO};font-size:12px;color:${C.link};text-decoration:underline;word-break:break-all;">${escapeHtml(link)}</a></span>`,
  );
}

/** Riquadro incassato, il contenitore usato per ruolo, moduli e indirizzo. */
export function box(innerHtml: string): EmailSection {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${C.inset}" style="border:1px solid ${C.border};border-radius:8px;">
  <tr><td style="padding:16px 18px;">${innerHtml}</td></tr>
</table>`;
}

/** Etichetta maiuscola dentro un riquadro. */
export function boxLabel(text: string): string {
  return `<span style="font-family:${FONT};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.textFaint};">${escapeHtml(text)}</span>`;
}

/** Barra verticale gialla con un avviso a fianco. */
export function warning(titleText: string, bodyText: string): EmailSection {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td width="4" bgcolor="${C.warn}" style="width:4px;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding:2px 0 2px 16px;font-family:${FONT};font-size:13px;line-height:21px;mso-line-height-rule:exactly;color:${C.textBody};">
      ${strong(titleText)}<br>${escapeHtml(bodyText)}
    </td>
  </tr>
</table>`;
}

/** Elenco a due colonne: nome a sinistra, valore a destra. */
export function rows(items: Array<{ label: string; value: string }>): EmailSection {
  const cells = items
    .map((item, i) => {
      const last = i === items.length - 1;
      const border = last ? '' : `border-bottom:1px solid ${C.borderSoft};`;
      return `<tr>
      <td style="padding:7px 0;font-family:${FONT};font-size:14px;color:${C.textBody};${border}">${escapeHtml(item.label)}</td>
      <td align="right" style="padding:7px 0;font-family:${FONT};font-size:13px;color:${C.link};${border}">${escapeHtml(item.value)}</td>
    </tr>`;
    })
    .join('\n');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${cells}</table>`;
}

/**
 * Il documento completo: intestazione col marchio, corpo, piede.
 *
 * `sections` sono blocchi gia' composti; ognuno diventa una riga della tabella
 * esterna, con il padding laterale di 40px del disegno.
 */
export function render(input: {
  title: string;
  preheaderText: string;
  sections: EmailSection[];
  footerLines: string[];
}): string {
  // La prima sezione ha il padding superiore del disegno (36px), le altre no.
  const [first, ...rest] = input.sections;
  const head = `        <tr><td class="mm-pad" style="padding:36px 40px 8px 40px;">${first ?? ''}</td></tr>`;
  const body = rest
    .map((s) => `        <tr><td class="mm-pad" style="padding:0 40px 24px 40px;">${s}</td></tr>`)
    .join('\n');

  const footer = input.footerLines
    .map(
      (line, i) =>
        `<p style="margin:0${i === input.footerLines.length - 1 ? '' : ' 0 6px 0'};font-family:${FONT};font-size:12px;line-height:19px;color:${i === 0 ? C.textFaint : C.textFooter};">${line}</p>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(input.title)}</title>
<style>
  @media only screen and (max-width:620px){
    .mm-wrap{width:100% !important}
    .mm-pad{padding-left:24px !important;padding-right:24px !important}
    .mm-h1{font-size:22px !important;line-height:30px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.page};">
${preheader(input.preheaderText)}

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.page};">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="mm-wrap" style="width:600px;max-width:600px;background-color:${C.card};border:1px solid ${C.border};border-radius:12px;">

        <tr>
          <td class="mm-pad" style="padding:28px 40px 24px 40px;border-bottom:1px solid ${C.border};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td width="34" valign="middle" style="width:34px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="30" style="width:30px;">
                    <tr>
                      <td align="center" valign="middle" bgcolor="${C.page}" style="width:30px;height:30px;border:1px solid ${C.borderLogo};border-radius:6px;font-family:${FONT};font-size:14px;font-weight:bold;color:${C.accentText};line-height:30px;mso-line-height-rule:exactly;">M</td>
                    </tr>
                  </table>
                </td>
                <td valign="middle" style="font-family:${FONT};font-size:13px;font-weight:bold;letter-spacing:2px;color:${C.text};">
                  METAMC<span style="font-weight:normal;letter-spacing:1px;color:${C.textFaint};"> &nbsp;CONSOLE</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

${head}
${body}

        <tr>
          <td class="mm-pad" style="padding:20px 40px 26px 40px;border-top:1px solid ${C.border};">
${footer}
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;
}

export { C as EMAIL_COLORS, FONT as EMAIL_FONT, MONO as EMAIL_MONO };
