import { randomUUID, createHash } from 'node:crypto';

const ACCOUNT = /^[A-Za-z0-9_-]{12,64}$/;
const CLASSES = new Set(['guerrier','pisteur','arcaniste','tisseur']);
export function cleanPlayer(value) {
  if (!value || !ACCOUNT.test(value.accountId || '') || !CLASSES.has(value.class)) throw Error('invalid_player');
  const text = (v,n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n);
  const name = text(value.name,18) || 'Aventurier';
  // Existing 0.18.1 clients have no character UUID. Name/class is explicitly
  // labelled as an observed character, never a count of all local save slots.
  return {accountId:value.accountId, name, class:value.class,
    characterId:createHash('sha256').update(name+'\0'+value.class).digest('hex').slice(0,32),
    level:Math.max(1,Math.min(60,Math.trunc(Number(value.level)||1))),
    zone:text(value.zone,40), itemLevel:Math.max(0,Math.min(80,Math.trunc(Number(value.itemLevel)||0)))};
}

export class AdminStore {
  constructor(db) { this.db=db; this.boot=randomUUID(); this.queue=Promise.resolve(); this.lastReport=0; }
  async open() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS tavryl_admin_players (
      account_id text PRIMARY KEY, first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(), online boolean NOT NULL DEFAULT false,
      boot text NOT NULL DEFAULT '', sessions integer NOT NULL DEFAULT 0,
      online_seconds double precision NOT NULL DEFAULT 0,
      current_character text NOT NULL DEFAULT '')`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS tavryl_admin_characters (
      account_id text NOT NULL REFERENCES tavryl_admin_players(account_id), character_id text NOT NULL,
      name text NOT NULL, class text NOT NULL, level integer NOT NULL, zone text NOT NULL,
      item_level integer NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,character_id))`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS tavryl_admin_bans (
      account_id text PRIMARY KEY REFERENCES tavryl_admin_players(account_id),
      reason text NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS tavryl_admin_audit (
      id bigserial PRIMARY KEY, action text NOT NULL, account_id text NOT NULL,
      reason text NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
  }
  // Serialize complete transactions on the same connection used by state commits.
  // StateStore already serializes its own work; use standalone, single-statement
  // CTEs here so an unrelated state commit cannot enter an admin transaction.
  async presence(values) {
    if (!Array.isArray(values) || values.length>12) throw Error('invalid_presence');
    const players=values.map(cleanPlayer);
    if (new Set(players.map(p=>p.accountId)).size!==players.length) throw Error('duplicate_player');
    const op=async()=>{
      for(const p of players) {
        await this.db.query(`WITH observed AS (
          INSERT INTO tavryl_admin_players(account_id,online,boot,sessions,current_character)
          VALUES($1,true,$2,1,$3)
          ON CONFLICT(account_id) DO UPDATE SET
            online_seconds=tavryl_admin_players.online_seconds + CASE
              WHEN tavryl_admin_players.online AND tavryl_admin_players.boot=$2
                AND now()-tavryl_admin_players.last_seen_at < interval '45 seconds'
              THEN greatest(0,extract(epoch FROM now()-tavryl_admin_players.last_seen_at)) ELSE 0 END,
            sessions=tavryl_admin_players.sessions + CASE
              WHEN tavryl_admin_players.online AND tavryl_admin_players.boot=$2
                AND now()-tavryl_admin_players.last_seen_at < interval '45 seconds' THEN 0 ELSE 1 END,
            online=true,boot=$2,last_seen_at=now(),current_character=$3
          RETURNING account_id)
          INSERT INTO tavryl_admin_characters(account_id,character_id,name,class,level,zone,item_level)
          SELECT account_id,$3,$4,$5,$6,$7,$8 FROM observed
          ON CONFLICT(account_id,character_id) DO UPDATE SET name=$4,class=$5,level=$6,zone=$7,item_level=$8,last_seen_at=now()`,
          [p.accountId,this.boot,p.characterId,p.name,p.class,p.level,p.zone,p.itemLevel]);
      }
      await this.db.query(`UPDATE tavryl_admin_players SET online=false
        WHERE online=true AND boot=$1 AND NOT(account_id=ANY($2::text[]))`,[this.boot,players.map(p=>p.accountId)]);
      this.lastReport=Date.now();
      return this.activeBans();
    };
    const job=this.queue.then(op); this.queue=job.catch(()=>{}); return job;
  }
  async activeBans() {
    const {rows}=await this.db.query(`SELECT account_id,reason,expires_at FROM tavryl_admin_bans
      WHERE expires_at IS NULL OR expires_at>now()`);
    return rows;
  }
  async allowed(accountId) {
    if(!ACCOUNT.test(accountId||'')) throw Error('invalid_account');
    const {rows}=await this.db.query(`SELECT reason,expires_at FROM tavryl_admin_bans
      WHERE account_id=$1 AND (expires_at IS NULL OR expires_at>now())`,[accountId]);
    return {allowed:rows.length===0,ban:rows[0]||null};
  }
  async overview() {
    const {rows:players}=await this.db.query(`SELECT p.account_id,p.first_seen_at,p.last_seen_at,
      (p.online AND p.boot=$1 AND p.last_seen_at>now()-interval '45 seconds') AS online,
      p.sessions,round(p.online_seconds::numeric) AS online_seconds,
      c.name,c.class,c.level,c.zone,c.item_level,
      (SELECT count(*)::integer FROM tavryl_admin_characters c2 WHERE c2.account_id=p.account_id) AS characters,
      CASE WHEN b.expires_at IS NULL OR b.expires_at>now() THEN b.reason END AS ban_reason,
      CASE WHEN b.expires_at IS NULL OR b.expires_at>now() THEN b.created_at END AS banned_at,
      b.expires_at AS ban_expires_at
      FROM tavryl_admin_players p
      LEFT JOIN tavryl_admin_characters c ON c.account_id=p.account_id AND c.character_id=p.current_character
      LEFT JOIN tavryl_admin_bans b ON b.account_id=p.account_id
      ORDER BY online DESC,p.last_seen_at DESC LIMIT 1000`,[this.boot]);
    const {rows:[counts]}=await this.db.query(`SELECT
      (SELECT count(*)::integer FROM tavryl_admin_players) AS accounts,
      (SELECT count(*)::integer FROM tavryl_admin_characters) AS characters,
      (SELECT count(*)::integer FROM tavryl_admin_bans WHERE expires_at IS NULL OR expires_at>now()) AS banned`);
    const {rows:audit}=await this.db.query(`SELECT id,action,account_id,reason,expires_at,created_at
      FROM tavryl_admin_audit ORDER BY id DESC LIMIT 100`);
    return {players,audit,counts:{...counts,online:players.filter(p=>p.online).length},
      reportFresh:Date.now()-this.lastReport<45000,limit:1000,updatedAt:new Date().toISOString()};
  }
  async characters(accountId) {
    if(!ACCOUNT.test(accountId||'')) throw Error('invalid_account');
    const {rows}=await this.db.query(`SELECT name,class,level,zone,item_level,first_seen_at,last_seen_at
      FROM tavryl_admin_characters WHERE account_id=$1 ORDER BY last_seen_at DESC LIMIT 100`,[accountId]);
    return rows;
  }
  async moderate(accountId,action,reason,duration) {
    if(!ACCOUNT.test(accountId||'') || !['ban','unban'].includes(action)) throw Error('invalid_action');
    reason=String(reason||'').trim();
    if(reason.length<3 || reason.length>300 || /[\u0000-\u001f]/.test(reason)) throw Error('invalid_reason');
    if(![0,3600,86400,604800].includes(duration)) throw Error('invalid_duration');
    const {rowCount}=await this.db.query('SELECT 1 FROM tavryl_admin_players WHERE account_id=$1',[accountId]);
    if(!rowCount) throw Error('unknown_player');
    if(action==='ban') {
      await this.db.query(`WITH change AS (
        INSERT INTO tavryl_admin_bans(account_id,reason,expires_at)
        VALUES($1,$2,CASE WHEN $3::integer=0 THEN NULL ELSE now()+make_interval(secs=>$3::integer) END)
        ON CONFLICT(account_id) DO UPDATE SET reason=$2,expires_at=EXCLUDED.expires_at,created_at=now()
        RETURNING account_id,reason,expires_at)
        INSERT INTO tavryl_admin_audit(action,account_id,reason,expires_at)
        SELECT 'ban',account_id,reason,expires_at FROM change`,[accountId,reason,duration]);
    } else {
      await this.db.query(`WITH change AS (DELETE FROM tavryl_admin_bans WHERE account_id=$1 RETURNING account_id)
        INSERT INTO tavryl_admin_audit(action,account_id,reason)
        SELECT 'unban',account_id,$2 FROM change`,[accountId,reason]);
    }
    return {ok:true};
  }
}
