import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const actor = { id: 'agent-alpha', tenantId: 'alpha' };
test('inbox lists only the signed-in tenant', () => {
  const s = new DeskService({ provider: {} });
  try { assert.deepEqual(s.listTickets(actor).map(t => t.id), [101]); } finally { s.close(); }
});
test('a simple approved reply reaches a healthy provider', async () => {
  const delivered = [];
  const s = new DeskService({ provider: { send: async m => { delivered.push(m); return { providerMessageId: 'demo-1' }; } } });
  try {
    s.updateDraft(actor, 101, 'A human will help.'); s.approveDraft(actor, 101);
    const t = await s.sendReply(actor, 101);
    assert.equal(delivered.length, 1); assert.equal(t.send_state, 'SENT');
  } finally { s.close(); }
});


test('alpha cannot access beta ticket', () => {
  const s = new DeskService({ provider: {} });

  try {
    assert.throws(
      () => s.getTicket(actor, 202),
      { status: 404 }
    );
  } finally {
    s.close();
  }
});

// test two part

test('duplicate webhook event is stored only once', () => {
  const s = new DeskService({ provider: {} });

  const event = {
    tenantId: 'alpha',
    ticketId: 101,
    eventId: 'evt-duplicate-1',
    body: 'Please help me.'
  };

  try {
    const first = s.receiveWebhook(event);
    const second = s.receiveWebhook(event);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const ticket = s.getTicket(actor, 101);

    assert.equal(ticket.messages.length, 1);
    assert.equal(
      ticket.audit.filter(a => a.action === 'inbound').length,
      1
    );
  } finally {
    s.close();
  }
});


// regression test

test('editing a draft invalidates its previous approval', async () => {
  let sends = 0;

  const s = new DeskService({
    provider: {
      send: async () => {
        sends++;
        return { providerMessageId: 'demo-1' };
      }
    }
  });

  try {
    s.updateDraft(actor, 101, 'Original reply');
    s.approveDraft(actor, 101);

    s.updateDraft(actor, 101, 'Edited reply');

    await assert.rejects(
      s.sendReply(actor, 101),
      { status: 409 }
    );

    assert.equal(sends, 0);
  } finally {
    s.close();
  }
});

// concurrent send protection

test('concurrent sends dispatch only once', async () => {
  let sends = 0;

  const s = new DeskService({
    provider: {
      send: async () => {
        sends++;
        await new Promise(r => setTimeout(r, 100));
        return { providerMessageId: 'demo-1' };
      }
    }
  });

  try {
    s.updateDraft(actor, 101, 'Hello customer');
    s.approveDraft(actor, 101);

    const results = await Promise.allSettled([
      s.sendReply(actor, 101),
      s.sendReply(actor, 101)
    ]);

    assert.equal(sends, 1);
  } finally {
    s.close();
  }
});

// Add reconciliation test


test('uncertain delivery can be reconciled', async () => {
  const provider = {
    send: async () => {
      const error = new Error('Timeout');
      error.kind = 'unknown';
      throw error;
    },
    lookup: async (clientRef) => ({
      state: 'delivered',
      providerMessageId: 'provider-123',
      clientRef
    })
  };

  const s = new DeskService({ provider });

  try {
    s.updateDraft(actor, 101, 'Hello customer');
    s.approveDraft(actor, 101);

    await assert.rejects(
      s.sendReply(actor, 101),
      /uncertain/i
    );

    const ticket = await s.reconcile(actor, 101);

    assert.equal(ticket.send_state, 'SENT');
  } finally {
    s.close();
  }
});

// Human Takeover Test

test('automation cannot send after human takeover', async () => {
  let sends = 0;

  const provider = {
    send: async () => {
      sends++;
      return { providerMessageId: 'demo-123' };
    },
    lookup: async () => ({ state: 'not_found' })
  };

  const s = new DeskService({ provider });

  try {
    s.updateDraft(actor, 101, 'Hello customer');
    s.approveDraft(actor, 101);
    s.handoff(actor, 101);

    await assert.rejects(
      s.sendReply(actor, 101, { automatic: true }),
      /human/i
    );

    assert.equal(sends, 0);
  } finally {
    s.close();
  }
});

