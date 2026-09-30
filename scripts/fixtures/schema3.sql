CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL, sequence INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('user','reply','ask')), raw TEXT NOT NULL,
    attachments TEXT NOT NULL CHECK(json_valid(attachments)),
    source_session_id TEXT, native_message_id TEXT, native_event_id TEXT,
    created_at INTEGER NOT NULL, processed INTEGER NOT NULL CHECK(processed IN (0,1)),
    excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), diagnostic TEXT,
    input_request_id TEXT UNIQUE, input_fingerprint TEXT,
    question_request_id TEXT,
    question_choices TEXT CHECK(question_choices IS NULL OR (json_valid(question_choices) AND json_type(question_choices)='array')),
    question_allow_freeform INTEGER CHECK(question_allow_freeform IN (0,1)),
    question_state TEXT CHECK(question_state IN ('pending','stale','answered','unknown')),
    question_version INTEGER NOT NULL CHECK(question_version>=0),
    clarification_history TEXT NOT NULL CHECK(json_valid(clarification_history)),
    UNIQUE(source_session_id,native_message_id),
    UNIQUE(source_session_id,native_event_id), UNIQUE(source_session_id,question_request_id),
    CHECK((kind='user' AND source_session_id IS NULL AND input_request_id IS NOT NULL AND input_fingerprint IS NOT NULL)
      OR (kind='reply' AND source_session_id IS NOT NULL AND (native_message_id IS NOT NULL OR native_event_id IS NOT NULL)
        AND input_request_id IS NULL AND input_fingerprint IS NULL)
      OR (kind='ask' AND source_session_id IS NOT NULL AND input_request_id IS NULL AND input_fingerprint IS NULL)),
    CHECK((kind='ask' AND question_request_id IS NOT NULL AND question_state IS NOT NULL AND question_version>0)
      OR (kind!='ask' AND question_request_id IS NULL AND question_choices IS NULL AND question_allow_freeform IS NULL
        AND question_state IS NULL AND question_version=0)));
CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0,1)), version INTEGER NOT NULL,
    session_id TEXT, mapping_state TEXT NOT NULL CHECK(mapping_state IN ('unbound','bound','calling','unknown')),
    mapping_error TEXT, creation_receipt TEXT CHECK(creation_receipt IS NULL OR json_valid(creation_receipt)),
    CHECK((mapping_state='bound' AND session_id IS NOT NULL) OR (mapping_state!='bound' AND session_id IS NULL)));
CREATE TABLE topic_messages (
    id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
    topic_id TEXT NOT NULL REFERENCES topics(id), origin TEXT NOT NULL CHECK(origin IN ('user','session')),
    prompt TEXT, session_id TEXT, state TEXT CHECK(state IN ('pending','calling','accepted','rejected','unknown','cancelled')),
    mode TEXT CHECK(mode IN ('prompt','ask')), request_id TEXT, was_freeform INTEGER CHECK(was_freeform IN (0,1)),
    native_message_id TEXT, result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT,
    created_at INTEGER NOT NULL, UNIQUE(message_id,topic_id),
    CHECK((origin='session' AND prompt IS NULL AND state IS NULL AND mode IS NULL
      AND request_id IS NULL AND was_freeform IS NULL AND native_message_id IS NULL AND result IS NULL AND error IS NULL)
      OR (origin='user' AND prompt IS NOT NULL AND state IS NOT NULL)),
    CHECK(mode!='ask' OR (request_id IS NOT NULL AND was_freeform IS NOT NULL)));
CREATE INDEX messages_revision ON messages(revision);
CREATE INDEX messages_eligible ON messages(processed,excluded,sequence);
CREATE INDEX topic_messages_pending ON topic_messages(origin,state);
PRAGMA user_version=3;
