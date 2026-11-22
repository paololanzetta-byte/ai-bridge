import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../packages/adapters/src/protocol.js';

test('toglie la riga di servizio tagliata dal limite di token', () => {
  assert.equal(parseReply('Il bilancio dipende da uso e budget. TA').text, 'Il bilancio dipende da uso e budget.');
  assert.equal(parseReply('Ok così.\nTAG: accord').text, 'Ok così.');
  assert.equal(parseReply('Fine. TAG:').text, 'Fine.');
});

test('toglie anche CHIEDI_UTENTE e CONCLUSO tagliati', () => {
  assert.equal(parseReply('Dipende da come la useremo. CHIEDI').text, 'Dipende da come la useremo.');
  assert.equal(parseReply('Dipende.\nCHIEDI_UT').text, 'Dipende.');
  assert.equal(parseReply('Fatto. CONCLUS').text, 'Fatto.');
});

test('non tocca il testo normale e le righe di servizio complete', () => {
  assert.equal(parseReply('La pasta è ottima').text, 'La pasta è ottima');
  const r = parseReply('Va bene.\nTAG: accordo');
  assert.equal(r.text, 'Va bene.');
  assert.equal(r.tag, 'accordo');
});
