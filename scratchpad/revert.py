import sys
which = sys.argv[1]
D='src/server/modules/payments/dunning.ts'
G='src/server/modules/payments/gateway.ts'
M='src/server/modules/payments/module.ts'
def rd(p): return open(p).read()
def wr(p,s): open(p,'w').write(s)

if which == 'A':
    s = rd(D)
    a = """    if (invoice.amount_due > 0) {
      this.recordPartialCollection(orgId, campaign, invoice, charge);
      return;
    }
"""
    assert a in s; wr(D, s.replace(a, '', 1))
elif which == 'B':
    s = rd(G)
    start = s.index('    if (this.nothingLeftToCollect(invoice)) {')
    end = s.index('    // Billing listens for this and moves the subscription to `past_due` through', start)
    wr(G, s[:start] + s[end:])
elif which == 'C':
    s = rd(D)
    start = s.index('      const sub = campaign.subscription ? this.ctx.svc.billing.subscription(orgId, campaign.subscription) : null;')
    end = s.index('      // A debit already with the bank is not a reason to present the bill', start)
    wr(D, s[:start] + s[end:])
elif which == 'D':
    s = rd(M)
    old = "      store.dunning.stopFor(event.org_id, invoiceId, 'The invoice was settled, so recovery stopped.');"
    new = """      const byCharge = ctx.db.count(
        `SELECT COUNT(*) FROM payments_charges WHERE org_id = ? AND invoice_id = ? AND status = 'succeeded'`,
        event.org_id, invoiceId,
      );
      if (byCharge > 0) return;
      store.dunning.stopFor(event.org_id, invoiceId, 'The invoice was settled outside the retry schedule, so recovery stopped.');"""
    assert old in s; wr(M, s.replace(old, new, 1))
elif which == 'restore':
    wr(D, rd('scratchpad/dunning.fixed.ts'))
    wr(G, rd('scratchpad/gateway.fixed.ts'))
    wr(M, rd('scratchpad/module.fixed.ts'))
print('done', which)
