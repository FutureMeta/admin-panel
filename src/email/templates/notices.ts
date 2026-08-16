// Email di avviso: reset password, cambio email, recovery code in esaurimento.
//
// SEC-44 — nessun campo di text libero. Le uniche variabili sono link,
// scadenze e un indirizzo email, tutti prodotti dal server.

import { escapeHtml } from './escape.ts';
import type { EmailTemplate } from './invite.ts';

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(d);
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="it">
  <body style="margin:0;padding:24px;background:#0A161D;font-family:Inter,system-ui,sans-serif;color:#E9F1F5">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
      <tr><td style="padding:0 0 24px">
        <span style="font:700 20px/28px Montserrat,system-ui,sans-serif;color:#DB6E19">MetaMC</span>
        <span style="font:600 20px/28px Montserrat,system-ui,sans-serif;color:#2478A1"> Admin</span>
      </td></tr>
      <tr><td style="background:#0E1F28;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:24px">
        <p style="margin:0 0 16px;font:600 15px/22px Inter,system-ui,sans-serif">${escapeHtml(title)}</p>
        ${body}
      </td></tr>
      <tr><td style="padding:24px 0 0;font:400 12px/18px Inter,system-ui,sans-serif;color:#718996">
        Non rispondere a questa email.
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(link: string, text: string): string {
  return `<a href="${escapeHtml(link)}" style="display:inline-block;background:#DB6E19;color:#0A161D;text-decoration:none;font:600 14px/20px Inter,system-ui,sans-serif;padding:12px 20px;border-radius:8px">${escapeHtml(text)}</a>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font:400 14px/22px Inter,system-ui,sans-serif;color:#A9BEC9">${escapeHtml(text)}</p>`;
}

// ---------------------------------------------------------------------------

export type PasswordNoticeInput =
  | { kind: 'reset-requested'; link: string; expiresAt: Date }
  | { kind: 'reset-completed' }
  | { kind: 'changed' };

export function passwordChangedNotice(input: PasswordNoticeInput): EmailTemplate {
  if (input.kind === 'reset-requested') {
    const title = 'Reimposta la tua password';
    const body =
      paragraph(`Il link vale fino al ${formatDate(input.expiresAt)} e funziona una volta sola.`) +
      button(input.link, 'Reimposta la password') +
      paragraph(
        'Dopo averla reimpostata dovrai comunque accedere con il tuo secondo fattore: ' +
          'il reset della password non lo sostituisce.',
      ) +
      paragraph('Se non hai chiesto tu il reset, ignora questo messaggio: senza il link non succede nulla.');
    return {
      subject: 'Reimposta la password di MetaMC Admin',
      html: shell(title, body),
      text: [
        title,
        '',
        input.link,
        '',
        `Il link vale fino al ${formatDate(input.expiresAt)} e funziona una volta sola.`,
        'Dopo il reset dovrai comunque accedere con il secondo fattore.',
        '',
        'Se non hai chiesto tu il reset, ignora questo messaggio.',
      ].join('\n'),
    };
  }

  const title =
    input.kind === 'reset-completed'
      ? 'La tua password è stata reimpostata'
      : 'La tua password è stata cambiata';
  const body =
    paragraph('Tutte le sessioni aperte sono state chiuse: dovrai accedere di nuovo.') +
    paragraph(
      'Se non sei stato tu, contatta subito un owner: qualcuno ha accesso alla tua casella di posta.',
    );
  return {
    subject: `MetaMC Admin — ${title.toLowerCase()}`,
    html: shell(title, body),
    text: [
      title,
      '',
      'Tutte le sessioni aperte sono state chiuse.',
      'Se non sei stato tu, contatta subito un owner.',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------

export type EmailChangeInput =
  | { kind: 'confirm'; link: string; expiresAt: Date }
  | { kind: 'cancel'; link: string; expiresAt: Date; newEmail: string };

export function emailChangeNotice(input: EmailChangeInput): EmailTemplate {
  if (input.kind === 'confirm') {
    const title = 'Conferma il tuo nuovo indirizzo';
    const body =
      paragraph(`Il link vale fino al ${formatDate(input.expiresAt)}.`) +
      button(input.link, "Conferma l'indirizzo") +
      paragraph('Fino alla conferma il tuo indirizzo di accesso resta quello di prima.');
    return {
      subject: 'Conferma il nuovo indirizzo per MetaMC Admin',
      html: shell(title, body),
      text: [title, '', input.link, '', `Il link vale fino al ${formatDate(input.expiresAt)}.`].join('\n'),
    };
  }

  const title = 'Richiesta di cambio indirizzo';
  const body =
    paragraph(`È stato richiesto di spostare il tuo accesso su ${input.newEmail}.`) +
    paragraph(`Se non sei stato tu, ANNULLA subito: il link vale fino al ${formatDate(input.expiresAt)}.`) +
    button(input.link, 'Annulla il cambio');
  return {
    subject: 'MetaMC Admin — richiesta di cambio indirizzo',
    html: shell(title, body),
    text: [
      title,
      '',
      `Nuovo indirizzo richiesto: ${input.newEmail}`,
      '',
      'Se non sei stato tu, annulla subito:',
      input.link,
      '',
      `Il link vale fino al ${formatDate(input.expiresAt)}.`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------

export function recoveryCodesLowNotice(input: { remaining: number }): EmailTemplate {
  const title = 'Ti restano pochi codici di recupero';
  const body =
    paragraph(
      `Ne hai ancora ${input.remaining}. Quando finiscono, l'unico modo di rientrare è la procedura ` +
        'assistita, che richiede due owner e ventiquattro ore.',
    ) + paragraph('Rigenerali dal pannello, nella sezione del tuo account.');
  return {
    subject: 'MetaMC Admin — pochi codici di recupero rimasti',
    html: shell(title, body),
    text: [
      title,
      '',
      `Ne restano ${input.remaining}.`,
      "Quando finiscono, l'unico rientro è la procedura assistita: due owner e 24 ore.",
      'Rigenerali dal pannello.',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------

export function offboardingNotice(input: { who: string; by: string }): EmailTemplate {
  const title = 'Offboarding eseguito';
  const body =
    paragraph(`${input.who} è stato disattivato da ${input.by}.`) +
    paragraph(
      'Sessioni chiuse, ruoli e permessi rimossi, inviti pendenti emessi da quella persona revocati.',
    );
  return {
    subject: 'MetaMC Admin — offboarding eseguito',
    html: shell(title, body),
    text: [title, '', `${input.who} disattivato da ${input.by}.`].join('\n'),
  };
}
