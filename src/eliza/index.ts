/**
 * Public surface of the elizaOS integration.
 *
 * An Eliza project imports the plugin and (optionally) the character:
 *
 *   import { singularityPlugin, singularityCharacter } from 'singularity-agent/eliza';
 *
 *   export default {
 *     agents: [{ character: singularityCharacter, plugins: [singularityPlugin] }],
 *   };
 */
export { singularityPlugin, default as plugin } from './plugin.js';
export { singularityCharacter } from './character.js';
export { chainActions } from './actions.js';
export { postToXAction, POST_TO_X } from './post-action.js';
export { postProjectUpdateAction, POST_PROJECT_UPDATE, angleFrom } from './update-action.js';
export { chainContextProvider, postingStatusProvider, providers } from './providers.js';
export { grokModels, grokClientFor } from './grok-model.js';
export { parseQuery, parseTransfer, asChainId, tokenize, type ParsedQuery } from './parse.js';
export { toPlainText } from './plain.js';
export { settingsEnv, SETTING_KEYS } from './settings.js';
