/* Data layer for the CTG4U consignment billing site.
 *
 * Everything the app knows about Supabase lives here. The UI never touches the
 * client directly, so the shape the calculation engine expects (calc.js) is
 * translated in exactly one place.
 */
(function (root) {
  'use strict';

  var CFG = root.CB_CONFIG;

  // Stop here rather than let supabase-js throw an opaque URL error.
  if (!CFG || !CFG.ready || !CFG.ready()) {
    root.DB_UNCONFIGURED = true;
    // The stub answers the calls both pages make on load, so a misconfigured
    // deployment shows the message instead of a console full of TypeErrors.
    root.DB = {
      unconfigured: true,
      onAuth: function () { },
      session: function () { return Promise.resolve(null); },
      me: function () { return Promise.resolve(null); },
      signOut: function () { return Promise.resolve(); }
    };
    var warn = 'This site has not been connected to its database yet. ' +
      'Fill in SUPABASE_URL and SUPABASE_KEY in assets/config.js.';
    root.addEventListener('DOMContentLoaded', function () {
      var g = document.getElementById('gate');
      if (g) {
        document.getElementById('gateTitle').textContent = 'Not configured';
        document.getElementById('gateMsg').textContent = warn;
        g.style.display = 'grid';
      } else {
        var t = document.getElementById('toast');
        if (t) { var d = document.createElement('div'); d.className = 'bad'; d.textContent = warn; t.appendChild(d); }
      }
    });
    return;
  }

  var sb = root.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    db: { schema: CFG.SCHEMA }
  });

  function fail(where, error) {
    if (!error) return;
    var e = new Error(where + ': ' + (error.message || error));
    e.code = error.code; e.details = error.details;
    throw e;
  }
  function rows(res, where) { fail(where, res.error); return res.data || []; }
  function one(res, where) { fail(where, res.error); return res.data; }

  /* ------------------------------------------------------------- session */

  var DB = {
    client: sb,

    onAuth: function (cb) {
      sb.auth.onAuthStateChange(function (_e, session) { cb(session); });
    },
    session: function () {
      return sb.auth.getSession().then(function (r) { return r.data.session; });
    },
    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password })
        .then(function (r) { fail('Sign in', r.error); return r.data; });
    },
    signUp: function (email, password, fullName) {
      return sb.auth.signUp({
        email: email, password: password,
        options: { data: { full_name: fullName || '' } }
      }).then(function (r) { fail('Sign up', r.error); return r.data; });
    },
    resetPassword: function (email) {
      return sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/index.html' })
        .then(function (r) { fail('Password reset', r.error); return true; });
    },
    signOut: function () { return sb.auth.signOut(); },

    /* A confirmation or password-reset link comes back one of two ways: PKCE
     * puts ?code= on the query and supabase-js exchanges it itself, while the
     * implicit flow puts #access_token=&refresh_token= on the fragment and it
     * does not. Without this, a visitor who just confirmed their address lands
     * on the sign-in page holding a perfectly good session the app never saw,
     * and has to type their password for no reason.
     * Resolves to the session, or null when the URL carries nothing. */
    consumeUrlSession: function () {
      var h = root.location.hash || '';
      if (h.indexOf('access_token=') < 0) return Promise.resolve(null);
      var q = new URLSearchParams(h.replace(/^#/, ''));
      var at = q.get('access_token'), rt = q.get('refresh_token');
      var clear = function () {
        // never leave tokens sitting in the address bar or the history entry
        root.history.replaceState({}, document.title,
          root.location.pathname + root.location.search);
      };
      if (!at || !rt) { clear(); return Promise.resolve(null); }
      return sb.auth.setSession({ access_token: at, refresh_token: rt })
        .then(function (r) {
          clear();
          if (r.error) throw new Error(r.error.message);
          return r.data.session;
        }, function (e) { clear(); throw e; });
    },

    /* The signed-in user's own row. A brand-new sign-up is 'pending' and can
     * read nothing else until an admin promotes it.
     *
     * The .eq() is not optional. An admin's RLS policy returns EVERY row of
     * app_users, so an unfiltered maybeSingle() sees more than one and resolves
     * to null — which the app reads as "no account yet" and shows the owner a
     * screen telling them to ask an administrator for access. It works right up
     * until the second person signs up, and then locks the admin out. */
    me: function () {
      return sb.auth.getUser().then(function (u) {
        var id = u.data && u.data.user && u.data.user.id;
        if (!id) return null;
        return sb.from('app_users').select('*').eq('id', id).maybeSingle()
          .then(function (r) {
            // No row yet can only mean the sign-up trigger has not fired; treat as pending.
            if (r.error && r.error.code !== 'PGRST116') fail('Load account', r.error);
            return r.data || null;
          });
      });
    },
    listUsers: function () {
      return sb.from('app_users').select('*').order('email').then(function (r) { return rows(r, 'List users'); });
    },
    setUserRole: function (id, role, active) {
      return sb.from('app_users').update({ role: role, active: active, updated_at: new Date().toISOString() })
        .eq('id', id).then(function (r) { fail('Update user', r.error); return true; });
    },

    /* -------------------------------------------------------- master data */

    /* Returns the exact shape calc.js wants: pharmacies / projects / products,
     * with products.project holding the brand owner CODE. */
    loadMaster: function () {
      return Promise.all([
        sb.from('pharmacies').select('*').order('code'),
        sb.from('brand_owners').select('*').order('code'),
        sb.from('products').select('*, brand_owners(code)').order('name')
      ]).then(function (r) {
        var ph = rows(r[0], 'Load pharmacies');
        var bo = rows(r[1], 'Load brand owners');
        var pr = rows(r[2], 'Load products');
        return {
          pharmacies: ph.map(function (p) {
            return {
              id: p.id, code: p.code, contact: p.contact, trading: p.trading,
              tin: p.tin || '', brn: p.brn || '', email: p.email || '', state: p.state || '',
              town: p.town || '', lat: p.lat, lng: p.lng,
              trackingOption: p.tracking_option || '',
              aliases: p.aliases || [], active: p.active
            };
          }),
          projects: bo.map(function (b) {
            return {
              id: b.id, code: b.code, name: b.name,
              xeroContact: b.xero_contact, email: b.email || '',
              trackingOption: b.tracking_option || '', active: b.active
            };
          }),
          products: pr.map(function (p) {
            return {
              id: p.id, sku: p.sku || '', name: p.name,
              project: p.brand_owners ? p.brand_owners.code : '',
              brandOwnerId: p.brand_owner_id,
              aliases: p.aliases || [], active: p.active
            };
          })
        };
      });
    },

    savePharmacy: function (p) {
      var row = {
        code: p.code, contact: p.contact, trading: p.trading,
        tin: p.tin || null, brn: p.brn || null, email: p.email || null,
        state: p.state || null, tracking_option: p.trackingOption || null,
        aliases: p.aliases || [], active: p.active !== false,
        updated_at: new Date().toISOString()
      };
      var q = p.id ? sb.from('pharmacies').update(row).eq('id', p.id).select().single()
        : sb.from('pharmacies').insert(row).select().single();
      return q.then(function (r) { return one(r, 'Save pharmacy'); });
    },

    /* Bulk upsert on code — used by the seed import and the master xlsx import.
     * Existing rows keep their id, so nothing that references them breaks. */
    upsertPharmacies: function (list) {
      var now = new Date().toISOString();
      return sb.from('pharmacies').upsert(list.map(function (p) {
        return {
          code: p.code, contact: p.contact, trading: p.trading,
          tin: p.tin || null, brn: p.brn || null, email: p.email || null,
          state: p.state || null, aliases: p.aliases || [], active: p.active !== false,
          updated_at: now
        };
      }), { onConflict: 'code' }).select()
        .then(function (r) { return rows(r, 'Import pharmacies'); });
    },

    saveBrandOwner: function (b) {
      var row = {
        code: b.code, name: b.name, xero_contact: b.xeroContact,
        email: b.email || null, tracking_option: b.trackingOption || null,
        active: b.active !== false,
        updated_at: new Date().toISOString()
      };
      var q = b.id ? sb.from('brand_owners').update(row).eq('id', b.id).select().single()
        : sb.from('brand_owners').insert(row).select().single();
      return q.then(function (r) { return one(r, 'Save brand owner'); });
    },
    deleteBrandOwner: function (id) {
      return sb.from('brand_owners').delete().eq('id', id)
        .then(function (r) { fail('Delete brand owner', r.error); return true; });
    },

    saveProduct: function (p) {
      var row = {
        sku: p.sku || null, name: p.name, brand_owner_id: p.brandOwnerId,
        aliases: p.aliases || [], active: p.active !== false,
        updated_at: new Date().toISOString()
      };
      var q = p.id ? sb.from('products').update(row).eq('id', p.id).select().single()
        : sb.from('products').insert(row).select().single();
      return q.then(function (r) { return one(r, 'Save product'); });
    },
    deleteProduct: function (id) {
      return sb.from('products').delete().eq('id', id)
        .then(function (r) { fail('Delete product', r.error); return true; });
    },

    /* An operator-confirmed name. Stored so the same spelling resolves by itself
     * next month instead of being re-judged by fuzzy matching. */
    /* Appended in the database, in one statement.
     *
     * These read the array, changed it here, and wrote the whole thing back.
     * Two aliases saved in the same moment meant the second write carried a
     * copy of the array from before the first, and one of them vanished. This
     * application is routinely used with two tabs open - that is exactly how a
     * stale read overwrote the fee rates once already - so the window is not
     * theoretical. */
    addProductAlias: function (id, alias) {
      return sb.rpc('product_add_alias', { p_id: id, p_alias: alias })
        .then(function (r) { fail('Save alias', r.error); return r.data || []; });
    },
    addPharmacyAlias: function (id, alias) {
      return sb.rpc('pharmacy_add_alias', { p_id: id, p_alias: alias })
        .then(function (r) { fail('Save alias', r.error); return r.data || []; });
    },

    /* ------------------------------------------------------------ settings */

    loadSettings: function () {
      return sb.from('settings').select('data').eq('id', true).maybeSingle()
        .then(function (r) {
          if (r.error && r.error.code !== 'PGRST116') fail('Load settings', r.error);
          return r.data ? r.data.data : null;
        });
    },
    saveSettings: function (data) {
      return sb.from('settings').upsert({
        id: true, data: data, updated_at: new Date().toISOString()
      }, { onConflict: 'id' }).then(function (r) { fail('Save settings', r.error); return true; });
    },

    /* ---------------------------------------------------------------- runs */

    /* League tables for the dashboard. Aggregated in the database because
     * seventy pharmacies across a year of runs is far more row traffic than the
     * answer is worth, and finalised runs only - a draft can still be rebuilt or
     * abandoned, so counting one would disagree with what was actually invoiced. */
    dashboard: function (fromPeriod, toPeriod) {
      return sb.rpc('dashboard_stats', {
        p_from: fromPeriod || null,
        p_to: toPeriod || null
      }).then(function (r) {
        if (r.error) throw new Error('Dashboard: ' + r.error.message);
        return r.data || {};
      });
    },
    listRuns: function (limit) {
      return sb.from('runs').select('*').order('period', { ascending: false })
        .order('created_at', { ascending: false }).limit(limit || 50)
        .then(function (r) { return rows(r, 'List runs'); });
    },
    getRun: function (id) {
      return Promise.all([
        sb.from('runs').select('*').eq('id', id).single(),
        sb.from('run_settlements').select('*, brand_owners(code,name,xero_contact,email)').eq('run_id', id),
        sb.from('documents').select('*').eq('run_id', id).order('number')
      ]).then(function (r) {
        return {
          run: one(r[0], 'Load run'),
          settlements: rows(r[1], 'Load settlements'),
          documents: rows(r[2], 'Load documents')
        };
      });
    },
    /* Has this period already been billed? Asked before every run so a month is
     * never invoiced twice by two people. */
    periodStatus: function (period) {
      return Promise.all([
        sb.from('runs').select('id,status,created_at,totals').eq('period', period),
        sb.from('documents').select('doc_type,number').eq('period', period).limit(1000)
      ]).then(function (r) {
        var rs = rows(r[0], 'Check period'), docs = rows(r[1], 'Check documents');
        return {
          runs: rs,
          finalised: rs.some(function (x) { return x.status === 'final'; }),
          documentCount: docs.length
        };
      });
    },

    createRun: function (period, cfg, totals, sourceFiles) {
      return sb.from('runs').insert({
        period: period, status: 'draft', cfg: cfg, totals: totals,
        source_files: sourceFiles || []
      }).select().single().then(function (r) { return one(r, 'Create run'); });
    },
    saveRunLines: function (runId, lines) {
      if (!lines.length) return Promise.resolve(0);
      var chunks = [], size = 500;
      for (var i = 0; i < lines.length; i += size) chunks.push(lines.slice(i, i + size));
      return chunks.reduce(function (p, c) {
        return p.then(function () {
          return sb.from('run_lines').insert(c.map(function (l) {
            return {
              run_id: runId,
              pharmacy_id: l.pharmacy ? l.pharmacy.id : null,
              brand_owner_id: l.project ? l.project.id : null,
              source_sheet: l._sheet || null, source_row: l._row || null,
              pharmacy_raw: l.pharmacyRaw || null, product_raw: l.productRaw || null,
              qty: l.qty, unit_price: l.unitPrice,
              gross: l.gross, discount: l.discount, net: l.net,
              issues: l.issues || []
            };
          })).then(function (r) { fail('Save run lines', r.error); });
        });
      }, Promise.resolve()).then(function () { return lines.length; });
    },
    /* Atomic. Two people finalising at the same second get different blocks. */
    reserveNumbers: function (docType, period, count) {
      return sb.rpc('reserve_doc_numbers', {
        p_doc_type: docType, p_period: period, p_count: count
      }).then(function (r) { fail('Reserve document numbers', r.error); return r.data; });
    },
    /* The second half of finalising, as one statement that either happens or
     * does not.
     *
     * It used to be three more round trips after the rows were uploaded -
     * settlements, then document numbers, then the flip to 'final' - and the
     * connection can stop between any two. Nothing was ever mis-invoiced by
     * that, because the flip came last, but a failure on the last step meant
     * the operator retried and got a SECOND run while the first kept the
     * document numbers it had already recorded.
     *
     * The database also does the checks that used to live in the browser: that
     * this period has no finalised run yet, taken under a row lock rather than
     * as a read that happened some time ago, and that every uploaded batch of
     * rows actually landed. */
    commitRun: function (runId, expectedLines, totals, projects, docs) {
      return sb.rpc('commit_run', {
        p_run_id: runId,
        p_expected_lines: expectedLines,
        p_totals: totals,
        p_settlements: projects.map(function (P) {
          return {
            brand_owner_id: P.project.id,
            pharmacy_count: P.pharmacyCount,
            sales_amount: P.salesAmount, discount: P.discount, net_sales: P.netSales,
            mgmt_fee: P.mgmtFee, service_fee: P.serviceFee,
            insurance_fee: P.insuranceFee || 0, sst: P.sst,
            total_payout: P.totalPayout,
            fee_invoice_number: P.serviceInvoiceNumber || null,
            payout_bill_number: P.payoutBillNumber || null,
            by_pharmacy: P.byPharmacy.map(function (B) {
              return {
                code: B.pharmacy.code, trading: B.pharmacy.trading,
                gross: B.gross, discount: B.discount, net: B.net, mgmtFee: B.mgmtFee
              };
            })
          };
        }),
        p_documents: docs.map(function (d) {
          return {
            doc_type: d.docType, number: d.number,
            contact_name: d.contact, amount: d.amount,
            // named by id, never by contact name: branches of one legal entity
            // can share a name, and the Xero connector matches on this
            pharmacy_id: d.pharmacyId || null,
            brand_owner_id: d.brandOwnerId || null
          };
        })
      }).then(function (r) { fail('Finalise run', r.error); return r.data || {}; });
    },
    voidRun: function (runId, note) {
      return sb.from('runs').update({ status: 'void', note: note || null })
        .eq('id', runId).then(function (r) { fail('Void run', r.error); return true; });
    },
    deleteRun: function (runId) {
      return sb.from('runs').delete().eq('id', runId)
        .then(function (r) { fail('Delete run', r.error); return true; });
    },

    /* ------------------------------------------------------------- Xero */

    /* Every Xero call goes through the edge function. The browser holds no
     * Xero credential and never sees a token: it names a run and the server
     * rebuilds the invoices from what was stored when that run was finalised. */
    xero: {
      call: function (action, opts) {
        opts = opts || {};
        return sb.auth.getSession().then(function (r) {
          var t = r.data.session && r.data.session.access_token;
          if (!t) throw new Error('Sign in first.');
          return fetch(CFG.SUPABASE_URL + '/functions/v1/xero?action=' + encodeURIComponent(action), {
            method: opts.method || 'GET',
            headers: {
              Authorization: 'Bearer ' + t,
              apikey: CFG.SUPABASE_KEY,
              'Content-Type': 'application/json'
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined
          });
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            if (!res.ok || j.error) {
              throw new Error(j.error || ('The Xero connector returned ' + res.status));
            }
            return j;
          });
        });
      },
      status: function () { return DB.xero.call('status').then(function (r) { return r.status; }); },
      connect: function () { return DB.xero.call('connect').then(function (r) { return r.url; }); },
      disconnect: function () { return DB.xero.call('disconnect'); },
      /* Safe to call twice: documents already carrying a Xero invoice id are
       * skipped by the server, not re-sent. */
      post: function (runId) {
        return DB.xero.call('post', { method: 'POST', body: { runId: runId } });
      }
    },

    audit: function (action, detail) {
      return sb.from('audit_log').insert({ action: action, detail: detail || {} })
        .then(function () { return true; }, function () { return false; });   // never block work
    }
  };

  root.DB = DB;
})(window);
