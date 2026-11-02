import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, DeskError } from './store.mjs';

// This inherited implementation is intentionally incomplete. See README acceptance criteria.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }
  close() { this.db.close(); }
  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }
  // row(actor, id) {
  //   const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  //   if (!row) throw new DeskError(404, 'Ticket not found');
  //   return row;
  // }
  //  fixed part // 
  row(actor, id) {
    const row = this.db.prepare(
      'SELECT * FROM tickets WHERE id = ? AND tenant_id = ?'
    ).get(id, actor.tenantId);

    if (!row) throw new DeskError(404, 'Ticket not found');

    return row;
  }

  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }

  // receiveWebhook(event) {
  //   const t = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?')
  //     .get(event.ticketId, event.tenantId);
  //   if (!t || !event.eventId || typeof event.body !== 'string') throw new DeskError(400, 'Invalid event');
  //   this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)')
  //     .run(t.id, event.eventId, event.body);
  //   record(this.db, t.id, 'inbound', event.eventId);
  //   return { accepted: true };
  // }
  // fixed part

  // receiveWebhook(event) {
  //   const t = this.db.prepare(
  //     'SELECT * FROM tickets WHERE id = ? AND tenant_id = ?'
  //   ).get(event.ticketId, event.tenantId);

  //   if (!t || !event.eventId || typeof event.body !== 'string') {
  //     throw new DeskError(400, 'Invalid event');
  //   }

  //   this.db.exec('BEGIN IMMEDIATE');

  //   try {
  //     this.db.prepare(
  //       'INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)'
  //     ).run(t.id, event.eventId, event.body);

  //     record(this.db, t.id, 'inbound', event.eventId);

  //     this.db.exec('COMMIT');

  //     return { accepted: true, duplicate: false };
  //   } catch (error) {
  //     this.db.exec('ROLLBACK');

  //     // if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
  //     //   return { accepted: true, duplicate: true };
  //     // }

  //     // fixed part

  //     if (
  //       error.errcode === 2067 ||
  //       error.message.includes('UNIQUE constraint failed')
  //     ) {
  //       return { accepted: true, duplicate: true };
  //     }


  //     throw error;
  //   }
  // }

  // fixed part

receiveWebhook(event) {
  const t = this.db.prepare(
    'SELECT * FROM tickets WHERE id = ? AND tenant_id = ?'
  ).get(event.ticketId, event.tenantId);

  if (!t || !event.eventId || typeof event.body !== 'string') {
    throw new DeskError(400, 'Invalid event');
  }

  this.db.exec('BEGIN IMMEDIATE');

  try {
    // First register the event with tenant-scoped uniqueness
    this.db.prepare(`
      INSERT INTO webhook_events (tenant_id, event_id, ticket_id)
      VALUES (?, ?, ?)
    `).run(event.tenantId, event.eventId, t.id);

    // Then store the actual message
    this.db.prepare(`
      INSERT INTO messages (ticket_id, event_id, body)
      VALUES (?, ?, ?)
    `).run(t.id, event.eventId, event.body);

    record(this.db, t.id, 'inbound', event.eventId);

    this.db.exec('COMMIT');

    return { accepted: true, duplicate: false };

  } catch (error) {
    this.db.exec('ROLLBACK');

    // Check whether this event already exists for this tenant
    const existing = this.db.prepare(`
      SELECT id FROM webhook_events
      WHERE tenant_id = ? AND event_id = ?
    `).get(event.tenantId, event.eventId);

    if (existing) {
      return { accepted: true, duplicate: true };
    }

    throw error;
  }
}

  updateDraft(actor, id, body) {
    this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, send_state = 'DRAFT' WHERE id = ?")
      .run(body, id);
    record(this.db, id, 'draft_updated', actor.id);
    return this.getTicket(actor, id);
  }
  approveDraft(actor, id) {
    const t = this.row(actor, id);
    if (!t.draft) throw new DeskError(400, 'No draft');
    this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ?').run(id);
    record(this.db, id, 'approved', actor.id);
    return this.getTicket(actor, id);
  }
  handoff(actor, id) {
    this.row(actor, id);
    this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ?").run(id);
    record(this.db, id, 'human_handoff', actor.id);
    return this.getTicket(actor, id);
  }
  // async sendReply(actor, id, { automatic = false } = {}) {
  //   const t = this.row(actor, id);
  //   // if (t.approved_version == null) throw new DeskError(409, 'Approve the reply first');

  //   if (t.approved_version !== t.version) {
  //     throw new DeskError(409, 'Approve the current reply version first');
  //   }

  //   let result;
  //   for (let attempt = 0; attempt < 2; attempt++) {
  //     try {
  //       result = await this.provider.send({ clientRef: randomUUID(), ticketId: id, body: t.draft });
  //       break;
  //     } catch (error) {
  //       if (attempt === 1) throw error;
  //     }
  //   }
  //   this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ?").run(id);
  //   record(this.db, id, 'sent', `${automatic ? 'automation' : actor.id}: ${result.providerMessageId}`);
  //   return this.getTicket(actor, id);
  // }
  
