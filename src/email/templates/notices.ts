// Email di avviso: reset password, cambio email, recovery code in esaurimento.
//
// Tutte usano l'impalcatura di layout.ts, quella di frontend/email-*.html.
// Due email dello stesso sistema che arrivano con due aspetti diversi sono un
// invito a non fidarsi di nessuna delle due: il riconoscimento visivo e' parte
// di come una persona distingue un messaggio vero da uno finto.
//
// SEC-44 — nessun campo di testo libero. Le variabili sono link, scadenze,
// nomi gia' normalizzati in scrittura e indirizzi prodotti dal server, e
// passano comunque dall'escaping dei costruttori.

import { escapeHtml } from './escape.ts';
import type { EmailTemplate } from './invite.ts';
import {
  box,
  button,
  eyebrow,
  heading,
  linkFallback,
  mono,
  paragraph,
  render,
  strong,
  warning,
} from './layout.ts';

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(d);
}

function formatShort(d: Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(d);
}

const FOOTER_TAIL = 'MetaMC Network · metamc.it · Email di servizio inviata allo staff della console.';

// ---------------------------------------------------------------------------

export type PasswordNoticeInput =
  | {
      kind: 'reset-requested';
      link: string;
      expiresAt: Date;
      requestedAt: Date;
      userName: string;
      userEmail: string;
      /** IP da cui e' partita la richiesta. `null` se non determinabile. */
      ip: string | null;
    }
  | { kind: 'reset-completed'; at: Date }
  | { kind: 'changed'; at: Date };

