import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { marked } from 'marked';
import { createTransport, type Transporter } from 'nodemailer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

import {
  EMAIL_ADDRESS,
  EMAIL_PASSWORD,
  EMAIL_POLL_INTERVAL,
  IMAP_HOST,
  IMAP_PORT,
  MAIN_GROUP_FOLDER,
  MAIN_TAG,
  NOTIFICATION_EMAIL,
  SMTP_HOST,
  SMTP_PORT,
} from '../config.js';
import {
  getEmailThread,
  getRouterState,
  logActivity,
  setEmailThread,
  setRouterState,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const TAG_REGEX = /\[([^\]]+)\]/;

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onNewTag: (tag: string, chatId: string) => void;
}

export class EmailChannel implements Channel {
  name = 'email';

  private imap!: ImapFlow;
  private smtp!: Transporter;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeenUid = 0;
  private opts: EmailChannelOpts;

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Restore lastSeenUid from DB
    const savedUid = getRouterState('email_last_seen_uid');
    if (savedUid) {
      this.lastSeenUid = parseInt(savedUid, 10) || 0;
    }

    // Set up IMAP
    // Port 993 = implicit TLS; other ports (e.g. 1143 for Proton Bridge) use STARTTLS
    const imapSecure = IMAP_PORT === 993;
    this.imap = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: imapSecure,
      auth: {
        user: EMAIL_ADDRESS,
        pass: EMAIL_PASSWORD,
      },
      logger: false,
      tls: {
        rejectUnauthorized: imapSecure,
      },
    });

    // Set up SMTP
    // Port 465 = implicit TLS; other ports (587, 1025, etc.) use STARTTLS or plain
    const smtpSecure = SMTP_PORT === 465;
    this.smtp = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: smtpSecure,
      auth: {
        user: EMAIL_ADDRESS,
        pass: EMAIL_PASSWORD,
      },
      tls: {
        rejectUnauthorized: smtpSecure,
      },
    });

    await this.imap.connect();
    this.connected = true;
    logger.info('Connected to IMAP server');

    // If no lastSeenUid, set it to the current max to avoid processing old emails
    if (this.lastSeenUid === 0) {
      await this.initializeLastSeenUid();
    }

    // Start polling
    this.startPolling();
  }

  private async initializeLastSeenUid(): Promise<void> {
    const lock = await this.imap.getMailboxLock('INBOX');
    try {
      // Get the highest UID in INBOX
      const status = await this.imap.status('INBOX', { uidNext: true });
      if (status.uidNext) {
        // uidNext is the next UID that will be assigned, so current max is uidNext - 1
        this.lastSeenUid = status.uidNext - 1;
        setRouterState('email_last_seen_uid', String(this.lastSeenUid));
        logger.info({ lastSeenUid: this.lastSeenUid }, 'Initialized email UID cursor');
      }
    } finally {
      lock.release();
    }
  }

  private startPolling(): void {
    const poll = async () => {
      if (!this.connected) return;

      try {
        await this.fetchNewMessages();
      } catch (err) {
        logger.error({ err }, 'Error polling email');
        // Attempt reconnect on IMAP errors
        if (!this.imap.usable) {
          logger.info('IMAP connection lost, reconnecting...');
          try {
            await this.imap.connect();
            this.connected = true;
          } catch (reconnectErr) {
            logger.error({ err: reconnectErr }, 'IMAP reconnect failed');
            this.connected = false;
          }
        }
      }

      if (this.connected) {
        this.pollTimer = setTimeout(poll, EMAIL_POLL_INTERVAL);
      }
    };

    this.pollTimer = setTimeout(poll, EMAIL_POLL_INTERVAL);
  }

  private async fetchNewMessages(): Promise<void> {
    const lock = await this.imap.getMailboxLock('INBOX');
    try {
      // Search for UIDs greater than lastSeenUid
      const uids: number[] =
        (await this.imap.search(
          { uid: `${this.lastSeenUid + 1}:*` },
          { uid: true },
        )) || [];

      const newUids = uids
        .filter((uid) => uid > this.lastSeenUid)
        .sort((a, b) => a - b);

      if (!newUids.length) return;

      for (const uid of newUids) {
        const msg = await this.imap.fetchOne(
          String(uid),
          { envelope: true, source: true },
          { uid: true },
        );

        if (!msg) continue;

        await this.processEmail(msg);

        this.lastSeenUid = uid;
        setRouterState('email_last_seen_uid', String(uid));
      }
    } finally {
      lock.release();
    }
  }

  private async processEmail(msg: FetchMessageObject): Promise<void> {
    if (!msg.source) return;
    const parsed: ParsedMail = await simpleParser(msg.source) as ParsedMail;

    const from = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
    const toRaw = parsed.to;
    const toObjects: AddressObject[] = !toRaw
      ? []
      : Array.isArray(toRaw)
        ? toRaw
        : [toRaw];
    const toAddresses = toObjects
      .flatMap((t: AddressObject) => t.value)
      .map((a) => a.address?.toLowerCase() || '');

    const myEmail = EMAIL_ADDRESS.toLowerCase();
    const notifyEmail = NOTIFICATION_EMAIL.toLowerCase();

    logger.debug(
      { uid: msg.uid, from, to: toAddresses, subject: parsed.subject },
      'Processing email',
    );

    // Self-to-self filter: only process emails FROM and TO our own address
    if (from !== myEmail || !toAddresses.includes(myEmail)) {
      logger.debug(
        { from, myEmail, toAddresses },
        'Email skipped: not self-to-self',
      );
      return;
    }

    // Ignore bot's own replies (FROM us TO notification email)
    if (toAddresses.includes(notifyEmail)) {
      logger.debug('Email skipped: bot reply to notification address');
      return;
    }

    const subject = parsed.subject || '';

    // Extract tag from subject
    const tagMatch = subject.match(TAG_REGEX);
    if (!tagMatch) {
      logger.debug({ subject }, 'Email has no tag in subject, skipping');
      return;
    }

    const tag = tagMatch[1].toLowerCase();
    const isAdmin = tag.toUpperCase() === MAIN_TAG;
    const folder = isAdmin ? MAIN_GROUP_FOLDER : tag;
    const chatId = `email:tag:${tag}`;

    // Extract plain text body, strip signature
    let body = parsed.text || '';
    const sigIndex = body.indexOf('\n-- \n');
    if (sigIndex !== -1) {
      body = body.slice(0, sigIndex);
    }
    body = body.trim();

    if (!body) {
      logger.debug({ chatId, subject }, 'Empty email body, skipping');
      return;
    }

    const timestamp = (parsed.date || new Date()).toISOString();
    const emailMessageId = parsed.messageId || '';

    // Extract trigger depth from custom header (set by sendSelfEmail)
    const depthHeader = parsed.headers?.get('x-nanoclaw-trigger-depth');
    const triggerDepth = depthHeader ? parseInt(String(depthHeader), 10) || 0 : 0;

    // Store thread info for reply threading
    if (emailMessageId) {
      setEmailThread(chatId, emailMessageId, subject);
    }

    // Notify about chat metadata
    this.opts.onChatMetadata(chatId, timestamp, subject);

    // Auto-register new tags
    const groups = this.opts.registeredGroups();
    if (!groups[chatId]) {
      this.opts.onNewTag(tag, chatId);
    }

    const message: NewMessage = {
      id: `email-${msg.uid}`,
      chat_id: chatId,
      sender: from,
      sender_name: parsed.from?.value?.[0]?.name || from.split('@')[0],
      content: body,
      timestamp,
      is_from_me: true,
      is_bot_message: false,
      subject,
      message_id: emailMessageId,
      triggerDepth: triggerDepth > 0 ? triggerDepth : undefined,
    };

    logger.info(
      { chatId, tag, subject, bodyLength: body.length },
      'Email received',
    );
    logActivity({
      event_type: 'email_received',
      group_folder: folder,
      summary: `Email received: [${tag}] "${subject}"`,
      details: { chatId, tag, subject, bodyLength: body.length },
    });

    this.opts.onMessage(chatId, message);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Extract tag from chatId for subject line
    const tagMatch = chatId.match(/^email:tag:(.+)$/);
    const tag = tagMatch ? tagMatch[1] : 'unknown';

    // Look up thread info for In-Reply-To headers
    const thread = getEmailThread(chatId);

    // Convert markdown to HTML for rich-text email
    const htmlBody = marked.parse(text) as string;
    const html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #333;">${htmlBody}</div>`;

    const mailOptions: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
      inReplyTo?: string;
      references?: string;
    } = {
      from: EMAIL_ADDRESS,
      to: NOTIFICATION_EMAIL,
      subject: `[${tag}] Agent Response`,
      text,
      html,
    };

    if (thread?.message_id) {
      mailOptions.inReplyTo = thread.message_id;
      mailOptions.references = thread.message_id;
    }

    try {
      await this.smtp.sendMail(mailOptions);
      logger.info({ chatId, to: NOTIFICATION_EMAIL }, 'Agent response sent via email');
      logActivity({
        event_type: 'email_sent',
        group_folder: tag,
        summary: `Email sent: [${tag}] Agent Response -> ${NOTIFICATION_EMAIL}`,
        details: { chatId, to: NOTIFICATION_EMAIL, subject: mailOptions.subject, textPreview: text.slice(0, 200) },
      });
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send email');
    }
  }

  async sendSelfEmail(subject: string, body: string, triggerDepth = 0): Promise<void> {
    try {
      await this.smtp.sendMail({
        from: EMAIL_ADDRESS,
        to: EMAIL_ADDRESS,
        subject,
        text: body,
        headers: {
          'X-NanoClaw-Trigger-Depth': String(triggerDepth + 1),
        },
      });
      logger.info({ subject, triggerDepth }, 'Self-trigger email sent');
      logActivity({
        event_type: 'trigger_email_sent',
        summary: `Self-trigger email: "${subject}" (depth: ${triggerDepth + 1})`,
        details: { subject, triggerDepth: triggerDepth + 1, bodyPreview: body.slice(0, 200) },
      });
    } catch (err) {
      logger.error({ subject, err }, 'Failed to send self-trigger email');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsChatId(chatId: string): boolean {
    return chatId.startsWith('email:tag:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    try {
      await this.imap?.logout();
    } catch {
      // ignore disconnect errors
    }
    this.smtp?.close();
    logger.info('Email channel disconnected');
  }
}
