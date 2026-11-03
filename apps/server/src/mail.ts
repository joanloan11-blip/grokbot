import nodemailer from 'nodemailer';

/** Почта настроена, если задан SMTP_HOST. Без неё ссылку выдаёт администратор. */
export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

let transport: nodemailer.Transporter | undefined;

function transporter(): nodemailer.Transporter {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
        : undefined,
      tls: { rejectUnauthorized: process.env.SMTP_TLS_VERIFY !== 'false' },
    });
  }
  return transport;
}

export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  if (!mailConfigured()) throw new Error('Почта не настроена');
  await transporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

export function resetEmail(link: string, locale: 'ru' | 'en') {
  if (locale === 'en') {
    return {
      subject: 'Mayak password reset',
      text: `Someone asked to reset the password for your Mayak account.\n\nSet a new password: ${link}\n\nThe link works once and expires in 1 hour. If it was not you, ignore this email.`,
      html: `<p>Someone asked to reset the password for your Mayak account.</p><p><a href="${link}">Set a new password</a></p><p>The link works once and expires in 1 hour. If it was not you, ignore this email.</p>`,
    };
  }
  return {
    subject: 'Сброс пароля в Маяке',
    text: `Вы запросили смену пароля в Маяке.\n\nЗадать новый пароль: ${link}\n\nСсылка одноразовая и действует 1 час. Если это были не вы, просто проигнорируйте письмо.`,
    html: `<p>Вы запросили смену пароля в Маяке.</p><p><a href="${link}">Задать новый пароль</a></p><p>Ссылка одноразовая и действует 1 час. Если это были не вы, просто проигнорируйте письмо.</p>`,
  };
}
