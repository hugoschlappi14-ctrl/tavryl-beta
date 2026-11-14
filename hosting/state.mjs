import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export const files = ['comptes.cfg', 'social.cfg'];
const fingerprint = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
export function validateSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid snapshot');
  for (const [key, value] of Object.entries(data)) {
    if (!files.includes(key) || typeof value !== 'string' || value.length > 16 * 1024 * 1024)
      throw Error('Invalid state file');
    if (value && !value.includes(key === 'comptes.cfg' ? '[comptes]' : '[social]'))
      throw Error('Invalid config section');
  }
  return data;
}

export class StateStore {
  constructor(url, directory) {
    if (!url) throw Error('DATABASE_URL is required');
    const endpoint = new URL(url);
    // Never allow a connection-string option to silently disable verification.
    for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) endpoint.searchParams.delete(key);
    const internal = /^dpg-[a-z0-9]+-a$/.test(endpoint.hostname);
    this.db = new pg.Client({connectionString: endpoint.toString(),
      ssl: internal ? false : {rejectUnauthorized: true},
      connectionTimeoutMillis: 5000, query_timeout: 4000, statement_timeout: 3500});
    this.directory = directory;
    this.revision = 0;
    this.last = '{}';
    this.lastFiles = {};
    this.fileVersions = new Map();
    this.lastFullRead = 0;
    this.queue = Promise.resolve();
  }
  async open() {
    await this.db.connect();
    await this.db.query(`CREATE TABLE IF NOT EXISTS tavryl_state (
      id integer PRIMARY KEY CHECK (id=1), revision integer NOT NULL,
      files jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.db.query(`INSERT INTO tavryl_state(id,revision,files) VALUES (1,0,'{}') ON CONFLICT DO NOTHING`);
    const {rows:[row]} = await this.db.query('SELECT revision,files FROM tavryl_state WHERE id=1');
    const data = validateSnapshot(row.files);
    this.revision = row.revision;
    this.last = JSON.stringify(data);
    this.lastFiles = data;
    await mkdir(this.directory, {recursive:true, mode:0o700});
    for (const [name, content] of Object.entries(data)) {
      await writeFile(path.join(this.directory,name),content,{mode:0o600});
      await writeFile(path.join(this.directory,name+'.bak'),content,{mode:0o600});
    }
    return Object.keys(data).length;
  }
  commit({background = false} = {}) {
    this.queue = this.queue.then(async () => {
      // Only periodic checkpoints may take this shortcut. Explicit commits
      // (new identity, social change, shutdown) always read and validate files.
      // Godot replaces each file by rename. Inode + nanosecond timestamps and
      // size detect replacement even when its content has the same length.
      // A full read every 30 seconds also bounds metadata-cache lifetime.
      const versions = new Map();
      for (const name of files) {
        try { versions.set(name, fingerprint(await stat(path.join(this.directory,name),{bigint:true}))); }
        catch(error) { if(error.code !== 'ENOENT') throw error; }
      }
      if (background && performance.now()-this.lastFullRead < 30000 &&
          versions.size === this.fileVersions.size &&
          files.every(name => versions.get(name) === this.fileVersions.get(name))) return;
      const snapshot = {};
      for (const name of files) {
        for(let attempt=0;attempt<3;attempt++) {
          try { snapshot[name] = await readFile(path.join(this.directory,name),'utf8'); break; }
          catch(error) {
            if(error.code !== 'ENOENT') throw error;
            if(attempt<2) await new Promise(resolve=>setTimeout(resolve,20));
          }
        }
      }
      validateSnapshot(snapshot);
      // A transient missing file during Godot's rename must never erase an account file.
      for (const name of Object.keys(this.lastFiles))
        if (!(name in snapshot)) throw Error('State file disappeared');
      // Keep the fingerprints from BEFORE the reads. A concurrent replacement
      // then forces another read on the next checkpoint instead of being hidden.
      this.fileVersions = versions;
      this.lastFullRead = performance.now();
      if (files.every(name => snapshot[name] === this.lastFiles[name])) return;
      const encoded = JSON.stringify(snapshot);
      if (encoded === this.last) return;
      const result = await this.db.query(`UPDATE tavryl_state SET files=$1, revision=revision+1,
        updated_at=now() WHERE id=1 AND revision=$2 RETURNING revision`, [encoded,this.revision]);
      if (result.rowCount !== 1) throw Error('Another host owns a newer state revision');
      this.revision=result.rows[0].revision;
      this.last=encoded;
      this.lastFiles=snapshot;
    });
    return this.queue;
  }
  async close() { await this.db.end(); }
}