async sendReply(actor, id, { automatic = false } = {}) {
  const t = this.row(actor, id);

  // 1. Automation must not send after human takeover
  if (automatic && t.owner !== 'automation') {
    throw new DeskError(409, 'Human has taken over this ticket');
  }

  // 2. Approval must match the current draft version
  if (t.approved_version !== t.version) {
    throw new DeskError(409, 'Approve the current reply version first');
  }

  // 3. Claim this version in the database before calling provider
  this.db.exec('BEGIN IMMEDIATE');

  let attempt;

  try {
    attempt = this.db.prepare(
      'SELECT * FROM attempts WHERE ticket_id = ? AND version = ?'
    ).get(id, t.version);

    if (attempt) {
      throw new DeskError(
        409,
        'This reply version already has a send attempt'
      );
    }

    const clientRef = randomUUID();

    this.db.prepare(`
      INSERT INTO attempts
        (ticket_id, version, client_ref, body, state)
      VALUES (?, ?, ?, ?, 'PENDING')
    `).run(id, t.version, clientRef, t.draft);

    this.db.prepare(`
      UPDATE tickets SET send_state = 'SENDING' WHERE id = ?
    `).run(id);

    record(this.db, id, 'send_started', clientRef);

    attempt = this.db.prepare(
      'SELECT * FROM attempts WHERE ticket_id = ? AND version = ?'
    ).get(id, t.version);

    this.db.exec('COMMIT');
  } catch (error) {
    this.db.exec('ROLLBACK');
    throw error;
  }

  // 4. Send using the persisted clientRef
  try {
    const result = await this.provider.send({
      clientRef: attempt.client_ref,
      ticketId: id,
      body: attempt.body
    });

    this.db.prepare(`
      UPDATE attempts
      SET state = 'SENT', provider_id = ?
      WHERE id = ?
    `).run(result.providerMessageId, attempt.id);

    this.db.prepare(`
      UPDATE tickets SET send_state = 'SENT' WHERE id = ?
    `).run(id);

    record(this.db, id, 'sent',
      `${automatic ? 'automation' : actor.id}: ${result.providerMessageId}`);

    return this.getTicket(actor, id);

  // } catch (error) {
  //   // Provider explicitly confirmed rejection
  //   if (error.kind === 'not_accepted') {
  //     this.db.prepare(`
  //       UPDATE attempts SET state = 'FAILED' WHERE id = ?
  //     `).run(attempt.id);

  //     this.db.prepare(`
  //       UPDATE tickets SET send_state = 'FAILED' WHERE id = ?
  //     `).run(id);

  //     record(this.db, id, 'send_failed', 'Provider explicitly rejected');

  //   } else {
  //     // Timeout/network error: delivery may already have happened
  //     this.db.prepare(`
  //       UPDATE attempts SET state = 'UNKNOWN' WHERE id = ?
  //     `).run(attempt.id);

  //     this.db.prepare(`
  //       UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ?
  //     `).run(id);

  //     record(this.db, id, 'send_unknown', attempt.client_ref);
  //   }

  //   throw new DeskError(502, 'Send result uncertain. Reconciliation required.');
  // }

  // fixed
  
  } catch (error) {
    // Provider explicitly confirmed rejection
    if (error.kind === 'not_accepted') {
      this.db.prepare(`
        UPDATE attempts SET state = 'FAILED' WHERE id = ?
      `).run(attempt.id);

      this.db.prepare(`
        UPDATE tickets SET send_state = 'FAILED' WHERE id = ?
      `).run(id);

      record(this.db, id, 'send_failed', 'Provider explicitly rejected');

      throw new DeskError(
        502,
        'Provider rejected the reply. It was not sent.'
      );
    }

    // Timeout/network error: delivery may already have happened
    this.db.prepare(`
      UPDATE attempts SET state = 'UNKNOWN' WHERE id = ?
    `).run(attempt.id);

    this.db.prepare(`
      UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ?
    `).run(id);

    record(this.db, id, 'send_unknown', attempt.client_ref);

    throw new DeskError(
      502,
      'Send result uncertain. Reconciliation required.'
    );
  }
}



  // async reconcile(actor, id) {
  //   this.row(actor, id);
  //   throw new DeskError(501, 'Reconciliation has not been implemented');
  // }
  // fixed part
  
async reconcile(actor, id) {
  this.row(actor, id);

  const attempt = this.db.prepare(`
    SELECT * FROM attempts
    WHERE ticket_id = ?
    AND state = 'UNKNOWN'
    ORDER BY id DESC
    LIMIT 1
  `).get(id);

  if (!attempt) {
    throw new DeskError(409, 'No uncertain delivery to reconcile');
  }

  const result = await this.provider.lookup(attempt.client_ref);

  if (result.state === 'delivered') {
    this.db.prepare(`
      UPDATE attempts
      SET state = 'SENT', provider_id = ?
      WHERE id = ?
    `).run(result.providerMessageId, attempt.id);

    this.db.prepare(`
      UPDATE tickets SET send_state = 'SENT'
      WHERE id = ?
    `).run(id);

    record(this.db, id, 'reconciled_sent', attempt.client_ref);

  } else if (result.state === 'not_found') {
    record(this.db, id, 'reconciliation_not_found', attempt.client_ref);
  }

  return this.getTicket(actor, id);
}

}
