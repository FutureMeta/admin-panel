// Template dell'email di invito. §8.1.6, SEC-44, SEC-45
//
// SEC-44 — nessun campo di testo libero: la sola variabile e' il link.
// `inviterName` e' gia' normalizzato a una allowlist di caratteri al momento
// della scrittura in DB (sanitizeDisplayName), e viene comunque escapato qui.
//
// Il template e' scritto a mano invece che con JSX di react-email perche'
// contiene quattro elementi e nessuna logica: `@react-email/render` resta
// nelle dipendenze per i template che lo meriteranno, e `react-email` sta in
// devDependencies come server di anteprima.

import { escapeHtml } from './escape.ts';

export type InviteEmailInput = {
  inviterName: string;
  link: string;
  expiresAt: Date;
};

export type EmailTemplate = { subject: string; html: string; text: string };

function formatExpiry(date: Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(date);
}

export function inviteEmail(input: InviteEmailInput): EmailTemplate {
  const inviter = escapeHtml(input.inviterName);
  const link = escapeHtml(input.link);
  const expiry = escapeHtml(formatExpiry(input.expiresAt));

  const html = `<!doctype html>
<html lang="it">
  <body style="margin:0;padding:24px;background:#0A161D;font-family:Inter,system-ui,sans-serif;color:#E9F1F5">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
      <tr><td style="padding:0 0 24px">
        <span style="font:700 20px/28px Montserrat,system-ui,sans-serif;color:#DB6E19">MetaMC</span>
        <span style="font:600 20px/28px Montserrat,system-ui,sans-serif;color:#2478A1"> Admin</span>
      </td></tr>
      <tr><td style="background:#0E1F28;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:24px">
        <p style="margin:0 0 16px;font:400 14px/22px Inter,system-ui,sans-serif">
          ${inviter} ti ha invitato nel pannello di amministrazione di MetaMC.
        </p>
        <p style="margin:0 0 24px;font:400 14px/22px Inter,system-ui,sans-serif;color:#A9BEC9">
          Il link vale una sola volta e scade il ${expiry}.
        </p>
        <a href="${link}" style="display:inline-block;background:#DB6E19;color:#0A161D;text-decoration:none;font:600 14px/20px Inter,system-ui,sans-serif;padding:12px 20px;border-radius:8px">
          Accetta l'invito
        </a>
        <p style="margin:24px 0 0;font:400 12px/18px Inter,system-ui,sans-serif;color:#718996">
          Se il pulsante non funziona, copia questo indirizzo nel browser:<br>
          <span style="font-family:'JetBrains Mono',ui-monospace,monospace;word-break:break-all">${link}</span>
        </p>
      </td></tr>
      <tr><td style="padding:24px 0 0;font:400 12px/18px Inter,system-ui,sans-serif;color:#718996">
        Se non aspettavi questo invito, ignora questo messaggio: senza il link non succede nulla.
        Non rispondere a questa email.
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `${input.inviterName} ti ha invitato nel pannello di amministrazione di MetaMC.`,
    '',
    "Accetta l'invito aprendo questo indirizzo:",
    input.link,
    '',
    `Il link vale una sola volta e scade il ${formatExpiry(input.expiresAt)}.`,
    '',
    'Se non aspettavi questo invito, ignora questo messaggio.',
  ].join('\n');

  return { subject: 'Invito al pannello MetaMC Admin', html, text };
}
