import { google } from './google.js';
import { microsoft } from './microsoft.js';
import { zoom } from './zoom.js';

export { PROVIDER_IDS, PROVIDER_LABEL, SecretariatError, isProviderId } from './common.js';
export const PROVIDERS = { google, microsoft, zoom };
