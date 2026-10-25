export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,name TEXT NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,inviteCode TEXT UNIQUE NOT NULL,createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (groupId TEXT NOT NULL REFERENCES groups(id),userId TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(groupId,userId));
CREATE TABLE IF NOT EXISTS messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,clientId TEXT NOT NULL,groupId TEXT NOT NULL REFERENCES groups(id),userId TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(userId,clientId));
CREATE INDEX IF NOT EXISTS messages_group_sequence ON messages(groupId,sequence);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(userId);
CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY,tokenHash TEXT NOT NULL REFERENCES sessions(tokenHash) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),tokenHash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS voices (connectionId TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,groupId TEXT NOT NULL REFERENCES groups(id),muted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_versions VALUES (1);`;

const migrations = new Map([
  [
    2,
    `
    CREATE TABLE devices (tokenHash TEXT PRIMARY KEY REFERENCES sessions(tokenHash) ON DELETE CASCADE,name TEXT NOT NULL,createdAt INTEGER NOT NULL,lastSeen INTEGER NOT NULL);
    CREATE TABLE recovery_codes (userId TEXT PRIMARY KEY REFERENCES users(id),codeHash TEXT UNIQUE NOT NULL,createdAt INTEGER NOT NULL);
    INSERT INTO devices SELECT tokenHash,'Existing device',createdAt,createdAt FROM sessions;
  `,
  ],
  [
    3,
    `
    CREATE TABLE storage_objects (key TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0),state TEXT NOT NULL CHECK(state IN ('writing','ready','uncertain','deleting','external')),sha256 TEXT NOT NULL,createdAt INTEGER NOT NULL);
    `,
  ],
  [
    4,
    `
    ALTER TABLE storage_objects RENAME TO storage_objects_v3;
    CREATE TABLE storage_objects (key TEXT PRIMARY KEY,bytes INTEGER NOT NULL CHECK(bytes>=0),state TEXT NOT NULL CHECK(state IN ('reserved','writing','ready','uncertain','deleting','external')),sha256 TEXT NOT NULL,createdAt INTEGER NOT NULL);
    INSERT INTO storage_objects SELECT * FROM storage_objects_v3;
    DROP TABLE storage_objects_v3;
    CREATE TABLE media_uploads (id TEXT PRIMARY KEY,groupId TEXT NOT NULL REFERENCES groups(id),userId TEXT NOT NULL REFERENCES users(id),key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','ready','committed','cancelled')),createdAt INTEGER NOT NULL);
    CREATE INDEX media_uploads_owner ON media_uploads(userId,state);
    CREATE TABLE message_attachments (messageId TEXT NOT NULL REFERENCES messages(id),uploadId TEXT UNIQUE NOT NULL REFERENCES media_uploads(id),position INTEGER NOT NULL,PRIMARY KEY(messageId,position));
    `,
  ],
  [
    5,
    `
    CREATE TABLE message_reactions (messageId TEXT NOT NULL REFERENCES messages(id),userId TEXT NOT NULL REFERENCES users(id),emoji TEXT NOT NULL,PRIMARY KEY(messageId,userId,emoji));
    CREATE TABLE message_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT,messageId TEXT NOT NULL REFERENCES messages(id),groupId TEXT NOT NULL REFERENCES groups(id),createdAt INTEGER NOT NULL);
    CREATE INDEX message_changes_group ON message_changes(groupId,sequence);
    CREATE INDEX message_changes_message ON message_changes(messageId,sequence);
    INSERT INTO message_changes(messageId,groupId,createdAt) SELECT id,groupId,createdAt FROM messages ORDER BY sequence;
  `,
  ],
  [
    6,
    `
    ALTER TABLE messages ADD COLUMN editedAt INTEGER;
    ALTER TABLE messages ADD COLUMN deletedAt INTEGER;
    ALTER TABLE message_changes ADD COLUMN kind TEXT NOT NULL DEFAULT 'reaction';
    UPDATE message_changes SET kind='create' WHERE sequence IN (SELECT MIN(sequence) FROM message_changes GROUP BY messageId);
  `,
  ],
  [
    7,
    `INSERT INTO message_changes(messageId,groupId,createdAt,kind) SELECT id,groupId,deletedAt,'delete' FROM messages WHERE deletedAt IS NOT NULL;`,
  ],
  [
    8,
    `
    CREATE TABLE avatar_images (id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('user','group')),targetId TEXT NOT NULL,baseRevision INTEGER NOT NULL,key TEXT UNIQUE NOT NULL,type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','active','retired')),createdAt INTEGER NOT NULL);
    CREATE TABLE avatar_slots (kind TEXT NOT NULL CHECK(kind IN ('user','group')),targetId TEXT NOT NULL,id TEXT REFERENCES avatar_images(id),revision INTEGER NOT NULL,PRIMARY KEY(kind,targetId));
    CREATE INDEX avatar_images_owner ON avatar_images(userId,createdAt);
  `,
  ],
  [
    9,
    `
    CREATE TABLE group_controls (groupId TEXT PRIMARY KEY REFERENCES groups(id),ownerId TEXT REFERENCES users(id),revision INTEGER NOT NULL);
    INSERT INTO group_controls SELECT g.id,(SELECT m.userId FROM memberships m WHERE m.groupId=g.id ORDER BY m.rowid LIMIT 1),1 FROM groups g;
    CREATE TABLE group_departures (groupId TEXT NOT NULL REFERENCES groups(id),userId TEXT NOT NULL REFERENCES users(id),access TEXT NOT NULL CHECK(access IN ('left','removed')),revision INTEGER NOT NULL,PRIMARY KEY(groupId,userId));
  `,
  ],
  [
    10,
    `
    CREATE TABLE cancelled_messages (userId TEXT NOT NULL REFERENCES users(id),clientId TEXT NOT NULL,groupId TEXT NOT NULL REFERENCES groups(id),PRIMARY KEY(userId,clientId));
    CREATE TABLE message_replies (messageId TEXT PRIMARY KEY REFERENCES messages(id),targetId TEXT NOT NULL REFERENCES messages(id));
    CREATE INDEX message_replies_target ON message_replies(targetId);
    CREATE TABLE server_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO server_state VALUES ('generation',lower(hex(randomblob(16))));
  `,
  ],
]);
export const LATEST_SCHEMA_VERSION = 10;
const run = (db, source) => {
  // Keep migrations as individual statements; complex triggers require their
  // own explicit migration implementation rather than naive SQL splitting.
  for (const sql of source.split(";").filter((statement) => statement.trim()))
    db.prepare(sql).run();
};
export function initializeSchema(db, through = LATEST_SCHEMA_VERSION) {
  if (
    !Number.isInteger(through) ||
    through < 1 ||
    through > LATEST_SCHEMA_VERSION
  )
    throw new Error("Unsupported database schema version.");
  db.transaction(() => {
    const exists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_versions'",
      )
      .get();
    const previous = exists
      ? db.prepare("SELECT MAX(version) AS version FROM schema_versions").get()
          .version
      : 0;
    if (previous > through)
      throw new Error("This database requires a newer Gather server.");
    run(db, BASE_SCHEMA);
    for (
      let version = Math.max(previous, 1) + 1;
      version <= through;
      version++
    ) {
      if (!migrations.has(version))
        throw new Error("Database migration is unavailable.");
      run(db, migrations.get(version));
      db.prepare("INSERT INTO schema_versions VALUES (?)").run(version);
    }
  });
}
