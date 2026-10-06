-- Published schema 5 at 18287bd7b624843540b61f73fd62325a1fd0725b (#51).
-- Pinned independently of both the current Store and the offline upgrader.
CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0,1)), version INTEGER NOT NULL,
    session_id TEXT, mapping_state TEXT NOT NULL CHECK(mapping_state IN ('unbound','bound','calling','unknown')),
    mapping_error TEXT, creation_receipt TEXT CHECK(creation_receipt IS NULL OR json_valid(creation_receipt)),
    CHECK((mapping_state='bound' AND session_id IS NOT NULL) OR (mapping_state!='bound' AND session_id IS NULL)));
CREATE TABLE deliveries (
    id TEXT PRIMARY KEY NOT NULL, source_session TEXT NOT NULL, source_message TEXT NOT NULL,
    topic_id TEXT NOT NULL REFERENCES topics(id), fingerprint TEXT NOT NULL,
    session_id TEXT, state TEXT NOT NULL CHECK(state IN ('calling','accepted','rejected','unknown')),
    mode TEXT CHECK(mode IN ('prompt','ask')), request_id TEXT, native_message_id TEXT,
    result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT, created_at INTEGER NOT NULL,
    UNIQUE(source_session,source_message,topic_id));
CREATE TABLE mailbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
    native_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reply','ask')), text TEXT NOT NULL,
    attachments TEXT NOT NULL CHECK(json_valid(attachments)),
    question TEXT CHECK(question IS NULL OR json_valid(question)), created_at INTEGER NOT NULL,
    notice_state TEXT NOT NULL CHECK(notice_state IN ('pending','calling','notified','unknown')),
    notice_id TEXT, notification_receipt TEXT);
CREATE TABLE seen (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT, created_at INTEGER NOT NULL);
PRAGMA user_version=5;
