// Email di invito. §8.1.6, SEC-44, SEC-45
//
// Impaginazione di frontend/email-invito.html: occhiello, titolo, saluto,
// riquadro con ruolo e moduli, pulsante, scadenza, indirizzo per esteso, piede.
//
// SEC-44 — nessun campo di testo libero scritto da chi riceve. Le variabili
// sono tutte prodotte dal server o scelte da chi invita, e passano comunque da
// `escapeHtml` dentro i costruttori di `layout.ts`. Chi accetta un invito non
// contribuisce con niente al contenuto di questa email: e' importante perche'
// e' l'unico messaggio che il pannello manda a un indirizzo non ancora
// verificato.
//
// Il testo del disegno dice «scade tra 24 ore»: la scadenza vera la decide
// INVITE_TTL_HOURS e viene scritta qui a partire dalla data reale. Un'email
// che dichiara una scadenza diversa da quella che il server applica e' un modo
// perche' qualcuno apra il link tardi e non capisca perche' non funziona.

import { escapeHtml } from './escape.ts';
import {
  box,
  boxLabel,
  button,
  EMAIL_COLORS,
  EMAIL_FONT,
  eyebrow,
  heading,
  linkFallback,
  paragraph,
  render,
  rows,
  strong,
} from './layout.ts';

export type EmailTemplate = { subject: string; html: string; text: string };

export type InviteEmailInput = {
  /** Nome scelto da chi invita: comparira' nel registro accanto alle azioni. */
  inviteeName: string;
  inviteeEmail: string;
  inviterName: string;
  roleName: string;
  /** I moduli che il ruolo apre, con il livello. Vuoto se il ruolo non ne apre. */
  modules: Array<{ name: string; level: string }>;
  link: string;
  createdAt: Date;
  expiresAt: Date;
};

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(date);
}

/** «tra 72 ore», «tra 2 ore», «tra 40 minuti»: quanto vale, non quando scade. */
function humanizeWindow(from: Date, to: Date): string {
  const minutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 90) return `tra ${minutes} minuti`;
  const hours = Math.round(minutes / 60);
  return `tra ${hours} ore`;
}

export function inviteEmail(input: InviteEmailInput): EmailTemplate {
  const window = humanizeWindow(input.createdAt, input.expiresAt);

  const roleBox = box(
    `${boxLabel('Ruolo assegnato')}
     <div style="padding-top:10px;font-family:${EMAIL_FONT};font-size:19px;font-weight:bold;color:${EMAIL_COLORS.accentStrong};">${escapeHtml(input.roleName)}</div>
     ${
       input.modules.length > 0
         ? `<div style="margin-top:16px;padding-top:14px;border-top:1px solid ${EMAIL_COLORS.border};">${boxLabel('Moduli inclusi')}</div>
            <div style="padding-top:6px;">${rows(input.modules.map((m) => ({ label: m.name, value: m.level })))}</div>`
         : ''
}`,
  );

  const html = render({
    title: 'Invito alla console MetaMC',
    logoFrom: input.link,
    preheaderText: `${input.inviterName} ti ha invitato nella console MetaMC come ${input.roleName}. L'invito scade ${window}.`,
    sections: [
      eyebrow('Invito allo staff') +
        heading('Hai accesso alla console') +
        paragraph(
          `Ciao ${escapeHtml(input.inviteeName)},<br>${strong(input.inviterName)} ti ha invitato nella console operativa di MetaMC, il pannello interno dello staff.`,
        ),
      roleBox,
      button(input.link, 'Attiva il tuo accesso'),
      paragraph(
        `L'invito scade ${strong(window)} e funziona una volta sola. Durante l'attivazione imposti la password e configuri la verifica in due passaggi, che è obbligatoria.`,
        0,
      ),
      linkFallback(input.link),
    ],
    footerLines: [
      `Invito creato il ${formatDateTime(input.createdAt)} (Europe/Rome) per ${escapeHtml(input.inviteeEmail)}.`,
      "MetaMC Network · metamc.it · Email di servizio inviata allo staff della console.<br>Non aspettavi questo invito? Ignora l'email o segnalalo a un owner.",
    ],
  });

  const text = [
    `Ciao ${input.inviteeName},`,
    `${input.inviterName} ti ha invitato nella console operativa di MetaMC.`,
    '',
    `Ruolo assegnato: ${input.roleName}`,
    ...(input.modules.length > 0
      ? ['Moduli inclusi:', ...input.modules.map((m) => `  - ${m.name}: ${m.level}`)]
      : []),
    '',
    'Attiva il tuo accesso aprendo questo indirizzo:',
    input.link,
    '',
    `L'invito scade ${window} e funziona una volta sola.`,
    "Durante l'attivazione imposti la password e configuri la verifica in due passaggi.",
    '',
    'Non aspettavi questo invito? Ignora questa email o segnalalo a un owner.',
  ].join('\n');

  return { subject: 'Invito alla console MetaMC', html, text };
}
