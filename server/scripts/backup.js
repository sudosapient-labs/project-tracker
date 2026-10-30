/* Copy the database to BACKUP_DIR (default: `backups` next to DATABASE_PATH) as a timestamped file,
   keep the newest BACKUP_KEEP (default 14), and mirror new uploaded files into BACKUP_DIR/uploads.
   Safe to run while the app is up. `pnpm db:backup` locally; in the Docker image (no pnpm) run
   `node server/scripts/backup.js`. See README → Backups for restoring. */
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';
import { backup, backupDirOf, backupUploads } from '../lib/backup.js';

const config = loadConfig();
const dir = backupDirOf(config);
const db = new DatabaseSync(config.dbPath, { readOnly: true });
try {
  console.info(`Backed up ${config.dbPath} to ${backup(db, dir, config.backupKeep)}`);
} finally {
  db.close();
}
console.info(`Copied ${backupUploads(config.uploadDir, dir)} new uploaded file(s) to ${dir}/uploads`);
