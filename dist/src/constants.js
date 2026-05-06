import pkg from '../package.json' with { type: 'json' };
/** Daemon filesystem layout constants. */
export const VERSION = pkg.version;
export const DAEMON_DIR_NAME = '.chronos';
export const CONFIG_FILE_NAME = 'config.json';
export const STATE_FILE_NAME = 'state.json';
export const LOCK_FILE_NAME = 'chronos-sync.lock';
