/* ==========================================================================
   KHQR Inspector - app.js
   AngularJS 1.8.x, no build step, no network access.
   Services: KhqrMetadataService, KhqrParser, KhqrSerializer, KhqrCrcService,
             KhqrValidationService, KhqrCompareService, KhqrQrService, KhqrFixtures
   Directive: khqrFileChange (passes the chosen file to the controller)
   Controller: KhqrController (controllerAs "vm", used by index.html)
   Every KHQR-specific rule lives in KhqrMetadataService or KhqrValidationService
   and is labelled with the confidence of its source.
   ========================================================================== */
(function () {
  'use strict';

  var MAX_INPUT_LENGTH = 20000;   // refuse larger payloads instead of freezing the page
  var MAX_DEPTH = 6;              // nested template depth limit
  var NON_ASCII = /[^\x00-\x7F]/;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

  var app = angular.module('khqrInspector', []);

  /* ======================================================================
     Metadata registry
     confidence: 'confirmed' = EMVCo rule or agreed by every source consulted
                 'implementation' = taken from published KHQR libraries only
     ====================================================================== */
  app.factory('KhqrMetadataService', function () {
    function def(name, description, presence, maxLength, format, pattern, extra) {
      var d = {
        known: true, name: name, description: description, presence: presence,
        maxLength: maxLength || null, format: format || '', pattern: pattern || null,
        unique: true, template: false, layer: 'emvco', confidence: 'confirmed',
        patternSeverity: 'error', missingSeverity: 'error', mai: false, reserved: false
      };
      for (var k in (extra || {})) { d[k] = extra[k]; }
      return d;
    }
    var KHQR = { layer: 'khqr' };
    var KHQR_IMPL = { layer: 'khqr', confidence: 'implementation' };
    var AMOUNT = /^\d+(\.\d+)?$/;

    var TOP = {
      '00': def('Payload Format Indicator', 'Version of the EMVCo QR payload format. Always 01.', 'Mandatory', 2, 'Fixed value 01', /^01$/),
      '01': def('Point of Initiation Method', '11 marks a static QR code, 12 a dynamic QR code.', 'Mandatory', 2, '11 or 12', /^1[12]$/),
      '15': def('Merchant Account Information (UnionPay)', 'UnionPay account in the KHQR profile. Kept as a raw value.', 'Optional', 31, 'Text', null, KHQR_IMPL),
      '29': def('Merchant Account Information, Individual', 'Bakong account of an individual payee (KHQR profile).', 'Conditional', null, 'Nested TLV', null,
        { template: 'yes', mai: true, layer: 'khqr' }),
      '30': def('Merchant Account Information, Merchant', 'Bakong account of a registered merchant (KHQR profile).', 'Conditional', null, 'Nested TLV', null,
        { template: 'yes', mai: true, layer: 'khqr' }),
      '52': def('Merchant Category Code', 'ISO 18245 category of the merchant.', 'Mandatory', 4, '4 digits', /^\d{4}$/),
      '53': def('Transaction Currency', 'ISO 4217 numeric currency. KHQR uses 116 (KHR) and 840 (USD).', 'Mandatory', 3, '3 digits', /^\d{3}$/),
      '54': def('Transaction Amount', 'Amount to pay. When absent the payer enters the amount.', 'Conditional', 13, 'Decimal number', AMOUNT),
      '55': def('Tip or Convenience Indicator', '01 prompts for a tip, 02 uses tag 56, 03 uses tag 57.', 'Conditional', 2, '01, 02 or 03', /^0[123]$/),
      '56': def('Convenience Fee Fixed', 'Fixed fee added to the amount.', 'Conditional', 13, 'Decimal number', AMOUNT),
      '57': def('Convenience Fee Percentage', 'Percentage fee added to the amount.', 'Conditional', 5, 'Decimal percentage', /^\d{1,2}(\.\d{1,2})?$/),
      '58': def('Country Code', 'ISO 3166-1 alpha-2 country code. KHQR uses KH.', 'Mandatory', 2, '2 uppercase letters', /^[A-Z]{2}$/),
      '59': def('Merchant Name', 'Name of the merchant or payee.', 'Mandatory', 25, 'Text up to 25 characters'),
      '60': def('Merchant City', 'City of the merchant or payee.', 'Mandatory', 15, 'Text up to 15 characters'),
      '61': def('Postal Code', 'Postal code of the merchant.', 'Optional', 10, 'Text up to 10 characters'),
      '62': def('Additional Data Field Template', 'Bill number, store label, terminal label and similar data.', 'Optional', null, 'Nested TLV', null, { template: 'yes' }),
      '63': def('CRC', 'CRC-16/CCITT-FALSE checksum of the payload. Always the last tag.', 'Mandatory', 4, '4 uppercase hex characters'),
      '64': def('Merchant Information, Language Template', 'Merchant name and city in an alternate language.', 'Optional', null, 'Nested TLV', null, { template: 'yes' }),
      '99': def('Timestamp Template', 'Creation and expiration timestamps used by KHQR.', 'Optional', null, 'Nested TLV', null,
        { template: 'yes', layer: 'khqr', confidence: 'implementation' })
    };

    var BAKONG_ID = def('Bakong Account ID', 'Account of the payee, written as name@bank.', 'Mandatory', 32, 'name@bank', /^[^@\s]+@[^@\s]+$/,
      { layer: 'khqr', patternSeverity: 'warning' });
    var ACQ_BANK_IMPL = def('Acquiring Bank', 'Name of the bank that holds the account.', 'Optional', 32, 'Text up to 32 characters', null, KHQR_IMPL);
    var GUID = def('Globally Unique Identifier', 'Identifies the scheme that owns this template (EMVCo).', 'Mandatory', null, 'Text');

    function sub(rows) { var o = {}, order = []; rows.forEach(function (r) { o[r[0]] = r[1]; order.push(r[0]); }); o.__order = order; return o; }
    function text25(name) { return def(name, name + '.', 'Optional', 25, 'Text up to 25 characters'); }

    var SUB = {
      '29': sub([['00', BAKONG_ID], ['01', def('Account Information', 'Extra account information.', 'Optional', 32, 'Text up to 32 characters', null, KHQR_IMPL)], ['02', ACQ_BANK_IMPL]]),
      '30': sub([['00', BAKONG_ID],
        ['01', def('Merchant ID', 'Merchant identifier issued by the acquiring bank.', 'Mandatory', 32, 'Text up to 32 characters', null, { layer: 'khqr', missingSeverity: 'warning' })],
        ['02', def('Acquiring Bank', 'Name of the bank that holds the account.', 'Mandatory', 32, 'Text up to 32 characters', null, { layer: 'khqr', missingSeverity: 'warning' })]]),
      '62': sub([['01', text25('Bill Number')], ['02', text25('Mobile Number')], ['03', text25('Store Label')], ['04', text25('Loyalty Number')],
        ['05', text25('Reference Label')], ['06', text25('Customer Label')], ['07', text25('Terminal Label')], ['08', text25('Purpose of Transaction')],
        ['09', def('Additional Consumer Data Request', 'Data the payer app should request.', 'Optional', 3, 'Up to 3 characters')]]),
      '64': sub([['00', def('Language Preference', 'ISO 639-1 language code.', 'Mandatory', 2, '2 letters', /^[A-Za-z]{2}$/, { patternSeverity: 'warning' })],
        ['01', def('Merchant Name, Alternate Language', 'Merchant name in the alternate language.', 'Mandatory', 25, 'Text up to 25 characters')],
        ['02', def('Merchant City, Alternate Language', 'Merchant city in the alternate language.', 'Optional', 15, 'Text up to 15 characters')]]),
      '99': sub([['00', def('Creation Timestamp', 'Unix time in milliseconds when the QR code was created.', 'Optional', 13, '13 digits (epoch milliseconds)', /^\d{13}$/, { layer: 'khqr', confidence: 'implementation', patternSeverity: 'warning' })],
        ['01', def('Expiration Timestamp', 'Unix time in milliseconds when a dynamic QR code expires.', 'Optional', 13, '13 digits (epoch milliseconds)', /^\d{13}$/, { layer: 'khqr', confidence: 'implementation', patternSeverity: 'warning' })]])
    };

    function num(id) { return /^\d{2}$/.test(id) ? parseInt(id, 10) : -1; }
    function isMai(id) { var n = num(id); return n >= 2 && n <= 51; }
    function unknown(what) {
      return def('Unknown ' + what, 'Not defined in the loaded metadata. The raw value is preserved unchanged.', '', null, '', null, { known: false });
    }

    function getMeta(id, parentId) {
      if (parentId) {
        if (SUB[parentId] && SUB[parentId][id]) { return SUB[parentId][id]; }
        if (isMai(parentId) && !SUB[parentId] && id === '00') { return GUID; }
        return unknown('subtag');
      }
      if (TOP[id]) { return TOP[id]; }
      var n = num(id);
      if (n >= 26 && n <= 51) {
        return def('Merchant Account Information', 'Payment scheme account template. Structure depends on the scheme.', 'Conditional', null, 'Nested TLV', null, { template: 'yes', mai: true });
      }
      if (n >= 2 && n <= 25) { return def('Merchant Account Information', 'Payment scheme account value.', 'Conditional', 99, 'Text', null, { mai: true }); }
      if (n >= 65 && n <= 79) { return def('Reserved for EMVCo', 'Reserved range. The value is preserved unchanged.', 'Optional', null, '', null, { reserved: true }); }
      if (n >= 80 && n <= 99) { return def('Unreserved Template', 'Free-use range. Parsed as nested TLV when the value is valid TLV.', 'Optional', null, 'Text or nested TLV', null, { template: 'try' }); }
      return unknown('tag');
    }

    function subtagList(parentId) {
      var defs = SUB[parentId], list = [];
      if (defs) { defs.__order.forEach(function (id) { list.push({ id: id, name: defs[id].name, meta: defs[id] }); }); }
      else if (isMai(parentId)) { list.push({ id: '00', name: GUID.name, meta: GUID }); }
      return list;
    }

    var KNOWN_TOP = ['00', '01', '15', '29', '30', '52', '53', '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64', '99'];
    return {
      getMeta: getMeta, subtagList: subtagList, isMai: isMai,
      knownTagOptions: KNOWN_TOP.map(function (id) { return { id: id, name: TOP[id].name }; })
    };
  });

  /* ======================================================================
     Parser: recursive EMVCo TLV decoder
     ====================================================================== */
  app.factory('KhqrParser', ['KhqrMetadataService', function (Meta) {
    var uidSeq = 0;

    function createNode(id, value, depth) {
      return {
        uid: 'n' + (++uidSeq), id: id, value: value, children: null, isTemplate: false,
        expanded: false, rawMode: false, rawText: '', depth: depth || 0, path: id, parentId: null,
        origId: id, origValue: value, origIsTemplate: false, isNew: false, nestError: null
      };
    }
    function markNew(node) {
      node.isNew = true; node.origId = null; node.origValue = null;
      if (node.children) { node.children.forEach(markNew); }
    }
    function fail(message, position) {
      return { error: { message: message, position: position, hint: 'Check for missing or extra characters near this position.' } };
    }

    // Reads sequential TLV records from one string. `base` is the absolute offset of s[0].
    function parseLevel(s, base, depth, parentId, parentPath) {
      var nodes = [], pos = 0;
      while (pos < s.length) {
        var at = base + pos;
        if (s.length - pos < 4) {
          return fail('Truncated tag header: ' + (s.length - pos) + ' character(s) remain but a tag needs 4 (2-digit ID, 2-digit length).', at);
        }
        var id = s.substr(pos, 2), lenText = s.substr(pos + 2, 2);
        if (!/^\d{2}$/.test(id)) { return fail('Invalid tag ID "' + id + '": tag IDs must be two digits.', at); }
        if (!/^\d{2}$/.test(lenText)) { return fail('Invalid length "' + lenText + '" for tag ' + id + ': lengths must be two digits.', at + 2); }
        var len = parseInt(lenText, 10), end = pos + 4 + len;
        if (end > s.length) {
          return fail('Truncated value for tag ' + id + ': length is ' + lenText + ' but only ' + (s.length - pos - 4) + ' character(s) remain.', at + 4);
        }
        var value = s.substring(pos + 4, end);
        var node = createNode(id, value, depth);
        node.parentId = parentId;
        node.path = parentPath ? parentPath + '.' + id : id;
        var meta = Meta.getMeta(id, parentId);
        if (meta.template && depth < MAX_DEPTH && !(meta.template === 'try' && value === '')) {
          var inner = parseLevel(value, at + 4, depth + 1, id, node.path);
          if (!inner.error) {
            node.children = inner.nodes; node.isTemplate = true; node.origIsTemplate = true; node.expanded = depth === 0;
          } else if (meta.template === 'yes') {
            // keep the raw value, report the problem (position is relative to this value)
            node.nestError = { message: inner.error.message, position: inner.error.position - (at + 4) };
          }
        }
        nodes.push(node);
        pos = end;
      }
      return { nodes: nodes };
    }

    // Parses an edited value for a node that owns nested TLV (positions are relative to the value).
    function parseValue(value, depth, ownId, ownPath) { return parseLevel(value, 0, depth + 1, ownId, ownPath); }

    function decode(source) {
      var src = String(source == null ? '' : source).trim();
      if (!src) { return { error: { message: 'The payload is empty.', position: null, hint: 'Paste a KHQR payload or load a sample.' }, source: src }; }
      if (src.length > MAX_INPUT_LENGTH) {
        return { error: { message: 'The payload has ' + src.length + ' characters; the limit is ' + MAX_INPUT_LENGTH + '.', position: null, hint: 'Remove extra text. A KHQR payload is usually under 400 characters.' }, source: src };
      }
      var r = parseLevel(src, 0, 0, null, '');
      r.source = src;
      return r;
    }

    function context(src, pos) {
      if (pos === null || pos === undefined) { return { before: '', at: '', after: '' }; }
      return {
        before: (pos > 24 ? '\u2026' : '') + src.slice(Math.max(0, pos - 24), pos),
        at: pos >= src.length ? '\u2039end\u203a' : src.substr(pos, 4),
        after: src.slice(pos + 4, pos + 28) + (src.length > pos + 28 ? '\u2026' : '')
      };
    }

    function walk(nodes, fn, parentId) {
      nodes.forEach(function (n, i) {
        fn(n, parentId || null, nodes, i);
        if (n.isTemplate) { walk(n.children, fn, n.id); }
      });
    }

    return { decode: decode, parseValue: parseValue, createNode: createNode, markNew: markNew, context: context, walk: walk, MAX_INPUT_LENGTH: MAX_INPUT_LENGTH };
  }]);

  /* ======================================================================
     Serializer: rebuilds the payload from the node model only
     ====================================================================== */
  app.factory('KhqrSerializer', function () {
    function tlv(id, value) { return id + pad2(value.length) + value; }
    function lengthField(len) { return len > 99 ? '--' : pad2(len); }

    function build(nodes, trail, errors) {
      var out = '';
      nodes.forEach(function (n) {
        var path = trail ? trail + '.' + n.id : n.id;
        var value = n.isTemplate ? build(n.children, path, errors) : String(n.value == null ? '' : n.value);
        if (!/^\d{2}$/.test(n.id)) { errors.push({ path: path, message: 'Tag ID "' + n.id + '" must be two digits.' }); }
        if (value.length > 99) { errors.push({ path: path, message: 'Value is ' + value.length + ' characters; the maximum is 99.' }); }
        out += n.id + (value.length > 99 ? String(value.length) : pad2(value.length)) + value;
      });
      return out;
    }
    function serialize(nodes) { var errors = []; var text = build(nodes, '', errors); return { text: text, errors: errors }; }
    function valueOf(node) { return node.isTemplate ? serialize(node.children).text : String(node.value == null ? '' : node.value); }

    return { serialize: serialize, valueOf: valueOf, tlv: tlv, lengthField: lengthField, pad2: pad2 };
  });

  /* ======================================================================
     CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0
     ====================================================================== */
  app.factory('KhqrCrcService', ['KhqrSerializer', 'KhqrParser', function (Ser, Parser) {
    function toBytes(str) {
      if (typeof TextEncoder !== 'undefined') { return new TextEncoder().encode(str); }
      var s = unescape(encodeURIComponent(str)), out = [];
      for (var i = 0; i < s.length; i++) { out.push(s.charCodeAt(i)); }
      return out;
    }
    // Standalone: takes the exact characters to checksum, returns 4 uppercase hex characters.
    function crc16(text) {
      var bytes = toBytes(String(text)), crc = 0xFFFF;
      for (var i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8;
        for (var b = 0; b < 8; b++) { crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF); }
      }
      return ('0000' + crc.toString(16).toUpperCase()).slice(-4);
    }
    function indexOfCrc(tree) { for (var i = 0; i < tree.length; i++) { if (tree[i].id === '63') { return i; } } return -1; }

    function idle(message) {
      return { present: false, declaredLength: '', existing: '', calculated: '', coveredLength: 0, coveredText: '', status: 'NO DATA', state: 'idle', message: message };
    }

    // Verifies tag 63 against the current model (everything before tag 63, plus the "6304" header).
    function inspect(tree) {
      var idx = indexOfCrc(tree), out = idle('');
      out.present = idx >= 0;
      var head = Ser.serialize(idx >= 0 ? tree.slice(0, idx) : tree);
      if (head.errors.length) { out.message = 'The payload cannot be serialized yet. Fix the structural errors first.'; return out; }
      out.coveredText = head.text + '6304';
      out.coveredLength = out.coveredText.length;
      out.calculated = crc16(out.coveredText);
      if (idx < 0) {
        out.status = 'MISSING'; out.state = 'fail';
        out.message = 'The payload has no tag 63. The checksum it would need is ' + out.calculated + '. Use Recalculate CRC to append it.';
        return out;
      }
      var existing = String(tree[idx].value);
      out.existing = existing; out.declaredLength = Ser.lengthField(existing.length);
      if (existing.length !== 4) {
        out.status = 'INVALID LENGTH'; out.state = 'fail';
        out.message = 'Tag 63 must hold exactly 4 characters but holds ' + existing.length + '. Use Recalculate CRC to rewrite it.';
      } else if (existing.toUpperCase() === out.calculated) {
        out.status = 'PASS'; out.state = 'pass';
        out.message = 'The stored checksum matches the checksum calculated over ' + out.coveredLength + ' characters.';
      } else {
        out.status = 'FAIL'; out.state = 'fail';
        out.message = 'Stored ' + existing + ' does not match calculated ' + out.calculated + '. Use Recalculate CRC to rewrite tag 63.';
      }
      return out;
    }

    // Rewrites tag 63 as the last tag with a fresh checksum. Returns the new CRC or null.
    function apply(tree, addIfMissing, move) {
      var idx = indexOfCrc(tree);
      if (idx < 0 && !addIfMissing) { return null; }
      if (idx >= 0 && !move) {   // automatic update: rewrite the value in place, never reorder tags
        var before = Ser.serialize(tree.slice(0, idx));
        if (before.errors.length) { return null; }
        tree[idx].value = crc16(before.text + '6304');
        return tree[idx].value;
      }
      var node = idx >= 0 ? tree[idx] : null;
      var rest = tree.filter(function (n) { return n !== node; });
      var head = Ser.serialize(rest);
      if (head.errors.length) { return null; }
      if (!node) { node = Parser.createNode('63', ''); Parser.markNew(node); } else { tree.splice(idx, 1); }
      node.value = crc16(head.text + '6304');
      tree.push(node);
      return node.value;
    }

    return { crc16: crc16, inspect: inspect, apply: apply, idle: idle };
  }]);

  /* ======================================================================
     Validation: structural, EMVCo and KHQR layers
     ====================================================================== */
  app.factory('KhqrValidationService', ['KhqrMetadataService', 'KhqrSerializer', 'KhqrParser', function (Meta, Ser, Parser) {
    var LAYERS = [{ key: 'structural', label: 'Structural' }, { key: 'emvco', label: 'EMVCo' }, { key: 'khqr', label: 'KHQR' }];
    var KHQR_CURRENCIES = { '116': 'KHR', '840': 'USD' };
    var REQUIRED_TOP = ['00', '01', '52', '53', '58', '59', '60'];

    function finish(list, hasData) {
      var counts = { error: 0, warning: 0, info: 0 };
      list.forEach(function (f) { counts[f.severity]++; });
      var layers = LAYERS.map(function (l) {
        var mine = list.filter(function (f) { return f.layer === l.key; });
        var c = function (s) { return mine.filter(function (f) { return f.severity === s; }).length; };
        return { key: l.key, label: l.label, errors: c('error'), warnings: c('warning'), infos: c('info') };
      });
      var verdict, summary;
      if (!hasData) {
        verdict = { state: 'idle', label: 'Not validated', detail: 'Decode a payload to run validation.' };
        summary = 'No payload has been validated yet.';
      } else if (counts.error) {
        verdict = { state: 'fail', label: 'Invalid', detail: counts.error + ' error(s), ' + counts.warning + ' warning(s), ' + counts.info + ' info' };
        summary = 'Invalid: ' + counts.error + ' error(s), ' + counts.warning + ' warning(s).';
      } else if (counts.warning) {
        verdict = { state: 'warn', label: 'Valid with warnings', detail: counts.warning + ' warning(s), ' + counts.info + ' info' };
        summary = 'Valid with ' + counts.warning + ' warning(s).';
      } else {
        verdict = { state: 'pass', label: 'Valid', detail: 'No errors or warnings, ' + counts.info + ' info' };
        summary = 'Valid: no errors or warnings.';
      }
      return { verdict: verdict, summaryText: summary, counts: counts, layers: layers, findings: list };
    }
    function empty() { return finish([], false); }

    function forParseError(error) {
      return finish([{ key: 'structural|parse|payload|0', layer: 'structural', severity: 'error', code: 'parse', path: error.position === null ? 'payload' : 'char ' + error.position,
        tagId: null, nodeUid: null, message: error.message, suggestion: error.hint || '' }], true);
    }

    function validate(tree, crc, now) {
      var list = [], seq = 0;
      function add(layer, severity, code, path, node, message, fix) {
        list.push({ key: layer + '|' + code + '|' + path + '|' + (seq++), layer: layer, severity: severity, code: code, path: path,
          tagId: node ? node.id : null, nodeUid: node ? node.uid : null, message: message, suggestion: fix || '' });
      }
      var top = {};
      tree.forEach(function (n) { if (!top[n.id]) { top[n.id] = n; } });
      function topValue(id) { return top[id] ? String(top[id].value) : null; }

      // Per-node checks, applied at every nesting level
      function checkLevel(nodes, parentId) {
        var seen = {};
        nodes.forEach(function (n) {
          var meta = Meta.getMeta(n.id, parentId), path = n.path;
          var value = Ser.valueOf(n), len = value.length;
          if (!/^\d{2}$/.test(n.id)) { add('structural', 'error', 'bad-id', path, n, 'Tag ID "' + n.id + '" must be exactly two digits.', 'Use a two-digit numeric ID such as 62.'); }
          if (len > 99) { add('structural', 'error', 'too-long', path, n, 'Value is ' + len + ' characters; a length field holds at most 99.', 'Shorten the value to 99 characters or fewer.'); }
          if (n.nestError) { add('structural', 'error', 'nested-tlv', path, n, 'The value of tag ' + n.id + ' is not valid nested TLV: ' + n.nestError.message + ' (position ' + n.nestError.position + ' within the value).', 'Correct the nested data, or edit the value as raw text.'); }
          if (len === 0) { add('emvco', 'error', 'empty', path, n, 'Length 00 is not allowed; values must be 1 to 99 characters.', 'Enter a value or remove the tag.'); }
          if (seen[n.id]) { add('emvco', 'error', 'duplicate', path, n, 'Tag ' + n.id + ' appears more than once at this level.', 'Remove the duplicate.'); }
          seen[n.id] = true;
          if (!meta.known) { add('emvco', 'info', 'unknown', path, n, 'Tag ' + n.id + ' is not defined in the loaded metadata. It is preserved unchanged.', ''); }
          else if (meta.reserved) { add('emvco', 'info', 'reserved', path, n, 'Tags 65 to 79 are reserved for EMVCo. The value is preserved unchanged.', ''); }
          else {
            if (meta.maxLength && len > meta.maxLength) { add(meta.layer, 'error', 'max-length', path, n, meta.name + ' allows at most ' + meta.maxLength + ' characters; found ' + len + '.', 'Shorten the value.'); }
            if (meta.pattern && len > 0 && !n.isTemplate && !meta.pattern.test(value)) {
              add(meta.layer, meta.patternSeverity, 'format', path, n, meta.name + ' should be ' + meta.format + '; found "' + shorten(value, 30) + '".', 'Use this format: ' + meta.format + '.');
            }
          }
          if (NON_ASCII.test(value)) { add('emvco', 'info', 'non-ascii', path, n, 'Contains non-ASCII characters. Length is counted in JavaScript characters and may differ from a byte-based count.', ''); }
          if (n.isTemplate) {
            Meta.subtagList(n.id).forEach(function (d) {
              if (d.meta.presence === 'Mandatory' && !n.children.some(function (c) { return c.id === d.id; })) {
                add(d.meta.layer, d.meta.missingSeverity, 'missing-sub', path + '.' + d.id, n, 'Subtag ' + d.id + ' (' + d.name + ') is missing from tag ' + n.id + '.', 'Add subtag ' + d.id + '.');
              }
            });
            checkLevel(n.children, n.id);
          }
        });
      }
      checkLevel(tree, null);

      // EMVCo top-level rules
      REQUIRED_TOP.forEach(function (id) {
        if (!top[id]) { add('emvco', 'error', 'missing-tag', id, null, 'Mandatory tag ' + id + ' (' + Meta.getMeta(id, null).name + ') is missing.', 'Add tag ' + id + '.'); }
      });
      if (!tree.some(function (n) { var v = parseInt(n.id, 10); return /^\d{2}$/.test(n.id) && v >= 2 && v <= 51; })) {
        add('emvco', 'error', 'no-mai', '26-51', null, 'At least one Merchant Account Information tag (02 to 51) must be present.', 'Add tag 29 or 30 for a KHQR account.');
      }
      if (tree.length && tree[0].id !== '00') { add('emvco', 'warning', 'order', tree[0].path, tree[0], 'Tag 00 should be the first tag.', 'Move tag 00 to the top.'); }
      var tip = topValue('55');
      if (tip === '02' && !top['56']) { add('emvco', 'error', 'fee-fixed', '56', null, 'Tag 55 is 02 so tag 56 (fixed fee) is required.', 'Add tag 56.'); }
      if (tip === '03' && !top['57']) { add('emvco', 'error', 'fee-pct', '57', null, 'Tag 55 is 03 so tag 57 (percentage fee) is required.', 'Add tag 57.'); }
      if ((top['56'] && tip !== '02') || (top['57'] && tip !== '03')) { add('emvco', 'warning', 'fee-unused', top['56'] ? '56' : '57', top['56'] || top['57'], 'A convenience fee tag is present without the matching tag 55 value.', 'Set tag 55 to 02 (tag 56) or 03 (tag 57).'); }

      // CRC and ordering
      var ci = -1;
      tree.forEach(function (n, i) { if (n.id === '63' && ci < 0) { ci = i; } });
      if (crc.status === 'MISSING') { add('emvco', 'error', 'crc-missing', '63', null, 'Tag 63 (CRC) is missing.', 'Use Recalculate CRC to append it.'); }
      else if (crc.status === 'INVALID LENGTH') { add('emvco', 'error', 'crc-length', tree[ci].path, tree[ci], 'Tag 63 must hold exactly 4 characters; found ' + crc.existing.length + '.', 'Use Recalculate CRC.'); }
      else if (crc.status === 'FAIL') { add('emvco', 'error', 'crc-mismatch', tree[ci].path, tree[ci], 'CRC mismatch: stored ' + crc.existing + ', calculated ' + crc.calculated + '.', 'Use Recalculate CRC to rewrite tag 63.'); }
      else if (crc.status === 'PASS' && crc.existing !== crc.existing.toUpperCase()) { add('emvco', 'warning', 'crc-case', tree[ci].path, tree[ci], 'The CRC is written in lowercase; EMVCo requires uppercase hex.', 'Use Recalculate CRC.'); }
      if (ci >= 0 && ci < tree.length - 1) { add('structural', 'error', 'after-crc', tree[ci + 1].path, tree[ci + 1], 'Data follows tag 63. The CRC must be the last data object.', 'Move tag 63 to the end or remove the trailing tags.'); }

      // KHQR profile rules (confidence noted per rule)
      var cur = topValue('53');
      if (cur && /^\d{3}$/.test(cur) && !KHQR_CURRENCIES[cur]) { add('khqr', 'warning', 'currency', '53', top['53'], 'Currency ' + cur + ' is neither KHR (116) nor USD (840), the currencies KHQR uses.', 'Use 116 or 840.'); }
      var cc = topValue('58');
      if (cc && /^[A-Z]{2}$/.test(cc) && cc !== 'KH') { add('khqr', 'warning', 'country', '58', top['58'], 'KHQR payloads use country code KH; found ' + cc + '.', 'Use KH.'); }
      if (!top['29'] && !top['30']) { add('khqr', 'warning', 'no-bakong', '29', null, 'No Bakong account tag found. KHQR payloads normally carry tag 29 (individual) or tag 30 (merchant).', 'Add tag 29 or 30.'); }
      if (top['29'] && top['30']) { add('khqr', 'warning', 'both-bakong', '30', top['30'], 'Both tag 29 and tag 30 are present. Published KHQR libraries emit only one.', 'Keep the account tag that applies.'); }
      var amt = topValue('54');
      if (amt && AMOUNT_OK(amt)) {
        if (cur === '116' && /\./.test(amt) && !/^\d+\.0+$/.test(amt)) { add('khqr', 'warning', 'khr-decimals', '54', top['54'], 'KHR amounts are normally whole numbers; found ' + amt + '. (Profile rule not checked against the NBC document.)', 'Use a whole number of riel.'); }
        if (cur === '840' && /\.\d{3,}$/.test(amt)) { add('khqr', 'warning', 'usd-decimals', '54', top['54'], 'USD amounts normally have at most 2 decimals; found ' + amt + '. (Profile rule not checked against the NBC document.)', 'Round to 2 decimals.'); }
      }
      var ts = top['99'] && top['99'].isTemplate ? top['99'] : null;
      var exp = ts ? ts.children.filter(function (c) { return c.id === '01'; })[0] : null;
      if (topValue('01') === '12') {
        if (!ts) { add('khqr', 'warning', 'no-ts', '99', null, 'This is a dynamic QR code (tag 01 is 12) but tag 99 (timestamps) is missing.', 'Add tag 99 with an expiration timestamp.'); }
        else if (!exp) { add('khqr', 'warning', 'no-exp', '99.01', ts, 'A dynamic QR code should carry an expiration timestamp (tag 99, subtag 01).', 'Add subtag 01.'); }
      }
      if (exp && /^\d{13}$/.test(exp.value) && now > parseInt(exp.value, 10)) { add('khqr', 'info', 'expired', exp.path, exp, 'The expiration timestamp is in the past (' + new Date(parseInt(exp.value, 10)).toISOString() + ').', ''); }
      return finish(list, true);
    }
    function AMOUNT_OK(s) { return /^\d+(\.\d+)?$/.test(s); }

    return { validate: validate, empty: empty, forParseError: forParseError, LAYERS: LAYERS };
  }]);

  /* ======================================================================
     Compare: original baseline versus the current model
     ====================================================================== */
  app.factory('KhqrCompareService', ['KhqrMetadataService', 'KhqrSerializer', function (Meta, Ser) {
    function snapshot(nodes) {
      return nodes.map(function (n) { return { id: n.id, isTemplate: n.isTemplate, value: n.isTemplate ? null : String(n.value), children: n.isTemplate ? snapshot(n.children) : null }; });
    }
    function flatten(nodes, entries, orders, parentKey, parentId) {
      var seen = {}, order = [];
      nodes.forEach(function (n) {
        seen[n.id] = (seen[n.id] || 0) + 1;
        var key = (parentKey ? parentKey + '.' : '') + n.id + (seen[n.id] > 1 ? '#' + seen[n.id] : '');
        order.push(key);
        entries[key] = { key: key, path: key, id: n.id, name: Meta.getMeta(n.id, parentId).name, isTemplate: !!n.isTemplate,
          value: n.isTemplate ? Ser.valueOf(n) : String(n.value), display: n.isTemplate ? '[nested template, ' + n.children.length + ' subtag(s)]' : String(n.value) };
        if (n.isTemplate) { flatten(n.children, entries, orders, key, n.id); }
      });
      orders[parentKey || ''] = order;
    }
    function diff(baseline, tree, originalPayload, currentPayload) {
      var A = {}, B = {}, oa = {}, ob = {}, changes = [];
      flatten(baseline || [], A, oa, '', null);
      flatten(tree, B, ob, '', null);
      var sum = { added: 0, removed: 0, modified: 0, unchanged: 0 };
      function push(type, e, oldV, newV) { changes.push({ key: type + '|' + e.key, type: type, path: e.path, name: e.name, oldValue: oldV, newValue: newV }); if (sum[type] !== undefined) { sum[type]++; } }
      Object.keys(B).forEach(function (k) {
        var b = B[k], a = A[k];
        if (!a) { push('added', b, null, b.display); }
        else if (b.isTemplate !== a.isTemplate) { push('modified', b, a.display, b.display); }
        else if (a.value === b.value) { push('unchanged', b, a.display, b.display); }
        else if (!b.isTemplate) { push('modified', b, a.display, b.display); }   // changed templates are reported through their children
      });
      Object.keys(A).forEach(function (k) { if (!B[k]) { push('removed', A[k], A[k].display, null); } });
      Object.keys(ob).forEach(function (pk) {
        if (!oa[pk]) { return; }
        var inB = ob[pk].filter(function (k) { return A[k]; }), inA = oa[pk].filter(function (k) { return B[k]; });
        if (inA.join('|') !== inB.join('|')) {
          var last = function (k) { return k.split('.').pop(); };
          changes.push({ key: 'order|' + pk, type: 'modified', path: pk || 'top level', name: 'Tag order', oldValue: inA.map(last).join(', '), newValue: inB.map(last).join(', ') });
          sum.modified++;
        }
      });
      var n = sum.added + sum.removed + sum.modified;
      var parts = [];
      ['added', 'removed', 'modified'].forEach(function (t) { if (sum[t]) { parts.push(sum[t] + ' ' + t); } });
      return {
        hasChanges: n > 0, changeCount: n, summary: sum, changes: changes,
        summaryText: baseline ? (n ? n + ' change(s) from the original: ' + parts.join(', ') + '.' : 'No changes from the original payload.') : 'Decode a payload to compare it with later edits.',
        originalPayload: originalPayload || '', currentPayload: currentPayload || ''
      };
    }
    return { snapshot: snapshot, diff: diff };
  }]);

  /* ======================================================================
     Synthetic fixtures. Checksums are produced by KhqrCrcService, never typed in.
     ====================================================================== */
  app.factory('KhqrFixtures', ['KhqrSerializer', 'KhqrCrcService', function (Ser, Crc) {
    var t = Ser.tlv;
    function withCrc(body) { var p = body + '6304'; return p + Crc.crc16(p); }
    var individual29 = t('29', t('00', 'sample_user@devb') + t('01', '000000000') + t('02', 'Sample Bank'));
    var merchant30 = t('30', t('00', 'sample_shop@devb') + t('01', 'SAMPLE000001') + t('02', 'Sample Bank'));
    var stamps = t('99', t('00', '1760000000000') + t('01', '4102444800000'));
    function core(mai, currency, amount, extra) {
      return t('00', '01') + t('01', amount ? '12' : '11') + mai + t('52', '5999') + t('53', currency) + (amount ? t('54', amount) : '') +
        t('58', 'KH') + t('59', 'Sample Shop') + t('60', 'Phnom Penh') + (extra || '');
    }
    var khrBody = core(individual29, '116', '10000', stamps);
    return {
      t: t, withCrc: withCrc, core: core, individual29: individual29, merchant30: merchant30, stamps: stamps, khrBody: khrBody,
      khr: withCrc(khrBody),
      usd: withCrc(core(individual29, '840', '1.50', stamps)),
      merchantStatic: withCrc(core(merchant30, '116', '', '')),
      singleSub: withCrc(core(t('29', t('00', 'sample_user@devb')), '116', '', ''))
    };
  }]);

  // <input type="file" khqr-file-change="vm.fn($file)"> calls the expression with the chosen file
  app.directive('khqrFileChange', ['$parse', function ($parse) {
    return {
      restrict: 'A',
      link: function (scope, element, attrs) {
        var handler = $parse(attrs.khqrFileChange);
        element.on('change', function (event) {
          var file = event.target.files && event.target.files[0];
          scope.$apply(function () { handler(scope, { $file: file }); });
          event.target.value = '';   // allows choosing the same photo again
        });
      }
    };
  }]);

  /* ======================================================================
     QR code: wraps vendor/qrcode.js (qrcode-generator, MIT) and draws on a canvas
     ====================================================================== */
  app.factory('KhqrQrService', ['$window', function ($window) {
    function lib() {
      var q = $window.qrcode;
      if (!q) { throw new Error('The QR library was not found. Put vendor/qrcode.js next to index.html.'); }
      // payloads are encoded as UTF-8 bytes so non-ASCII text survives
      if (q.stringToBytesFuncs && q.stringToBytesFuncs['UTF-8']) { q.stringToBytes = q.stringToBytesFuncs['UTF-8']; }
      return q;
    }
    function encode(text, level) {
      var code = lib()(0, level || 'M');   // type number 0 = smallest version that fits
      code.addData(String(text), 'Byte');
      try { code.make(); }
      catch (e) { throw new Error('The payload is too long for a QR code at error correction level ' + (level || 'M') + '. Try a lower level.'); }
      var n = code.getModuleCount();
      return { count: n, version: (n - 17) / 4, isDark: function (r, c) { return code.isDark(r, c); } };
    }
    // Whole pixels per module plus a 4-module quiet zone, as the QR standard requires.
    function layout(qr, targetPx) {
      var quiet = 4, cells = qr.count + quiet * 2, cell = Math.max(2, Math.floor(targetPx / cells));
      return { quiet: quiet, cell: cell, size: cell * cells };
    }
    // Always black on white, whatever the page theme, so scanners can read it.
    function draw(canvas, qr, targetPx) {
      var L = layout(qr, targetPx);
      canvas.width = L.size; canvas.height = L.size;
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) { return false; }
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, L.size, L.size);
      ctx.fillStyle = '#000000';
      for (var r = 0; r < qr.count; r++) {
        for (var c = 0; c < qr.count; c++) {
          if (qr.isDark(r, c)) { ctx.fillRect((c + L.quiet) * L.cell, (r + L.quiet) * L.cell, L.cell, L.cell); }
        }
      }
      return true;
    }
    return { encode: encode, draw: draw, layout: layout };
  }]);

  /* ======================================================================
     Controller
     ====================================================================== */
  app.controller('KhqrController', ['$window', '$document', '$timeout', '$q', 'KhqrParser', 'KhqrSerializer', 'KhqrCrcService',
    'KhqrValidationService', 'KhqrMetadataService', 'KhqrCompareService', 'KhqrQrService', 'KhqrFixtures',
    function ($window, $document, $timeout, $q, Parser, Ser, Crc, Val, Meta, Cmp, Qr, Fx) {
      var vm = this;
      var doc = $document[0];
      var infoMap = {};
      var model = { source: '', baseline: null };
      var toastTimer = null;
      var RANK = { ok: 0, info: 1, warning: 2, error: 3 }, RANK_NAME = ['ok', 'info', 'warning', 'error'];

      /* ---------- static configuration bound by the template ---------- */
      vm.statusCardDefs = [{ key: 'parsing', title: 'Parsing' }, { key: 'structure', title: 'TLV structure' }, { key: 'crc', title: 'CRC check' }, { key: 'khqr', title: 'KHQR rules' }];
      vm.tabs = [{ key: 'validation', label: 'Validation' }, { key: 'changes', label: 'Changes' }, { key: 'json', label: 'JSON' }, { key: 'tests', label: 'Tests' }];
      vm.knownTagOptions = Meta.knownTagOptions;
      vm.samples = [
        { id: 'khr-individual', title: 'Individual, KHR, dynamic', payload: Fx.khr },
        { id: 'usd-individual', title: 'Individual, USD, dynamic', payload: Fx.usd },
        { id: 'merchant-static', title: 'Merchant (tag 30), static', payload: Fx.merchantStatic },
        { id: 'single-subtag', title: 'Individual, one subtag, static', payload: Fx.singleSub }
      ];
      vm.selectedSampleId = vm.samples[0].id;

      /* ---------- state ---------- */
      function idleStatus(detail) {
        return {
          parsing: { state: 'idle', label: 'No payload', detail: detail || 'Decode a payload to begin.' },
          structure: { state: 'idle', label: 'Not checked', detail: 'Waiting for a decoded payload.' },
          crc: { state: 'idle', label: 'Not checked', detail: 'Waiting for a decoded payload.' },
          khqr: { state: 'idle', label: 'Not checked', detail: 'Waiting for a decoded payload.' },
          tagCount: 0, topLevelCount: 0, nestedCount: 0
        };
      }
      vm.theme = 'light';
      try { if ($window.localStorage.getItem('khqrInspectorTheme') === 'dark') { vm.theme = 'dark'; } } catch (e) { /* storage unavailable */ }
      vm.rawInput = '';
      vm.stats = { charCount: 0, payloadLength: 0 };
      vm.options = { autoDecode: false, autoCrc: true };
      vm.parseError = null;
      vm.inputMessage = null;
      vm.status = idleStatus();
      vm.hasDecoded = false;
      vm.tree = [];
      vm.search = { query: '', matches: [], activeIndex: 0 };
      vm.treeFilter = 'all';
      vm.newTag = { id: '', value: '' };
      vm.newTagError = null;
      vm.newSubtag = { id: '', value: '' };
      vm.newSubtagError = null;
      vm.subtagOptions = [];
      vm.selectedNode = null;
      vm.selectedMeta = null;
      vm.selectedPathLabel = '';
      vm.selectedFindings = [];
      vm.accountPanel = { visible: false, fields: [] };
      vm.pendingRemoval = null;
      vm.removalWarnings = [];
      vm.editorError = null;
      vm.rawTemplateError = null;
      vm.output = { payload: '', length: 0, json: '' };
      vm.crc = Crc.idle('Decode a payload to verify its CRC.');
      vm.crcTool = { input: '', result: '' };
      vm.validation = Val.empty();
      vm.findingFilter = { severity: 'all', layer: 'all' };
      vm.activeTab = 'validation';
      vm.tabCounts = { validation: 0, changes: 0 };
      vm.compareShowUnchanged = false;
      vm.comparison = Cmp.diff(null, [], '', '');
      vm.toast = { visible: false, type: 'info', message: '' };
      vm.qrLevels = [{ id: 'L', label: 'Low (L)' }, { id: 'M', label: 'Medium (M)' }, { id: 'Q', label: 'Quartile (Q)' }, { id: 'H', label: 'High (H)' }];
      vm.qrOptions = { level: 'M' };
      vm.qr = { ready: false, info: '', warning: '', message: 'Decode a payload to see its QR code.' };
      vm.scan = { active: false, status: '' };

      vm.findingFilterFn = function (f) {
        return (vm.findingFilter.severity === 'all' || f.severity === vm.findingFilter.severity) &&
               (vm.findingFilter.layer === 'all' || f.layer === vm.findingFilter.layer);
      };
      vm.changeFilterFn = function (c) { return vm.compareShowUnchanged || c.type !== 'unchanged'; };

      /* ---------- helpers ---------- */
      function showToast(message, type) {
        if (toastTimer) { $timeout.cancel(toastTimer); }
        vm.toast = { visible: true, type: type || 'info', message: message };
        toastTimer = $timeout(function () { vm.toast.visible = false; }, 3500);
      }
      vm.dismissToast = function () { vm.toast.visible = false; };

      function locate(target, nodes, parent) {
        nodes = nodes || vm.tree;
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i] === target) { return { list: nodes, index: i, parent: parent || null }; }
          if (nodes[i].isTemplate) { var r = locate(target, nodes[i].children, nodes[i]); if (r) { return r; } }
        }
        return null;
      }
      function findByUid(uid, nodes) {
        nodes = nodes || vm.tree;
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].uid === uid) { return nodes[i]; }
          if (nodes[i].isTemplate) { var r = findByUid(uid, nodes[i].children); if (r) { return r; } }
        }
        return null;
      }
      function ancestorsOf(target, nodes, trail) {
        nodes = nodes || vm.tree; trail = trail || [];
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i] === target) { return trail; }
          if (nodes[i].isTemplate) { var r = ancestorsOf(target, nodes[i].children, trail.concat(nodes[i])); if (r) { return r; } }
        }
        return null;
      }
      function reindex(nodes, depth, parentPath, parentId) {
        nodes.forEach(function (n) {
          n.depth = depth; n.parentId = parentId; n.path = parentPath ? parentPath + '.' + n.id : n.id;
          if (n.isTemplate) {
            n.nestError = null;
            if (!n.rawMode) { n.rawText = Ser.serialize(n.children).text; }
            reindex(n.children, depth + 1, n.path, n.id);
          } else {
            // a leaf whose tag must hold nested TLV is checked again after every edit
            n.nestError = null;
            if (Meta.getMeta(n.id, parentId).template === 'yes' && n.value) {
              var r = Parser.parseValue(String(n.value), depth, n.id, n.path);
              if (r.error) { n.nestError = { message: r.error.message, position: r.error.position }; }
            }
          }
        });
      }
      function metaOf(node) { return Meta.getMeta(node.id, node.parentId); }

      /* ---------- analysis pipeline ---------- */
      function analyze(tree) {
        var ser = Ser.serialize(tree), crc = Crc.inspect(tree);
        return { ser: ser, crc: crc, val: Val.validate(tree, crc, Date.now()) };
      }

      function buildInfo(nodes, byUid) {
        nodes.forEach(function (n) {
          var agg = { rank: 0, err: false, warn: false, mod: false, unk: false };
          if (n.isTemplate) {
            buildInfo(n.children, byUid);
            n.children.forEach(function (c) {
              var ci = infoMap[c.uid];
              agg.rank = Math.max(agg.rank, ci.rank); agg.err = agg.err || ci.deepErr; agg.warn = agg.warn || ci.deepWarn;
              agg.mod = agg.mod || ci.deepMod; agg.unk = agg.unk || ci.deepUnk;
            });
          }
          var value = Ser.valueOf(n), own = 0;
          (byUid[n.uid] || []).forEach(function (f) { own = Math.max(own, RANK[f.severity]); });
          var modified = n.isNew || n.id !== n.origId || value !== n.origValue;
          var unknown = !metaOf(n).known;
          infoMap[n.uid] = {
            len: value.length, value: value, modified: modified, rank: Math.max(own, agg.rank),
            deepErr: agg.err || own === 3, deepWarn: agg.warn || own === 2, deepMod: agg.mod || modified, deepUnk: agg.unk || unknown
          };
        });
      }
      function liveInfo(node) { var v = Ser.valueOf(node); return { len: v.length, value: v, modified: false, rank: 0, deepErr: false, deepWarn: false, deepMod: false, deepUnk: false }; }
      function info(node) { return infoMap[node.uid] || liveInfo(node); }

      function countNodes(nodes) { var c = 0; Parser.walk(nodes, function () { c++; }); return c; }

      function refresh() {
        reindex(vm.tree, 0, '', null);
        var a = analyze(vm.tree);
        vm.crc = a.crc;
        vm.validation = a.val;
        var byUid = {};
        a.val.findings.forEach(function (f) { if (f.nodeUid) { (byUid[f.nodeUid] = byUid[f.nodeUid] || []).push(f); } });
        infoMap = {};
        buildInfo(vm.tree, byUid);
        vm.output.payload = a.ser.errors.length ? '' : a.ser.text;
        vm.output.length = vm.output.payload.length;
        vm.output.json = JSON.stringify(toJson(a), null, 2);
        renderQr();
        vm.comparison = Cmp.diff(model.baseline, vm.tree, model.source, vm.output.payload);
        updateStatus(a);
        vm.tabCounts.validation = a.val.counts.error + a.val.counts.warning;
        vm.tabCounts.changes = vm.comparison.changeCount;
        refreshSelection();
        computeMatches(false);
      }
      function afterEdit() {
        if (vm.options.autoCrc) { Crc.apply(vm.tree, false, false); }
        refresh();
      }

      function updateStatus(a) {
        var total = countNodes(vm.tree), top = vm.tree.length;
        var c = a.val.counts, layer = function (k) { return a.val.layers.filter(function (l) { return l.key === k; })[0]; };
        var st = layer('structural'), kq = layer('khqr');
        var firstOf = function (lk, sev) { var f = a.val.findings.filter(function (x) { return x.layer === lk && x.severity === sev; })[0]; return f ? f.message : ''; };
        vm.status = {
          parsing: { state: 'pass', label: 'Parsed', detail: total + ' tag(s) decoded without TLV errors.' },
          structure: st.errors ? { state: 'fail', label: 'Invalid structure', detail: firstOf('structural', 'error') } : { state: 'pass', label: 'Valid structure', detail: 'Headers, lengths and nesting are consistent.' },
          crc: { state: a.crc.state, label: a.crc.status === 'PASS' ? 'CRC verified' : a.crc.status, detail: a.crc.status === 'PASS' ? 'Calculated ' + a.crc.calculated + ' matches the stored value.' : a.crc.message },
          khqr: kq.errors ? { state: 'fail', label: kq.errors + ' KHQR error(s)', detail: firstOf('khqr', 'error') } :
                kq.warnings ? { state: 'warn', label: kq.warnings + ' KHQR warning(s)', detail: firstOf('khqr', 'warning') } :
                { state: 'pass', label: 'KHQR rules met', detail: 'No KHQR profile errors or warnings.' },
          tagCount: total, topLevelCount: top, nestedCount: total - top
        };
        void c;
      }

      function toJson(a) {
        function conv(nodes, parentId) {
          return nodes.map(function (n) {
            var o = { id: n.id, name: Meta.getMeta(n.id, parentId).name, length: Ser.valueOf(n).length };
            if (n.isTemplate) { o.children = conv(n.children, n.id); } else { o.value = String(n.value); }
            return o;
          });
        }
        return { payload: vm.output.payload, crc: { status: a.crc.status, stored: a.crc.existing, calculated: a.crc.calculated },
          validation: { verdict: a.val.verdict.label, errors: a.val.counts.error, warnings: a.val.counts.warning }, tags: conv(vm.tree, null) };
      }

      function clearModel() {
        vm.tree = []; vm.hasDecoded = false; infoMap = {}; model.baseline = null; model.source = '';
        vm.output = { payload: '', length: 0, json: '' };
        vm.crc = Crc.idle('Decode a payload to verify its CRC.');
        vm.validation = Val.empty();
        vm.comparison = Cmp.diff(null, [], '', '');
        vm.tabCounts = { validation: 0, changes: 0 };
        vm.search = { query: vm.search.query, matches: [], activeIndex: 0 };
        vm.selectNode(null);
        renderQr();
      }

      /* ---------- input panel ---------- */
      function updateStats() { vm.stats.charCount = vm.rawInput.length; vm.stats.payloadLength = vm.rawInput.trim().length; }
      vm.onRawInputChange = function () {
        updateStats(); vm.inputMessage = null;
        if (vm.options.autoDecode) { if (vm.rawInput.trim()) { vm.decode(); } else { vm.parseError = null; clearModel(); vm.status = idleStatus(); } }
      };
      vm.onInputKeydown = function ($event) {
        if ($event.key === 'Enter' && ($event.ctrlKey || $event.metaKey)) { $event.preventDefault(); vm.decode(); }
      };
      vm.onOptionsChanged = function () { if (vm.options.autoDecode && vm.rawInput.trim() && !vm.hasDecoded) { vm.decode(); } };

      vm.decode = function () {
        updateStats(); vm.inputMessage = null; vm.parseError = null;
        var r = Parser.decode(vm.rawInput);
        if (r.error) {
          var ctx = Parser.context(r.source, r.error.position);
          vm.parseError = { message: r.error.message, position: r.error.position, hint: r.error.hint, before: ctx.before, at: ctx.at, after: ctx.after };
          clearModel();
          if (!r.source) { vm.status = idleStatus('Enter a payload to decode.'); return; }
          vm.validation = Val.forParseError(r.error);
          vm.tabCounts.validation = 1;
          vm.status = idleStatus();
          vm.status.parsing = { state: 'fail', label: 'Parse error', detail: r.error.message };
          vm.status.structure = { state: 'fail', label: 'Invalid structure', detail: r.error.message };
          return;
        }
        model.source = r.source;
        vm.tree = r.nodes;
        vm.hasDecoded = true;
        reindex(vm.tree, 0, '', null);
        model.baseline = Cmp.snapshot(vm.tree);
        vm.search = { query: vm.search.query, matches: [], activeIndex: 0 };
        vm.selectNode(null);
        refresh();
        vm.pendingRemoval = null;
      };

      vm.pasteFromClipboard = function () {
        var nav = $window.navigator;
        if (!nav.clipboard || !nav.clipboard.readText) { vm.inputMessage = { type: 'warning', text: 'This browser does not allow reading the clipboard. Click in the box and press Ctrl+V instead.' }; return; }
        $q.when(nav.clipboard.readText()).then(function (text) { vm.rawInput = text; vm.decode(); },
          function () { vm.inputMessage = { type: 'warning', text: 'Clipboard access was blocked. Click in the box and press Ctrl+V instead.' }; });
      };
      vm.loadSample = function (id) {
        var s = vm.samples.filter(function (x) { return x.id === id; })[0] || vm.samples[0];
        vm.rawInput = s.payload; vm.selectedSampleId = s.id; vm.decode();
        showToast('Loaded sample: ' + s.title + '.', 'info');
      };
      vm.clearInput = function () { vm.rawInput = ''; updateStats(); vm.parseError = null; vm.inputMessage = null; clearModel(); vm.status = idleStatus(); };

      vm.toggleTheme = function () {
        vm.theme = vm.theme === 'dark' ? 'light' : 'dark';
        try { $window.localStorage.setItem('khqrInspectorTheme', vm.theme); } catch (e) { /* storage unavailable */ }
      };
      vm.resetApplication = function () {
        vm.stopScan(); vm.clearInput(); vm.search = { query: '', matches: [], activeIndex: 0 }; vm.treeFilter = 'all';
        vm.newTag = { id: '', value: '' }; vm.newTagError = null; vm.findingFilter = { severity: 'all', layer: 'all' };
        vm.compareShowUnchanged = false; vm.crcTool = { input: '', result: '' }; vm.activeTab = 'validation';
        vm.testCases.forEach(function (t) { t.status = 'pending'; t.message = ''; }); updateTestSummary();
        delete vm.tabCounts.tests;
        showToast('Everything was reset.', 'info');
      };
      vm.resetToOriginal = function () {
        if (!model.source) { return; }
        var r = Parser.decode(model.source);
        if (r.error) { return; }
        vm.tree = r.nodes; reindex(vm.tree, 0, '', null);
        vm.selectNode(null); refresh();
        showToast('Restored the original payload.', 'success');
      };

      /* ---------- tree ---------- */
      vm.isSelected = function (node) { return vm.selectedNode === node; };
      vm.toggleNode = function (node, $event) { if ($event) { $event.stopPropagation(); } node.expanded = !node.expanded; };
      function setExpanded(nodes, v) { nodes.forEach(function (n) { if (n.isTemplate) { n.expanded = v; setExpanded(n.children, v); } }); }
      vm.expandAll = function () { setExpanded(vm.tree, true); };
      vm.collapseAll = function () { setExpanded(vm.tree, false); };

      vm.isNodeVisible = function (node) {
        var i = info(node);
        switch (vm.treeFilter) {
          case 'errors': return i.deepErr;
          case 'warnings': return i.deepWarn;
          case 'templates': return node.isTemplate;
          case 'unknown': return i.deepUnk;
          case 'modified': return i.deepMod;
          default: return true;
        }
      };
      vm.getTagName = function (node) { return metaOf(node).name; };
      vm.getValuePreview = function (node) { var v = String(node.value == null ? '' : node.value); return v === '' ? '(empty)' : shorten(v, 48); };
      vm.getLength = function (node) { return info(node).len; };
      vm.getLengthField = function (node) { return Ser.lengthField(info(node).len); };
      vm.getRawTlv = function (node) { return node.id + vm.getLengthField(node) + info(node).value; };
      vm.getNodeSeverity = function (node) { return RANK_NAME[info(node).rank]; };
      vm.isModified = function (node) { return info(node).modified; };

      vm.onTreeKeydown = function ($event, node) {
        if ($event.target !== $event.currentTarget) { return; }
        var key = $event.key;
        var rows = Array.prototype.filter.call(doc.querySelectorAll('#tagTree .tree-row'), function (el) { return el.offsetParent !== null; });
        var at = rows.indexOf($event.currentTarget);
        function focusRow(i) { if (rows[i]) { rows[i].focus(); } }
        if (key === 'Enter' || key === ' ') { $event.preventDefault(); vm.selectNode(node); }
        else if (key === 'ArrowDown') { $event.preventDefault(); focusRow(at + 1); }
        else if (key === 'ArrowUp') { $event.preventDefault(); focusRow(at - 1); }
        else if (key === 'Home') { $event.preventDefault(); focusRow(0); }
        else if (key === 'End') { $event.preventDefault(); focusRow(rows.length - 1); }
        else if (key === 'ArrowRight' && node.isTemplate) { $event.preventDefault(); if (!node.expanded) { node.expanded = true; } else { focusRow(at + 1); } }
        else if (key === 'ArrowLeft' && node.isTemplate && node.expanded) { $event.preventDefault(); node.expanded = false; }
      };

      function scrollToNode(node) {
        $timeout(function () { var el = doc.getElementById('node-' + node.uid); if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); } }, 0);
      }
      function revealNode(node) { (ancestorsOf(node) || []).forEach(function (a) { a.expanded = true; }); }

      /* ---------- search ---------- */
      function computeMatches(resetIndex) {
        var q = vm.search.query.trim().toLowerCase(), found = [];
        if (q) {
          Parser.walk(vm.tree, function (n) {
            var hay = [n.id, n.path, vm.getTagName(n), n.isTemplate ? '' : String(n.value)].join('\n').toLowerCase();
            if (hay.indexOf(q) !== -1) { found.push(n); }
          });
        }
        vm.search.matches = found;
        vm.search.activeIndex = resetIndex ? 0 : Math.min(vm.search.activeIndex, Math.max(0, found.length - 1));
        vm.matchSet = {}; found.forEach(function (n) { vm.matchSet[n.uid] = true; });
        return found;
      }
      vm.matchSet = {};
      vm.onSearchChange = function () { computeMatches(true).forEach(revealNode); };
      vm.isMatch = function (node) { return !!vm.matchSet[node.uid]; };
      vm.isActiveMatch = function (node) { return vm.search.matches[vm.search.activeIndex] === node; };
      vm.gotoMatch = function (dir) {
        var m = vm.search.matches; if (!m.length) { return; }
        vm.search.activeIndex = (vm.search.activeIndex + dir + m.length) % m.length;
        var node = m[vm.search.activeIndex];
        revealNode(node); vm.selectNode(node); scrollToNode(node);
      };
      vm.clearSearch = function () { vm.search = { query: '', matches: [], activeIndex: 0 }; vm.matchSet = {}; };

      /* ---------- selection and editor ---------- */
      vm.selectNode = function (node) {
        vm.selectedNode = node || null;
        vm.pendingRemoval = null; vm.removalWarnings = [];
        vm.editorError = null; vm.rawTemplateError = null;
        vm.newSubtag = { id: '', value: '' }; vm.newSubtagError = null;
        refreshSelection();
      };
      function refreshSelection() {
        var n = vm.selectedNode;
        if (n && !locate(n)) { n = vm.selectedNode = null; }
        if (!n) { vm.selectedMeta = null; vm.selectedPathLabel = ''; vm.selectedFindings = []; vm.subtagOptions = []; vm.accountPanel = { visible: false, fields: [] }; return; }
        vm.selectedMeta = metaOf(n);
        vm.selectedPathLabel = n.path.replace(/\./g, ' \u203a ');
        vm.selectedFindings = vm.validation.findings.filter(function (f) { return f.nodeUid === n.uid; });
        vm.subtagOptions = n.isTemplate ? Meta.subtagList(n.id).map(function (d) { return { id: d.id, name: d.name }; }) : [];
        buildAccountPanel(n);
      }

      function buildAccountPanel(n) {
        if (!(n.isTemplate && n.depth === 0 && Meta.isMai(n.id))) { vm.accountPanel = { visible: false, fields: [] }; return; }
        var defs = Meta.subtagList(n.id), seen = {}, fields = [];
        function firstChild(id) { return n.children.filter(function (c) { return c.id === id; })[0] || null; }
        defs.forEach(function (d) {
          seen[d.id] = true;
          fields.push({ subId: d.id, label: d.name, confidence: d.meta.confidence, node: firstChild(d.id),
            hint: d.meta.presence + (d.meta.maxLength ? ', up to ' + d.meta.maxLength + ' characters' : '') });
        });
        n.children.forEach(function (c) {
          if (!seen[c.id]) { seen[c.id] = true; fields.push({ subId: c.id, label: 'Unknown subtag', confidence: 'unknown', node: c, hint: 'Not defined in the loaded metadata. The value is preserved unchanged.' }); }
        });
        var khqr = n.id === '29' || n.id === '30';
        vm.accountPanel = {
          visible: true, templateId: n.id, fields: fields,
          title: n.id === '29' ? 'Individual account (tag 29)' : n.id === '30' ? 'Merchant account (tag 30)' : 'Merchant account information (tag ' + n.id + ')',
          specNote: khqr ? 'Subtag meanings follow the ABA PayWay KHQR guide and published Bakong KHQR libraries; they are not checked against the NBC specification document. The currency is carried in tag 53 and the amount in tag 54, not in account subtags.'
                         : 'No KHQR profile is defined for this template, so subtags are shown as raw values.'
        };
      }
      vm.onAccountFieldChanged = function (field) { vm.onValueChanged(field.node); };
      vm.addAccountField = function (field) {
        var parent = vm.selectedNode; if (!parent || !parent.isTemplate) { return; }
        var order = Meta.subtagList(parent.id).map(function (d) { return d.id; }), rank = order.indexOf(field.subId), at = parent.children.length;
        for (var i = 0; i < parent.children.length; i++) { var r = order.indexOf(parent.children[i].id); if (r > rank) { at = i; break; } }
        var node = Parser.createNode(field.subId, ''); Parser.markNew(node);
        parent.children.splice(at, 0, node);
        afterEdit();
      };
      vm.removeAccountField = function (field) { if (field.node) { vm.requestRemove(field.node); } };

      vm.canEditTagId = function (node) { return !(node.depth === 0 && node.id === '63'); };
      vm.isValueReadOnly = function (node) { return node.depth === 0 && node.id === '63'; };
      vm.onTagIdChanged = function (node) { void node; afterEdit(); };
      vm.onValueChanged = function (node) {
        var len = String(node.value == null ? '' : node.value).length;
        vm.editorError = len > 99 ? 'This value is ' + len + ' characters. A length field holds at most 99, so the payload cannot be rebuilt until it is shorter.' : null;
        afterEdit();
      };

      function insertTopLevel(node) {
        var at = -1; vm.tree.forEach(function (n, i) { if (n.id === '63' && at < 0) { at = i; } });
        if (at >= 0) { vm.tree.splice(at, 0, node); } else { vm.tree.push(node); }
      }
      // Builds a new node (parsing nested TLV when the tag is a template) or returns an error message.
      function buildNew(id, value, siblings, parentId, depth, parentPath) {
        if (!/^\d{2}$/.test(id)) { return { error: 'The tag ID must be exactly two digits.' }; }
        if (siblings.some(function (s) { return s.id === id; })) { return { error: 'Tag ' + id + ' already exists here. Each tag may appear once.' }; }
        if (value.length > 99) { return { error: 'The value is ' + value.length + ' characters; the maximum is 99.' }; }
        var meta = Meta.getMeta(id, parentId);
        if (!value && meta.template !== 'yes') { return { error: 'Enter a value. Empty values are not allowed (length 00).' }; }
        var node = Parser.createNode(id, value, depth);
        node.parentId = parentId; node.path = parentPath ? parentPath + '.' + id : id;
        if (meta.template && value) {
          var r = Parser.parseValue(value, depth, id, node.path);
          if (!r.error) { node.children = r.nodes; node.isTemplate = true; }
          else if (meta.template === 'yes') { return { error: 'Tag ' + id + ' holds nested TLV but this value is not valid: ' + r.error.message + ' (position ' + r.error.position + ' in the value).' }; }
        } else if (meta.template === 'yes') { node.children = []; node.isTemplate = true; }
        Parser.markNew(node);
        return { node: node };
      }
      vm.addTopLevelTag = function () {
        var r = buildNew(vm.newTag.id || '', vm.newTag.value || '', vm.tree, null, 0, '');
        if (r.error) { vm.newTagError = r.error; return; }
        insertTopLevel(r.node);
        vm.newTag = { id: '', value: '' }; vm.newTagError = null;
        afterEdit(); vm.selectNode(r.node); revealNode(r.node); scrollToNode(r.node);
        showToast('Added tag ' + r.node.id + '.', 'success');
      };
      vm.addSubtag = function (parent) {
        var r = buildNew(vm.newSubtag.id || '', vm.newSubtag.value || '', parent.children, parent.id, parent.depth + 1, parent.path);
        if (r.error) { vm.newSubtagError = r.error; return; }
        parent.children.push(r.node);
        vm.newSubtag = { id: '', value: '' }; vm.newSubtagError = null;
        afterEdit();
      };

      vm.canMoveNode = function (node, dir) {
        var loc = locate(node); if (!loc) { return false; }
        var j = loc.index + dir;
        if (j < 0 || j >= loc.list.length) { return false; }
        if (!loc.parent && (node.id === '63' || loc.list[j].id === '63')) { return false; }   // tag 63 stays last
        return true;
      };
      vm.moveNode = function (node, dir) {
        if (!vm.canMoveNode(node, dir)) { return; }
        var loc = locate(node), j = loc.index + dir, other = loc.list[j];
        loc.list[j] = node; loc.list[loc.index] = other;
        afterEdit();
      };

      vm.canResetNode = function (node) {
        if (node.depth === 0 && node.id === '63' && vm.options.autoCrc) { return false; }   // the CRC is rewritten automatically
        return !node.isNew && info(node).modified;
      };
      vm.resetNode = function (node) {
        if (!vm.canResetNode(node)) { return; }
        node.id = node.origId;
        node.rawMode = false;
        if (node.origIsTemplate) {
          var r = Parser.parseValue(node.origValue, node.depth, node.id, node.id);
          if (!r.error) { node.children = r.nodes; node.isTemplate = true; node.value = null; }
        } else { node.children = null; node.isTemplate = false; node.value = node.origValue; }
        vm.editorError = null;
        afterEdit();
      };

      vm.requestRemove = function (node) {
        var warnings = [], meta = metaOf(node), loc = locate(node);
        if (!loc) { return; }
        if (!node.parentId && meta.presence === 'Mandatory') { warnings.push('Tag ' + node.id + ' is mandatory in EMVCo QR payloads, so validation will report an error.'); }
        if (!node.parentId && node.id === '63') { warnings.push('Without tag 63 the payload has no checksum. Recalculate CRC adds it back.'); }
        if (node.parentId && meta.presence === 'Mandatory') { warnings.push('Subtag ' + node.id + ' is mandatory in tag ' + node.parentId + '.'); }
        if (node.isTemplate && node.children.length) { warnings.push('This also removes ' + countNodes(node.children) + ' nested subtag(s).'); }
        vm.pendingRemoval = node; vm.removalWarnings = warnings;
      };
      vm.cancelRemove = function () { vm.pendingRemoval = null; vm.removalWarnings = []; };
      vm.confirmRemove = function () {
        var node = vm.pendingRemoval, loc = node && locate(node);
        if (!loc) { vm.cancelRemove(); return; }
        var id = node.id, selectedInside = vm.selectedNode && (vm.selectedNode === node || (ancestorsOf(vm.selectedNode) || []).indexOf(node) !== -1);
        loc.list.splice(loc.index, 1);
        vm.pendingRemoval = null; vm.removalWarnings = [];
        if (selectedInside) { vm.selectedNode = loc.parent || null; }
        afterEdit();
        showToast('Removed tag ' + id + '.', 'info');
      };

      vm.canParseAsTemplate = function (node) {
        if (node.isTemplate || !node.value) { return false; }
        // offered only where the structure is open: unknown or reserved tags, or tags that should hold nested TLV
        var m = metaOf(node);
        if (m.known && !m.template && !m.reserved) { return false; }
        var r = Parser.parseValue(String(node.value), node.depth, node.id, node.path);
        return !r.error && r.nodes.length > 0;
      };
      vm.parseAsTemplate = function (node) {
        var r = Parser.parseValue(String(node.value), node.depth, node.id, node.path);
        if (r.error) { vm.editorError = r.error.message; return; }
        node.children = r.nodes; node.isTemplate = true; node.expanded = true; node.value = null;
        // the serialized value is unchanged, so origValue still matches
        afterEdit(); vm.selectNode(node);
      };
      vm.toggleRawMode = function (node) {
        vm.rawTemplateError = null;
        if (node.rawMode) { node.rawMode = false; node.rawText = Ser.serialize(node.children).text; }
        else { node.rawText = Ser.serialize(node.children).text; node.rawMode = true; }
      };
      vm.applyRawTemplate = function (node) {
        var r = Parser.parseValue(node.rawText || '', node.depth, node.id, node.path);
        if (r.error) { vm.rawTemplateError = r.error.message + (r.error.position !== null ? ' (position ' + r.error.position + ' in the raw value)' : ''); return; }
        var old = {}; node.children.forEach(function (c) { if (!old[c.id]) { old[c.id] = c; } });
        r.nodes.forEach(function (c) {
          var o = old[c.id];
          if (o) { c.origId = o.origId; c.origValue = o.origValue; c.origIsTemplate = o.origIsTemplate; c.isNew = o.isNew; } else { Parser.markNew(c); }
        });
        node.children = r.nodes; node.rawMode = false; vm.rawTemplateError = null;
        afterEdit();
      };

      /* ---------- CRC ---------- */
      vm.recalculateCrc = function () {
        var v = Crc.apply(vm.tree, true, true);
        if (!v) { showToast('The payload cannot be serialized yet, so no CRC was written.', 'error'); return; }
        refresh();
        showToast('CRC set to ' + v + '.', 'success');
      };
      vm.onCrcToolInput = function () { vm.crcTool.result = vm.crcTool.input ? Crc.crc16(vm.crcTool.input) : ''; };

      /* ---------- QR code ---------- */
      function renderQr() {
        var payload = vm.output.payload;
        if (!payload) {
          vm.qr = { ready: false, info: '', warning: '', message: vm.hasDecoded ? 'The payload cannot be rebuilt yet, so there is no QR code. Fix the structural errors first.' : 'Decode a payload to see its QR code.' };
          return;
        }
        try {
          var enc = Qr.encode(payload, vm.qrOptions.level), errors = vm.validation.counts.error, canvas = doc.getElementById('qrCanvas');
          if (canvas) { Qr.draw(canvas, enc, 320); }
          vm.qr = { ready: true, message: '', info: 'Version ' + enc.version + ', ' + enc.count + ' x ' + enc.count + ' modules',
            warning: errors ? 'This payload has ' + errors + ' validation error(s). The QR code shows it exactly as rebuilt, so scanners or banking apps may reject it.' : '' };
        } catch (e) { vm.qr = { ready: false, info: '', warning: '', message: e.message }; }
      }
      vm.onQrOptionsChanged = function () { renderQr(); };
      // Copies the QR code to the clipboard as a 1024px PNG image.
      vm.copyQrImage = function () {
        if (!vm.qr.ready) { return; }
        var nav = $window.navigator;
        if (!nav.clipboard || !nav.clipboard.write || typeof $window.ClipboardItem === 'undefined') {
          showToast('This browser cannot copy images. Right-click the QR code and choose Copy image.', 'error'); return;
        }
        try {
          var canvas = doc.createElement('canvas');
          Qr.draw(canvas, Qr.encode(vm.output.payload, vm.qrOptions.level), 1024);
          // a promise keeps the click permission valid while the PNG is produced (needed by Safari)
          var png = new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) { if (blob) { resolve(blob); } else { reject(new Error('The PNG could not be created.')); } }, 'image/png');
          });
          $q.when(nav.clipboard.write([new $window.ClipboardItem({ 'image/png': png })])).then(
            function () { showToast('QR code image copied.', 'success'); },
            function () { showToast('Copying was blocked. Right-click the QR code and choose Copy image.', 'error'); });
        } catch (e) { showToast(e.message, 'error'); }
      };

      /* ---------- scan a QR code with the camera or from a photo (vendor/jsQR.js) ---------- */
      var scanner = { stream: null, frame: 0, canvas: null, last: 0 };
      var NO_LIB = 'The QR scanner library was not found. Put vendor/jsQR.js next to index.html.';
      function cameraError(err) {
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') { return 'Camera permission was denied. Allow camera access for this site in the browser settings, or use Scan photo.'; }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') { return 'No camera was found on this device. Use Scan photo instead.'; }
        if (name === 'NotReadableError') { return 'The camera is in use by another app. Close it and try again, or use Scan photo.'; }
        return 'The camera could not be started' + (err && err.message ? ' (' + err.message + ')' : '') + '. Use Scan photo instead.';
      }
      function loadScanned(text) {
        vm.rawInput = text; vm.decode();
        showToast(vm.hasDecoded ? 'QR code scanned and decoded.' : 'QR code scanned, but the content is not a valid KHQR payload.', vm.hasDecoded ? 'success' : 'warning');
      }
      vm.stopScan = function () {
        if (scanner.frame) { $window.cancelAnimationFrame(scanner.frame); scanner.frame = 0; }
        if (scanner.stream) { scanner.stream.getTracks().forEach(function (t) { t.stop(); }); scanner.stream = null; }
        var video = doc.getElementById('scanVideo');
        if (video) { video.srcObject = null; }
        vm.scan = { active: false, status: '' };
      };
      function scanLoop(video) {
        scanner.frame = $window.requestAnimationFrame(function (now) {
          if (!vm.scan.active) { return; }
          if (now - scanner.last > 120 && video.readyState >= 2 && video.videoWidth) {   // about 8 scans a second
            scanner.last = now;
            var scale = Math.min(1, 800 / video.videoWidth), w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
            var cv = scanner.canvas || (scanner.canvas = doc.createElement('canvas'));
            cv.width = w; cv.height = h;
            var ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, w, h);
            var hit = $window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (hit && hit.data) { $timeout(function () { vm.stopScan(); loadScanned(hit.data); }); return; }
          }
          scanLoop(video);
        });
      }
      vm.startScan = function () {
        var nav = $window.navigator;
        vm.inputMessage = null;
        if (!$window.jsQR) { vm.inputMessage = { type: 'error', text: NO_LIB }; return; }
        if (!nav.mediaDevices || !nav.mediaDevices.getUserMedia || $window.isSecureContext === false) {
          vm.inputMessage = { type: 'warning', text: 'Live camera scanning needs a secure page (https or localhost). Use Scan photo instead.' }; return;
        }
        vm.stopScan();
        vm.scan = { active: true, status: 'Starting the camera\u2026' };
        $q.when(nav.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })).then(function (stream) {
          if (!vm.scan.active) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }   // stopped while waiting
          scanner.stream = stream;
          var video = doc.getElementById('scanVideo');
          video.srcObject = stream;
          return $q.when(video.play()).then(function () { vm.scan.status = 'Point the camera at a KHQR code.'; scanLoop(video); });
        }).catch(function (err) { vm.stopScan(); vm.inputMessage = { type: 'warning', text: cameraError(err) }; });
      };
      // Photo scan: tries a few sizes because phone photos are large and the code may be small in the frame.
      vm.scanImageFile = function (file) {
        if (!file) { return; }
        vm.inputMessage = null;
        if (!$window.jsQR) { vm.inputMessage = { type: 'error', text: NO_LIB }; return; }
        var url = $window.URL.createObjectURL(file), img = new $window.Image();
        img.onload = function () {
          $window.URL.revokeObjectURL(url);
          $timeout(function () {
            var found = null, longest = Math.max(img.naturalWidth, img.naturalHeight), cv = doc.createElement('canvas');
            [1600, 1000, 600].some(function (target) {
              var scale = Math.min(1, target / longest), w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
              cv.width = w; cv.height = h;
              var ctx = cv.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(img, 0, 0, w, h);
              found = $window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
              return !!found;
            });
            if (found && found.data) { loadScanned(found.data); }
            else { vm.inputMessage = { type: 'warning', text: 'No QR code was found in that photo. Try a sharper, closer photo with the whole code in the frame.' }; }
          });
        };
        img.onerror = function () {
          $window.URL.revokeObjectURL(url);
          $timeout(function () { vm.inputMessage = { type: 'error', text: 'That file could not be read as an image.' }; });
        };
        img.src = url;
      };

      /* ---------- copy and export ---------- */
      function legacyCopy(text) {
        var ta = doc.createElement('textarea'), ok = false;
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        doc.body.appendChild(ta); ta.select();
        try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
        doc.body.removeChild(ta);
        return ok;
      }
      function copyText(text, label) {
        if (!text) { showToast('Nothing to copy yet.', 'warning'); return; }
        var done = function (ok) { showToast(ok ? label + ' copied.' : 'Copy failed. Select the text and copy it manually.', ok ? 'success' : 'error'); };
        var nav = $window.navigator;
        if (nav.clipboard && nav.clipboard.writeText) { $q.when(nav.clipboard.writeText(text)).then(function () { done(true); }, function () { done(legacyCopy(text)); }); }
        else { done(legacyCopy(text)); }
      }
      function download(name, text, type) { downloadBlob(name, new Blob([text], { type: type + ';charset=utf-8' })); }
      function downloadBlob(name, blob) {
        var url = $window.URL.createObjectURL(blob), a = doc.createElement('a');
        a.href = url; a.download = name; doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
        $timeout(function () { $window.URL.revokeObjectURL(url); }, 1000);
      }
      vm.copyPayload = function () { copyText(vm.output.payload, 'Payload'); };
      vm.copyCrc = function () { copyText(vm.crc.calculated, 'CRC'); };
      vm.copyCrcToolResult = function () { copyText(vm.crcTool.result, 'CRC'); };
      vm.copyJson = function () { copyText(vm.output.json, 'JSON'); };
      vm.downloadPayload = function () { if (vm.output.payload) { download('khqr-payload.txt', vm.output.payload, 'text/plain'); } };
      vm.downloadJson = function () { if (vm.output.json) { download('khqr-decoded.json', vm.output.json, 'application/json'); } };
      vm.copyValidationReport = function () {
        var v = vm.validation, lines = ['KHQR validation report', 'Payload: ' + (vm.output.payload || model.source), 'Result: ' + v.verdict.label + ' (' + v.verdict.detail + ')',
          'CRC: ' + vm.crc.status + (vm.crc.calculated ? ' (stored ' + (vm.crc.existing || 'none') + ', calculated ' + vm.crc.calculated + ')' : ''), ''];
        v.findings.forEach(function (f) {
          lines.push('[' + f.severity.toUpperCase() + '] ' + f.path + ' (' + f.layer + '): ' + f.message + (f.suggestion ? ' Fix: ' + f.suggestion : ''));
        });
        if (!v.findings.length) { lines.push('No findings.'); }
        copyText(lines.join('\n'), 'Validation report');
      };
      vm.goToFinding = function (f) {
        var node = f.nodeUid && findByUid(f.nodeUid);
        if (!node) { return; }
        revealNode(node); vm.selectNode(node); scrollToNode(node);
      };
      vm.setActiveTab = function (key) { vm.activeTab = key; };

      /* ---------- tests ---------- */
      function pipeline(payload) {
        var d = Parser.decode(payload);
        if (d.error) { return { d: d }; }
        reindex(d.nodes, 0, '', null);
        return { d: d, tree: d.nodes, a: analyze(d.nodes) };
      }
      function nodeAt(tree, path) {
        var hit = null; Parser.walk(tree, function (n) { if (n.path === path && !hit) { hit = n; } }); return hit;
      }
      function has(a, code, path, sev) {
        return a.val.findings.some(function (f) { return f.code === code && (!path || f.path === path) && (!sev || f.severity === sev); });
      }
      function result(ok, message) { return { ok: ok, message: message }; }
      function clean(p) { return !p.d.error && p.a.val.counts.error === 0 && p.a.val.counts.warning === 0; }
      var t = Fx.t, withCrc = Fx.withCrc;
      var wrongCrc = Fx.khr.slice(0, -1) + (Fx.khr.slice(-1) === '0' ? '1' : '0');
      var unknownPayload = withCrc(Fx.core(t('30', t('00', 'sample_shop@devb') + t('01', 'SAMPLE000001') + t('02', 'Sample Bank') + t('05', 'keep-me')), '116', '', t('66', 'top-level-unknown')));
      var badFormats = withCrc(t('00', '01') + t('01', '12') + t('29', t('00', 'nobank') + t('02', 'Sample Bank')) + t('52', '5999') + t('53', '99') + t('54', 'abc') +
        t('58', 'KH') + t('59', 'Sample Shop') + t('60', 'Phnom Penh'));

      vm.testCases = [
        { id: 't01', title: '1. Valid payload with correct CRC', description: 'Decodes, verifies the CRC and reports no errors or warnings.', payload: Fx.khr,
          run: function () { var p = pipeline(Fx.khr); return result(clean(p) && p.a.crc.status === 'PASS', 'CRC ' + p.a.crc.existing + ', ' + p.a.val.summaryText); } },
        { id: 't02', title: '2. Incorrect CRC', description: 'The last checksum character is changed; verification must fail.', payload: wrongCrc,
          run: function () { var p = pipeline(wrongCrc); return result(p.a.crc.status === 'FAIL' && has(p.a, 'crc-mismatch'), 'Stored ' + p.a.crc.existing + ', calculated ' + p.a.crc.calculated); } },
        { id: 't03', title: '3. Missing CRC tag', description: 'The payload ends without tag 63.', payload: Fx.khrBody,
          run: function () { var p = pipeline(Fx.khrBody); return result(p.a.crc.status === 'MISSING' && has(p.a, 'crc-missing'), 'CRC status: ' + p.a.crc.status); } },
        { id: 't04', title: '4. CRC tag with an invalid length', description: 'Tag 63 declares length 03.', payload: Fx.khrBody + '6303ABC',
          run: function () { var p = pipeline(Fx.khrBody + '6303ABC'); return result(p.a.crc.status === 'INVALID LENGTH' && has(p.a, 'crc-length'), 'CRC status: ' + p.a.crc.status); } },
        { id: 't05', title: '5. Truncated TLV value', description: 'The payload is cut inside a value; the parser must report where.', payload: Fx.khr.slice(0, Fx.khr.length - 10),
          run: function () { var d = Parser.decode(Fx.khr.slice(0, Fx.khr.length - 10)); return result(!!d.error && /truncated/i.test(d.error.message), d.error ? d.error.message + ' [position ' + d.error.position + ']' : 'No error reported'); } },
        { id: 't06', title: '6. Invalid TLV length', description: 'A length field contains letters.', payload: '00020101AB12',
          run: function () { var d = Parser.decode('00020101AB12'); return result(!!d.error && d.error.position === 8 && /length/i.test(d.error.message), d.error ? d.error.message + ' [position ' + d.error.position + ']' : 'No error reported'); } },
        { id: 't07', title: '7. Tag 29 with all documented subtags (USD)', description: 'Nested tag 29 with Bakong ID, account information and acquiring bank. USD is carried by tag 53.', payload: Fx.usd,
          run: function () { var p = pipeline(Fx.usd), n = nodeAt(p.tree, '29'); var ids = n && n.isTemplate ? n.children.map(function (c) { return c.id; }).join(',') : '';
            return result(clean(p) && ids === '00,01,02' && nodeAt(p.tree, '53').value === '840', 'Subtags: ' + ids + ', currency 840, ' + p.a.val.summaryText); } },
        { id: 't08', title: '8. Tag 29 with only one subtag', description: 'Only the Bakong account ID is present.', payload: Fx.singleSub,
          run: function () { var p = pipeline(Fx.singleSub), n = nodeAt(p.tree, '29'); return result(clean(p) && n.children.length === 1, 'Subtags: ' + n.children.length + ', ' + p.a.val.summaryText); } },
        { id: 't09', title: '9. Tag 30 merchant account', description: 'Nested tag 30 with Bakong ID, merchant ID and acquiring bank.', payload: Fx.merchantStatic,
          run: function () { var p = pipeline(Fx.merchantStatic), n = nodeAt(p.tree, '30'); var ids = n.children.map(function (c) { return c.id; }).join(',');
            return result(clean(p) && ids === '00,01,02', 'Subtags: ' + ids + ', ' + p.a.val.summaryText); } },
        { id: 't10', title: '10. Unknown top-level and nested tags', description: 'Tags 66 and 30.05 are unknown; they must survive a decode and rebuild byte for byte.', payload: unknownPayload,
          run: function () { var p = pipeline(unknownPayload); var same = !p.d.error && Ser.serialize(p.tree).text === unknownPayload;
            return result(same && !!nodeAt(p.tree, '66') && !!nodeAt(p.tree, '30.05') && has(p.a, 'unknown', '30.05') && has(p.a, 'reserved', '66'), same ? 'Round trip identical, unknown tags reported as info.' : 'Rebuilt payload differs'); } },
        { id: 't11', title: '11. Edit a value and recalculate its length', description: 'Changes tag 59 and checks the new length field.', payload: Fx.khr,
          run: function () { var p = pipeline(Fx.khr), v = 'Edited Shop Name'; nodeAt(p.tree, '59').value = v; var text = Ser.serialize(p.tree).text;
            return result(text.indexOf(t('59', v)) !== -1, 'Rebuilt tag: ' + t('59', v)); } },
        { id: 't12', title: '12. Edit a nested account and rebuild', description: 'Changes 29.00, which also changes the length of tag 29, then refreshes the CRC.', payload: Fx.khr,
          run: function () { var p = pipeline(Fx.khr); nodeAt(p.tree, '29.00').value = 'edited_user@devb'; Crc.apply(p.tree, false);
            var text = Ser.serialize(p.tree).text, want = t('29', t('00', 'edited_user@devb') + t('01', '000000000') + t('02', 'Sample Bank'));
            return result(text.indexOf(want) !== -1 && Crc.inspect(p.tree).status === 'PASS', 'Tag 29 rebuilt as ' + shorten(want, 60) + ', CRC PASS'); } },
        { id: 't13', title: '13. Add and remove supported tags', description: 'Adds tag 61 before the CRC and removes tag 54.', payload: Fx.khr,
          run: function () { var p = pipeline(Fx.khr); var add = Parser.createNode('61', '12345'); Parser.markNew(add);
            var ci = p.tree.map(function (n) { return n.id; }).indexOf('63'); p.tree.splice(ci, 0, add);
            p.tree.splice(p.tree.map(function (n) { return n.id; }).indexOf('54'), 1); Crc.apply(p.tree, false);
            var text = Ser.serialize(p.tree).text, again = pipeline(text);
            return result(text.indexOf(t('61', '12345')) !== -1 && text.indexOf(t('54', '10000')) === -1 && !again.d.error && again.a.crc.status === 'PASS', 'Rebuilt payload re-decodes with CRC PASS'); } },
        { id: 't14', title: '14. Invalid currency and account format', description: 'Currency 99, amount "abc" and a Bakong ID without @.', payload: badFormats,
          run: function () { var p = pipeline(badFormats); var ok = has(p.a, 'format', '53', 'error') && has(p.a, 'format', '54', 'error') && has(p.a, 'format', '29.00', 'warning');
            return result(ok, p.a.val.summaryText); } },
        { id: 't15', title: '15. Empty payload and extremely long input', description: 'Both are rejected immediately with a clear message.', payload: '',
          run: function () { var t0 = Date.now(), e = Parser.decode(''), l = Parser.decode(new Array(MAX_INPUT_LENGTH + 2).join('0')), ms = Date.now() - t0;
            return result(!!e.error && !!l.error && ms < 500, 'Empty: "' + (e.error && e.error.message) + '" Long: "' + (l.error && shorten(l.error.message, 60)) + '" (' + ms + ' ms)'); } },
        { id: 't16', title: '16. CRC algorithm check values', description: 'CRC-16/CCITT-FALSE of "123456789" is 29B1; of empty text is FFFF.', payload: '',
          run: function () { var a = Crc.crc16('123456789'), b = Crc.crc16(''); return result(a === '29B1' && b === 'FFFF', '"123456789" gives ' + a + ', empty gives ' + b); } },
        { id: 't17', title: '17. QR code encoding', description: 'The sample payload fits in a QR code and the three finder patterns are in place.', payload: Fx.khr,
          run: function () {
            var q = Qr.encode(Fx.khr, 'M'), ok = (q.count - 17) % 4 === 0, n = q.count;
            [[0, 0], [0, n - 7], [n - 7, 0]].forEach(function (o) {
              for (var i = 0; i < 7; i++) { ok = ok && q.isDark(o[0], o[1] + i) && q.isDark(o[0] + 6, o[1] + i) && q.isDark(o[0] + i, o[1]) && q.isDark(o[0] + i, o[1] + 6); }
              ok = ok && q.isDark(o[0] + 3, o[1] + 3) && !q.isDark(o[0] + 1, o[1] + 1);
            });
            return result(ok, 'Version ' + q.version + ', ' + n + ' x ' + n + ' modules');
          } }
      ];
      vm.testCases.forEach(function (c) { c.status = 'pending'; c.message = ''; });
      vm.testSummary = { passed: 0, failed: 0, pending: vm.testCases.length };

      function updateTestSummary() {
        var s = { passed: 0, failed: 0, pending: 0 };
        vm.testCases.forEach(function (c) { if (c.status === 'pass') { s.passed++; } else if (c.status === 'fail') { s.failed++; } else { s.pending++; } });
        vm.testSummary = s;
        if (s.pending < vm.testCases.length) { vm.tabCounts.tests = s.passed + '/' + vm.testCases.length; }
      }
      vm.runTest = function (test) {
        try { var r = test.run(); test.status = r.ok ? 'pass' : 'fail'; test.message = r.message; }
        catch (e) { test.status = 'fail'; test.message = 'Test threw an error: ' + e.message; }
        updateTestSummary();
      };
      vm.runAllTests = function () { vm.testCases.forEach(vm.runTest); };
      vm.loadTestSample = function (test) { if (test.payload) { vm.rawInput = test.payload; vm.decode(); } };

      updateStats();
    }]);
})();
