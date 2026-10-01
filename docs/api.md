# Native Chat API and setup

Protocol **5** uses native session Chat, not the protocol-4 mirrored transcript.
There is no module frontend. Discover the enabled `assistant` ID/digest in Host
`GET /_modules.active`; its API base is `/_modules/assistant/<digest>/api`.
Native role selection and session IDs come from the ordinary Host APIs.

`GET /state` returns
`{protocolVersion:5,conversation:"native-session-chat",inbox:"consume-on-read",foregroundSessionId,schemaVersion:5}`.
The old module `/messages`, `/inputs`, `/timeline`, SSE and local-clarification
flows return **410 NATIVE_CHAT_REQUIRED**, not new content with old semantics.
Dashboard and other clients must explicitly move to native `prompt` and
`session/chat`; changing only a URL is not a compatible protocol-4 upgrade.

## Session setup

Create an ordinary native session with the Assistant role (`assistant/coordinator`)
and use the native Chat Composer. The role is exclusive: do not combine it with
unrelated roles. Its instructions include the one shared topic Skill; no Skill
reader tool is needed. The Host's public resource-policy and input-origin
capabilities are required before the service opens its store.

The first receipt-authenticated browser input selects an unconfigured foreground.
Alternatively persist its exact existing ID as `foregroundSessionId`. Other
coordinator-labelled sessions do not take over it. Unloaded is not missing; use
normal Host load/reload without creating a replacement. A role update only
applies to an existing handle after an explicit idle reload.

Persistent defaults use the Assistant `config` value in Host `modules/config.json`
without changing its `enabled`, version or digest:

```json
{
  "defaultCwd": "/absolute/project",
  "foregroundSessionId": null,
  "worker": {
    "cwd": "/absolute/project",
    "roles": [{"moduleId":"assistant","roleId":"worker"}],
    "toolScope": {
      "builtins":["view","grep","glob","bash","apply_patch","ask_user","skill"],
      "mcpServers":[]
    }
  }
}
```

Defaults apply to newly created workers, not existing sessions. New workers
inherit the Host default model. Unsupported resource/model fields are rejected;
one-time native resource preparation is not a saved template. The built-in scope
does not sandbox same-user code or permit reconstructing removed peer channels.

## One MCP endpoint

`POST /mcp` uses the Host role's digest-bound connection and actual
`cockpit/invocation` metadata, not caller-supplied session arguments.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `assistant_topics` | `{after?,limit?}` | Read the register. |
| `assistant_topic` | `{topicId?,title?,content?,archived?,sessionId?}` | Edit the register; omit ID for a new topic. |
| `assistant_dispatch` | `{items:[{topicId,prompt}]}` | Deliver the complete faithful split once for this native human input. |
| `assistant_inbox` | `{ids?,limit?,peek?}` | Read and consume returned entries; `peek:true` only counts. |
| `assistant_history` | `{sessionId,cursor?,recent?}` | Read recent dialogue for topic preparation, or an original native page. |
| `assistant_status` | `{topicId}` | Inspect mapping and native activity/question facts. |

Native attachments on the genuine source input are forwarded as descriptors.
No preview URL is converted into a path and no second attachment store exists.
Native ask answers require the complete original human words in a single-topic
dispatch; attached or mixed answers are rejected, never silently changed.

MCP success means the stated local operation or native acceptance, not successful
business completion. Transport uncertainty is not permission to repeat a send.
Reading a consumed inbox response again uses `assistant_history`, not replay.

### Recent dialogue

`assistant_history({sessionId,recent:true})` returns at most the latest **three**
nonempty primary `user.message` / `assistant.message` bodies in append order,
oldest first. The organizer defaults to this view. Tool events, subagent events,
ephemeral chunks, empty tool-call messages, attachments and opaque model metadata
are not included. Bodies accompanying a main-agent tool call remain dialogue.
Native event IDs and message IDs (when present) identify each excerpt.

The service reads persisted history without loading the source or saving a
transcript. It searches at most 16 native pages of 32 events to find the sample.
Each body's JSON-encoded UTF-8 text is limited to 3,000 bytes, without splitting
a surrogate pair; `truncated` and `originalLength` (UTF-16 units) identify
shortened bodies. The response is capped at 12,000 JSON-encoded UTF-8 bytes.
An oversized native identity fails explicitly rather than overflowing the tool.

The response has `view:"recent"`, `limit:3`, `order:"oldest-first"`, `messages`,
`complete`, `scanLimited` and `read:{pages,events}`. `complete` means the latest
three messages were found or native history ended with fewer messages; it never
means all historical topics or a business task are complete. `scanLimited:true`
means the search budget ended first, not that the conversation is empty.
Native failures, expired cursors and nonadvancing pages fail explicitly without
claiming a complete sample.

Recent sampling always starts at the latest event and rejects `cursor`.
`recent:false` preserves the original 16-event native page and its opaque cursor
for explicitly requested history checks. This remains the foreground default,
including after inbox consumption; original Chat history is never shortened.

## Organizer

The separate organizer role has only topics/topic/history tools, not delivery or
inbox. Select sources in the current native user input using an explicit line:

```text
historySessionIds: ["actual-native-session-id"]
```

Only those sources may be read or registered in that interaction. This is not a
permission to scan all histories, dispatch business or become the foreground.
Sharing the topic Skill does not confer another session's identity.
