/**
 * bootstrapLogging — install the log gate before anything else can speak.
 *
 * A side-effect module, and it has to be one. `import` declarations are
 * HOISTED: a bare `installLogGate(__DEV__)` written between the imports of
 * App.tsx looks like it runs first and actually runs last, after every module
 * in the graph has been evaluated — so anything that logs at import time slips
 * out ungated. Making it a module and importing it FIRST is the only ordering
 * the language actually guarantees.
 *
 * See utils/logRedaction for what the gate does and why warn/error survive it.
 */
import { installLogGate } from './utils/logRedaction';

installLogGate(typeof __DEV__ !== 'undefined' ? __DEV__ : false);