// same webhook event id test

test('same webhook event id is allowed across tenants', () => {
  const s = new DeskService({
    provider: {
      send: async () => ({ providerMessageId: 'demo' }),
      lookup: async () => ({ state: 'not_found' })
    }
  });

  try {
    assert.equal(
      s.receiveWebhook({
        tenantId: 'alpha',
        ticketId: 101,
        eventId: 'shared-event',
        body: 'Alpha message'
      }).duplicate,
      false
    );

    assert.equal(
      s.receiveWebhook({
        tenantId: 'beta',
        ticketId: 202,
        eventId: 'shared-event',
        body: 'Beta message'
      }).duplicate,
      false
    );
  } finally {
    s.close();
  }
});


// Provider rejection test



test('provider rejection marks reply as FAILED', async () => {
  const provider = {
    send: async () => {
      const error = new Error('Provider rejected');
      error.kind = 'not_accepted';
      throw error;
    },
    lookup: async () => ({ state: 'not_found' })
  };

  const s = new DeskService({ provider });

  try {
    s.updateDraft(actor, 101, 'Hello customer');
    s.approveDraft(actor, 101);

    // fixed
    // await assert.rejects(
    //   s.sendReply(actor, 101),
    //   /uncertain/i
    // );
await assert.rejects(s.sendReply(actor, 101), /rejected/i);
    const ticket = s.getTicket(actor, 101);

    assert.equal(ticket.send_state, 'FAILED');
    assert.equal(ticket.attempts[0].state, 'FAILED');
  } finally {
    s.close();
  }
});

// Restart recovery test

test('UNKNOWN delivery survives restart and reconciles without resending', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'justinsurance-'));
  const databasePath = join(folder, 'test.sqlite');

  let sendCalls = 0;

  try {
    // First application instance: provider accepts but times out
    const first = new DeskService({
      databasePath,
      provider: {
        send: async () => {
          sendCalls++;
          const error = new Error('Timeout after acceptance');
          error.kind = 'timeout';
          throw error;
        },
        lookup: async () => ({ state: 'delivered', providerMessageId: 'restart-demo-1' })
      }
    });

    first.updateDraft(actor, 101, 'Restart recovery test reply');
    first.approveDraft(actor, 101);

    await assert.rejects(first.sendReply(actor, 101), /uncertain/i);

    const beforeRestart = first.getTicket(actor, 101);
    assert.equal(beforeRestart.send_state, 'UNKNOWN');
    assert.equal(beforeRestart.attempts.length, 1);

    first.close();

    // Second application instance: same database, provider lookup confirms delivery
    const second = new DeskService({
      databasePath,
      provider: {
        send: async () => {
          sendCalls++;
          throw new Error('Should not resend');
        },
        lookup: async () => ({
          state: 'delivered',
          providerMessageId: 'restart-demo-1'
        })
      }
    });

    const recovered = await second.reconcile(actor, 101);

    assert.equal(recovered.send_state, 'SENT');
    assert.equal(recovered.attempts[0].state, 'SENT');
    assert.equal(sendCalls, 1); // Only the first send happened

    second.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});


// Overlapping Webhook Replay Test


test('overlapping webhook replay creates only one message', async () => {
  const s = new DeskService({ provider: {} });

  const event = {
    tenantId: 'alpha',
    ticketId: 101,
    eventId: 'overlap-event-001',
    body: 'Concurrent webhook message'
  };

  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => s.receiveWebhook(event))
    );

    const ticket = s.getTicket(actor, 101);

    assert.equal(results.length, 10);

    assert.equal(
      results.filter(result => result.duplicate).length,
      9
    );

    assert.equal(
      ticket.messages.filter(
        message => message.body === 'Concurrent webhook message'
      ).length,
      1
    );

    assert.equal(
      ticket.audit.filter(a => a.action === 'inbound').length,
      1
    );
  } finally {
    s.close();
  }
});

