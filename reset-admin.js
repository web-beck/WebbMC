'use strict';
// Forgot the admin password? Run this in a terminal on the machine (or container) running WebMC:
//
//   node reset-admin.js              the admin account (creates one called "admin" if there is none)
//   node reset-admin.js <username>   that account; it becomes an admin if it is not one already
//
// It prints a one-time password. Sign in with it and the panel asks for a new password. It works whether or not
// the panel is running: the panel picks it up on the next sign-in (or the next start).
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env file */
}

const store = require('./lib/store');
store.load();
const auth = require('./lib/auth');

auth
  .terminalReset(process.argv[2])
  .then(({ login, otp, created, promoted }) => {
    console.log('');
    if (created) console.log(`  Created a new admin account "${login}".`);
    else if (promoted) console.log(`  "${login}" was not an admin. It will be one after signing in with this password.`);
    console.log(`  Sign in as:          ${login}`);
    console.log(`  One-time password:   ${otp}`);
    console.log('');
    console.log('  It works once, for the next 24 hours. After signing in you choose a new password.');
    console.log('  Other browsers signed in to this account are signed out.');
    console.log(`  (Data folder: ${store.DATA_DIR})`);
    console.log('');
  })
  .catch((err) => {
    console.error(`\n  ${err.message.replace(/\n/g, '\n  ')}\n`);
    process.exit(1);
  });
