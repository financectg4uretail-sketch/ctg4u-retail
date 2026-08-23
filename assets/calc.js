/* CTG4U RETAIL SDN BHD - Consignment Billing Engine
 * Pure calculation module. No DOM, no I/O. Loaded by index.html and by test.js under Node.
 *
 * Accounting model: AGENT / net presentation.
 *   Pharmacy collections are a pass-through liability owed to the brand owner (project party).
 *   CTG4U revenue = Pharmacy Management Fee (RM75 per pharmacy per brand owner) + Service Fee
 *   (3.8% of GROSS sales amount), both subject to 8% service tax.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- money */

  // Half-up to 2dp, immune to binary float noise (1.005 -> 1.01, not 1.00).
  function r2(n) {
    if (!isFinite(n)) return 0;
    var s = n < 0 ? -1 : 1, x = Math.abs(n);
    return s * Math.round((x + Number.EPSILON * x + 1e-9) * 100) / 100;
  }
  function sum(arr, f) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += f ? (f(arr[i], i) || 0) : (arr[i] || 0);
    return t;
  }
  // Money sums stay on 2dp values, so re-rounding kills accumulated float drift only.
  function sumMoney(arr, f) { return r2(sum(arr, f)); }

  function money(n) {
    var v = r2(n);
    return (v < 0 ? '-' : '') + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ------------------------------------------------------------ normalise */

  function normKey(s) {
    return String(s == null ? '' : s)
      .toUpperCase()
      .replace(/[.,''`"()\[\]\-_/\\&+]/g, ' ')
      .replace(/\bSDN\s*BHD\b|\bSDN\b|\bBHD\b|\bPLT\b|\bENTERPRISE\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) { return normKey(s).split(' ').filter(Boolean); }

  /* 0..1 similarity: exact > containment > token overlap (Jaccard).
   *
   * Containment is worth only what the lengths justify. It used to be a flat
   * 0.9 - comfortably above the threshold at which a match is applied without
   * asking - and normKey drops SDN BHD, so a pharmacy registered as WELL
   * PHARMACY SDN BHD normalises to "WELL PHARMACY" and is a substring of every
   * other WELL PHARMACY branch in the master. Type a branch that is not in the
   * master yet and the shortest name in the family won at 0.9, which is how a
   * newly opened branch's sales get invoiced to a different company that merely
   * shares a stem. The real sixty-two never showed it because an exact match
   * scores 1.0 and beats it - the damage only appears for a name nobody has
   * added, which is exactly when nobody is watching for it.
   *
   * Scaling by the length ratio says the honest thing: a short name sitting
   * inside a much longer one is weak evidence, not near-identity. The token
   * overlap is still taken when it is the better of the two, so shortening a
   * name rather than adding to it is unaffected. */
  function similarity(a, b) {
    var A = normKey(a), B = normKey(b);
    if (!A || !B) return 0;
    if (A === B) return 1;

    /* Same name, different idea of where the spaces go.
     *
     * normKey turns punctuation into spaces, so the real product Zeero-Basic-A-1
     * becomes "ZEERO BASIC A 1" while a pharmacy typing Zeero Basic A1 gives
     * "ZEERO BASIC A1". Compared as tokens those share only two of five and
     * score 0.4 - nowhere near a match - so the line arrives unattributed and
     * has to be resolved by hand every month. MIZINO PLACENTA 30S against
     * MIZINO PLACENTA 30 S fails the same way.
     *
     * Where the spaces fall is not information about which product this is, so
     * comparing with them removed says what a reader would: these are the same
     * name. Kept just below an exact match, since the strings did differ. */
    if (A.replace(/ /g, '') === B.replace(/ /g, '')) return 0.98;

    var ta = tokens(A), tb = tokens(B);
    if (!ta.length || !tb.length) return 0;
    var setB = {}, hit = 0;
    for (var i = 0; i < tb.length; i++) setB[tb[i]] = 1;
    for (var j = 0; j < ta.length; j++) if (setB[ta[j]]) hit++;
    var overlap = hit / (ta.length + tb.length - hit);

    if (A.indexOf(B) >= 0 || B.indexOf(A) >= 0) {
      /* Sub-linear in what is missing, because the two ends of this are not
       * symmetrical. Dropping a pack size - MIZINO PLACENTA for MIZINO PLACENTA
       * 30S - is the commonest way a pharmacy types a product and barely weakens
       * the evidence. A name that is only a small fragment of another - WELL
       * PHARMACY inside WELL PHARMACY ALLIANCE (TAMAN MOUNT AUSTIN) - is weak
       * evidence however neatly it sits inside.
       *
       * Scaling straight by the ratio treats those the same way and put the
       * dropped pack size at 0.71, a hundredth under the bar, which would have
       * meant confirming by hand most of the lines in a month. The square root
       * keeps it comfortably matched while leaving the fragment far below.
       *
       * Being generous at the top is only safe because ambiguity is caught
       * separately: if two products both contain the typed name they score the
       * same, tie, and resolveLines refuses rather than picking the first. */
      var ratio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
      return Math.max(overlap, 0.9 * Math.sqrt(ratio));
    }
    return overlap;
  }

  /* Best match in `list` for `needle`; `fields` are candidate name properties.
   *
   * `rivals` is the count of DIFFERENT entries that scored exactly as well.
   * Keeping only the first of equals is what a scoring loop does by default, and
   * it is silent: typing UNICARE PHARMACY ties eight branches at 0.90 and the
   * first one gets the invoice. Callers that decide who gets paid have to be
   * able to see that, so it is reported rather than hidden. */
  function bestMatch(needle, list, fields, threshold) {
    threshold = threshold == null ? 0.62 : threshold;
    var best = null, bestScore = 0, tied = [];
    for (var i = 0; i < list.length; i++) {
      for (var f = 0; f < fields.length; f++) {
        var s = similarity(needle, list[i][fields[f]]);
        if (s > bestScore) { bestScore = s; best = list[i]; tied = [list[i]]; }
        else if (s === bestScore && s > 0 && tied.indexOf(list[i]) < 0) tied.push(list[i]);
      }
    }
    return bestScore >= threshold
      ? { item: best, score: bestScore, rivals: tied.length, tied: tied }
      : null;
  }

  /* -------------------------------------------------------------- config */

  var DEFAULTS = {
    /* Who is issuing the statement. It goes in the header, the way any
     * remittance advice names the party sending the money, so a brand owner
     * can tell at a glance who this came from and where to write back. Left
     * blank rather than guessed: a registration number invented for a document
     * that goes to another company is worse than an absent one. */
    coName: 'CTG4U RETAIL SDN BHD',
    coReg: '',                   // company registration no
    coSst: '',                   // SST registration no, if registered
    coAddress: '',               // free text, newlines become lines
    coEmail: '',
    coPhone: '',

    discountPct: 19.20,          // pharmacy discount off gross sales
    mgmtFeePerPharmacy: 75.00,   // RM per pharmacy per brand owner per month
    serviceFeePct: 3.80,         // % of GROSS sales amount (not net)
    /* Two separate facts that were one setting, which is why turning the charge
     * off also broke the check on the pharmacy's own sheet.
     *
     * The RATE is what the pharmacy sheets print on their Insurans line, and it
     * is 0.8%. It is not deducted from what the pharmacy pays; it is there for
     * the pharmacy to see, and the cross-check reads it to confirm we are
     * looking at the same arrangement the sheet was built on.
     *
     * Whether it comes off the BRAND OWNER's payout is the separate question,
     * and the answer here is no. A contract that does charge it flips the
     * switch; the rate does not have to be falsified to stop the deduction. */
    insuranceFeePct: 0.80,       // what the pharmacy sheets state
    deductInsurance: false,      // whether the brand owner is charged it
    sstPct: 8.00,                // service tax on the fees
    sstOnMgmtFee: true,
    sstOnServiceFee: true,
    sstOnInsurance: false,       // insurance is not a taxable service by default

    /* Xero chart of accounts. Deliberately blank.
     *
     * These carried 320 / 500 / 510, which are not codes this organisation has -
     * it uses 400-0005, 500-0100 and 500-0200. A wrong code is not a small
     * error: Xero rejects every line carrying it, so a whole month's import
     * fails. The real values live in Settings, and a default here only decides
     * what happens when Settings is empty or has been reset. Refusing to build
     * is the right answer to that; inventing a plausible code is not. */
    acctPassThrough: '',         // Consignment Collections Payable - Brand Owners
    acctMgmtIncome: '',          // Pharmacy Management Fee Income
    acctServiceIncome: '',       // Consignment Service Fee Income
    acctInsuranceIncome: '',     // set this if insurance should land somewhere
                                 // other than service fee income

    taxTypeExempt: 'Tax Exempt', // pharmacy invoice + payout bill
    taxTypeSST: 'SST on Sales',  // MUST match the org's Xero tax rate name exactly

    /* Xero tracking. Naming the category switches it on; every line is then
     * tagged automatically from whichever side of the deal it belongs to.
     * Both the category and the option must exist in the organisation exactly
     * as spelled, or Xero rejects the line. */
    trackingCategory: '',        // e.g. 'Brand' - blank turns tracking off
    trackingBy: 'brandOwner',    // 'brandOwner' | 'pharmacy'
    trackingCategory2: '',       // Xero allows a second category
    trackingBy2: 'pharmacy',

    dueDays: 30,
    period: '',                  // 'YYYY-MM'
    invoiceDate: '',             // 'YYYY-MM-DD', defaults to period month-end
    pharmacyInvPrefix: 'CTG4U',  // -> CTG4U2607-0001
    serviceInvPrefix: 'CTGSF',
    payoutBillPrefix: 'CTGPO',
    startNumber: 1,
    // Per-type starts. The website reserves a block of numbers from the
    // database for each document type, so the three sequences advance
    // independently and a re-run can never reuse a number already in Xero.
    startPharmacy: 0,   // 0 = fall back to startNumber
    startFee: 0,
    startPayout: 0
  };

  function cfg(overrides) {
    var c = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) c[k] = DEFAULTS[k];
    if (overrides) for (k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k) && overrides[k] !== undefined && overrides[k] !== '') c[k] = overrides[k];
    }
    return c;
  }

  /* --------------------------------------------------------------- dates */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function monthEnd(period) {                    // 'YYYY-MM' -> 'YYYY-MM-DD'
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(period || ''));
    if (!m) return '';
    var y = +m[1], mo = +m[2];
    return y + '-' + pad(mo) + '-' + pad(new Date(y, mo, 0).getDate());
  }

  function monthStart(period) {                   // 'YYYY-MM' -> 'YYYY-MM-01'
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(period || ''));
    return m ? m[1] + '-' + pad(+m[2]) + '-01' : '';
  }

  function addDays(iso, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return iso;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    d.setUTCDate(d.getUTCDate() + (days || 0));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function dmy(iso) {                            // Xero import wants DD/MM/YYYY
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
  }

  function periodLabel(period) {
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(period || ''));
    if (!m) return String(period || '');
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[+m[2] - 1] + ' ' + m[1];
  }

  function periodYYMM(period) {
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(period || ''));
    return m ? m[1].slice(2) + pad(+m[2]) : '0000';
  }

  /* --------------------------------------------------------------- lines */

  /* A raw line coming out of the sold-out list:
   *   { pharmacyRaw, productRaw, qty, unitPrice, amount, dateRaw, _sheet, _row }
   * resolve() attaches: pharmacy (master obj|null), project (master obj|null),
   *                     gross, discount, net, issues[]
   */
  /* Auto-apply only above APPLY_AT; between SUGGEST_AT and APPLY_AT the match is
   * shown to the operator and applied only if they save it. */
  var APPLY_AT = 0.72, SUGGEST_AT = 0.5;

  function resolveLines(rawLines, master, c) {
    c = cfg(c);
    var disc = c.discountPct / 100;
    var pharmacies = master.pharmacies || [];
    var products = master.products || [];
    var projects = master.projects || [];

    // Product -> project lookup, exact first for speed then fuzzy.
    // Aliases are what the operator confirmed by hand in a previous month; they
    // win over fuzzy matching so a once-corrected name never drifts back.
    var prodIndex = {};
    products.forEach(function (p) {
      if (p.sku) prodIndex[normKey(p.sku)] = p;
      if (p.name) prodIndex[normKey(p.name)] = p;
      (p.aliases || []).forEach(function (a) { if (a) prodIndex[normKey(a)] = p; });
    });
    var pharmIndex = {};
    pharmacies.forEach(function (p) {
      (p.aliases || []).forEach(function (a) { if (a) pharmIndex[normKey(a)] = p; });
    });
    var projByCode = {};
    projects.forEach(function (p) { projByCode[normKey(p.code)] = p; projByCode[normKey(p.name)] = p; });

    var pharmCache = {}, prodCache = {};

    return rawLines.map(function (L, idx) {
      var out = {
        idx: idx,
        _sheet: L._sheet || '', _row: L._row || 0,
        pharmacyRaw: L.pharmacyRaw || '', productRaw: L.productRaw || '',
        qty: num(L.qty), unitPrice: num(L.unitPrice), dateRaw: L.dateRaw || '',
        issues: []
      };

      // --- pharmacy
      var pk = normKey(out.pharmacyRaw);
      if (!(pk in pharmCache)) {
        pharmCache[pk] = !out.pharmacyRaw ? null
          : pharmIndex[pk] ? { item: pharmIndex[pk], score: 1 }
            : bestMatch(out.pharmacyRaw, pharmacies, ['trading', 'contact', 'code']);
      }
      var pm = pharmCache[pk];

      /* A tie decides who gets the invoice, so it may not be broken quietly.
       * Eight UNICARE branches score 0.90 against a sheet that just says
       * UNICARE PHARMACY, and they are eight different Xero contacts - picking
       * the first of equals bills the wrong company and looks like success.
       * The confirmed alias still wins outright, which is how the operator
       * settles it once and never sees it again. Same rule the product side
       * already had for MIZINO PREMIUM against MIZINO PLACENTA. */
      var ambiguous = !!(pm && pm.score < 1 && pm.rivals > 1);
      out.pharmacy = pm && !ambiguous ? pm.item : null;
      out.pharmacyScore = pm ? pm.score : 0;
      out.pharmacySuggestion = ambiguous ? pm.item : null;
      out.pharmacyRivals = ambiguous ? pm.tied : null;
      if (!out.pharmacyRaw) out.issues.push('no pharmacy on row');
      else if (ambiguous) {
        out.issues.push('pharmacy name matches ' + pm.rivals + ' branches equally: ' +
          pm.tied.map(function (x) { return x.trading || x.contact; }).join(', '));
      } else if (!out.pharmacy) out.issues.push('pharmacy not in master: ' + out.pharmacyRaw);

      // --- product -> brand owner (project)
      var dk = normKey(out.productRaw);
      /* Two thresholds on purpose. Applying a match by itself has to be
       * conservative because it decides who gets paid; merely SUGGESTING one to
       * a human can be generous, since they still have to accept it. Zeero-A-1
       * against Zeero-A-2 scores only 0.60, so a single 0.72 gate would have
       * left the operator staring at an empty dropdown with no hint at all. */
      if (!(dk in prodCache)) {
        var exact = prodIndex[dk] || null, near = null, nearScore = 0;
        if (!exact && out.productRaw) {
          var bm = bestMatch(out.productRaw, products, ['sku', 'name'], SUGGEST_AT);
          if (bm) { near = bm.item; nearScore = bm.score; }
        }
        prodCache[dk] = { exact: exact, near: near, nearScore: nearScore };
      }
      var pc = prodCache[dk];

      /* Only an exact name, sku or confirmed alias may decide who gets paid.
       * `strictProduct` refuses the near match outright and offers it as a
       * suggestion instead, because these files carry MIZINO PREMIUM, MIZINO
       * PLACENTA and MIZINO ENZYME - three DIFFERENT legal entities sharing a
       * word. Similarity cannot tell them apart, and guessing wrong pays the
       * settlement to the wrong company. Same rule as the pharmacy rename path. */
      out.product = pc.exact ||
        (L.strictProduct || pc.nearScore < APPLY_AT ? null : pc.near);
      out.productSuggestion = (!out.product && pc.near) ? pc.near : null;
      out.productSuggestionScore = out.productSuggestion ? pc.nearScore : 0;

      /* Resolution order: what the product is mapped to wins, because one sheet
       * can now mix several brands. `projectCode` is the fallback a
       * single-brand file supplies for the whole sheet. */
      if (out.product) {
        out.project = projByCode[normKey(out.product.project)] || null;
        if (!out.project) out.issues.push('brand owner "' + out.product.project + '" not in master');
      } else if (L.projectCode) {
        out.project = projByCode[normKey(L.projectCode)] || null;
        if (!out.project) out.issues.push('brand owner "' + L.projectCode + '" not in master');
      } else {
        out.project = null;
      }

      if (!out.productRaw) {
        out.issues.push(L.strictProduct ? 'no package on row' : 'no product on row');
      } else if (!out.project) {
        out.issues.push('product not mapped to a brand owner: ' + out.productRaw);
      }

      // --- money. An explicit amount column wins; otherwise qty x unit price.
      var computed = r2(out.qty * out.unitPrice);
      var given = L.amount == null || L.amount === '' ? null : r2(num(L.amount));
      out.gross = given == null ? computed : given;
      if (given != null && out.qty && out.unitPrice && Math.abs(given - computed) > 0.02) {
        out.issues.push('amount ' + money(given) + ' != qty x price ' + money(computed));
      }
      if (!out.gross) out.issues.push('zero amount');
      /* Now that a bracketed figure is read as the credit it is, a return can
         reach the invoice. One negative line among positives is ordinary; it is
         a whole invoice going negative that is not, because that is a credit
         note and Xero wants it raised as one. Flagged here so it reaches the
         Review tab rather than being discovered in Xero. */
      else if (out.gross < 0) out.issues.push('credit row: ' + money(out.gross));
      // Discount is applied per line and rounded there, so the invoice, the
      // statement and the payout bill can never disagree by rounding.
      out.net = r2(out.gross * (1 - disc));
      out.discount = r2(out.gross - out.net);
      return out;
    });
  }

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v == null) return 0;
    var raw = String(v).trim();
    /* Accountants write a credit as (250.00). Stripping punctuation turned that
       into 250.00 and billed a returned pack as a sale - the sign is the whole
       meaning of the row, and it was the one character being thrown away. */
    var bracketed = /^\(.*\)$/.test(raw);
    var s = raw.replace(/[^\d.\-]/g, '');
    var n = parseFloat(s);
    if (!isFinite(n)) return 0;
    return bracketed ? -Math.abs(n) : n;
  }

  /* ---------------------------------------------------------- settlement */

  /* Builds, for each brand owner (project):
   *   byPharmacy[] : { pharmacy, gross, discount, net, mgmtFee, lines[] }
   *   salesAmount, discount, netSales, pharmacyCount,
   *   mgmtFee     = RM75 x pharmacyCount        (each brand owner pays its own RM75)
   *   serviceFee  = 3.8% x salesAmount (GROSS)
   *   sst         = 8%   x (mgmtFee + serviceFee)
   *   totalPayout = netSales - mgmtFee - serviceFee - sst
   */
  /* One collapsed sale: a pharmacy, a brand owner, a product at a price.
   *
   * BOTH sides of the deal are built from these same rows, and the money is
   * rounded HERE, once. It used to be rounded per raw row on one side and
   * recomputed by Xero from quantity x price on the other, and those two
   * disagreed on 68.8% of realistic price and row-count combinations by up to
   * three cents each - which is how a pass-through control account stops
   * clearing to zero and an auditor starts asking about it.
   *
   * The brand owner is part of the key. Without it, two brands whose product
   * names normalise to the same string at the same price would collapse into
   * one invoice line carrying whichever brand happened to arrive first, and the
   * settlement could no longer tell them apart. */
  function collapseItems(lines, c) {
    var disc = c.discountPct / 100;
    var map = {}, order = [];
    lines.forEach(function (L) {
      if (!isBillable(L)) return;
      var k = (L.pharmacy.code || L.pharmacy.trading) + '|' +
              (L.project.code || L.project.name) + '|' +
              normKey(L.productRaw) + '|' + r2(L.unitPrice).toFixed(2);
      if (!map[k]) {
        map[k] = {
          key: k, pharmacy: L.pharmacy, project: L.project,
          description: L.productRaw, unitPrice: r2(L.unitPrice),
          qty: 0, gross: 0, net: 0, discount: 0, lines: []
        };
        order.push(k);
      }
      var I = map[k];
      I.qty += L.qty;
      I.gross = r2(I.gross + L.gross);
      I.lines.push(L);
    });
    return order.map(function (k) {
      var I = map[k];
      I.net = r2(I.gross * (1 - disc));
      I.discount = r2(I.gross - I.net);
      return I;
    });
  }

  /* How this item has to be written on a Xero invoice so that Xero's own
   * arithmetic - quantity x unit amount, less the discount rate - lands on the
   * net above rather than near it. When the sheet's quantity and price
   * reproduce the gross, the invoice keeps showing them, which is what the
   * pharmacy expects to read. When they do not - an amount column that
   * disagrees, or a sheet with no quantity at all, which produced a RM0 invoice
   * against a full payout - the amount itself is billed and the detail moves
   * into words. A line Xero computes differently from the settlement is money
   * with no owner. */
  function invoiceShape(item, c) {
    var q = num(item.qty), u = r2(item.unitPrice);
    if (q > 0 && u > 0 && r2(q * u) === r2(item.gross)) {
      return { qty: q, unit: u, description: item.description };
    }
    return {
      qty: 1, unit: r2(item.gross),
      description: item.description +
        (q > 0 && u > 0 ? ' (' + q + ' x ' + money(u) + ')' : '')
    };
  }

  function buildSettlement(lines, c) {
    c = cfg(c);
    var projects = {}, order = [];
    var unmapped = lines.filter(function (L) { return !isBillable(L); });

    /* The same collapsed rows the pharmacy invoices are built from, so the two
       sides are summing identical figures rather than two roundings of one. */
    collapseItems(lines, c).forEach(function (I) {
      var pc = I.project.code || I.project.name;
      if (!projects[pc]) {
        projects[pc] = { project: I.project, code: pc, pharmMap: {}, pharmOrder: [], lines: [] };
        order.push(pc);
      }
      var P = projects[pc];
      P.lines = P.lines.concat(I.lines);
      var ph = I.pharmacy.code || I.pharmacy.trading;
      if (!P.pharmMap[ph]) {
        P.pharmMap[ph] = { pharmacy: I.pharmacy, items: [], lines: [] };
        P.pharmOrder.push(ph);
      }
      P.pharmMap[ph].items.push(I);
      P.pharmMap[ph].lines = P.pharmMap[ph].lines.concat(I.lines);
    });

    var out = order.map(function (pc) {
      var P = projects[pc];
      var byPharmacy = P.pharmOrder.map(function (ph) {
        var B = P.pharmMap[ph];
        var gross = sumMoney(B.items, function (i) { return i.gross; });
        var net = sumMoney(B.items, function (i) { return i.net; });
        return {
          pharmacy: B.pharmacy,
          lines: B.lines,
          items: B.items,
          gross: gross,
          discount: r2(gross - net),
          net: net,
          mgmtFee: r2(c.mgmtFeePerPharmacy)
        };
      });

      var salesAmount = sumMoney(byPharmacy, function (b) { return b.gross; });
      var netSales = sumMoney(byPharmacy, function (b) { return b.net; });
      var pharmacyCount = byPharmacy.length;
      var mgmtFee = r2(c.mgmtFeePerPharmacy * pharmacyCount);
      var serviceFee = r2(salesAmount * c.serviceFeePct / 100);
      var insuranceFee = c.deductInsurance
        ? r2(salesAmount * (c.insuranceFeePct || 0) / 100) : 0;
      var sstBase = r2(
        (c.sstOnMgmtFee ? mgmtFee : 0) +
        (c.sstOnServiceFee ? serviceFee : 0) +
        (c.sstOnInsurance ? insuranceFee : 0));
      var sst = r2(sstBase * c.sstPct / 100);
      var feesTotal = r2(mgmtFee + serviceFee + insuranceFee + sst);

      return {
        project: P.project,
        code: pc,
        lines: P.lines,
        byPharmacy: byPharmacy,
        pharmacyCount: pharmacyCount,
        salesAmount: salesAmount,
        discount: r2(salesAmount - netSales),
        netSales: netSales,
        mgmtFee: mgmtFee,
        serviceFee: serviceFee,
        insuranceFee: insuranceFee,
        sstBase: sstBase,
        sst: sst,
        feesTotal: feesTotal,
        totalPayout: r2(netSales - feesTotal)
      };
    });

    out.sort(function (a, b) { return b.salesAmount - a.salesAmount; });
    return { projects: out, unmapped: unmapped };
  }

  /* A line is billable only if it can be BOTH invoiced to a pharmacy and settled
   * to a brand owner. Both sides must use this one predicate: if the pharmacy
   * side accepted a line the settlement side rejected, CTG4U would collect money
   * it never owed to anyone and nobody would see it. */
  function isBillable(L) { return !!(L.pharmacy && L.project && L.gross); }

  /* Pharmacy-side view: one Xero invoice per pharmacy, one line per product. */
  function buildPharmacyBilling(lines, c) {
    c = cfg(c);
    var map = {}, order = [];
    collapseItems(lines, c).forEach(function (I) {
      var k = I.pharmacy.code || I.pharmacy.trading;
      if (!map[k]) { map[k] = { pharmacy: I.pharmacy, items: [] }; order.push(k); }
      map[k].items.push(I);
    });

    return order.map(function (k) {
      var P = map[k];
      var gross = sumMoney(P.items, function (i) { return i.gross; });
      var net = sumMoney(P.items, function (i) { return i.net; });
      return {
        pharmacy: P.pharmacy, items: P.items,
        gross: gross, discount: r2(gross - net), net: net
      };
    }).sort(function (a, b) { return b.net - a.net; });
  }

  /* The one control that must never be switched off: everything invoiced to the
   * pharmacies has to equal everything owed to the brand owners, because they are
   * the same money seen from two sides. Any difference is money with no owner. */
  function crossCheck(billing, settlement) {
    var billed = sumMoney(billing, function (b) { return b.net; });
    var owed = sumMoney(settlement.projects, function (p) { return p.netSales; });
    return {
      ok: Math.abs(r2(billed - owed)) < 0.005,
      billed: billed, owed: owed, diff: r2(billed - owed),
      excludedRows: settlement.unmapped.length,
      excludedGross: sumMoney(settlement.unmapped, function (l) { return l.gross; })
    };
  }

  /* -------------------------------------------------- sheet -> raw lines */

  var TOTAL_RE = /^(grand\s*|sub\s*)?total$|^jumlah( besar)?$|^总计$|^合计$|^小计$/i;

  /* A sale row must name a product. A row without one is a title, a spacer or a
   * TOTAL footer - and a footer carries the sheet's own total, so ingesting it
   * silently doubles the month. Returns a reason string, or '' if the row is real. */
  function noiseReason(r, map) {
    var cell = function (i) { return i == null ? '' : String(r[i] == null ? '' : r[i]).trim(); };
    var prod = cell(map.product);
    if (TOTAL_RE.test(prod)) return 'total row';
    if (!prod) {
      var anyTotal = r.some(function (v) { return TOTAL_RE.test(String(v == null ? '' : v).trim()); });
      return anyTotal ? 'total row' : 'no product';
    }
    return '';
  }

  /* sheet = { name, rows (header first), headerRow, map, pharmFromName }.
   * Shared by the app and the tests so both see exactly the same rows. */
  function extractRows(sheet) {
    var m = sheet.map, raw = [], skipped = [];
    sheet.rows.slice(1).forEach(function (r, i) {
      var meta = { _sheet: sheet.name, _row: (sheet.headerRow || 0) + i + 2 };
      var why = noiseReason(r, m);
      if (why) {
        // Only worth reporting if the row carried money - a blank spacer is noise.
        var amt = m.amount != null ? num(r[m.amount]) : num(r[m.qty]) * num(r[m.unitPrice]);
        if (amt) skipped.push(assign({}, meta, { reason: why, amount: r2(amt) }));
        return;
      }
      /* A merged cell in Excel carries its value on the first row only; every
         row under it arrives blank. The fallback used to apply only when the
         sheet had NO pharmacy column at all, so a per-pharmacy sheet with a
         merged name column lost every row but the first - measured at 750 of
         1750 gross gone. It is only safe to fill in when the whole sheet
         belongs to one pharmacy, which is exactly when pharmFromName is set. */
      var pcell = m.pharmacy != null ? String(r[m.pharmacy] == null ? '' : r[m.pharmacy]).trim() : '';
      raw.push(assign({}, meta, {
        pharmacyRaw: pcell || (sheet.pharmFromName ? sheet.pharmFromName.trading : ''),
        productRaw: r[m.product],
        qty: m.qty != null ? r[m.qty] : 0,
        unitPrice: m.unitPrice != null ? r[m.unitPrice] : 0,
        amount: m.amount != null ? r[m.amount] : null,
        dateRaw: m.date != null ? r[m.date] : ''
      }));
    });
    return { raw: raw, skipped: skipped };
  }

  /* ---------------------------------------------------------- tracking */

  /* Which tracking option a line carries. The brand owner is the usual answer -
   * it is the thing the operator wants to see separately in Xero - but a line
   * can be tagged by pharmacy instead. An entity with no explicit option falls
   * back to its name, which is what most organisations set the options to. */
  function trackingOption(by, pharmacy, project) {
    var e = by === 'pharmacy' ? pharmacy : project;
    if (!e) return '';
    return (e.trackingOption || '').trim() ||
      (by === 'pharmacy' ? (e.trading || e.contact || '') : (e.name || e.xeroContact || ''));
  }

  /* The two tracking pairs for a line, as Xero wants them. Returns [] when no
   * category is configured, so tracking simply does not appear. */
  function trackingPairs(c, pharmacy, project) {
    var out = [];
    if (c.trackingCategory) {
      var o1 = trackingOption(c.trackingBy, pharmacy, project);
      if (o1) out.push({ name: c.trackingCategory, option: o1 });
    }
    if (c.trackingCategory2) {
      var o2 = trackingOption(c.trackingBy2, pharmacy, project);
      if (o2) out.push({ name: c.trackingCategory2, option: o2 });
    }
    return out;
  }

  /* Every distinct (category, option) the run will send, so it can be held
   * against what the organisation actually has before anything is created. */
  function trackingUsed(settlement, billing, c) {
    c = cfg(c);
    var seen = {}, out = [];
    var add = function (pairs) {
      pairs.forEach(function (t) {
        var k = t.name + '||' + t.option;
        if (!seen[k]) { seen[k] = 1; out.push(t); }
      });
    };
    (billing || []).forEach(function (B) {
      B.items.forEach(function (i) { add(trackingPairs(c, B.pharmacy, i.project)); });
    });
    (settlement && settlement.projects || []).forEach(function (P) {
      add(trackingPairs(c, null, P.project));
      P.byPharmacy.forEach(function (b) { add(trackingPairs(c, b.pharmacy, P.project)); });
    });
    return out;
  }

  /* Hold a run against what the organisation actually has, before anything is
   * created. Pure: `org` is what the connector's `check` action returns, and
   * the answer is a list of findings the caller renders however it likes.
   *
   * This is the decision half of the pre-flight, kept out of the page so it can
   * be tested. A last-mile check that is itself untested is worth very little.
   *
   * Xero refuses a line carrying an account code or a tracking option it does
   * not have, and it refuses them ONE LINE AT A TIME - so a single mis-spelling
   * loses that brand owner's reporting while the rest of the month looks like
   * it worked. That is the failure this exists to catch. */
  function xeroPreflight(org, settlement, billing, c) {
    c = cfg(c);
    org = org || {};
    var accounts = {}, tax = {}, cats = {};
    (org.accounts || []).forEach(function (a) { accounts[String(a.code == null ? '' : a.code).trim()] = a; });
    (org.taxRates || []).forEach(function (t) {
      tax[String(t.name == null ? '' : t.name).trim().toLowerCase()] = t;
      tax[String(t.taxType == null ? '' : t.taxType).trim().toLowerCase()] = t;
    });
    (org.trackingCategories || []).forEach(function (t) {
      cats[String(t.name == null ? '' : t.name).trim().toLowerCase()] =
        (t.options || []).map(function (o) { return String(o == null ? '' : o).trim().toLowerCase(); });
    });

    var out = [];
    var add = function (what, sends, ok, detail) {
      out.push({ what: what, sends: sends, ok: !!ok, detail: detail || '' });
    };

    [['Pass-through account', 'acctPassThrough'],
     ['Management fee income', 'acctMgmtIncome'],
     ['Service fee income', 'acctServiceIncome'],
     ['Insurance income', 'acctInsuranceIncome']].forEach(function (f) {
      var code = String(c[f[1]] || '').trim();
      /* insurance falls back to the service fee account, so an unset one is
         not a finding - it is simply not used */
      if (!code && f[1] === 'acctInsuranceIncome') return;
      var a = accounts[code];
      add(f[0], code, !!a, a
        ? a.name + ' — ' + a.type + (a.status && a.status !== 'ACTIVE' ? ' (' + a.status + ')' : '')
        : (code ? '' : 'nothing is set'));
    });

    [['Tax type for exempt lines', 'taxTypeExempt'],
     ['Tax type for SST lines', 'taxTypeSST']].forEach(function (f) {
      var want = String(c[f[1]] || '').trim();
      var t = tax[want.toLowerCase()];
      add(f[0], want, !!t, t ? t.name + ' → ' + t.taxType + ' @ ' + t.rate + '%' : '');
    });

    trackingUsed(settlement, billing, c).forEach(function (t) {
      var opts = cats[String(t.name).trim().toLowerCase()];
      add('Tracking: ' + t.name, t.option,
        !!opts && opts.indexOf(String(t.option).trim().toLowerCase()) >= 0,
        opts ? '' : 'the organisation has no category called "' + t.name + '"');
    });

    /* Every contact name these files will send.
     *
     * This one fails differently from the others and that is why it is worth
     * checking. A wrong account code or tracking option makes Xero REJECT the
     * line, loudly. A *ContactName that matches nothing is ACCEPTED: Xero
     * creates a brand new contact under that name and posts the document
     * against it. Nothing is rejected, nothing is reported, and the month looks
     * like it imported perfectly - while a brand owner now has two contacts,
     * the bill sits on the empty one with no email, no payment terms and no
     * history, and the real one shows nothing owing.
     *
     * The names have to match exactly, and they come from sixty-two pharmacies
     * and thirty-two brand owners typed at different times, so "exactly" is a
     * real bar. Checking is only possible because the contact list has already
     * been pulled for the Master data screen.
     *
     * With no contact list to compare against, this says so rather than
     * quietly passing - the check not having run is not the same as it passing.
     */
    var known = null;
    if (org.contacts && org.contacts.length) {
      known = {};
      org.contacts.forEach(function (x) {
        var n = String((x && x.name != null ? x.name : x) || '').trim().toLowerCase();
        if (n) known[n] = true;
      });
    }
    var wants = [], seenName = {};
    (settlement && settlement.projects || []).forEach(function (S) {
      var n = S.project.xeroContact || S.project.name;
      if (n && !seenName['b' + n]) { seenName['b' + n] = 1; wants.push(['Brand owner', n]); }
    });
    (billing || []).forEach(function (B) {
      var n = B.pharmacy.contact || B.pharmacy.trading;
      if (n && !seenName['p' + n]) { seenName['p' + n] = 1; wants.push(['Pharmacy', n]); }
    });
    wants.forEach(function (w) {
      if (!known) {
        add('Contact: ' + w[0], w[1], false,
          'no contact list has been pulled from Xero, so this cannot be checked - ' +
          'import it on the Master data tab');
        return;
      }
      var hit = known[String(w[1]).trim().toLowerCase()];
      add('Contact: ' + w[0], w[1], !!hit,
        hit ? '' : 'Xero has no contact with this exact name and would create a new one');
    });

    return { findings: out, bad: out.filter(function (x) { return !x.ok; }).length };
  }

  /* ------------------------------------------------------- Xero CSV out */

  function invNo(prefix, period, seq) {
    return prefix + periodYYMM(period) + '-' + String(seq).replace(/^(\d)$/, '000$1')
      .replace(/^(\d\d)$/, '00$1').replace(/^(\d\d\d)$/, '0$1');
  }

  function seqStart(c, key) {
    var v = c[key];
    return v && v > 0 ? v : c.startNumber;
  }

  function dates(c) {
    var idate = c.invoiceDate || monthEnd(c.period);
    return { idate: idate, ddate: addDays(idate, c.dueDays) };
  }

  /* Nothing may be built with a missing account code. Xero rejects the line,
   * and it rejects it AFTER the operator has done the month, so the failure
   * lands as far from the cause as it can get. */
  function requireAccounts(c, which) {
    var missing = which.filter(function (k) { return !String(c[k] || '').trim(); });
    if (missing.length) {
      throw new Error('No Xero account code set for: ' + missing.join(', ') +
        '. Set them on the Settings tab before building anything - Xero rejects ' +
        'every line that carries a code the organisation does not have.');
    }
  }

  var TRACK_COLS = ['TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2'];

  var SALES_COLS = ['*ContactName', 'EmailAddress', '*InvoiceNumber', 'Reference', '*InvoiceDate',
    '*DueDate', 'InventoryItemCode', '*Description', '*Quantity', '*UnitAmount',
    'Discount', '*AccountCode', '*TaxType', 'Currency'].concat(TRACK_COLS);

  var BILL_COLS = ['*ContactName', '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate',
    'InventoryItemCode', '*Description', '*Quantity', '*UnitAmount',
    '*AccountCode', '*TaxType', 'Currency'].concat(TRACK_COLS);

  /* Spreads the pairs across the four CSV columns Xero expects. */
  function trackingCells(pairs) {
    return {
      'TrackingName1': pairs[0] ? pairs[0].name : '',
      'TrackingOption1': pairs[0] ? pairs[0].option : '',
      'TrackingName2': pairs[1] ? pairs[1].name : '',
      'TrackingOption2': pairs[1] ? pairs[1].option : ''
    };
  }

  /* (A) ACCREC to each pharmacy. Coded to the pass-through liability, not revenue. */
  function xeroPharmacyInvoices(billing, c) {
    c = cfg(c);
    requireAccounts(c, ['acctPassThrough']);
    var d = dates(c), rows = [], seq = seqStart(c, 'startPharmacy') - 1;
    billing.forEach(function (B) {
      seq++;
      var no = invNo(c.pharmacyInvPrefix, c.period, seq);
      B.invoiceNumber = no;
      B.items.forEach(function (it, i) {
        // written so Xero's own arithmetic reproduces it.net exactly
        var sh = invoiceShape(it, c);
        // tagged from the brand whose goods the line is, so a pharmacy carrying
        // several brands still reports correctly line by line
        rows.push(assign({
          '*ContactName': B.pharmacy.contact || B.pharmacy.trading,
          'EmailAddress': i === 0 ? (B.pharmacy.email || '') : '',
          '*InvoiceNumber': no,
          'Reference': 'Consignment sales ' + periodLabel(c.period),
          '*InvoiceDate': dmy(d.idate),
          '*DueDate': dmy(d.ddate),
          'InventoryItemCode': '',
          '*Description': sh.description,
          '*Quantity': sh.qty,
          '*UnitAmount': sh.unit.toFixed(2),
          'Discount': r2(c.discountPct).toFixed(2),
          '*AccountCode': c.acctPassThrough,
          '*TaxType': c.taxTypeExempt,
          'Currency': 'MYR'
        }, trackingCells(trackingPairs(c, B.pharmacy, it.project))));
      });
    });
    return { columns: SALES_COLS, rows: rows };
  }

  /* (B) ACCREC to each brand owner for CTG4U's own fees. This is the revenue. */
  function xeroServiceInvoices(settlement, c) {
    c = cfg(c);
    requireAccounts(c, ['acctMgmtIncome', 'acctServiceIncome']);
    var d = dates(c), rows = [], seq = seqStart(c, 'startFee') - 1;
    settlement.projects.forEach(function (S) {
      seq++;
      var no = invNo(c.serviceInvPrefix, c.period, seq);
      S.serviceInvoiceNumber = no;
      var base = assign({
        '*ContactName': S.project.xeroContact || S.project.name,
        'EmailAddress': S.project.email || '',
        '*InvoiceNumber': no,
        'Reference': 'Fees ' + periodLabel(c.period),
        '*InvoiceDate': dmy(d.idate),
        '*DueDate': dmy(d.ddate),
        'InventoryItemCode': '',
        'Discount': '',
        'Currency': 'MYR'
      }, trackingCells(trackingPairs(c, null, S.project)));
      if (S.mgmtFee) rows.push(assign({}, base, {
        '*Description': 'Pharmacy Management Fee - ' + S.pharmacyCount + ' pharmacy(s) - ' + periodLabel(c.period),
        '*Quantity': S.pharmacyCount,
        '*UnitAmount': r2(c.mgmtFeePerPharmacy).toFixed(2),
        '*AccountCode': c.acctMgmtIncome,
        '*TaxType': c.sstOnMgmtFee ? c.taxTypeSST : c.taxTypeExempt
      }));
      if (S.serviceFee) rows.push(assign({}, base, {
        'EmailAddress': '',
        '*Description': 'Consignment Service Fee ' + r2(c.serviceFeePct) + '% on gross sales of ' +
          periodLabel(c.period) + ' (MYR ' + money(S.salesAmount) + ')',
        '*Quantity': 1,
        '*UnitAmount': r2(S.serviceFee).toFixed(2),
        '*AccountCode': c.acctServiceIncome,
        '*TaxType': c.sstOnServiceFee ? c.taxTypeSST : c.taxTypeExempt
      }));
      if (S.insuranceFee) rows.push(assign({}, base, {
        'EmailAddress': '',
        '*Description': 'Insurance ' + r2(c.insuranceFeePct) + '% on gross sales of ' +
          periodLabel(c.period) + ' (MYR ' + money(S.salesAmount) + ')',
        '*Quantity': 1,
        '*UnitAmount': r2(S.insuranceFee).toFixed(2),
        '*AccountCode': c.acctInsuranceIncome || c.acctServiceIncome,
        '*TaxType': c.sstOnInsurance ? c.taxTypeSST : c.taxTypeExempt
      }));
    });
    return { columns: SALES_COLS, rows: rows };
  }

  /* (C) ACCPAY to each brand owner for the collections owed, at NET SALES.
   * Not at Total Payout: the fees are billed separately by (B), so billing the
   * bill net of fees as well would charge the brand owner twice. Cash actually
   * remitted = this bill minus invoice (B) = Total Payout. */
  function xeroPayoutBills(settlement, c) {
    c = cfg(c);
    requireAccounts(c, ['acctPassThrough']);
    var d = dates(c), rows = [], seq = seqStart(c, 'startPayout') - 1;
    settlement.projects.forEach(function (S) {
      seq++;
      var no = invNo(c.payoutBillPrefix, c.period, seq);
      S.payoutBillNumber = no;
      S.byPharmacy.forEach(function (B) {
        rows.push(assign({
          '*ContactName': S.project.xeroContact || S.project.name,
          '*InvoiceNumber': no,
          'Reference': 'Consignment settlement ' + periodLabel(c.period),
          '*InvoiceDate': dmy(d.idate),
          '*DueDate': dmy(d.ddate),
          'InventoryItemCode': '',
          '*Description': B.pharmacy.trading + ' - net collections after ' + r2(c.discountPct) +
            '% discount (gross MYR ' + money(B.gross) + ')',
          '*Quantity': 1,
          '*UnitAmount': r2(B.net).toFixed(2),
          '*AccountCode': c.acctPassThrough,
          '*TaxType': c.taxTypeExempt,
          'Currency': 'MYR'
        }, trackingCells(trackingPairs(c, B.pharmacy, S.project))));
      });
    });
    return { columns: BILL_COLS, rows: rows };
  }

  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }

  function toCSV(table) {
    var esc = function (v) {
      var s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var out = [table.columns.map(esc).join(',')];
    table.rows.forEach(function (r) {
      out.push(table.columns.map(function (c) { return esc(r[c]); }).join(','));
    });
    return out.join('\r\n');
  }

  /* ------------------------------------------------------ Xero contacts */

  /* Xero > Contacts > Export gives a CSV whose exact *ContactName is the only
   * string Xero will accept on an import. Typing those names by hand is the
   * single most common reason an import is rejected, so we read them instead.
   * rows = array of arrays, header first. Column roles are found by header word,
   * with a value-based fallback for the name column. */
  function parseXeroContacts(rows) {
    if (!rows || rows.length < 2) return [];
    var hdr = (rows[0] || []).map(function (h) {
      return String(h == null ? '' : h).toLowerCase().replace(/[^a-z]/g, '');
    });
    var find = function (exact, contains) {
      var i = hdr.indexOf(exact);
      if (i >= 0) return i;
      for (var j = 0; j < hdr.length; j++) if (hdr[j].indexOf(contains) >= 0) return j;
      return -1;
    };
    var iName = find('contactname', 'contactname');
    if (iName < 0) iName = find('name', 'name');
    var iEmail = find('emailaddress', 'email');
    var iAcct = find('accountnumber', 'accountnumber');
    var iTax = find('taxnumber', 'taxnumber');

    // No usable header? Fall back to the column with the most non-numeric,
    // mostly-distinct values - that is the name column in every Xero export.
    if (iName < 0) {
      var body = rows.slice(1), best = -1, bestScore = 0;
      for (var c = 0; c < (rows[0] || []).length; c++) {
        var vals = body.map(function (r) { return r[c]; }).filter(function (v) { return v !== '' && v != null; });
        if (!vals.length) continue;
        var seen = {};
        vals.forEach(function (v) { seen[normKey(v)] = 1; });
        // Fill rate must be in the score. A column with one lonely value scores a
        // perfect "all text, all distinct" otherwise, and wins over the real names.
        var fill = vals.length / (body.length || 1);
        if (fill < 0.5) continue;
        var s = fill *
          (vals.filter(function (v) { return !looksNum(v); }).length / vals.length) *
          (Object.keys(seen).length / vals.length);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      iName = best;
    }
    if (iName < 0) return [];

    var out = [], seenName = {};
    rows.slice(1).forEach(function (r) {
      var name = String(r[iName] == null ? '' : r[iName]).trim();
      if (!name) return;
      var k = normKey(name);
      if (seenName[k]) return;               // Xero repeats the contact per address row
      seenName[k] = 1;
      out.push({
        name: name,
        email: iEmail >= 0 ? String(r[iEmail] == null ? '' : r[iEmail]).trim() : '',
        accountNumber: iAcct >= 0 ? String(r[iAcct] == null ? '' : r[iAcct]).trim() : '',
        taxNumber: iTax >= 0 ? String(r[iTax] == null ? '' : r[iTax]).trim() : ''
      });
    });
    return out;
  }

  /* Match every master pharmacy to a real Xero contact. Nothing is applied here -
   * the caller decides, because a wrong contact silently invoices the wrong company.
   *
   * States, and why the line is drawn where it is:
   *   ok     - byte-identical already, nothing to do.
   *   rename - normKey-identical: the SAME name differing only in punctuation,
   *            spacing or Sdn Bhd spelling. Safe to apply in bulk.
   *   review - anything else, INCLUDING a 0.90 containment hit. "WELL PHARMACY"
   *            is contained in "WELL PHARMACY ALLIANCE (MUTIARA RINI)" and they are
   *            different legal entities; auto-applying that invoices the wrong
   *            branch. A high score is not evidence of sameness, only of similarity.
   *   none   - nothing above the floor; no suggestion is invented.
   */
  function matchXeroContacts(pharmacies, contacts) {
    return pharmacies.map(function (p, i) {
      var cur = p.contact || '';
      var hit = bestMatch(cur || p.trading, contacts, ['name'], 0.6);
      var alt = cur ? bestMatch(p.trading, contacts, ['name'], 0.6) : null;
      if (!hit || (alt && alt.score > hit.score)) hit = alt || hit;

      var state;
      if (!hit) state = 'none';
      else if (hit.item.name === cur) state = 'ok';
      else if (cur && normKey(hit.item.name) === normKey(cur)) state = 'rename';
      else state = 'review';

      return {
        index: i, pharmacy: p, current: cur,
        suggestion: hit ? hit.item : null,
        score: hit ? hit.score : 0,
        exact: state === 'ok',
        state: state
      };
    });
  }

  /* ----------------------------------------------------------- statement */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  var SPLIT_LINES = new RegExp('[' + String.fromCharCode(13, 10) + ']+');

  var STMT_CSS = [
    'body{font:12px/1.55 "Public Sans","Segoe UI",Arial,sans-serif;color:#1b2733;margin:0;background:#f4f7f9}',
    '.stmt{background:#fff;max-width:760px;margin:0 auto 24px;padding:34px 40px;page-break-after:always}',
    '.stmt:last-child{page-break-after:auto}',
    /* The coloured band, then who is sending and who is being paid. The shape
       is the one every remittance advice uses, because the questions a reader
       arrives with are always the same two: who is this from, and is my
       account right. */
    '.band{display:flex;justify-content:space-between;align-items:center;background:#0077c8;color:#fff;',
    '  padding:10px 18px;margin:-34px -40px 16px;border-radius:2px}',
    '.bco{font-weight:800;font-size:14px;letter-spacing:.4px}',
    '.bti{font-size:12px;opacity:.92}',
    '.head{display:flex;justify-content:space-between;gap:34px;align-items:flex-start}',
    '.issuer{max-width:46%}',
    '.issuer .co{font-size:15px;font-weight:700}',
    '.issuer .reg{font-size:10px;color:#8494a5;margin-top:1px}',
    '.issuer .addr{font-size:10.5px;color:#5b6b7c;margin-top:6px;line-height:1.45}',
    '.facts{flex:1;max-width:52%}',
    '.facts .ref{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}',
    '.facts .per{font-size:12px;color:#5b6b7c;margin-bottom:9px}',
    '.kv div{display:flex;gap:8px;font-size:10.5px;line-height:1.6}',
    '.kv span{flex:none;width:112px;color:#8494a5}',
    '.kv span:after{content:":"}',
    '.kv b{font-weight:600;color:#1b2733}',
    '.kv .warn{display:block;background:#fff6e5;border:1px solid #f0d5a0;color:#8a5a12;',
    '  padding:7px 9px;border-radius:3px;font-size:10px;line-height:1.5;margin-top:6px}',
    '.lead{font-size:11px;color:#8494a5;margin:14px 0 2px;border-top:1px solid #e6ecf1;padding-top:10px}',
    '.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0077c8;padding-bottom:12px}',
    '.co{font-size:17px;font-weight:800;letter-spacing:.3px}',
    '.ti{font-size:13px;color:#555;margin-top:2px}',
    '.meta{text-align:right;font-size:11px}',
    '.meta span{display:block;color:#8494a5;text-transform:uppercase;letter-spacing:.6px;font-size:9px}',
    '.meta div{margin-bottom:6px}',
    '.to{margin:12px 0 12px}.to span{display:block;color:#888;text-transform:uppercase;letter-spacing:.6px;font-size:9px}',
    '.to b{font-size:15px}.to .sm{color:#888;font-size:10px}',
    'table{width:100%;border-collapse:collapse}',
    '.dt th{background:#f1f5f8;text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;',
    '  color:#5b6b7c;padding:7px 8px;border-bottom:1px solid #d9e1e8}',
    '.dt td{padding:5px 8px;border-bottom:1px solid #eee}',
    '.dt tr.tt td{border-top:1.5px solid #333;border-bottom:0;font-weight:700;background:#fafafa}',
    '.n{text-align:right;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;white-space:nowrap}',
    /* The deductions and the payout are one argument and may not be split by a
       page break: at twenty to twenty-six pharmacies the summary straddled the
       boundary, which put TOTAL PAYOUT AMOUNT on a page of its own, away from
       the lines that arrive at it. Measured, not guessed. */
    '.sm2{margin-top:16px;width:62%;margin-left:38%;break-inside:avoid;page-break-inside:avoid;',
    /* and not away from the footer either: keeping each whole but letting
       them separate put a page carrying nothing but two signature lines
       after a statement of twelve pharmacies. */
    '  break-after:avoid;page-break-after:avoid}',
    '.sm2 td{padding:4px 0}.sm2 td.n{width:130px}',
    '.sm2 tr.sub td{border-top:1px solid #ccc;font-weight:600}',
    '.sm2 tr.tot td{border-top:2px solid #1b2733;border-bottom:3px double #1b2733;font-weight:800;font-size:14px;padding:8px 0}',
    /* The signature block lives inside this, so keeping the footer whole keeps
       a signature line from being orphaned from the name above it. */
    '.ft{margin-top:20px;font-size:10px;color:#666;border-top:1px solid #eee;padding-top:10px;',
    '  break-inside:avoid;page-break-inside:avoid}',
    '.sig{display:flex;gap:60px;margin-top:26px}',
    '.sig div{flex:1;font-size:10px;color:#666}',
    '.sig span{display:block;border-top:1px solid #999;margin-top:28px}',
    /* The page margin belongs to @page, not to the section's padding.
       Padding is applied once, at the top of the element - so on a statement
       that ran to a second page the table began flush against the paper edge,
       inside the area most printers cannot reach. Giving @page the margin
       gives every page the same one. */
    /* The band bleeds to the edge of the section using negative margins, so
       the section needs the padding those margins are measured against. The
       PAGE margin still comes from @page, which is what puts a margin on the
       second page as well as the first. */
    '@media print{body{background:#fff}.stmt{margin:0;padding:0;max-width:none}',
    '  .band{margin:0 0 22px}}',
    '@page{size:A4;margin:16mm 15mm}'
  ].join('');

  /* One brand owner's statement. Every figure comes off the settlement object,
   * so the statement and the Xero files can never tell different stories. */
  /* An address is typed and pasted, so it arrives with whatever line endings
   * the machine it came from uses. One place decides what a line is. */
  function lines(v) {
    return String(v == null ? '' : v).split(SPLIT_LINES)
      .map(function (l) { return l.trim(); }).filter(Boolean);
  }

  function statementHTML(P, c) {
    c = cfg(c);
    var sr = function (l, v, cls) {
      return '<tr class="' + (cls || '') + '"><td>' + l + '</td><td class="n">' + v + '</td></tr>';
    };
    var rows = P.byPharmacy.map(function (B) {
      return '<tr><td>' + esc(B.pharmacy.trading) + '</td><td class="n">' + money(B.gross) + '</td>' +
        '<td class="n">' + money(B.discount) + '</td><td class="n">' + money(B.net) + '</td>' +
        '<td class="n">' + money(B.mgmtFee) + '</td></tr>';
    }).join('');

    /* A labelled pair, colons aligned down the block. */
    var kv = function (k, v) {
      return v ? '<div><span>' + k + '</span><b>' + esc(v) + '</b></div>' : '';
    };
    var addr = lines(c.coAddress).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');

    /* Whose account the payout is going to. Printed so it can be checked
       BEFORE the money moves rather than chased afterwards, and marked plainly
       when it has never been filled in - a blank here is the difference
       between a payment and a payment somewhere else. */
    var B = P.project || {};
    var bank = (B.bankName || B.bankAccountName || B.bankAccountNo)
      ? kv('Name in bank account', B.bankAccountName || B.name) +
        kv('Bank account', B.bankAccountNo) +
        kv('Bank name', B.bankName)
      : '<div class="warn">Bank details not set for this brand owner &mdash; ' +
        'add them on the Contacts tab before remitting.</div>';

    return '<section class="stmt">' +
      '<div class="band"><span class="bco">' + esc(c.coName || 'CTG4U RETAIL SDN BHD') + '</span>' +
      '<span class="bti">Consignment Settlement Statement</span></div>' +

      '<div class="head">' +
        '<div class="issuer">' +
          '<div class="co">' + esc(c.coName || 'CTG4U RETAIL SDN BHD') + '</div>' +
          (c.coReg ? '<div class="reg">Company no. ' + esc(c.coReg) + '</div>' : '') +
          (c.coSst ? '<div class="reg">SST no. ' + esc(c.coSst) + '</div>' : '') +
          '<div class="addr">' + addr + '</div>' +
          (c.coEmail ? '<div class="addr"><div>' + esc(c.coEmail) + '</div></div>' : '') +
          (c.coPhone ? '<div class="addr"><div>' + esc(c.coPhone) + '</div></div>' : '') +
        '</div>' +
        '<div class="facts">' +
          '<div class="ref">' + esc(P.payoutBillNumber || '—') + '</div>' +
          '<div class="per">Statement for ' + esc(monthStart(c.period)) + ' to ' +
            esc(monthEnd(c.period)) + '</div>' +
          '<div class="kv">' +
            kv('Brand owner', P.project.name) +
            kv('Reference', P.code) +
            (B.address ? '<div><span>Address</span><b>' +
              lines(B.address).map(esc).join('<br>') + '</b></div>' : '') +
            kv('Company no.', B.brn) +
            kv('Tax no.', B.taxNo) +
            bank +
          '</div>' +
        '</div>' +
      '</div>' +


      '<table class="dt"><thead><tr><th>Pharmacy</th><th class="n">Sales Amount</th>' +
      '<th class="n">Discount ' + r2(c.discountPct) + '%</th><th class="n">Net Sales</th>' +
      '<th class="n">Mgmt Fee</th></tr></thead><tbody>' + rows +
      '<tr class="tt"><td>Total &mdash; ' + P.pharmacyCount + ' pharmacy(s)</td>' +
      '<td class="n">' + money(P.salesAmount) + '</td><td class="n">' + money(P.discount) + '</td>' +
      '<td class="n">' + money(P.netSales) + '</td><td class="n">' + money(P.mgmtFee) + '</td></tr></tbody></table>' +

      '<table class="sm2">' +
      sr('Sales Amount', money(P.salesAmount)) +
      sr('Less: Discount ' + r2(c.discountPct) + '%', '(' + money(P.discount) + ')') +
      sr('Net Sales', money(P.netSales), 'sub') +
      sr('Less: Pharmacy Management Fee (' + P.pharmacyCount + ' pharmacy &times; MYR ' + money(c.mgmtFeePerPharmacy) + ')',
        '(' + money(P.mgmtFee) + ')') +
      sr('Less: Service Fee ' + r2(c.serviceFeePct) + '% of Sales Amount', '(' + money(P.serviceFee) + ')') +
      (P.insuranceFee ? sr('Less: Insurance ' + r2(c.insuranceFeePct) + '% of Sales Amount',
        '(' + money(P.insuranceFee) + ')') : '') +
      sr('Less: SST ' + r2(c.sstPct) + '% on fees', '(' + money(P.sst) + ')') +
      sr('TOTAL PAYOUT AMOUNT (MYR)', money(P.totalPayout), 'tot') +
      '</table>' +

      '<div class="ft">Fees are billed separately on tax invoice <b>' + esc(P.serviceInvoiceNumber || '—') +
      '</b> and offset against settlement <b>' + esc(P.payoutBillNumber || '—') + '</b>.<br>' +
      'Service fee is calculated on the gross Sales Amount before discount. Amounts in Malaysian Ringgit.' +
      '<div class="sig"><div>Prepared by<br><span></span></div>' +
      '<div>Acknowledged by ' + esc(P.project.name) + '<br><span></span></div></div></div></section>';
  }

  /* Full printable document. Document numbers are stamped first so the statement
   * quotes the same invoice/bill numbers the CSVs carry. */
  /* The printable statement, as one document.
   *
   * `only` prints a single brand owner by index; leave it out for all of them.
   * Either way the numbering runs over the WHOLE settlement first, because
   * xeroServiceInvoices and xeroPayoutBills are what stamp serviceInvoiceNumber
   * and payoutBillNumber onto each project, and the statement prints those
   * numbers so the brand owner can tie the page to the documents in Xero.
   * Numbering only the one being printed would restart the sequence at 0001 and
   * quote numbers that belong to somebody else.
   *
   * This can throw: an unset account code stops the builders, deliberately. The
   * caller opens a window, so it has to be given the chance to not open one. */
  function statementDoc(settlement, c, only) {
    c = cfg(c);
    xeroServiceInvoices(settlement, c);
    xeroPayoutBills(settlement, c);
    var show = (only == null || only < 0) ? settlement.projects
      : [settlement.projects[only]].filter(Boolean);
    return '<!doctype html><html><head><meta charset="utf-8"><title>Consignment Settlement ' +
      esc(periodLabel(c.period)) + '</title><style>' + STMT_CSS + '</style></head><body>' +
      show.map(function (P) { return statementHTML(P, c); }).join('') +
      '</body></html>';
  }

  /* -------------------------------------------- package billing sheets ---- */

  /* The pharmacy billing sheets are a cross-tab, not a list: one row per package
   * sold, with every product as its own column holding a quantity. The unit of
   * sale is the PACKAGE, so that is what gets invoiced; the product columns only
   * describe what was inside it.
   *
   * Each sheet also states its own Total Sales / Commission / Insurans /
   * Billing. Those are captured and handed back, so what we computed can be held
   * against what the pharmacy computed. If the two disagree the sheet was read
   * wrongly, and nothing should be billed from it.
   */

  var PKG_TOTAL_RE      = /^\s*total\s*sales\s*$/i;
  var PKG_CREDIT_RE     = /credit\s*note/i;
  var PKG_VOUCHER_RE    = /amount\s*after\s*voucher/i;
  var PKG_COMMISSION_RE = /^\s*commission\s*$/i;
  var PKG_INSURANCE_RE  = /^\s*insuran(s|ce)\s*$/i;
  var PKG_BILLING_RE    = /^\s*billing\s*$/i;

  function findPackageHeader(rows) {
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var cells = (rows[i] || []).map(function (c) {
        return String(c == null ? '' : c).trim().toLowerCase();
      });
      if (cells.indexOf('date') >= 0 && cells.indexOf('package') >= 0 &&
          cells.indexOf('price') >= 0) return i;
    }
    return -1;
  }

  function isPackageSheet(rows) { return findPackageHeader(rows) >= 0; }

  function firstMatch(cells, re) {
    for (var i = 0; i < cells.length; i++) if (re.test(cells[i])) return i;
    return -1;
  }

  function parsePackageSheet(rows) {
    var h = findPackageHeader(rows);
    if (h < 0) return null;

    var cells = (rows[h] || []).map(function (c) {
      return String(c == null ? '' : c).trim().toLowerCase();
    });
    var col = {
      date: cells.indexOf('date'),
      pkg: cells.indexOf('package'),
      price: cells.indexOf('price'),
      voucher: firstMatch(cells, /voucher\s*used/),
      net: firstMatch(cells, /after\s*deduct/)
    };

    /* The pharmacy's own identity sits above the header: the trading name in the
     * first column, and beside it the registered name, which is what Xero knows
     * it as. The address follows the registered name, so a cell carrying a long
     * run of digits is skipped. */
    var trading = '', contact = '';
    for (var i = 0; i < h; i++) {
      var r = rows[i] || [];
      var a = String(r[0] == null ? '' : r[0]).trim();
      if (a && !trading && !/billing/i.test(a)) trading = a;
      for (var j = 1; j < r.length && !contact; j++) {
        var v = String(r[j] == null ? '' : r[j]).trim();
        if (v && /\b(SDN|BHD|PLT|ENTERPRISE|PHARMACY|TRADING|FARMASI)\b/i.test(v) &&
            !/\d{3}/.test(v)) contact = v;
      }
    }

    var lines = [], giveaways = [], stated = {}, inData = true;
    for (var k = h + 1; k < rows.length; k++) {
      var row = rows[k] || [];
      var label = String(row[col.pkg] == null ? '' : row[col.pkg]).trim();
      var rate = num(row[0]);
      var price = num(row[col.price]);

      /* The first totals label closes the sale rows for good. Below the totals
       * these sheets carry a restated 'Billed amount' and a Stock Out summary of
       * product quantities; reading on would bill the summary as if it were
       * sales, which is exactly what the cross-check caught. */
      if (PKG_TOTAL_RE.test(label))      { inData = false; stated.totalSales = price; continue; }
      if (PKG_CREDIT_RE.test(label))     { inData = false; stated.creditNote = price; continue; }
      if (PKG_VOUCHER_RE.test(label))    { inData = false; stated.afterVoucher = price; continue; }
      if (PKG_COMMISSION_RE.test(label)) { inData = false; stated.commission = price; stated.commissionRate = rate; continue; }
      if (PKG_INSURANCE_RE.test(label))  { inData = false; stated.insurance = price; stated.insuranceRate = rate; continue; }
      if (PKG_BILLING_RE.test(label))    { inData = false; stated.billing = price; continue; }

      if (!inData) continue;                                // past the sale rows

      /* A row with no price is never invoiced. But a giveaway is not a blank
       * row: it carries a date, a quantity somewhere, or a note explaining
       * itself. Those are reported rather than silently dropped, because the
       * stock left the shelf even though nobody paid for it. */
      if (!price) {
        var carries = row.some(function (v, i) {
          return i !== col.price && v !== '' && v != null && String(v).trim() !== '';
        });
        if (carries) {
          var note = '';
          for (var n = row.length - 1; n > col.price; n--) {
            var t = String(row[n] == null ? '' : row[n]).trim();
            if (t && isNaN(Number(t)) && !/^#/.test(t)) { note = t; break; }
          }
          giveaways.push({ row: k + 1, pkg: label || '(no package)', note: note });
        }
        continue;
      }

      lines.push({
        _row: k + 1,
        dateRaw: row[col.date],
        pkg: label || '(unnamed package)',
        price: r2(price),
        net: col.net >= 0 ? r2(num(row[col.net])) : null,
        voucher: col.voucher >= 0 ? num(row[col.voucher]) : 0
      });
    }

    return {
      headerRow: h, columns: col,
      pharmacyTrading: trading, pharmacyContact: contact,
      lines: lines, giveaways: giveaways, stated: stated
    };
  }

  /* Same package at the same price becomes one invoice line with the quantity
   * counted, which is how these have always been keyed by hand. */
  function packageLines(parsed) {
    var by = {}, order = [];
    parsed.lines.forEach(function (l) {
      var key = normKey(l.pkg) + '|' + l.price.toFixed(2);
      if (!by[key]) { by[key] = { pkg: l.pkg, price: l.price, qty: 0, gross: 0 }; order.push(key); }
      by[key].qty += 1;
      by[key].gross = r2(by[key].gross + l.price);
    });
    return order.map(function (k) { return by[k]; });
  }

  /* Hold our arithmetic against the pharmacy's own. A disagreement means the
   * sheet was read wrongly and nothing should be billed from it. */
  function packageCrossCheck(parsed, c) {
    c = cfg(c);
    var d = 1 - c.discountPct / 100;
    var gross = sumMoney(parsed.lines, function (l) { return l.price; });
    var net = r2(gross * d);

    /* What the invoice will actually total. Xero applies the discount and rounds
     * line by line, so the invoice can land a sen or two away from the sheet's
     * own Billing cell, which discounts the total in one go. That is expected -
     * it is the same difference the AutoCount process already lives with - but
     * it is reported rather than hidden, because the pharmacy has its own
     * figure in front of it. */
    var invoiceTotal = sumMoney(packageLines(parsed), function (l) {
      return r2(l.qty * l.price * d);
    });

    var out = {
      gross: gross, net: net, invoiceTotal: invoiceTotal,
      roundingDiff: r2(invoiceTotal - net),
      statedSales: parsed.stated.totalSales,
      statedBilling: parsed.stated.billing,
      statedCommission: parsed.stated.commission,
      statedInsurance: parsed.stated.insurance,
      problems: [], notes: []
    };
    if (out.roundingDiff) {
      out.notes.push('per-line rounding makes the invoice ' + money(invoiceTotal) +
        ', ' + money(Math.abs(out.roundingDiff)) + ' ' +
        (out.roundingDiff < 0 ? 'below' : 'above') + ' the ' + money(net) + ' on the sheet');
    }
    /* A sheet that states nothing cannot be checked, and that is not the same
     * as a sheet that checks out.
     *
     * Every comparison below is guarded on the figure being present, so a sheet
     * whose totals block was never read produced no problems at all and came
     * back ok - reported on screen as agreeing with the pharmacy's own figures,
     * when in truth there were no figures of its own to agree with. The whole
     * point of this function is that the pharmacy totalled the sheet
     * independently; with that gone there is nothing holding the parse honest,
     * and how the rows were read is exactly what can go wrong.
     *
     * These sheets come off a standard template and always carry Total Sales
     * and Billing, so one arriving without them means it was trimmed, or it is
     * laid out differently and was read wrongly. Either way the sheet, not the
     * month, is what needs fixing. */
    if (parsed.stated.totalSales == null && parsed.stated.billing == null) {
      out.problems.push('this sheet carries no Total Sales or Billing of its own, ' +
        'so there is nothing to check how it was read - ask the pharmacy for the ' +
        'sheet with its totals block');
    }

    if (parsed.stated.totalSales != null &&
        Math.abs(r2(gross - parsed.stated.totalSales)) >= 0.01) {
      out.problems.push('the sheet states Total Sales ' + money(parsed.stated.totalSales) +
        ' but its rows add up to ' + money(gross));
    }
    if (parsed.stated.billing != null &&
        Math.abs(r2(net - parsed.stated.billing)) >= 0.01) {
      out.problems.push('the sheet states Billing ' + money(parsed.stated.billing) +
        ' but ' + r2(c.discountPct) + '% off gives ' + money(net));
    }
    if (parsed.stated.commissionRate &&
        Math.abs(parsed.stated.commissionRate * 100 - c.discountPct) > 0.001) {
      out.problems.push('the sheet uses a ' + r2(parsed.stated.commissionRate * 100) +
        '% commission but Settings says ' + r2(c.discountPct) + '%');
    }
    if (parsed.stated.insuranceRate &&
        Math.abs(parsed.stated.insuranceRate * 100 - (c.insuranceFeePct || 0)) > 0.001) {
      out.problems.push('the sheet uses a ' + r2(parsed.stated.insuranceRate * 100) +
        '% insurance but Settings says ' + r2(c.insuranceFeePct || 0) + '%');
    }
    out.ok = !out.problems.length;
    return out;
  }

  /* ------------------------------------------------ column auto-detection */

  var DATE_RE = /^(\d{1,4})[-\/.](\d{1,2})[-\/.](\d{1,4})$/;

  function looksDate(v) {
    if (v instanceof Date) return true;
    if (typeof v === 'number') return v > 30000 && v < 60000;   // Excel serial
    return DATE_RE.test(String(v == null ? '' : v).trim());
  }
  function looksNum(v) {
    if (typeof v === 'number') return isFinite(v);
    var s = String(v == null ? '' : v).replace(/[,\s]/g, '');
    /* A credit written the accountant's way is still a number. Without this the
       one bracketed row in a column dragged the column's numeric rate below the
       bar, the column stopped being recognised as the amount, and the sheet was
       billed off quantity x price instead - which turns a return into a sale. */
    s = s.replace(/^\((.*)\)$/, '-$1').replace(/^RM/i, '');
    return s !== '' && /^-?\d*\.?\d+$/.test(s);
  }

  /* The real header is rarely row 1 - report titles, the pharmacy name and blank
   * rows sit above it. Pick the row that looks most like a header: mostly text,
   * mostly filled, and followed by a row that is mostly numbers/dates. */
  function findHeaderRow(rows) {
    var best = 0, bestScore = -1;
    for (var i = 0; i < Math.min(rows.length - 1, 12); i++) {
      var r = rows[i] || [];
      var filled = r.filter(function (c) { return c !== '' && c != null; }).length;
      if (filled < 2) continue;
      var texty = r.filter(function (c) { return c !== '' && c != null && !looksNum(c); }).length / filled;
      var nxt = rows[i + 1] || [];
      var nxtFilled = nxt.filter(function (c) { return c !== '' && c != null; }).length || 1;
      var nxtNum = nxt.filter(function (c) { return looksNum(c) || looksDate(c); }).length / nxtFilled;
      var score = texty * 1.0 + nxtNum * 0.8 + (filled / Math.max(1, r.length)) * 0.5;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /* rows: array of arrays, first row = header. Returns a column index per role,
   * chosen from the DATA (header words only break ties) so a renamed column or
   * a translated header does not break the month-end run. */
  function detectColumns(rows, master) {
    if (!rows || rows.length < 2) return {};
    var header = rows[0].map(function (h) { return String(h == null ? '' : h).toLowerCase().trim(); });
    var body = rows.slice(1).filter(function (r) { return r.some(function (c) { return c !== '' && c != null; }); });
    var n = header.length, sample = body.slice(0, 300);
    var pharmacies = (master && master.pharmacies) || [];
    var products = (master && master.products) || [];

    var stats = [];
    for (var c = 0; c < n; c++) {
      var vals = sample.map(function (r) { return r[c]; }).filter(function (v) { return v !== '' && v != null; });
      var nonEmpty = vals.length || 1;
      var st = {
        i: c, header: header[c] || '', filled: vals.length / (sample.length || 1),
        numRate: vals.filter(looksNum).length / nonEmpty,
        dateRate: vals.filter(looksDate).length / nonEmpty,
        intRate: vals.filter(function (v) { return looksNum(v) && Math.abs(num(v) % 1) < 1e-9; }).length / nonEmpty,
        decRate: vals.filter(function (v) { return looksNum(v) && Math.abs(num(v) % 1) > 1e-9; }).length / nonEmpty,
        distinct: (function () { var s = {}; vals.forEach(function (v) { s[normKey(v)] = 1; }); return Object.keys(s).length; })(),
        avg: vals.filter(looksNum).length ? sum(vals.filter(looksNum).map(num)) / vals.filter(looksNum).length : 0,
        pharmRate: pharmacies.length ? vals.filter(function (v) {
          return !looksNum(v) && bestMatch(v, pharmacies, ['trading', 'contact', 'code'], 0.7);
        }).length / nonEmpty : 0,
        prodRate: products.length ? vals.filter(function (v) {
          return !looksNum(v) && bestMatch(v, products, ['sku', 'name'], 0.75);
        }).length / nonEmpty : 0
      };
      stats.push(st);
    }

    function hw(st, words, w) {                    // header-word nudge
      for (var i = 0; i < words.length; i++) if (st.header.indexOf(words[i]) >= 0) return w;
      return 0;
    }
    function pick(scorer, taken) {
      var best = null, bs = 0;
      stats.forEach(function (st) {
        if (taken.indexOf(st.i) >= 0) return;
        var s = scorer(st);
        if (s > bs) { bs = s; best = st; }
      });
      return bs > 0.35 ? best.i : null;
    }

    var taken = [], out = {};

    out.date = pick(function (s) { return s.dateRate * 1.0 + hw(s, ['date', 'tarikh', '日期'], 0.25); }, taken);
    if (out.date != null) taken.push(out.date);

    /* A column whose header says PHARMACY is the pharmacy column even when not
     * one name in it is recognised - especially then. The nudge used to be 0.3
     * against a 0.35 bar, so a sheet naming shops that are not in the master
     * data scored 0.30, the column was discarded, and every row fell back to
     * the pharmacy the TAB is named after. Rows belonging to one shop were
     * billed to another, silently, and the only sheets it could happen to were
     * the ones nobody recognised - which is exactly when someone should look.
     * Trust the header; let the unknown names surface on Review instead. */
    out.pharmacy = pick(function (s) {
      var named = hw(s, ['pharmacy', 'outlet', 'branch', 'store', 'customer', '药房'], 1);
      if (named && s.numRate <= 0.8) return 1 + s.pharmRate;
      return s.pharmRate * 1.0;
    }, taken);
    if (out.pharmacy != null) taken.push(out.pharmacy);

    out.product = pick(function (s) {
      if (s.numRate > 0.8 || s.dateRate > 0.5) return 0;
      var base = s.prodRate * 0.9;
      var textiness = (1 - s.numRate) * Math.min(1, s.distinct / 3) * 0.45;
      return base + textiness + hw(s, ['product', 'item', 'description', 'sku', 'package', '产品', '品名'], 0.3);
    }, taken);
    if (out.product != null) taken.push(out.product);

    /* A column whose header says what it is may not be conscripted into another
       role. Quantity and unit price are both chosen before amount, and both
       score well on any numeric column, so a sheet carrying nothing but an
       Amount column had that column taken as one of them - leaving no amount at
       all, every row worth zero, and the whole month excluded. Whoever sent the
       sheet wrote the word; believe it. */
    var saysAmount = function (s) {
      return hw(s, ['amount', 'total', 'subtotal', 'value', 'jumlah', '金额', '小计'], 1) ? 0 : 1;
    };

    out.qty = pick(function (s) {
      if (s.numRate < 0.7) return 0;
      return saysAmount(s) * (s.intRate * 0.55 + (s.avg > 0 && s.avg < 200 ? 0.25 : 0)) +
        hw(s, ['qty', 'quantity', 'unit sold', 'sold', 'kuantiti', '数量'], 0.4);
    }, taken);
    if (out.qty != null) taken.push(out.qty);

    out.unitPrice = pick(function (s) {
      if (s.numRate < 0.7) return 0;
      return saysAmount(s) * (s.decRate * 0.35 + 0.2) +
        hw(s, ['unit price', 'u/price', 'price', 'harga', 'rate', '单价'], 0.45);
    }, taken);
    if (out.unitPrice != null) taken.push(out.unitPrice);

    // Amount: strongest evidence is amount ~= qty x unitPrice on most rows.
    out.amount = pick(function (s) {
      if (s.numRate < 0.7) return 0;
      var score = 0.15 + hw(s, ['amount', 'total', 'subtotal', 'value', 'jumlah', '金额', '小计'], 0.45);
      if (out.qty != null && out.unitPrice != null) {
        var hit = 0, seen = 0;
        sample.forEach(function (r) {
          var q = num(r[out.qty]), p = num(r[out.unitPrice]), a = num(r[s.i]);
          if (!q || !p) return;
          seen++;
          if (Math.abs(a - q * p) <= 0.02) hit++;
        });
        if (seen >= 3) score += (hit / seen) * 0.7;
      }
      return score;
    }, taken);

    return out;
  }

  /* ------------------------------------------------------------- exports */

  return {
    DEFAULTS: DEFAULTS, cfg: cfg,
    r2: r2, sum: sum, sumMoney: sumMoney, money: money, num: num,
    normKey: normKey, similarity: similarity, bestMatch: bestMatch,
    monthEnd: monthEnd,
    monthStart: monthStart, addDays: addDays, dmy: dmy, periodLabel: periodLabel, periodYYMM: periodYYMM,
    resolveLines: resolveLines, buildSettlement: buildSettlement, buildPharmacyBilling: buildPharmacyBilling,
    isBillable: isBillable, crossCheck: crossCheck, extractRows: extractRows, noiseReason: noiseReason,
    trackingPairs: trackingPairs, trackingOption: trackingOption, trackingUsed: trackingUsed,
    xeroPreflight: xeroPreflight,
    statementHTML: statementHTML, statementDoc: statementDoc, STMT_CSS: STMT_CSS, esc: esc,
    parseXeroContacts: parseXeroContacts, matchXeroContacts: matchXeroContacts,
    xeroPharmacyInvoices: xeroPharmacyInvoices, xeroServiceInvoices: xeroServiceInvoices,
    xeroPayoutBills: xeroPayoutBills, toCSV: toCSV, invNo: invNo,
    detectColumns: detectColumns,
    requireAccounts: requireAccounts,
    collapseItems: collapseItems,
    invoiceShape: invoiceShape, findHeaderRow: findHeaderRow, looksDate: looksDate, looksNum: looksNum,
    isPackageSheet: isPackageSheet, parsePackageSheet: parsePackageSheet,
    packageLines: packageLines, packageCrossCheck: packageCrossCheck
  };
});
