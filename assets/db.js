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
  /* Only the columns the caller actually supplied.
   *
   * The save functions used to build a complete row every time, so any caller
   * that did not mention a column set it to null. The master xlsx import is
   * exactly such a caller - it carries six columns against a table of a dozen -
   * so exporting the master data and importing it back emptied every pharmacy
   * registration number, every brand owner's bank details, and both tracking
   * options. Nothing said so; the fields were simply gone next month.
   *
   * One field, state, was hand-preserved at that call site, which shows the
   * trap was already known. Preserving them one at a time only works until the
   * next column is added, so the answer is for the data layer not to write a
   * column it was told nothing about.
   *
   * To clear one deliberately, pass it: '' becomes null, as it did before.
   *
   * `spec` maps the shape the app uses to the columns the database has. A
   * value of true means store it as given; 'blank' means an empty string is a
   * cleared column rather than an empty one. */
  function pick(src, spec) {
    var row = {};
    Object.keys(spec).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) return;
      var s = spec[k];
      var col = typeof s === 'string' ? s : s[0];
      var blank = typeof s !== 'string' && s[1] === 'blank';
      row[col] = blank ? (src[k] === '' || src[k] == null ? null : src[k]) : src[k];
    });
    return row;
  }

  /* Rows for a bulk upsert, and the columns it refuses to touch.
   *
   * pick() protects a single save: a key the caller did not supply is not
   * written, so saving one field cannot blank another. A bulk upsert had no
   * such protection - it wrote every column unconditionally, turning an absent
   * field into null. Restoring a backup taken before TIN and BRN existed would
   * therefore have erased the TIN and BRN of every pharmacy in it, along with
   * every alias the operator had taught it, and reported success.
   *
   * A bulk upsert is one statement, so its columns have to be the same for
   * every row - there is no per-row "leave this alone". The conservative
   * reading is the one taken here: a column is written only if EVERY row in the
   * batch has something to say about it. A file that never mentions TIN cannot
   * clear anyone's TIN, and a file that mentions it for only some rows does not
   * get to null the rest. Setting one pharmacy's field is what the single-row
   * save is for.
   *
   * What was left alone is returned rather than assumed, because a quiet import
   * that skipped half the columns is its own kind of surprise. */
  function bulkRows(list, spec) {
    var keys = Object.keys(spec);
    var use = keys.filter(function (k) {
      return list.length && list.every(function (o) {
        return o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
      });
    });
    var skipped = keys.filter(function (k) { return use.indexOf(k) < 0; })
      .map(function (k) { return typeof spec[k] === 'string' ? spec[k] : spec[k][0]; });
    return {
      rows: list.map(function (o) {
        var row = {};
        use.forEach(function (k) {
          var col = typeof spec[k] === 'string' ? spec[k] : spec[k][0];
          row[col] = o[k] === '' ? null : o[k];
        });
        return row;
      }),
      skipped: skipped
    };
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
              bankName: b.bank_name || '', bankAccountName: b.bank_account_name || '',
              bankAccountNo: b.bank_account_no || '',
              address: b.address || '', phone: b.phone || '',
              brn: b.brn || '', taxNo: b.tax_no || '',
              xeroSyncedAt: b.xero_synced_at || null,
              trackingOption: b.tracking_option || '', active: b.active
            };
          }),
          products: pr.map(function (p) {
            return {
              id: p.id, sku: p.sku || '', name: p.name,
              project: p.brand_owners ? p.brand_owners.code : '',
              brandOwnerId: p.brand_owner_id,
              /* Without this every product reads as a single SKU, so bundles
                 would be offered as things to put INSIDE a bundle - refused by
                 the database, but only after the operator picked one. */
              isBundle: !!p.is_bundle,
              aliases: p.aliases || [], active: p.active
            };
          })
        };
      });
    },

    savePharmacy: function (p) {
      var row = pick(p, {
        code: 'code', contact: 'contact', trading: 'trading',
        tin: ['tin', 'blank'], brn: ['brn', 'blank'], email: ['email', 'blank'],
        state: ['state', 'blank'], trackingOption: ['tracking_option', 'blank'],
        town: ['town', 'blank'], lat: 'lat', lng: 'lng',
        aliases: 'aliases'
      });
      if (Object.prototype.hasOwnProperty.call(p, 'active')) row.active = p.active !== false;
      row.updated_at = new Date().toISOString();
      var q = p.id ? sb.from('pharmacies').update(row).eq('id', p.id).select().single()
        : sb.from('pharmacies').insert(row).select().single();
      return q.then(function (r) { return one(r, 'Save pharmacy'); });
    },

    /* Bulk upsert on code — used by the seed import and the master import.
     * Existing rows keep their id, so nothing that references them breaks. */
    upsertPharmacies: function (list) {
      var b = bulkRows(list, {
        code: 'code', contact: 'contact', trading: 'trading',
        tin: 'tin', brn: 'brn', email: 'email', state: 'state',
        town: 'town', lat: 'lat', lng: 'lng',
        aliases: 'aliases', trackingOption: 'tracking_option', active: 'active'
      });
      /* What was left alone rides back on the result so the caller can tell the
         operator. A file that silently updated three columns out of eight is a
         surprise worth having in front of them, not in a console they will
         never open. */
      if (!b.rows.length) {
        var none = []; none.skippedColumns = b.skipped; return Promise.resolve(none);
      }
      var now = new Date().toISOString();
      b.rows.forEach(function (r) { r.updated_at = now; });
      return sb.from('pharmacies').upsert(b.rows, { onConflict: 'code' }).select()
        .then(function (r) {
          var out = rows(r, 'Import pharmacies');
          out.skippedColumns = b.skipped;
          return out;
        });
    },

    /* A brand owner's details as Xero holds them, written with the moment they
     * were read. The statement prints the stored copy, not a live one: a
     * document reprinted a year later has to show the details it was issued
     * with, and printing must not depend on Xero being reachable. */
    syncBrandOwnerFromXero: function (id, x) {
      /* Only what Xero actually holds a value for. A blank field on the Xero
       * contact means Xero has nothing to say about it, not that the answer is
       * nothing - writing the blank through would let a pull erase something
       * typed here, which is the same way the master import used to empty a
       * column. What is missing is reported to the operator instead. */
      var row = { xero_synced_at: new Date().toISOString(),
                  updated_at: new Date().toISOString() };
      var take = {
        email: 'email', address: 'address', phone: 'phone',
        companyNumber: 'brn', taxNumber: 'tax_no',
        bankAccountDetails: 'bank_account_no'
      };
      Object.keys(take).forEach(function (k) {
        var v = String(x[k] == null ? '' : x[k]).trim();
        if (v) row[take[k]] = v;
      });
      return sb.from('brand_owners').update(row)
        .eq('id', id).then(function (r) { fail('Save Xero details', r.error); return true; });
    },

    saveBrandOwner: function (b) {
      var row = pick(b, {
        code: 'code', name: 'name', xeroContact: 'xero_contact',
        email: ['email', 'blank'], trackingOption: ['tracking_option', 'blank'],
        bankName: ['bank_name', 'blank'],
        bankAccountName: ['bank_account_name', 'blank'],
        bankAccountNo: ['bank_account_no', 'blank'],
        address: ['address', 'blank'], phone: ['phone', 'blank'],
        brn: ['brn', 'blank'], taxNo: ['tax_no', 'blank']
      });
      if (Object.prototype.hasOwnProperty.call(b, 'active')) row.active = b.active !== false;
      row.updated_at = new Date().toISOString();
      var q = b.id ? sb.from('brand_owners').update(row).eq('id', b.id).select().single()
        : sb.from('brand_owners').insert(row).select().single();
      return q.then(function (r) { return one(r, 'Save brand owner'); });
    },
    deleteBrandOwner: function (id) {
      return sb.from('brand_owners').delete().eq('id', id)
        .then(function (r) { fail('Delete brand owner', r.error); return true; });
    },

    saveProduct: function (p) {
      var row = pick(p, {
        sku: ['sku', 'blank'], name: 'name', brandOwnerId: 'brand_owner_id',
        aliases: 'aliases', isBundle: 'is_bundle'
      });
      if (Object.prototype.hasOwnProperty.call(p, 'active')) row.active = p.active !== false;
      row.updated_at = new Date().toISOString();
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
              /* Which product the line resolved to, and what was inside it if it
                 was a bundle. The resolver worked both out; the run used to keep
                 neither, so the stock ledger would have had to match the raw
                 text a second time and could have reached a different answer
                 than the month was billed on. */
              product_id: l.product ? l.product.id : null,
              parts: (l.parts && l.parts.length) ? l.parts : null,
              qty: l.qty, unit_price: l.unitPrice,
              gross: l.gross, discount: l.discount, net: l.net,
              issues: l.issues || []
            };
          })).then(function (r) { fail('Save run lines', r.error); });
        });
      }, Promise.resolve()).then(function () { return lines.length; });
    },
    /* ------------------------------------------------------------- stock */

    /* Every movement is a row and the balance is their sum, so there is no
     * stored total that can drift from its own history. */
    stock: {
      balances: function (pharmacyId, brandOwnerId) {
        return sb.rpc('stock_balances', {
          p_pharmacy: pharmacyId || null, p_brand_owner: brandOwnerId || null
        }).then(function (r) { fail('Read stock', r.error); return r.data || []; });
      },
      /* Replaces the whole opening set for one pharmacy - an opening balance is
         a figure somebody counted, and half-applying it is worse than not. */
      setOpening: function (pharmacyId, on, rows) {
        return sb.rpc('stock_set_opening', {
          p_pharmacy: pharmacyId, p_on: on || null, p_rows: rows || []
        }).then(function (r) { fail('Save opening stock', r.error); return r.data; });
      },
      move: function (pharmacyId, productId, on, qty, kind, note) {
        return sb.rpc('stock_move', {
          p_pharmacy: pharmacyId, p_product: productId, p_on: on || null,
          p_qty: qty, p_kind: kind, p_note: note || null
        }).then(function (r) { fail('Record stock movement', r.error); return r.data; });
      },
      /* Posting is idempotent in the database, so a retry after a dropped
         connection cannot decrement the shelf twice. */
      postRun: function (runId) {
        return sb.rpc('stock_post_run', { p_run_id: runId })
          .then(function (r) { fail('Post stock for this run', r.error); return r.data || {}; });
      },
      unpostRun: function (runId) {
        return sb.rpc('stock_unpost_run', { p_run_id: runId })
          .then(function (r) { fail('Take back stock for this run', r.error); return r.data; });
      },
      /* opening + in - out = closing for a window, both ends derived from the
         same rows so the report cannot disagree with itself */
      movement: function (from, to, pharmacyId, brandOwnerId) {
        return sb.rpc('stock_movement', {
          p_from: from, p_to: to,
          p_pharmacy: pharmacyId || null, p_brand_owner: brandOwnerId || null
        }).then(function (r) { fail('Read stock movement', r.error); return r.data || []; });
      },
      /* Whether a run's sales ever reached the ledger. Asked by the run detail,
         because "finalised" and "the shelves know about it" are two different
         facts and until now only one of them was ever shown. */
      postedCount: function (runId) {
        return sb.from('stock_movements').select('id', { count: 'exact', head: true })
          .eq('run_id', runId)
          .then(function (r) { fail('Check posted stock', r.error); return r.count || 0; });
      },
      history: function (pharmacyId, productId) {
        return sb.from('stock_movements')
          .select('moved_on,qty,kind,period,note,run_id')
          .eq('pharmacy_id', pharmacyId).eq('product_id', productId)
          .order('moved_on', { ascending: false }).limit(200)
          .then(function (r) { return rows(r, 'Read stock history'); });
      }
    },

    /* -------------------------------------------------- delivery orders */

    /* Raising the delivery order is what puts the stock in. One write, so the
     * paper the pharmacy signed and the ledger cannot disagree. */
    deliveries: {
      list: function (pharmacyId, from, to) {
        return sb.rpc('delivery_list', {
          p_pharmacy: pharmacyId || null, p_from: from || null, p_to: to || null
        }).then(function (r) { fail('Read delivery orders', r.error); return r.data || []; });
      },
      get: function (id) {
        return sb.rpc('delivery_get', { p_id: id })
          .then(function (r) { fail('Read delivery order', r.error); return r.data || null; });
      },
      create: function (pharmacyId, on, prefix, reference, note, rows) {
        return sb.rpc('delivery_create', {
          p_pharmacy: pharmacyId, p_on: on, p_prefix: prefix || 'CTGDO',
          p_reference: reference || null, p_note: note || null, p_rows: rows || []
        }).then(function (r) { fail('Raise delivery order', r.error); return r.data || {}; });
      },
      /* Cancelling takes the stock back out but keeps the document - the
         number is already on paper at the pharmacy. */
      cancel: function (id, reason) {
        return sb.rpc('delivery_cancel', { p_id: id, p_reason: reason || null })
          .then(function (r) { fail('Cancel delivery order', r.error); return r.data || {}; });
      }
    },

    /* ----------------------------------------------------------- bundles */

    /* What a package contains. Used to move stock wherever a sheet does not
     * state its own contents - where it does, the sheet wins. */
    bundles: {
      list: function (brandOwnerId) {
        return sb.rpc('bundle_list', { p_brand_owner: brandOwnerId || null })
          .then(function (r) { fail('Read bundles', r.error); return r.data || []; });
      },
      /* Replaces the whole recipe: a component left out is one removed, which
         is what the screen says it is doing. */
      setComponents: function (bundleId, rows) {
        return sb.rpc('bundle_set_components', { p_bundle: bundleId, p_rows: rows || [] })
          .then(function (r) { fail('Save bundle', r.error); return r.data; });
      },
      /* Creates whatever the file names and does not exist yet, and reports it
         rather than doing it quietly - a typo becoming a new product is how one
         master list turns into two of everything. */
      /* The monthly promotion workbook is one sheet per brand, twenty-seven at
         once. Selecting a brand owner twenty-seven times is not a workflow, so
         each row carries the owner it belongs to. */
      importMany: function (rows) {
        return sb.rpc('bundle_import_many', { p_rows: rows || [] })
          .then(function (r) { fail('Import promotion workbook', r.error); return r.data || {}; });
      },
      import: function (brandOwnerId, rows) {
        return sb.rpc('bundle_import', { p_brand_owner: brandOwnerId, p_rows: rows || [] })
          .then(function (r) { fail('Import bundles', r.error); return r.data || {}; });
      }
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
      /* The organisation's own registered details, for the head of a statement.
         Read rather than retyped: Xero already holds them, and two copies of
         one fact eventually give two answers. */
      org: function () { return DB.xero.call('org').then(function (r) { return r.org; }); },
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
