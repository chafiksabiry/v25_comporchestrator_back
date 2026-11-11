import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pushCredentialFor } from '../services/voiceTokenService.js';

const IOS = 'CR' + 'a'.repeat(32);
const ANDROID = 'CR' + 'b'.repeat(32);
const cfg = { twilioPushCredentialSidIos: IOS, twilioPushCredentialSidAndroid: ANDROID };

describe('clé push du jeton d’une application native', () => {
  it('une clé par plateforme', () => {
    assert.equal(pushCredentialFor('ios', cfg), IOS);
    assert.equal(pushCredentialFor('android', cfg), ANDROID);
  });
  it('rien pour le navigateur ou une plateforme inconnue', () => {
    assert.equal(pushCredentialFor(undefined, cfg), null);
    assert.equal(pushCredentialFor('web', cfg), null);
  });
  it('rien tant que la clé n’est pas configurée ou si elle est mal formée', () => {
    assert.equal(pushCredentialFor('ios', { twilioPushCredentialSidIos: '' }), null);
    assert.equal(pushCredentialFor('ios', { twilioPushCredentialSidIos: 'pas-une-cle' }), null);
  });
});