export function passwordChangedNotice(input: PasswordNoticeInput): EmailTemplate {
  if (input.kind === 'reset-requested') {
    const minutes = Math.max(
      1,
      Math.round((input.expiresAt.getTime() - input.requestedAt.getTime()) / 60_000),
    );
    const validity = `${minutes} minuti`;

    const html = render({
      title: 'Reimposta la password della console MetaMC',
      preheaderText: `Link per reimpostare la password della console MetaMC. Valido ${validity}, un solo utilizzo.`,
      sections: [
        eyebrow('Sicurezza account') +
          heading('Reimposta la password') +
          paragraph(
            `Ciao ${escapeHtml(input.userName)},<br>abbiamo ricevuto una richiesta di reimpostazione della password per l'account ${mono(input.userEmail)}.`,
            16,
          ) +
          paragraph(`Il link vale ${strong(validity)} e può essere usato una volta sola.`, 28),
        button(input.link, 'Scegli una nuova password'),
        linkFallback(input.link),
        warning(
          'Non hai richiesto tu il reset?',
          'Ignora questa email: la password resta quella attuale. La richiesta è registrata nel registro attività della console — se si ripete, avvisa un owner.',
        ),
      ],
      footerLines: [
        `Richiesta partita il ${formatShort(input.requestedAt)} (Europe/Rome)${input.ip ? ` da IP ${escapeHtml(input.ip)}` : ''}.`,
        `${FOOTER_TAIL}<br>La reimpostazione non modifica la verifica in due passaggi.`,
      ],
    });

    return {
      subject: 'Reimposta la password della console MetaMC',
      html,
      text: [
        `Ciao ${input.userName},`,
        `abbiamo ricevuto una richiesta di reimpostazione della password per ${input.userEmail}.`,
        '',
        'Scegli una nuova password aprendo questo indirizzo:',
        input.link,
        '',
        `Il link vale ${validity} e può essere usato una volta sola.`,
        'La reimpostazione non modifica la verifica in due passaggi.',
        '',
        'Non hai richiesto tu il reset? Ignora questa email: la password resta quella attuale.',
        'La richiesta è registrata nel registro attività della console.',
      ].join('\n'),
    };
  }

  const title = input.kind === 'reset-completed' ? 'Password reimpostata' : 'Password cambiata';
  const html = render({
    title,
    preheaderText: `${title} il ${formatShort(input.at)}. Tutte le altre sessioni sono state chiuse.`,
    sections: [
      eyebrow('Sicurezza account') +
        heading(title) +
        paragraph(
          `La nuova password è attiva dal ${mono(formatShort(input.at))}. Tutte le sessioni aperte sono state chiuse: dovrai accedere di nuovo.`,
          0,
        ),
      warning(
        'Non sei stato tu?',
        'Contatta subito un owner: significa che qualcuno ha accesso alla tua casella di posta.',
      ),
    ],
    footerLines: [
      `Modifica registrata il ${formatShort(input.at)} (Europe/Rome).`,
      `${FOOTER_TAIL}<br>La modifica della password non tocca la verifica in due passaggi.`,
    ],
  });

  return {
    subject: `MetaMC Admin — ${title.toLowerCase()}`,
    html,
    text: [
      title,
      '',
      `Attiva dal ${formatShort(input.at)}.`,
      'Tutte le sessioni aperte sono state chiuse.',
      '',
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
    return {
      subject: 'Conferma il nuovo indirizzo per MetaMC Admin',
      html: render({
        title,
        preheaderText: `Conferma il nuovo indirizzo. Il link vale fino al ${formatDate(input.expiresAt)}.`,
        sections: [
          eyebrow('Sicurezza account') +
            heading(title) +
            paragraph(
              `Il link vale fino al ${strong(formatDate(input.expiresAt))}. Fino alla conferma il tuo indirizzo di accesso resta quello di prima.`,
              0,
            ),
          button(input.link, "Conferma l'indirizzo"),
          linkFallback(input.link),
        ],
        footerLines: [`${FOOTER_TAIL}`],
      }),
      text: [title, '', input.link, '', `Il link vale fino al ${formatDate(input.expiresAt)}.`].join('\n'),
    };
  }

  const title = 'Richiesta di cambio indirizzo';
  return {
    subject: 'MetaMC Admin — richiesta di cambio indirizzo',
    html: render({
      title,
      preheaderText: `È stato richiesto di spostare il tuo accesso su ${input.newEmail}.`,
      sections: [
        eyebrow('Sicurezza account') +
          heading(title) +
          paragraph(`È stato richiesto di spostare il tuo accesso su ${mono(input.newEmail)}.`, 0),
        warning(
          'Non sei stato tu?',
          `Annulla subito con il pulsante qui sotto: il link vale fino al ${formatDate(input.expiresAt)}.`,
        ),
        button(input.link, 'Annulla il cambio'),
        linkFallback(input.link),
      ],
      footerLines: [`${FOOTER_TAIL}`],
    }),
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
  return {
    subject: 'MetaMC Admin — pochi codici di recupero rimasti',
    html: render({
      title,
      preheaderText: `Ne restano ${input.remaining}. Rigenerali dal pannello.`,
      sections: [
        eyebrow('Sicurezza account') +
          heading(title) +
          paragraph(
            `Ne hai ancora ${strong(String(input.remaining))}. Quando finiscono, l'unico modo di rientrare è la procedura assistita, che richiede due owner e ventiquattro ore.`,
            0,
          ),
        box(
          `<span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;color:#9db1bc;">Rigenerali dal pannello, nella sezione del tuo account. I vecchi codici smettono di funzionare nello stesso istante.</span>`,
        ),
      ],
      footerLines: [`${FOOTER_TAIL}`],
    }),
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
  return {
    subject: 'MetaMC Admin — offboarding eseguito',
    html: render({
      title,
      preheaderText: `${input.who} è stato disattivato da ${input.by}.`,
      sections: [
        eyebrow('Amministrazione') +
          heading(title) +
          paragraph(`${strong(input.who)} è stato disattivato da ${strong(input.by)}.`, 0),
        box(
          `<span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:21px;color:#9db1bc;">Sessioni chiuse, ruoli e permessi rimossi, inviti pendenti emessi da quella persona revocati.</span>`,
        ),
      ],
      footerLines: [`${FOOTER_TAIL}`],
    }),
    text: [title, '', `${input.who} disattivato da ${input.by}.`].join('\n'),
  };
}
